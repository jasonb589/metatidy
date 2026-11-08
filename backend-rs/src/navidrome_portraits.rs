//! Navidrome's native artist image API (available since 0.61.0).
//!
//! The native API uses X-ND-Authorization, not Subsonic credentials. Subsonic
//! credentials returned by login are used only for server-side artwork reads.
//! No request is retried, and redirects are never followed with credentials.
//!
//! Contract: https://github.com/navidrome/navidrome/blob/v0.64.2/server/nativeapi/artists.go
//! Upload: https://github.com/navidrome/navidrome/blob/v0.64.2/server/nativeapi/image_upload.go

use std::io::Cursor;
use std::time::{Duration, Instant};

use image::{ImageFormat, ImageReader, Limits};
use reqwest::header::{HeaderValue, ACCEPT};
use reqwest::{multipart, RequestBuilder, Response, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::Mutex;

const AUTH_HEADER: &str = "x-nd-authorization";
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 4096;

// Deliberately not Debug/Serialize: configuration contains the server password.
#[derive(Clone)]
pub struct Settings {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Artist {
    pub id: String,
    pub name: String,
    #[serde(default, alias = "albumCount")]
    pub album_count: u64,
    #[serde(default, alias = "songCount")]
    pub song_count: u64,
    #[serde(default, alias = "mbzArtistId")]
    pub mbid: Option<String>,
    #[serde(default, alias = "uploadedImage")]
    pub uploaded_image: Option<String>,
    #[serde(default, alias = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(default, alias = "imageHash")]
    pub image_hash: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ArtistPage {
    pub items: Vec<Artist>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub is_admin: bool,
    pub server_version: Option<String>,
    /// Version support only; upload permission also depends on server settings.
    pub supports_upload: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct UploadResult {
    pub uploaded: bool,
    pub message: String,
}

pub struct Image {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Only fixed messages and HTTP status codes escape this module. In particular,
/// reqwest errors and upstream response bodies may contain credential URLs.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Navidrome 配置无效：{0}")]
    Configuration(&'static str),
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("Navidrome 身份验证失败，请检查配置的账号和密码")]
    Unauthorized,
    #[error("Navidrome 拒绝操作，请检查账号权限和 EnableArtworkUpload 配置")]
    Forbidden,
    #[error("Navidrome 未找到目标歌手或接口，请检查歌手 ID 和服务版本")]
    NotFound,
    #[error("Navidrome 请求过于频繁，请稍后再试")]
    RateLimited,
    #[error("Navidrome 返回 HTTP {status}")]
    Http { status: u16, uncertain: bool },
    #[error("Navidrome 请求未完成，请检查连接；上传中断时请先在 Navidrome 确认结果")]
    Network { timeout: bool, uncertain: bool },
    #[error("{message}")]
    Protocol {
        message: &'static str,
        uncertain: bool,
    },
    #[error("{0}")]
    InvalidImage(&'static str),
}

impl Error {
    pub fn outcome_uncertain(&self) -> bool {
        matches!(
            self,
            Self::Http {
                uncertain: true,
                ..
            } | Self::Network {
                uncertain: true,
                ..
            } | Self::Protocol {
                uncertain: true,
                ..
            }
        )
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound)
    }

    pub fn is_bad_request(&self) -> bool {
        matches!(
            self,
            Self::Configuration(_) | Self::InvalidInput(_) | Self::InvalidImage(_)
        )
    }

    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Self::RateLimited)
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Network { timeout: true, .. })
    }
}

#[derive(Clone)]
struct Session {
    token: String,
    username: String,
    is_admin: bool,
    subsonic_token: Option<String>,
    subsonic_salt: Option<String>,
    expires_at: Instant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    is_admin: bool,
    #[serde(default)]
    subsonic_token: Option<String>,
    #[serde(default)]
    subsonic_salt: Option<String>,
}

pub struct Client {
    base: Url,
    username: String,
    password: String,
    http: reqwest::Client,
    session: Mutex<Option<Session>>,
}

impl Client {
    pub fn new(settings: Settings) -> Result<Self, Error> {
        Self::with_timeout(settings, Duration::from_secs(20))
    }

    fn with_timeout(settings: Settings, timeout: Duration) -> Result<Self, Error> {
        let base = validate_base_url(&settings.url)?;
        if settings.username.trim().is_empty() || settings.password.is_empty() {
            return Err(Error::Configuration("请配置用户名和密码"));
        }
        if settings.username.len() > 512 || settings.password.len() > 4096 {
            return Err(Error::Configuration("用户名或密码过长"));
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .user_agent(concat!(
                "MetaTidy/",
                env!("CARGO_PKG_VERSION"),
                " (Navidrome artist portraits)"
            ))
            .build()
            .map_err(|_| Error::Configuration("无法初始化 HTTP 客户端"))?;
        Ok(Self {
            base,
            username: settings.username,
            password: settings.password,
            http,
            session: Mutex::new(None),
        })
    }

    /// Tests native read access. A failed optional Subsonic version probe leaves
    /// capability unknown; it does not invent a version or try a write probe.
    pub async fn status(&self) -> Result<ConnectionStatus, Error> {
        let session = self.login().await?;
        let response = self
            .native_request(
                self.http
                    .get(self.endpoint(&["api", "artist"]))
                    .query(&[("_start", "0"), ("_end", "1")]),
                &session,
                false,
            )
            .await?;
        let _: Vec<Artist> = read_json(response, false).await?;
        let server_version = self.server_version(&session).await;
        let supports_upload = server_version.as_deref().and_then(version_supports_upload);
        Ok(ConnectionStatus {
            connected: true,
            is_admin: session.is_admin,
            server_version,
            supports_upload,
        })
    }

    /// `name` is Navidrome's full-text candidate filter, not an exact match.
    /// The caller must let the user choose an artist ID before uploading.
    pub async fn list_artists(
        &self,
        q: &str,
        page: u32,
        page_size: u32,
    ) -> Result<ArtistPage, Error> {
        if q.chars().count() > 200 {
            return Err(Error::InvalidInput("歌手搜索词不能超过 200 个字符"));
        }
        if page == 0 || !(1..=100).contains(&page_size) {
            return Err(Error::InvalidInput(
                "页码从 1 开始，每页数量必须在 1 到 100 之间",
            ));
        }
        let start = (page - 1)
            .checked_mul(page_size)
            .filter(|value| *value <= i32::MAX as u32 - page_size)
            .ok_or(Error::InvalidInput("歌手列表页码过大"))?;
        let mut url = self.endpoint(&["api", "artist"]);
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("_start", &start.to_string())
                .append_pair("_end", &(start + page_size).to_string())
                .append_pair("_sort", "name")
                .append_pair("_order", "ASC");
            if !q.trim().is_empty() {
                query.append_pair("name", q.trim());
            }
        }
        let session = self.login().await?;
        let response = self
            .native_request(self.http.get(url), &session, false)
            .await?;
        let total = response
            .headers()
            .get("x-total-count")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(protocol("Navidrome 歌手列表缺少有效分页总数", false))?;
        let items: Vec<Artist> = read_json(response, false).await?;
        if items.len() > page_size as usize {
            return Err(protocol("Navidrome 未按请求返回分页歌手列表", false));
        }
        Ok(ArtistPage {
            items,
            total,
            page,
            page_size,
        })
    }

    pub async fn get_artist(&self, id: &str) -> Result<Artist, Error> {
        validate_artist_id(id)?;
        let session = self.login().await?;
        let response = self
            .native_request(
                self.http.get(self.endpoint(&["api", "artist", id])),
                &session,
                false,
            )
            .await?;
        let artist: Artist = read_json(response, false).await?;
        if artist.id != id {
            return Err(protocol("Navidrome 返回的歌手 ID 与所选目标不一致", false));
        }
        Ok(artist)
    }

    /// Uploads exactly once. A transport error or 5xx may occur after storage;
    /// callers must consume confirmation before calling and must not retry it.
    pub async fn upload_image(&self, id: &str, bytes: Vec<u8>) -> Result<UploadResult, Error> {
        validate_artist_id(id)?;
        validate_image(&bytes, true)?;
        let image = multipart::Part::bytes(bytes)
            .file_name("portrait.jpg")
            .mime_str("image/jpeg")
            .map_err(|_| Error::InvalidImage("无法构建 JPEG 上传内容"))?;
        let session = self.login().await?;
        let response = self
            .native_request(
                self.http
                    .post(self.endpoint(&["api", "artist", id, "image"]))
                    .multipart(multipart::Form::new().part("image", image)),
                &session,
                true,
            )
            .await?;
        if response.status() != StatusCode::OK {
            return Err(protocol(
                "Navidrome 未返回预期的上传确认，请先检查目标头像",
                true,
            ));
        }
        let body: serde_json::Value = read_json(response, true).await?;
        if body.get("status").and_then(|value| value.as_str()) != Some("ok") {
            return Err(protocol(
                "Navidrome 未返回预期的上传确认，请先检查目标头像",
                true,
            ));
        }
        Ok(UploadResult {
            uploaded: true,
            message: "头像已上传至 Navidrome，显示更新可能需要片刻".to_string(),
        })
    }

    /// Returns image bytes, never a URL containing Subsonic credentials.
    pub async fn get_current_image(&self, id: &str) -> Result<Image, Error> {
        let artist = self.get_artist(id).await?;
        let session = self.login().await?;
        let mut url = self.subsonic_url("getCoverArt", &session)?;
        let artwork_id = match artist.image_hash.as_deref() {
            Some(hash) if hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
                format!("ar-{id}_{hash}")
            }
            _ => format!("ar-{id}"),
        };
        url.query_pairs_mut()
            .append_pair("id", &artwork_id)
            .append_pair("size", "300");
        if let Some(updated_at) = artist.updated_at.as_deref() {
            url.query_pairs_mut().append_pair("_", updated_at);
        }
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| transport_error(error, false))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_session(&session).await;
        }
        check_status(response.status(), false)?;
        let bytes = read_bounded(response, MAX_IMAGE_BYTES, false).await?;
        if let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let response = &body["subsonic-response"];
            if response["status"] == "failed" {
                return match response["error"]["code"].as_u64() {
                    Some(40 | 41 | 44) => {
                        self.clear_session(&session).await;
                        Err(Error::Unauthorized)
                    }
                    Some(50) => Err(Error::Forbidden),
                    Some(70) => Err(Error::NotFound),
                    _ => Err(protocol("Navidrome 未能读取当前头像", false)),
                };
            }
        }
        let content_type = validate_image(&bytes, false)?.to_string();
        Ok(Image {
            bytes,
            content_type,
        })
    }

    fn endpoint(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        // HTTP(S) URL validation guarantees hierarchical path segments.
        url.path_segments_mut()
            .expect("validated HTTP URL")
            .pop_if_empty()
            .extend(segments.iter().copied());
        url
    }

    async fn login(&self) -> Result<Session, Error> {
        // Holding this lock also prevents concurrent requests from creating a
        // login storm when a cached session expires.
        let mut cached = self.session.lock().await;
        if let Some(session) = cached.as_ref() {
            if session.expires_at > Instant::now() {
                return Ok(session.clone());
            }
        }
        *cached = None;
        let response = self
            .http
            .post(self.endpoint(&["auth", "login"]))
            .json(&serde_json::json!({
                "username": &self.username,
                "password": &self.password,
            }))
            .send()
            .await
            .map_err(|error| transport_error(error, false))?;
        check_status(response.status(), false)?;
        let login: LoginResponse = read_json(response, false).await?;
        if login.token.is_empty() || login.token.len() > 16 * 1024 {
            return Err(protocol("Navidrome 登录响应没有有效会话", false));
        }
        auth_value(&login.token)?;
        let session = Session {
            token: login.token,
            username: login
                .username
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| self.username.clone()),
            is_admin: login.is_admin,
            subsonic_token: login.subsonic_token,
            subsonic_salt: login.subsonic_salt,
            expires_at: Instant::now() + SESSION_TTL,
        };
        *cached = Some(session.clone());
        Ok(session)
    }

    async fn native_request(
        &self,
        request: RequestBuilder,
        session: &Session,
        upload: bool,
    ) -> Result<Response, Error> {
        let response = request
            .header(ACCEPT, "application/json")
            .header(AUTH_HEADER, auth_value(&session.token)?)
            .send()
            .await
            .map_err(|error| transport_error(error, upload))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_session(session).await;
            return Err(Error::Unauthorized);
        }
        if let Some(token) = response
            .headers()
            .get(AUTH_HEADER)
            .and_then(|header| header.to_str().ok())
            .filter(|token| !token.is_empty() && token.len() <= 16 * 1024)
        {
            if auth_value(token).is_ok() {
                let mut cached = self.session.lock().await;
                if let Some(current) = cached.as_mut() {
                    if current.token == session.token {
                        current.token = token.to_owned();
                        current.expires_at = Instant::now() + SESSION_TTL;
                    }
                }
            }
        }
        check_status(response.status(), upload)?;
        Ok(response)
    }

    async fn clear_session(&self, rejected: &Session) {
        let mut cached = self.session.lock().await;
        if cached.as_ref().map(|value| &value.token) == Some(&rejected.token) {
            *cached = None;
        }
    }

    fn subsonic_url(&self, command: &str, session: &Session) -> Result<Url, Error> {
        let token = session
            .subsonic_token
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(protocol("Navidrome 登录响应缺少头像读取凭据", false))?;
        let salt = session
            .subsonic_salt
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(protocol("Navidrome 登录响应缺少头像读取凭据", false))?;
        let mut url = self.endpoint(&["rest", command]);
        url.query_pairs_mut()
            .append_pair("u", &session.username)
            .append_pair("t", token)
            .append_pair("s", salt)
            .append_pair("v", "1.16.1")
            .append_pair("c", "MetaTidy")
            .append_pair("f", "json");
        Ok(url)
    }

    async fn server_version(&self, session: &Session) -> Option<String> {
        let url = self.subsonic_url("ping", session).ok()?;
        let response = self.http.get(url).send().await.ok()?;
        check_status(response.status(), false).ok()?;
        let body: serde_json::Value = read_json(response, false).await.ok()?;
        let subsonic = body.get("subsonic-response")?;
        if subsonic.get("status")?.as_str()? != "ok"
            || !subsonic
                .get("type")?
                .as_str()?
                .eq_ignore_ascii_case("navidrome")
        {
            return None;
        }
        let version = subsonic.get("serverVersion")?.as_str()?;
        if version.is_empty() || version.len() > 100 {
            return None;
        }
        Some(version.to_owned())
    }
}

