//! Limited, identifiable Last.fm artist-portrait requests.
//!
//! Only an artist's ordinary page and the explicitly allowlisted image CDN are
//! used. There is no API-key handling, image-gallery crawling, cookie jar,
//! browser impersonation, automatic redirect following, or automatic retry.
//! Every outgoing request shares one process-wide gate. Its small state file
//! preserves pacing, consecutive failures and cooldowns across restarts.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, Utc};
use image::{ImageFormat, ImageReader, Limits};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::{ACCEPT, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{Response, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const USER_AGENT: &str = concat!(
    "metatidy/",
    env!("CARGO_PKG_VERSION"),
    " (artist portraits; +https://github.com/jasonb589/metatidy)"
);
const MIN_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const BLOCK_COOLDOWN: u64 = 60 * 60;
const FAILURE_COOLDOWN: u64 = 15 * 60;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_GATE_BYTES: u64 = 16 * 1024;
const PLACEHOLDER_HASH: &str = "2a96cbd8b46e442fc41c2b86b821562f";

static IMAGE_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^/i/u/(?:[A-Za-z0-9_-]{1,32}/){0,3}([a-fA-F0-9]{32})\.(?:jpg|png|webp)$")
        .expect("fixed image URL pattern")
});
static HTML_HEAD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?is)<head\b[^>]*>(.*?)</head\s*>").unwrap());
static INERT_HTML: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?is)<!--.*?-->|<(?:script|style|template)\b[^>]*>.*?</(?:script|style|template)\s*>",
    )
    .unwrap()
});
static META_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?is)<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>"#).unwrap());
static HTML_ATTRIBUTE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
        .unwrap()
});

#[derive(Debug, Clone, Serialize)]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub retry_after_seconds: Option<u64>,
}

impl ProviderError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            retry_after_seconds: None,
        }
    }

    fn with_retry(mut self, seconds: u64) -> Self {
        self.retry_after_seconds = Some(seconds.max(1));
        self
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug)]
pub struct FetchedPortrait {
    pub artist: String,
    pub source_page: String,
    pub source_image: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub busy: bool,
    pub cooldown: bool,
    pub retry_after_seconds: Option<u64>,
    /// Unix timestamp in seconds; includes normal pacing when not cooling down.
    pub retry_at: Option<i64>,
    pub reason: Option<String>,
    pub min_interval_seconds: u64,
}

#[derive(Clone)]
pub struct LastfmPortraitClient {
    client: reqwest::Client,
    gate: Arc<RequestGate>,
    interval: Duration,
    #[cfg(test)]
    bases: Option<BaseUrls>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedGate {
    version: u8,
    next_request_at_ms: i64,
    cooldown_until_ms: i64,
    consecutive_failures: u32,
    reason: Option<String>,
}

impl Default for PersistedGate {
    fn default() -> Self {
        Self {
            version: 1,
            next_request_at_ms: 0,
            cooldown_until_ms: 0,
            consecutive_failures: 0,
            reason: None,
        }
    }
}

#[derive(Default)]
struct GateInner {
    saved: PersistedGate,
    last_request: Option<Instant>,
    paths: BTreeSet<PathBuf>,
}

#[derive(Default)]
struct RequestGate {
    operation: Arc<AsyncMutex<()>>,
    inner: Mutex<GateInner>,
}

static PROCESS_GATE: Lazy<Arc<RequestGate>> = Lazy::new(|| Arc::new(RequestGate::default()));

fn persistence_error() -> ProviderError {
    ProviderError::new(
        "persistence_error",
        "Last.fm 请求保护状态无法读取或保存；已停止联网，请检查数据目录权限和 gate.json。",
    )
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn remaining_seconds(until_ms: i64, current_ms: i64) -> u64 {
    let remaining = until_ms.saturating_sub(current_ms).max(0) as u64;
    remaining / 1000 + u64::from(remaining % 1000 != 0)
}

fn pacing_delay(
    next_request_at_ms: i64,
    current_ms: i64,
    elapsed: Option<Duration>,
    interval: Duration,
) -> Duration {
    let wall_delay =
        Duration::from_millis(next_request_at_ms.saturating_sub(current_ms).max(0) as u64);
    let monotonic_delay = elapsed
        .map(|elapsed| interval.saturating_sub(elapsed))
        .unwrap_or_default();
    wall_delay.max(monotonic_delay)
}

fn load_gate(path: &Path) -> Result<PersistedGate, ProviderError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedGate::default());
        }
        Err(_) => return Err(persistence_error()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_GATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| persistence_error())?;
    if bytes.len() as u64 > MAX_GATE_BYTES {
        return Err(persistence_error());
    }
    let saved: PersistedGate = serde_json::from_slice(&bytes).map_err(|_| persistence_error())?;
    if saved.version != 1
        || saved.next_request_at_ms < 0
        || saved.cooldown_until_ms < 0
        || saved.consecutive_failures > 3
        || saved
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > 80)
    {
        return Err(persistence_error());
    }
    Ok(saved)
}

fn save_gate(inner: &GateInner) -> Result<(), ProviderError> {
    let bytes = serde_json::to_vec(&inner.saved).map_err(|_| persistence_error())?;
    for destination in &inner.paths {
        let temporary = destination.with_file_name(format!("gate-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            // Rust's rename replaces an existing file on both Unix and Windows
            // (MoveFileExW), keeping the old state intact until replacement.
            fs::rename(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(persistence_error());
        }
    }
    Ok(())
}

impl RequestGate {
    fn register(&self, data_dir: &Path) -> Result<(), ProviderError> {
        let directory = data_dir.join("lastfm-portraits");
        fs::create_dir_all(&directory).map_err(|_| persistence_error())?;
        let path = directory
            .canonicalize()
            .map_err(|_| persistence_error())?
            .join("gate.json");
        let saved = load_gate(&path)?;
        let mut inner = self.inner.lock().map_err(|_| persistence_error())?;
        // Constructing another client must never reset the process-wide gate.
        inner.saved.next_request_at_ms =
            inner.saved.next_request_at_ms.max(saved.next_request_at_ms);
        inner.saved.consecutive_failures = inner
            .saved
            .consecutive_failures
            .max(saved.consecutive_failures);
        if saved.cooldown_until_ms > inner.saved.cooldown_until_ms {
            inner.saved.cooldown_until_ms = saved.cooldown_until_ms;
            inner.saved.reason = saved.reason;
        }
        inner.paths.insert(path);
        save_gate(&inner)
    }

    fn acquire(&self) -> Result<OwnedMutexGuard<()>, ProviderError> {
        self.operation.clone().try_lock_owned().map_err(|_| {
            ProviderError::new("busy", "Last.fm 正在处理另一个请求，请稍后再试。")
                .with_retry(MIN_INTERVAL.as_secs())
        })
    }

    async fn before_request(&self, interval: Duration) -> Result<(), ProviderError> {
        loop {
            let delay = {
                let mut inner = self.inner.lock().map_err(|_| persistence_error())?;
                let current = now_ms();
                if inner.saved.cooldown_until_ms > current {
                    return Err(ProviderError::new(
                        "cooldown",
                        "Last.fm 请求已暂停；冷却结束后可再次尝试。",
                    )
                    .with_retry(remaining_seconds(inner.saved.cooldown_until_ms, current)));
                }
                let delay = pacing_delay(
                    inner.saved.next_request_at_ms,
                    current,
                    inner.last_request.map(|instant| instant.elapsed()),
                    interval,
                );
                if delay.is_zero() {
                    inner.saved.next_request_at_ms =
                        current.saturating_add(interval.as_millis() as i64);
                    // Reserve and persist the request before touching the network.
                    save_gate(&inner)?;
                    // Disk latency must not count toward the request interval.
                    inner.last_request = Some(Instant::now());
                    return Ok(());
                }
                // A backwards clock change must not turn a request into a long queue.
                if delay > interval + Duration::from_secs(1) {
                    return Err(ProviderError::new(
                        "cooldown",
                        "Last.fm 请求仍处于已保存的等待时间内，请稍后再试。",
                    )
                    .with_retry(delay.as_secs().saturating_add(1)));
                }
                delay
            };
            tokio::time::sleep(delay).await;
        }
    }

    fn block(&self, code: &str, seconds: u64) -> Result<u64, ProviderError> {
        let mut inner = self.inner.lock().map_err(|_| persistence_error())?;
        let current = now_ms();
        let duration_ms = seconds.saturating_mul(1000).min(i64::MAX as u64) as i64;
        inner.saved.cooldown_until_ms = inner
            .saved
            .cooldown_until_ms
            .max(current.saturating_add(duration_ms));
        inner.saved.reason = Some(code.to_owned());
        inner.saved.consecutive_failures = 0;
        save_gate(&inner)?;
        Ok(remaining_seconds(inner.saved.cooldown_until_ms, current))
    }

    fn transient_failure(&self) -> Result<Option<u64>, ProviderError> {
        let mut inner = self.inner.lock().map_err(|_| persistence_error())?;
        inner.saved.consecutive_failures = (inner.saved.consecutive_failures + 1).min(3);
        let pause = if inner.saved.consecutive_failures >= 3 {
            inner.saved.cooldown_until_ms = now_ms().saturating_add(FAILURE_COOLDOWN as i64 * 1000);
            inner.saved.reason = Some("upstream_unavailable".to_owned());
            Some(FAILURE_COOLDOWN)
        } else {
            None
        };
        save_gate(&inner)?;
        Ok(pause)
    }

    fn finish(&self, result: &Result<FetchedPortrait, ProviderError>) -> Result<(), ProviderError> {
        if result.as_ref().err().is_some_and(|error| {
            matches!(
                error.code.as_str(),
                "timeout"
                    | "network_error"
                    | "upstream_unavailable"
                    | "forbidden"
                    | "rate_limited"
                    | "challenge"
                    | "cooldown"
                    | "persistence_error"
            )
        }) {
            return Ok(());
        }
        let mut inner = self.inner.lock().map_err(|_| persistence_error())?;
        if inner.saved.consecutive_failures != 0 {
            inner.saved.consecutive_failures = 0;
            save_gate(&inner)?;
        }
        Ok(())
    }

    fn status(&self, interval: Duration) -> ProviderStatus {
        let busy = self.operation.try_lock().is_err();
        match self.inner.lock() {
            Ok(inner) => {
                let current = now_ms();
                let until = inner
                    .saved
                    .cooldown_until_ms
                    .max(inner.saved.next_request_at_ms);
                let waiting = until > current;
                let cooldown = inner.saved.cooldown_until_ms > current;
                ProviderStatus {
                    busy,
                    cooldown,
                    retry_after_seconds: waiting.then(|| remaining_seconds(until, current)),
                    retry_at: waiting.then(|| until.saturating_add(999) / 1000),
                    reason: cooldown.then(|| inner.saved.reason.clone()).flatten(),
                    min_interval_seconds: interval.as_secs(),
                }
            }
            Err(_) => ProviderStatus {
                busy,
                cooldown: true,
                retry_after_seconds: None,
                retry_at: None,
                reason: Some("persistence_error".to_owned()),
                min_interval_seconds: interval.as_secs(),
            },
        }
    }
}

impl LastfmPortraitClient {
    /// `data_dir` is the application's data root, not a per-request directory.
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, ProviderError> {
        let client = Self::http_client(REQUEST_TIMEOUT)?;
        let gate = PROCESS_GATE.clone();
        gate.register(data_dir.as_ref())?;
        Ok(Self {
            client,
            gate,
            interval: MIN_INTERVAL,
            #[cfg(test)]
            bases: None,
        })
    }

    fn http_client(timeout: Duration) -> Result<reqwest::Client, ProviderError> {
        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .pool_max_idle_per_host(1);
        // Local mocks must not depend on a developer's environment proxy.
        #[cfg(test)]
        let builder = builder.no_proxy();
        builder
            .build()
            .map_err(|_| ProviderError::new("network_error", "无法初始化 Last.fm 请求客户端。"))
    }

    pub fn status(&self) -> ProviderStatus {
        self.gate.status(self.interval)
    }

    pub async fn fetch_artist(&self, artist: &str) -> Result<FetchedPortrait, ProviderError> {
        let (artist, source_page) = artist_page(artist)?;
        let _operation = self.gate.acquire()?;
        let result = self.fetch_artist_inner(artist, source_page).await;
        self.gate.finish(&result)?;
        result
    }

    /// Download one manually selected Last.fm CDN URL, without looking up a page.
    pub async fn fetch_image(
        &self,
        artist: &str,
        source_image: &str,
    ) -> Result<FetchedPortrait, ProviderError> {
        let (artist, source_page) = artist_page(artist)?;
        let image = image_url(source_image)?;
        let _operation = self.gate.acquire()?;
        let result = self.fetch_image_inner(artist, source_page, image).await;
        self.gate.finish(&result)?;
        result
    }

    async fn fetch_artist_inner(
        &self,
        artist: String,
        source_page: Url,
    ) -> Result<FetchedPortrait, ProviderError> {
        let response = self.request(&source_page, false).await?;
        if !matches!(
            content_type(&response).as_str(),
            "text/html" | "application/xhtml+xml"
        ) {
            return Err(ProviderError::new(
                "unexpected_content_type",
                "Last.fm 歌手主页没有返回 HTML 页面。",
            ));
        }
        let html = self.read_body(response, MAX_HTML_BYTES).await?;
        let html = String::from_utf8_lossy(&html);
        if is_challenge(&html) {
            let seconds = self.gate.block("challenge", BLOCK_COOLDOWN)?;
            return Err(ProviderError::new(
                "challenge",
                "Last.fm 返回验证或访问拦截页面，已暂停请求一小时。",
            )
            .with_retry(seconds));
        }
        let image = main_image(&html)?;
        self.fetch_image_inner(artist, source_page, image).await
    }

    async fn fetch_image_inner(
        &self,
        artist: String,
        source_page: Url,
        image: Url,
    ) -> Result<FetchedPortrait, ProviderError> {
        let response = self.request(&image, true).await?;
        let mime = content_type(&response);
        if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") {
            if mime == "text/html" {
                let body = self.read_body(response, MAX_HTML_BYTES).await?;
                if is_challenge(&String::from_utf8_lossy(&body)) {
                    let seconds = self.gate.block("challenge", BLOCK_COOLDOWN)?;
                    return Err(ProviderError::new(
                        "challenge",
                        "Last.fm 图片服务返回验证页面，已暂停请求一小时。",
                    )
                    .with_retry(seconds));
                }
            }
            return Err(ProviderError::new(
                "unexpected_content_type",
                "Last.fm 图片服务没有返回 JPEG、PNG 或 WebP 图片。",
            ));
        }
        let bytes = self.read_body(response, MAX_IMAGE_BYTES).await?;
        let bytes = tokio::task::spawn_blocking(move || validate_image(bytes, &mime))
            .await
            .map_err(|_| ProviderError::new("invalid_image", "Last.fm 图片校验未完成。"))??;
        Ok(FetchedPortrait {
            artist,
            source_page: source_page.to_string(),
            source_image: image.to_string(),
            bytes,
        })
    }

    async fn request(&self, source: &Url, image: bool) -> Result<Response, ProviderError> {
        self.gate.before_request(self.interval).await?;
        let destination = self.request_url(source, image);
        let response = self
            .client
            .get(destination)
            .header(
                ACCEPT,
                if image {
                    "image/jpeg, image/png, image/webp"
                } else {
                    "text/html"
                },
            )
            .send()
            .await
            .map_err(|error| self.request_error(error))?;
        let status = response.status();
        if status.as_u16() == 403 {
            let seconds = self.gate.block("forbidden", BLOCK_COOLDOWN)?;
            return Err(
                ProviderError::new("forbidden", "Last.fm 拒绝访问，已暂停请求一小时。")
                    .with_retry(seconds),
            );
        }
        if status.as_u16() == 429 {
            let delay = retry_after_seconds(
                response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                Utc::now().timestamp(),
            );
            let seconds = self.gate.block("rate_limited", delay)?;
            return Err(ProviderError::new(
                "rate_limited",
                "Last.fm 限制请求频率，已按等待时间暂停。",
            )
            .with_retry(seconds));
        }
        if status.is_server_error() {
            let retry = self.gate.transient_failure()?;
            let mut error = ProviderError::new(
                "upstream_unavailable",
                "Last.fm 服务暂时不可用。连续三次失败将暂停十五分钟。",
            );
            error.retry_after_seconds = retry;
            return Err(error);
        }
        if status.is_redirection() {
            return Err(ProviderError::new(
                "redirect_blocked",
                "Last.fm 返回重定向；为限制请求范围，未跟随跳转。可手动提供头像图片链接。",
            ));
        }
        if status.as_u16() == 404 {
            return Err(ProviderError::new(
                if image {
                    "image_not_found"
                } else {
                    "artist_not_found"
                },
                if image {
                    "Last.fm 图片不存在。"
                } else {
                    "Last.fm 没有该歌手主页。"
                },
            ));
        }
        if status.as_u16() != 200 {
            return Err(ProviderError::new(
                "upstream_error",
                "Last.fm 返回了无法使用的响应。",
            ));
        }
        Ok(response)
    }

    fn request_url(&self, source: &Url, _image: bool) -> Url {
        #[cfg(test)]
        if let Some(bases) = &self.bases {
            let mut destination = if _image {
                bases.image.clone()
            } else {
                bases.page.clone()
            };
            destination.set_path(source.path());
            return destination;
        }
        source.clone()
    }

    fn request_error(&self, error: reqwest::Error) -> ProviderError {
        let retry = match self.gate.transient_failure() {
            Ok(retry) => retry,
            Err(error) => return error,
        };
        // Never include reqwest's URL-bearing Display text in user-facing errors.
        let mut result = if error.is_timeout() {
            ProviderError::new("timeout", "Last.fm 请求超时。连续三次失败将暂停十五分钟。")
        } else {
            ProviderError::new(
                "network_error",
                "Last.fm 网络请求失败。连续三次失败将暂停十五分钟。",
            )
        };
        result.retry_after_seconds = retry;
        result
    }

    async fn read_body(
        &self,
        mut response: Response,
        limit: usize,
    ) -> Result<Vec<u8>, ProviderError> {
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(ProviderError::new(
                "response_too_large",
                "Last.fm 响应超过允许大小。",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| self.request_error(error))?
        {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(ProviderError::new(
                    "response_too_large",
                    "Last.fm 响应超过允许大小，已停止下载。",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn content_type(response: &Response) -> String {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn artist_page(input: &str) -> Result<(String, Url), ProviderError> {
    let artist = input.trim();
    if artist.is_empty()
        || artist.chars().count() > 200
        || artist.chars().any(char::is_control)
        || matches!(artist, "." | "..")
    {
        return Err(ProviderError::new(
            "invalid_artist",
            "请提供有效的歌手名称（最多 200 字符）。",
        ));
    }
    let mut encoded = String::with_capacity(artist.len() * 3);
    for byte in artist.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(*byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    let page = Url::parse(&format!("https://www.last.fm/music/{encoded}"))
        .map_err(|_| ProviderError::new("invalid_artist", "无法构造 Last.fm 歌手主页地址。"))?;
    Ok((artist.to_owned(), page))
}

fn image_url(input: &str) -> Result<Url, ProviderError> {
    let invalid = || {
        ProviderError::new(
        "invalid_image_url",
        "只接受 Last.fm 图片域名上的 HTTPS JPEG、PNG 或 WebP 原图链接，且不能包含参数、登录信息或片段。",
    )
    };
    if input.len() > 2048
        || input.contains('\\')
        || input
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid());
    }
    let url = Url::parse(input).map_err(|_| invalid())?;
    let authority = input
        .split_once("://")
        .map(|(_, remainder)| remainder.split('/').next().unwrap_or_default())
        .unwrap_or_default();
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("lastfm.freetls.fastly.net" | "lastfm-img.freetls.fastly.net")
        )
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.contains('@')
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let captures = IMAGE_PATH.captures(url.path()).ok_or_else(invalid)?;
    if captures[1].eq_ignore_ascii_case(PLACEHOLDER_HASH) {
        return Err(ProviderError::new(
            "placeholder_image",
            "Last.fm 仅返回默认占位图，未找到该歌手头像。",
        ));
    }
    Ok(url)
}

fn decode_attribute(value: &str) -> String {
    // URLs only need basic HTML entities. Numeric entities are handled so that
    // validation always sees the actual URL rather than an encoded hostname.
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|end| *end <= 12).and_then(|end| {
            let entity = &rest[1..end];
            let character = match entity {
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "lt" => Some('<'),
                "gt" => Some('>'),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                    .or_else(|| {
                        entity
                            .strip_prefix('#')
                            .and_then(|digits| digits.parse().ok())
                    })
                    .and_then(char::from_u32),
            }?;
            Some((character, end + 1))
        });
        if let Some((character, length)) = decoded {
            result.push(character);
            rest = &rest[length..];
        } else {
            result.push('&');
            rest = &rest[1..];
        }
    }
    result.push_str(rest);
    result
}

fn main_image(html: &str) -> Result<Url, ProviderError> {
    let missing = || {
        ProviderError::new(
            "parse_error",
            "Last.fm 主页没有可识别的主头像；可手动提供图片链接。",
        )
    };
    // Strip comments/scripts first; they can contain fake </head> tags too.
    let visible = INERT_HTML.replace_all(html, "");
    let head = HTML_HEAD.captures(&visible).ok_or_else(missing)?;
    for tag in META_TAG.find_iter(&head[1]) {
        let mut property = None;
        let mut content = None;
        for attribute in HTML_ATTRIBUTE.captures_iter(tag.as_str()) {
            let value = attribute
                .get(2)
                .or_else(|| attribute.get(3))
                .or_else(|| attribute.get(4));
            let Some(value) = value else { continue };
            if attribute[1].eq_ignore_ascii_case("property") && property.is_none() {
                property = Some(decode_attribute(value.as_str()));
            } else if attribute[1].eq_ignore_ascii_case("content") && content.is_none() {
                content = Some(decode_attribute(value.as_str()));
            }
        }
        if property
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("og:image"))
        {
            let value = content.ok_or_else(missing)?;
            return image_url(&value).map_err(|error| {
                if error.code == "invalid_image_url" {
                    ProviderError::new(
                        "upstream_image_unsupported",
                        "Last.fm 主页返回的头像地址暂不受支持，本次未下载；可手动提供受支持的 Last.fm 图片链接。",
                    )
                } else {
                    error
                }
            });
        }
    }
    Err(missing())
}

fn is_challenge(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    [
        "<title>just a moment",
        "<title>access denied",
        "<title>attention required",
        "cf-chl-",
        "/cdn-cgi/challenge-platform/",
        "verify you are human",
        "verify that you are human",
        "please complete the captcha",
        "challenge-form",
        "g-recaptcha",
        "hcaptcha.com/1/api.js",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn retry_after_seconds(value: Option<&str>, current_seconds: i64) -> u64 {
    let delay = value
        .and_then(|value| {
            let value = value.trim();
            if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
                // An excessively large value becomes an effectively indefinite
                // cooldown, rather than retrying earlier than the server asks.
                return Some(value.parse::<u64>().unwrap_or(u64::MAX));
            }
            let timestamp = DateTime::parse_from_rfc2822(value)
                .map(|date| date.timestamp())
                .ok()
                .or_else(|| {
                    ["%A, %d-%b-%y %H:%M:%S GMT", "%a %b %e %H:%M:%S %Y"]
                        .iter()
                        .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
                        .map(|date| date.and_utc().timestamp())
                })?;
            Some(timestamp.saturating_sub(current_seconds).max(0) as u64)
        })
        .unwrap_or(BLOCK_COOLDOWN);
    delay.max(MIN_INTERVAL.as_secs())
}

fn validate_image(bytes: Vec<u8>, declared_mime: &str) -> Result<Vec<u8>, ProviderError> {
    let invalid = || {
        ProviderError::new(
            "invalid_image",
            "Last.fm 返回的图片无法解码、格式不符或尺寸过大。",
        )
    };
    let format = image::guess_format(&bytes).map_err(|_| invalid())?;
    let mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        _ => return Err(invalid()),
    };
    if mime != declared_mime {
        return Err(invalid());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| invalid())?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(invalid());
    }
    Ok(bytes)
}

#[cfg(test)]
#[derive(Clone)]
struct BaseUrls {
    page: Url,
    image: Url,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, Bytes};
    use axum::extract::{Request, State};
    use axum::http::{HeaderName, HeaderValue, StatusCode};
    use axum::response::Response as MockResponse;
    use axum::Router;
    use std::collections::VecDeque;

    const IMAGE: &str =
        "https://lastfm.freetls.fastly.net/i/u/300x300/0123456789abcdef0123456789abcdef.png";
    // Minimal metadata from the observed public 二珂 page, without embedding
    // the full page or requiring a real Last.fm request during tests.
    const ERKE_IMAGE: &str =
        "https://lastfm-img.freetls.fastly.net/i/u/ar0/58a46edad6d325e9b4034258587509a9.jpg";
    const ERKE_HEAD: &str = r#"<html><head>
    <meta property="og:image"           content="https://lastfm-img.freetls.fastly.net/i/u/ar0/58a46edad6d325e9b4034258587509a9.jpg" data-replaceable-head-tag>
    <meta property="og:image:width"     content="1200" data-replaceable-head-tag>
    <meta property="og:image:height"    content="630" data-replaceable-head-tag>
    </head><body></body></html>"#;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("metatidy-lastfm-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Reply {
        status: u16,
        mime: &'static str,
        headers: Vec<(&'static str, String)>,
        bytes: Vec<u8>,
        chunked: bool,
        delay: Option<Duration>,
    }
    impl Reply {
        fn html(text: impl Into<String>) -> Self {
            Self {
                status: 200,
                mime: "text/html",
                headers: vec![],
                bytes: text.into().into_bytes(),
                chunked: false,
                delay: None,
            }
        }
        fn status(status: u16) -> Self {
            Self {
                status,
                ..Self::html("")
            }
        }
        fn png() -> Self {
            Self {
                mime: "image/png",
                bytes: png(),
                ..Self::html("")
            }
        }
        fn jpeg() -> Self {
            Self {
                mime: "image/jpeg",
                bytes: jpeg(),
                ..Self::html("")
            }
        }
    }

    struct MockServer {
        base: Url,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    struct MockState {
        requests: Arc<Mutex<Vec<String>>>,
        replies: Mutex<VecDeque<Reply>>,
    }

    async fn mock_reply(State(state): State<Arc<MockState>>, request: Request) -> MockResponse {
        let mut recorded = format!("{} {} HTTP/1.1\r\n", request.method(), request.uri());
        for (name, value) in request.headers() {
            recorded.push_str(name.as_str());
            recorded.push_str(": ");
            recorded.push_str(value.to_str().unwrap_or_default());
            recorded.push_str("\r\n");
        }
        state.requests.lock().unwrap().push(recorded);
        let reply = state
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Reply::status(500));
        if let Some(delay) = reply.delay {
            tokio::time::sleep(delay).await;
        }
        let body = if reply.chunked {
            // An unknown-size body exercises chunk-by-chunk limits without the
            // client rejecting a declared Content-Length before reading it.
            let bytes = Bytes::from(reply.bytes);
            Body::from_stream(futures::stream::unfold(
                (bytes, 0usize),
                |(bytes, offset)| async move {
                    if offset == bytes.len() {
                        return None;
                    }
                    let end = (offset + 64 * 1024).min(bytes.len());
                    let chunk = bytes.slice(offset..end);
                    Some((Ok::<_, std::io::Error>(chunk), (bytes, end)))
                },
            ))
        } else {
            Body::from(reply.bytes)
        };
        let mut response = MockResponse::new(body);
        *response.status_mut() = StatusCode::from_u16(reply.status).unwrap();
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(reply.mime));
        for (name, value) in reply.headers {
            response.headers_mut().insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(&value).unwrap(),
            );
        }
        response
    }

    impl MockServer {
        async fn new(replies: Vec<Reply>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let state = Arc::new(MockState {
                requests: requests.clone(),
                replies: Mutex::new(replies.into()),
            });
            let router = Router::new().fallback(mock_reply).with_state(state);
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                base,
                requests,
                task,
            }
        }

        fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }
    impl Drop for MockServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn test_client(directory: &TestDirectory, server: &MockServer) -> LastfmPortraitClient {
        let gate = Arc::new(RequestGate::default());
        gate.register(&directory.0).unwrap();
        LastfmPortraitClient {
            client: LastfmPortraitClient::http_client(Duration::from_secs(2)).unwrap(),
            gate,
            interval: Duration::from_millis(1),
            bases: Some(BaseUrls {
                page: server.base.clone(),
                image: server.base.clone(),
            }),
        }
    }

    fn png() -> Vec<u8> {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    fn jpeg() -> Vec<u8> {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Jpeg).unwrap();
        output.into_inner()
    }

    fn html(image: &str) -> String {
        format!("<html><head><meta property=\"og:image\" content=\"{image}\"></head><body></body></html>")
    }

    #[test]
    fn urls_cannot_escape_artist_page_or_image_allowlist() {
        let (_, page) = artist_page(" AC/DC + 中国?# ").unwrap();
        assert_eq!(
            page.as_str(),
            "https://www.last.fm/music/AC%2FDC%20%2B%20%E4%B8%AD%E5%9B%BD%3F%23"
        );
        assert!(page.query().is_none());
        assert!(artist_page(&"中".repeat(200)).is_ok());
        assert!(artist_page(&"中".repeat(201)).is_err());
        for artist in ["", "..", "\n", "name\0"] {
            assert!(artist_page(artist).is_err());
        }
        assert!(image_url(IMAGE).is_ok());
        for accepted in [
            ERKE_IMAGE.to_owned(),
            ERKE_IMAGE.replace("lastfm-img.freetls.fastly.net", "lastfm.freetls.fastly.net"),
            ERKE_IMAGE.replace(".net/", ".net:443/"),
            IMAGE.replace("lastfm.freetls.fastly.net", "lastfm-img.freetls.fastly.net"),
        ] {
            assert!(image_url(&accepted).is_ok(), "{accepted}");
        }
        for bad in [
            IMAGE.replace("https:", "http:"),
            IMAGE.replace(".net/", ".net:444/"),
            IMAGE.replace("lastfm.freetls.fastly.net", "evil.test"),
            IMAGE.replace(
                "lastfm.freetls.fastly.net",
                "lastfm.freetls.fastly.net.evil.test",
            ),
            IMAGE.replace("https://", "https://user@"),
            IMAGE.replace("https://", "https://@"),
            IMAGE.replace(".net/", ".net\\"),
            format!("{IMAGE}?url=http://127.0.0.1"),
            format!("{IMAGE}#fragment"),
            IMAGE.replace("/i/u/", "/api/"),
            IMAGE.replace(".png", ".svg"),
            IMAGE.replace("300x300/", "%2F/"),
        ] {
            assert_eq!(
                image_url(&bad).unwrap_err().code,
                "invalid_image_url",
                "{bad}"
            );
        }
        assert_eq!(
            image_url(&IMAGE.replace("0123456789abcdef0123456789abcdef", PLACEHOLDER_HASH))
                .unwrap_err()
                .code,
            "placeholder_image"
        );
        for bad in [
            ERKE_IMAGE.replace("https:", "http:"),
            ERKE_IMAGE.replace(".net/", ".net:444/"),
            ERKE_IMAGE.replace(
                "lastfm-img.freetls.fastly.net",
                "lastfm-img.freetls.fastly.net.evil.test",
            ),
            ERKE_IMAGE.replace(
                "lastfm-img.freetls.fastly.net",
                "fake-lastfm-img.freetls.fastly.net",
            ),
            ERKE_IMAGE.replace("https://", "https://user@"),
            ERKE_IMAGE.replace("https://", "https://@"),
            format!("{ERKE_IMAGE}?redirect=https://evil.test"),
            format!("{ERKE_IMAGE}#fragment"),
            ERKE_IMAGE.replace("/i/u/ar0/", "/api/"),
            ERKE_IMAGE.replace(".jpg", ".svg"),
        ] {
            assert_eq!(
                image_url(&bad).unwrap_err().code,
                "invalid_image_url",
                "{bad}"
            );
        }
    }

    #[test]
    fn metadata_parsing_uses_only_real_head_og_image() {
        let page = format!("<html><head><!-- {} --><script>\"{}\"</script><META content='{IMAGE}' PROPERTY='og:image'></head><body><img src='https://evil.test/a.png'></body></html>", html("https://evil.test/a.png"), html("https://evil.test/b.png"));
        assert_eq!(main_image(&page).unwrap().as_str(), IMAGE);
        assert_eq!(
            main_image("<html><head></head><body><img src='a.png'></body></html>")
                .unwrap_err()
                .code,
            "parse_error"
        );
        assert!(main_image(&html("https://evil.test/a.png")).is_err());
        assert_eq!(
            main_image(&html(&IMAGE.replace("https:", "https&#58;")))
                .unwrap()
                .as_str(),
            IMAGE
        );
        assert_eq!(
            main_image(&html(&format!("{IMAGE}?a=1&amp;b=2")))
                .unwrap_err()
                .code,
            "upstream_image_unsupported"
        );
    }

    #[test]
    fn observed_artist_metadata_supports_new_cdn_and_preserves_placeholder_detection() {
        assert_eq!(main_image(ERKE_HEAD).unwrap().as_str(), ERKE_IMAGE);
        let placeholder = ERKE_IMAGE.replace("58a46edad6d325e9b4034258587509a9", PLACEHOLDER_HASH);
        assert_eq!(
            main_image(&html(&placeholder)).unwrap_err().code,
            "placeholder_image"
        );
        assert_eq!(
            image_url(&placeholder).unwrap_err().code,
            "placeholder_image"
        );
    }

    #[test]
    fn retry_after_handles_seconds_http_dates_and_bounds() {
        let now = DateTime::parse_from_rfc2822("Wed, 21 Oct 2015 07:27:00 GMT")
            .unwrap()
            .timestamp();
        assert_eq!(retry_after_seconds(Some("120"), now), 120);
        assert_eq!(
            retry_after_seconds(Some("Wed, 21 Oct 2015 07:28:00 GMT"), now),
            60
        );
        assert_eq!(
            retry_after_seconds(Some("Wednesday, 21-Oct-15 07:28:00 GMT"), now),
            60
        );
        assert_eq!(
            retry_after_seconds(Some("Wed Oct 21 07:28:00 2015"), now),
            60
        );
        assert_eq!(retry_after_seconds(Some("0"), now), 5);
        assert_eq!(
            retry_after_seconds(Some("999999999999999999999999999"), now),
            u64::MAX
        );
        assert_eq!(retry_after_seconds(Some("2592000"), now), 30 * 24 * 60 * 60);
        assert_eq!(retry_after_seconds(Some("invalid"), now), BLOCK_COOLDOWN);
    }

    #[test]
    fn image_validation_rejects_disguised_or_corrupt_content() {
        assert!(validate_image(png(), "image/png").is_ok());
        assert!(validate_image(png(), "image/jpeg").is_err());
        assert!(validate_image(b"<html>captcha</html>".to_vec(), "image/png").is_err());
        assert!(validate_image(b"\x89PNG\r\n\x1a\n".to_vec(), "image/png").is_err());
    }

    #[tokio::test]
    async fn successful_page_fetch_uses_identifiable_ua_without_cookies() {
        let directory = TestDirectory::new();
        let mut page = Reply::html(html(IMAGE));
        page.headers.push((
            "Set-Cookie",
            "probe=must-not-be-returned; Path=/".to_owned(),
        ));
        let server = MockServer::new(vec![page, Reply::png()]).await;
        let client = test_client(&directory, &server);
        let portrait = client.fetch_artist("Radiohead").await.unwrap();
        assert_eq!(portrait.artist, "Radiohead");
        assert_eq!(portrait.source_page, "https://www.last.fm/music/Radiohead");
        assert_eq!(portrait.source_image, IMAGE);
        assert_eq!(portrait.bytes, png());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /music/Radiohead HTTP/1.1"));
        assert!(requests[0].contains(USER_AGENT));
        assert!(!requests
            .iter()
            .any(|request| request.to_lowercase().contains("cookie:")));
    }

    #[tokio::test]
    async fn observed_new_cdn_image_fetches_in_two_bounded_requests() {
        let directory = TestDirectory::new();
        let server = MockServer::new(vec![Reply::html(ERKE_HEAD), Reply::jpeg()]).await;
        let client = test_client(&directory, &server);
        let portrait = client.fetch_artist("二珂").await.unwrap();
        assert_eq!(portrait.artist, "二珂");
        assert_eq!(
            portrait.source_page,
            "https://www.last.fm/music/%E4%BA%8C%E7%8F%82"
        );
        assert_eq!(portrait.source_image, ERKE_IMAGE);
        assert_eq!(portrait.bytes, jpeg());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /music/%E4%BA%8C%E7%8F%82 HTTP/1.1"));
        assert!(
            requests[1].starts_with("GET /i/u/ar0/58a46edad6d325e9b4034258587509a9.jpg HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn unsupported_upstream_image_is_distinct_from_invalid_manual_input() {
        let invalid = ERKE_IMAGE.replace(
            "lastfm-img.freetls.fastly.net",
            "lastfm-img.freetls.fastly.net.evil.test",
        );
        let directory = TestDirectory::new();
        let server = MockServer::new(vec![Reply::html(html(&invalid))]).await;
        let client = test_client(&directory, &server);
        let manual = client.fetch_image("二珂", &invalid).await.unwrap_err();
        assert_eq!(manual.code, "invalid_image_url");
        assert_eq!(server.count(), 0);
        let automatic = client.fetch_artist("二珂").await.unwrap_err();
        assert_eq!(automatic.code, "upstream_image_unsupported");
        assert!(automatic.message.starts_with("Last.fm 主页返回的头像地址"));
        assert_eq!(
            server.count(),
            1,
            "unsupported URLs must not trigger an image request"
        );
    }

    #[tokio::test]
    async fn manual_url_fetches_only_once_and_redirects_are_not_followed() {
        let directory = TestDirectory::new();
        let mut redirect = Reply::status(302);
        redirect
            .headers
            .push(("Location", "http://127.0.0.1/private".to_owned()));
        let server = MockServer::new(vec![Reply::png(), redirect, Reply::png()]).await;
        let client = test_client(&directory, &server);
        client.fetch_image("Radiohead", IMAGE).await.unwrap();
        assert_eq!(server.count(), 1);
        let error = client.fetch_artist("Radiohead").await.unwrap_err();
        assert_eq!(error.code, "redirect_blocked");
        assert_eq!(server.count(), 2);
    }

    #[tokio::test]
    async fn forbidden_and_challenge_persist_cooldown_and_no_image_is_not_challenge() {
        for reply in [Reply::status(403), Reply::html("<html><head><title>Just a moment...</title></head><body>verify you are human</body></html>")] {
            let directory = TestDirectory::new();
            let server = MockServer::new(vec![reply]).await;
            let client = test_client(&directory, &server);
            let error = client.fetch_artist("Radiohead").await.unwrap_err();
            assert!(matches!(error.code.as_str(), "forbidden" | "challenge"));
            assert!(client.status().cooldown);
            let restarted = test_client(&directory, &server);
            assert!(restarted.status().retry_after_seconds.unwrap() > 3500);
            assert_eq!(restarted.fetch_image("Radiohead", IMAGE).await.unwrap_err().code, "cooldown");
            assert_eq!(server.count(), 1);
        }
        let directory = TestDirectory::new();
        let server = MockServer::new(vec![Reply::html(
            "<html><head><title>Radiohead</title></head></html>",
        )])
        .await;
        let client = test_client(&directory, &server);
        assert_eq!(
            client.fetch_artist("Radiohead").await.unwrap_err().code,
            "parse_error"
        );
        assert!(!client.status().cooldown);
    }

    #[tokio::test]
    async fn rate_limit_date_and_three_failures_stop_further_requests() {
        let directory = TestDirectory::new();
        let mut reply = Reply::status(429);
        let retry_at = Utc::now().timestamp() + 120;
        reply.headers.push((
            "Retry-After",
            DateTime::<Utc>::from_timestamp(retry_at, 0)
                .unwrap()
                .to_rfc2822(),
        ));
        let server = MockServer::new(vec![reply]).await;
        let client = test_client(&directory, &server);
        let error = client.fetch_artist("Radiohead").await.unwrap_err();
        assert_eq!(error.code, "rate_limited");
        let saved = load_gate(&directory.0.join("lastfm-portraits/gate.json")).unwrap();
        assert!(saved.cooldown_until_ms >= retry_at * 1000);
        assert!(error.retry_after_seconds.is_some());
        assert_eq!(
            client.fetch_artist("Radiohead").await.unwrap_err().code,
            "cooldown"
        );
        assert_eq!(server.count(), 1);

        let directory = TestDirectory::new();
        let server = MockServer::new(vec![
            Reply::status(503),
            Reply::status(503),
            Reply::status(503),
        ])
        .await;
        let client = test_client(&directory, &server);
        for _ in 0..3 {
            assert_eq!(
                client.fetch_artist("Radiohead").await.unwrap_err().code,
                "upstream_unavailable"
            );
        }
        assert!(client.status().cooldown);
        assert_eq!(
            client.fetch_artist("Radiohead").await.unwrap_err().code,
            "cooldown"
        );
        assert_eq!(server.count(), 3);
    }

    #[tokio::test]
    async fn busy_requests_are_rejected_and_streaming_bodies_are_capped() {
        let directory = TestDirectory::new();
        let mut reply = Reply::html("x".repeat(MAX_HTML_BYTES + 1));
        reply.chunked = true;
        let server = MockServer::new(vec![reply]).await;
        let client = test_client(&directory, &server);
        let held = client.gate.acquire().unwrap();
        assert_eq!(
            client.fetch_artist("Radiohead").await.unwrap_err().code,
            "busy"
        );
        assert_eq!(server.count(), 0);
        drop(held);
        assert_eq!(
            client.fetch_artist("Radiohead").await.unwrap_err().code,
            "response_too_large"
        );
        assert_eq!(server.count(), 1);
    }

    #[test]
    fn gate_pacing_uses_wall_and_monotonic_time_without_shortening_waits() {
        assert_eq!(pacing_delay(6000, 1000, None, MIN_INTERVAL), MIN_INTERVAL);
        assert_eq!(
            pacing_delay(6000, 9000, Some(Duration::from_secs(1)), MIN_INTERVAL),
            Duration::from_secs(4)
        );
        assert_eq!(
            pacing_delay(6000, 500, Some(Duration::from_secs(7)), MIN_INTERVAL),
            Duration::from_millis(5500)
        );
        assert_eq!(
            pacing_delay(6000, 7000, Some(Duration::from_secs(6)), MIN_INTERVAL),
            Duration::ZERO
        );
    }

    #[test]
    fn gate_state_survives_atomic_replacement_and_reload() {
        let directory = TestDirectory::new();
        let gate = RequestGate::default();
        gate.register(&directory.0).unwrap();
        {
            let mut inner = gate.inner.lock().unwrap();
            inner.saved.next_request_at_ms = 123456789;
            save_gate(&inner).unwrap();
        }
        gate.transient_failure().unwrap();
        let restarted = RequestGate::default();
        restarted.register(&directory.0).unwrap();
        let inner = restarted.inner.lock().unwrap();
        assert_eq!(inner.saved.next_request_at_ms, 123456789);
        assert_eq!(inner.saved.consecutive_failures, 1);
    }

    #[tokio::test]
    async fn streamed_image_size_limit_and_timeout_do_not_retry() {
        let directory = TestDirectory::new();
        let mut oversized = Reply::png();
        oversized.bytes = vec![0u8; MAX_IMAGE_BYTES + 1];
        oversized.chunked = true;
        let server = MockServer::new(vec![oversized]).await;
        let client = test_client(&directory, &server);
        assert_eq!(
            client
                .fetch_image("Radiohead", IMAGE)
                .await
                .unwrap_err()
                .code,
            "response_too_large"
        );
        assert_eq!(server.count(), 1);

        let directory = TestDirectory::new();
        let mut delayed = Reply::png();
        delayed.delay = Some(Duration::from_secs(2));
        let server = MockServer::new(vec![delayed]).await;
        let mut client = test_client(&directory, &server);
        client.client = LastfmPortraitClient::http_client(Duration::from_millis(100)).unwrap();
        assert_eq!(
            client
                .fetch_image("Radiohead", IMAGE)
                .await
                .unwrap_err()
                .code,
            "timeout"
        );
        assert_eq!(server.count(), 1);
        assert_eq!(
            client.gate.inner.lock().unwrap().saved.consecutive_failures,
            1
        );
    }

    #[test]
    fn corrupt_gate_state_fails_closed() {
        let directory = TestDirectory::new();
        let gate = RequestGate::default();
        gate.register(&directory.0).unwrap();
        fs::write(directory.0.join("lastfm-portraits/gate.json"), b"{broken}").unwrap();
        assert_eq!(
            RequestGate::default()
                .register(&directory.0)
                .unwrap_err()
                .code,
            "persistence_error"
        );
    }
}