fn validate_base_url(raw: &str) -> Result<Url, Error> {
    let url = Url::parse(raw.trim())
        .map_err(|_| Error::Configuration("服务地址必须是完整的 HTTP 或 HTTPS URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Configuration(
            "服务地址必须是完整的 HTTP 或 HTTPS URL",
        ));
    }
    let has_userinfo = raw
        .trim()
        .split_once("://")
        .map(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .contains('@')
        })
        .unwrap_or(false);
    if has_userinfo || !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Configuration(
            "请将用户名和密码放入独立配置，不能嵌入服务地址",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Error::Configuration("服务地址不能包含查询参数或片段"));
    }
    Ok(url)
}

fn validate_artist_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(Error::InvalidInput("无效的 Navidrome 歌手 ID"));
    }
    Ok(())
}

fn version_supports_upload(version: &str) -> Option<bool> {
    let number = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let number = number.split_whitespace().next()?;
    let mut parts = number.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch) >= (0, 61, 0))
}

fn auth_value(token: &str) -> Result<HeaderValue, Error> {
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| protocol("Navidrome 返回了无效的会话凭据", false))?;
    value.set_sensitive(true);
    Ok(value)
}

fn protocol(message: &'static str, uncertain: bool) -> Error {
    Error::Protocol { message, uncertain }
}

fn transport_error(error: reqwest::Error, uncertain: bool) -> Error {
    Error::Network {
        timeout: error.is_timeout(),
        uncertain,
    }
}

fn check_status(status: StatusCode, upload: bool) -> Result<(), Error> {
    match status {
        StatusCode::UNAUTHORIZED => Err(Error::Unauthorized),
        StatusCode::FORBIDDEN => Err(Error::Forbidden),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => Err(Error::NotFound),
        StatusCode::TOO_MANY_REQUESTS => Err(Error::RateLimited),
        _ if status.is_redirection() => Err(protocol(
            "Navidrome 返回重定向，请将服务地址配置为最终访问地址",
            upload,
        )),
        _ if !status.is_success() => Err(Error::Http {
            status: status.as_u16(),
            uncertain: upload && status.is_server_error(),
        }),
        _ => Ok(()),
    }
}

async fn read_json<T: DeserializeOwned>(response: Response, uncertain: bool) -> Result<T, Error> {
    let bytes = read_bounded(response, MAX_JSON_BYTES, uncertain).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| protocol("Navidrome 返回了无法识别的响应", uncertain))
}

async fn read_bounded(
    mut response: Response,
    limit: usize,
    uncertain: bool,
) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(protocol("Navidrome 响应超过允许大小", uncertain));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(error, uncertain))?
    {
        if chunk.len() > limit - bytes.len() {
            return Err(protocol("Navidrome 响应超过允许大小", uncertain));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_image(bytes: &[u8], jpeg_only: bool) -> Result<&'static str, Error> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::InvalidImage("头像文件不能为空且不能超过 8 MiB"));
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Error::InvalidImage("无法识别头像图片格式"))?;
    let format = reader
        .format()
        .ok_or(Error::InvalidImage("无法识别头像图片格式"))?;
    let content_type = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png if !jpeg_only => "image/png",
        ImageFormat::WebP if !jpeg_only => "image/webp",
        ImageFormat::Gif if !jpeg_only => "image/gif",
        _ => return Err(Error::InvalidImage("头像必须是有效的 JPEG 图片")),
    };
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| Error::InvalidImage("头像文件不是有效图片"))?;
    if width == 0 || height == 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(Error::InvalidImage("头像尺寸必须在 1 到 4096 像素之间"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| Error::InvalidImage("头像图片无法安全解码"))?;
    Ok(content_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    use axum::body::Bytes;
    use axum::extract::{Path, Query, State};
    use axum::http::HeaderMap;
    use axum::response::{IntoResponse, Response as AxumResponse};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    #[derive(Default)]
    struct MockState {
        logins: AtomicUsize,
        native_reads: AtomicUsize,
        uploads: AtomicUsize,
        redirect_hits: AtomicUsize,
        list_status: AtomicU16,
        upload_status: AtomicU16,
        upload_delay_ms: AtomicUsize,
        login_redirect: AtomicBool,
        malformed_upload: AtomicBool,
        version: StdMutex<Option<String>>,
        queries: StdMutex<Vec<HashMap<String, String>>>,
        auth_headers: StdMutex<Vec<String>>,
        upload_body: StdMutex<Option<String>>,
    }

    struct Mock {
        base: String,
        state: Arc<MockState>,
        task: JoinHandle<()>,
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Mock {
        async fn start() -> Self {
            let state = Arc::new(MockState::default());
            *state.version.lock().unwrap() = Some("0.64.2".to_string());
            let router = Router::new()
                .route("/music/auth/login", post(mock_login))
                .route("/music/api/artist", get(mock_list))
                .route("/music/api/artist/:id", get(mock_artist))
                .route("/music/api/artist/:id/image", post(mock_upload))
                .route("/music/rest/ping", get(mock_ping))
                .route("/music/rest/getCoverArt", get(mock_image))
                .route(
                    "/music/redirect-hit",
                    get(mock_redirect_hit).post(mock_redirect_hit),
                )
                .with_state(state.clone());
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                base: format!("http://{address}/music/"),
                state,
                task,
            }
        }

        fn settings(&self) -> Settings {
            Settings {
                url: self.base.clone(),
                username: "portrait-user".to_string(),
                password: "fake-private-password".to_string(),
            }
        }

        fn client(&self) -> Client {
            Client::new(self.settings()).unwrap()
        }
    }

    fn portrait(format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, format)
            .unwrap();
        bytes.into_inner()
    }

    fn artist_json(id: &str, uploaded: bool) -> Value {
        json!({
            "id": id,
            "name": "Same Name",
            "albumCount": 3,
            "songCount": 12,
            "mbzArtistId": "12345678-1234-1234-1234-123456789012",
            "updatedAt": if uploaded { "2026-11-08T12:01:00Z" } else { "2026-11-08T12:00:00Z" },
            "uploadedImage": if uploaded { "artist-1_Same Name.jpeg" } else { "" },
            "imageHash": "0123456789abcdef"
        })
    }

    fn record_auth(state: &MockState, headers: &HeaderMap) {
        let auth = headers.get(AUTH_HEADER).unwrap().to_str().unwrap();
        assert!(matches!(auth, "Bearer jwt-initial" | "Bearer jwt-renewed"));
        assert!(headers.get("authorization").is_none());
        state.auth_headers.lock().unwrap().push(auth.to_string());
    }

    async fn mock_login(
        State(state): State<Arc<MockState>>,
        Json(body): Json<Value>,
    ) -> AxumResponse {
        state.logins.fetch_add(1, Ordering::SeqCst);
        assert_eq!(body["username"], "portrait-user");
        assert_eq!(body["password"], "fake-private-password");
        if state.login_redirect.load(Ordering::SeqCst) {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", "/music/redirect-hit")],
            )
                .into_response();
        }
        Json(json!({
            "token": "jwt-initial",
            "username": "portrait-user",
            "isAdmin": false,
            "subsonicToken": "fake-subsonic-token",
            "subsonicSalt": "fake-salt"
        }))
        .into_response()
    }

    async fn mock_list(
        State(state): State<Arc<MockState>>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> AxumResponse {
        record_auth(&state, &headers);
        state.native_reads.fetch_add(1, Ordering::SeqCst);
        state.queries.lock().unwrap().push(query);
        let status = state.list_status.load(Ordering::SeqCst);
        if status != 0 {
            return (
                StatusCode::from_u16(status).unwrap(),
                "private upstream body",
            )
                .into_response();
        }
        (
            [("x-total-count", "17"), (AUTH_HEADER, "jwt-renewed")],
            Json(vec![artist_json("artist-1", false)]),
        )
            .into_response()
    }

    async fn mock_artist(
        State(state): State<Arc<MockState>>,
        Path(id): Path<String>,
        headers: HeaderMap,
    ) -> AxumResponse {
        record_auth(&state, &headers);
        Json(artist_json(&id, state.uploads.load(Ordering::SeqCst) > 0)).into_response()
    }

    async fn mock_upload(
        State(state): State<Arc<MockState>>,
        Path(id): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> AxumResponse {
        record_auth(&state, &headers);
        assert_eq!(id, "artist-1");
        assert!(headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        state.uploads.fetch_add(1, Ordering::SeqCst);
        *state.upload_body.lock().unwrap() = Some(String::from_utf8_lossy(&body).into_owned());
        let delay = state.upload_delay_ms.load(Ordering::SeqCst);
        if delay != 0 {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
        }
        let status = state.upload_status.load(Ordering::SeqCst);
        if status == 307 {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", "/music/redirect-hit")],
            )
                .into_response();
        }
        if status != 0 {
            return (
                StatusCode::from_u16(status).unwrap(),
                "fake-private-password jwt-initial https://example.invalid/?t=fake-subsonic-token",
            )
                .into_response();
        }
        if state.malformed_upload.load(Ordering::SeqCst) {
            return (StatusCode::OK, "<html>proxy page</html>").into_response();
        }
        // Navidrome returns JSON text without explicitly setting Content-Type.
        (StatusCode::OK, "{\"status\":\"ok\"}").into_response()
    }

    fn check_subsonic(query: &HashMap<String, String>) {
        assert_eq!(query.get("u").unwrap(), "portrait-user");
        assert_eq!(query.get("t").unwrap(), "fake-subsonic-token");
        assert_eq!(query.get("s").unwrap(), "fake-salt");
        assert_eq!(query.get("c").unwrap(), "MetaTidy");
    }

    async fn mock_ping(
        State(state): State<Arc<MockState>>,
        Query(query): Query<HashMap<String, String>>,
    ) -> AxumResponse {
        check_subsonic(&query);
        Json(json!({"subsonic-response": {
            "status": "ok", "type": "navidrome", "serverVersion": *state.version.lock().unwrap()
        }}))
        .into_response()
    }

    async fn mock_image(Query(query): Query<HashMap<String, String>>) -> AxumResponse {
        check_subsonic(&query);
        assert_eq!(query.get("id").unwrap(), "ar-artist-1_0123456789abcdef");
        assert_eq!(query.get("size").unwrap(), "300");
        // MIME is detected from bytes; an upstream's header is not trusted.
        (
            [("content-type", "application/octet-stream")],
            portrait(ImageFormat::Png),
        )
            .into_response()
    }

    async fn mock_redirect_hit(State(state): State<Arc<MockState>>) -> &'static str {
        state.redirect_hits.fetch_add(1, Ordering::SeqCst);
        "must not be reached"
    }

    #[tokio::test]
    async fn navidrome_workflow_uses_native_auth_pagination_and_single_multipart_upload() {
        let mock = Mock::start().await;
        let client = mock.client();
        let status = client.status().await.unwrap();
        assert!(status.connected);
        assert!(!status.is_admin);
        assert_eq!(status.server_version.as_deref(), Some("0.64.2"));
        assert_eq!(status.supports_upload, Some(true));

        let page = client
            .list_artists(" 周杰伦 & friends ", 2, 2)
            .await
            .unwrap();
        assert_eq!(page.total, 17);
        assert_eq!(page.page, 2);
        assert_eq!(page.items[0].album_count, 3);
        assert_eq!(page.items[0].song_count, 12);
        let query = mock.state.queries.lock().unwrap().last().unwrap().clone();
        assert_eq!(query["name"], "周杰伦 & friends");
        assert_eq!(query["_start"], "2");
        assert_eq!(query["_end"], "4");
        assert_eq!(query["_sort"], "name");

        let result = client
            .upload_image("artist-1", portrait(ImageFormat::Jpeg))
            .await
            .unwrap();
        assert!(result.uploaded);
        let artist = client.get_artist("artist-1").await.unwrap();
        assert_eq!(
            artist.uploaded_image.as_deref(),
            Some("artist-1_Same Name.jpeg")
        );
        let image = client.get_current_image("artist-1").await.unwrap();
        assert_eq!(image.content_type, "image/png");
        assert!(!image.bytes.is_empty());
        let body = mock.state.upload_body.lock().unwrap().clone().unwrap();
        assert!(body.contains("name=\"image\"; filename=\"portrait.jpg\""));
        assert!(
            body.contains("Content-Type: image/jpeg") || body.contains("content-type: image/jpeg")
        );
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 1);
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 1);
        assert!(mock
            .state
            .auth_headers
            .lock()
            .unwrap()
            .iter()
            .skip(1)
            .all(|value| value == "Bearer jwt-renewed"));
        let public = serde_json::to_string(&(status, page, artist)).unwrap();
        assert!(!public.contains("jwt-"));
        assert!(!public.contains("fake-private-password"));
        assert!(!public.contains("fake-subsonic-token"));
        assert!(public.contains("album_count"));
        assert!(!public.contains("albumCount"));
    }

    #[tokio::test]
    async fn navidrome_401_clears_cache_without_automatic_login_or_upload_retry() {
        let mock = Mock::start().await;
        let client = mock.client();
        mock.state.list_status.store(401, Ordering::SeqCst);
        let error = client.list_artists("", 1, 10).await.unwrap_err();
        assert!(error.is_unauthorized());
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 1);
        assert_eq!(mock.state.native_reads.load(Ordering::SeqCst), 1);
        mock.state.list_status.store(0, Ordering::SeqCst);
        client.list_artists("", 1, 10).await.unwrap();
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 2);
        mock.state.upload_status.store(401, Ordering::SeqCst);
        let error = client
            .upload_image("artist-1", portrait(ImageFormat::Jpeg))
            .await
            .unwrap_err();
        assert!(error.is_unauthorized());
        assert!(!error.outcome_uncertain());
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 1);
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn navidrome_upload_errors_never_echo_secrets_or_retry() {
        let mock = Mock::start().await;
        let client = mock.client();
        for (status, uncertain) in [(403, false), (500, true), (307, true)] {
            mock.state.upload_status.store(status, Ordering::SeqCst);
            let error = client
                .upload_image("artist-1", portrait(ImageFormat::Jpeg))
                .await
                .unwrap_err();
            assert_eq!(error.outcome_uncertain(), uncertain);
            assert!(!error.to_string().contains("fake-private"));
            assert!(!error.to_string().contains("jwt-"));
            assert!(!error.to_string().contains("https://"));
        }
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 3);
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 1);
        assert_eq!(mock.state.redirect_hits.load(Ordering::SeqCst), 0);
        mock.state.upload_status.store(0, Ordering::SeqCst);
        mock.state.malformed_upload.store(true, Ordering::SeqCst);
        let error = client
            .upload_image("artist-1", portrait(ImageFormat::Jpeg))
            .await
            .unwrap_err();
        assert!(error.outcome_uncertain());
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn navidrome_upload_timeout_is_uncertain_and_not_retried() {
        let mock = Mock::start().await;
        let client = Client::with_timeout(mock.settings(), Duration::from_millis(200)).unwrap();
        mock.state.upload_delay_ms.store(1000, Ordering::SeqCst);
        let error = client
            .upload_image("artist-1", portrait(ImageFormat::Jpeg))
            .await
            .unwrap_err();
        assert!(error.is_timeout());
        assert!(error.outcome_uncertain());
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 1);
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn navidrome_login_redirect_is_not_followed() {
        let mock = Mock::start().await;
        let client = mock.client();
        mock.state.login_redirect.store(true, Ordering::SeqCst);
        let error = client.status().await.unwrap_err();
        assert!(!error.outcome_uncertain());
        assert_eq!(mock.state.redirect_hits.load(Ordering::SeqCst), 0);
        assert_eq!(mock.state.native_reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn navidrome_reports_unknown_and_unsupported_versions_honestly() {
        let mock = Mock::start().await;
        let client = mock.client();
        *mock.state.version.lock().unwrap() = None;
        assert_eq!(client.status().await.unwrap().supports_upload, None);
        *mock.state.version.lock().unwrap() = Some("0.60.3".to_string());
        assert_eq!(client.status().await.unwrap().supports_upload, Some(false));
    }

    #[tokio::test]
    async fn navidrome_rejects_bad_inputs_before_contacting_server() {
        let mock = Mock::start().await;
        let client = mock.client();
        assert!(client
            .list_artists(&"a".repeat(201), 1, 10)
            .await
            .unwrap_err()
            .is_bad_request());
        assert!(client
            .list_artists("", 0, 10)
            .await
            .unwrap_err()
            .is_bad_request());
        assert!(client
            .list_artists("", 1, 101)
            .await
            .unwrap_err()
            .is_bad_request());
        assert!(client
            .get_artist("../auth/login")
            .await
            .unwrap_err()
            .is_bad_request());
        assert!(client
            .upload_image("artist-1", portrait(ImageFormat::Png))
            .await
            .unwrap_err()
            .is_bad_request());
        assert!(client
            .upload_image("artist-1", vec![0; MAX_IMAGE_BYTES + 1])
            .await
            .unwrap_err()
            .is_bad_request());
        assert_eq!(mock.state.logins.load(Ordering::SeqCst), 0);
        assert_eq!(mock.state.uploads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn navidrome_url_validation_allows_local_networks_and_rejects_embedded_credentials() {
        for url in [
            "http://navidrome:4533",
            "http://127.0.0.1:4533/music/",
            "http://[::1]:4533",
            "https://example.invalid/prefix",
        ] {
            assert!(validate_base_url(url).is_ok());
        }
        for url in [
            "ftp://example.invalid",
            "http://user:password@example.invalid",
            "https://example.invalid?token=secret",
            "https://example.invalid/#secret",
            "not a url",
        ] {
            assert!(validate_base_url(url).is_err());
        }
        assert_eq!(version_supports_upload("0.61.0"), Some(true));
        assert_eq!(version_supports_upload("v0.64.2 (abc)"), Some(true));
        assert_eq!(version_supports_upload("0.60.3"), Some(false));
        assert_eq!(version_supports_upload("0.61.0-SNAPSHOT"), None);
        assert_eq!(version_supports_upload("dev"), None);
        assert!(validate_image(b"<html>challenge</html>", false).is_err());
    }
}
