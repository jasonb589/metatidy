//! 密码登录：一个访问口令（`METATIDY_PASSWORD`）+ Postgres 会话表 + HttpOnly Cookie。
//!
//! 为什么要有：容器一旦把端口暴露到局域网，同网段任何人都能打开界面直接改写你的音乐标签、
//! 甚至按模板移动文件（不可撤销）。原来整个 API 是完全裸奔的。
//!
//! 设计取舍：
//! - **不设 `METATIDY_PASSWORD` 就完全关闭认证**（中间件直接放行）。这样 CI 的端到端验收、
//!   本地开发和原来的调用方都不用改任何一个请求；代价是「以为设了其实没设」很危险，所以
//!   `/api/session` 会带 `warning`、启动时 `warn!`、顶栏也显示「未设密码」。
//! - 会话存 Postgres 而不是签名的无状态 Cookie：不需要新引入 HMAC/rand 依赖，重启容器不丢
//!   登录态，而且能真撤销（退出登录 = 删行）。认证**不依赖 Redis**（Redis 只跑任务进度）。
//! - 口令比较是**定长比较**（不因第几位不同而提前返回），避免时序侧信道；登录失败按来源 IP
//!   限速（内存计数，连续 5 次失败锁 5 分钟），成功即清零。
//! - Cookie 默认不带 `Secure`：这套东西基本跑在局域网 http 上，带上反而登不进去；
//!   走 HTTPS/反代时用 `METATIDY_COOKIE_SECURE=1` 打开。
//! - 静态文件（HTML/JS）本身不拦：它不含任何数据，数据全在 `/api/*` 后面。未登录访问 `/`
//!   拿到的是空壳界面 + 登录遮罩，而不是一个 401 页面。
//! - 反代后面（所有请求都来自反代 IP）用 `METATIDY_TRUST_PROXY=1` 让限速按
//!   `X-Forwarded-For` 的第一段算；**默认不信任**这个头，否则任何人都能伪造它绕过限速。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;

/// 会话 Cookie 名。
pub const COOKIE_NAME: &str = "metatidy_session";
/// 连续失败多少次后锁定。
pub const MAX_FAILS: u32 = 5;
/// 锁定多少秒。
pub const LOCK_SECS: u64 = 300;
/// 登录请求体上限（里面只有口令，64KB 绰绰有余）。
const LOGIN_BODY_LIMIT: usize = 64 * 1024;
/// 没设口令时给前端的原话（顶栏会显示它）。
pub const WARNING_NO_PASSWORD: &str =
    "未设置 METATIDY_PASSWORD：同网段任何人都能打开界面并修改你的音乐库";

// ---------------------------------------------------------------- 会话表读写

/// 生成会话 token：两个 UUIDv4 拼起来（244 位随机），十六进制。
fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Cookie 里的 token 是不是一个未过期的会话。
pub async fn verify(db: &PgPool, token: &str) -> Result<bool, AppError> {
    let hit: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM sessions WHERE token = $1 AND expires_at > now()")
            .bind(token)
            .fetch_optional(db)
            .await?;
    Ok(hit.is_some())
}

/// 建会话（顺手清掉过期行），返回 token。
pub async fn create_session(db: &PgPool, days: i64, user_agent: &str) -> Result<String, AppError> {
    let _ = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await;
    let token = new_token();
    sqlx::query(
        "INSERT INTO sessions (token, expires_at, user_agent)
         VALUES ($1, now() + make_interval(days => $2), $3)",
    )
    .bind(&token)
    .bind(days as i32)
    .bind(user_agent)
    .execute(db)
    .await?;
    Ok(token)
}

/// 删会话（退出登录）。删不到也不算错（Cookie 早就过期了）。
pub async fn destroy_session(db: &PgPool, token: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM sessions WHERE token = $1")
        .bind(token)
        .execute(db)
        .await?;
    Ok(())
}

// ------------------------------------------------------------------- Cookie

/// 从 `Cookie` 头里取出会话 token。
pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name.trim() == COOKIE_NAME {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 拼 `Set-Cookie`：HttpOnly + SameSite=Lax（够挡 CSRF 的表单提交，也不影响正常跳转）。
pub fn session_cookie(token: &str, max_age_secs: i64, secure: bool) -> String {
    let mut out = format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        max_age_secs.max(0)
    );
    if secure {
        out.push_str("; Secure");
    }
    out
}

/// 清 Cookie（退出登录用：值留空 + Max-Age=0）。
pub fn clear_cookie(secure: bool) -> String {
    session_cookie("", 0, secure)
}

// ------------------------------------------------------------------- 口令

/// 定长比较：长度差与每一位的异或都累进同一个 u32，中途不返回。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u32;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as u32;
    }
    diff == 0
}

/// 口令比较。空口令永远不匹配：没配口令时根本走不到这里，但别让它变成万能钥匙。
pub fn password_matches(expected: &str, given: &str) -> bool {
    if expected.is_empty() || given.is_empty() {
        return false;
    }
    constant_time_eq(expected.as_bytes(), given.as_bytes())
}

// ------------------------------------------------------------------- 限速

struct Attempts {
    fails: u32,
    locked_until: Option<Instant>,
    seen: Instant,
}

impl Attempts {
    fn fresh() -> Self {
        Self {
            fails: 0,
            locked_until: None,
            seen: Instant::now(),
        }
    }
}

/// 失败计数：key 是来源 IP。单进程内存表足够（这套东西只跑一个容器）。
static ATTEMPTS: Lazy<Mutex<HashMap<String, Attempts>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 还锁着多少秒（没锁返回 None）。
pub fn lock_remaining_secs(key: &str) -> Option<u64> {
    let map = ATTEMPTS.lock().ok()?;
    let until = map.get(key)?.locked_until?;
    let now = Instant::now();
    if until > now {
        Some((until - now).as_secs() + 1)
    } else {
        None
    }
}

/// 记一次失败，返回「还能试几次」。
pub fn record_failure(key: &str) -> u32 {
    let mut map = match ATTEMPTS.lock() {
        Ok(map) => map,
        Err(_) => return 0,
    };
    prune(&mut map);
    let entry = map.entry(key.to_string()).or_insert_with(Attempts::fresh);
    entry.fails += 1;
    entry.seen = Instant::now();
    if entry.fails >= MAX_FAILS {
        entry.locked_until = Some(Instant::now() + Duration::from_secs(LOCK_SECS));
    }
    MAX_FAILS.saturating_sub(entry.fails)
}

/// 登录成功就清零。
pub fn clear_failures(key: &str) {
    if let Ok(mut map) = ATTEMPTS.lock() {
        map.remove(key);
    }
}

/// 表太大时丢掉一小时没动静的条目（家用场景几乎不会触发）。
fn prune(map: &mut HashMap<String, Attempts>) {
    if map.len() < 256 {
        return;
    }
    let now = Instant::now();
    map.retain(|_, a| now.duration_since(a.seen) < Duration::from_secs(3600));
}

/// 限速用的来源标识：默认用真实对端 IP；配了 `METATIDY_TRUST_PROXY` 才看反代头。
pub fn client_key(trust_proxy: bool, headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    if trust_proxy {
        if let Some(first) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(ip) = first.split(',').next() {
                let ip = ip.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
        if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
            let ip = ip.trim();
            if !ip.is_empty() {
                return ip.to_string();
            }
        }
    }
    match peer {
        Some(addr) => addr.ip().to_string(),
        None => "unknown".to_string(),
    }
}

// ------------------------------------------------------------------- 接口

/// 带 `Set-Cookie` 的 JSON 响应。
fn json_with_cookie(status: StatusCode, cookie: Option<String>, body: Value) -> Response {
    let mut res = (status, Json(body)).into_response();
    if let Some(value) = cookie {
        if let Ok(header_value) = HeaderValue::from_str(&value) {
            res.headers_mut().insert(header::SET_COOKIE, header_value);
        }
    }
    res
}

/// `GET /api/session`：前端启动先问一句「要不要登录、我现在算不算已登录」。
pub async fn session_info(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let required = state.config.auth_password.is_some();
    let mut authenticated = !required;
    if required {
        if let Some(token) = token_from_headers(&headers) {
            authenticated = verify(&state.db, &token).await.unwrap_or(false);
        }
    }
    Json(json!({
        "required": required,
        "authenticated": authenticated,
        "session_days": state.config.auth_session_days,
        "warning": if required { Value::Null } else { json!(WARNING_NO_PASSWORD) },
    }))
}

/// `POST /api/login`：口令对了就下发 HttpOnly 会话 Cookie。
pub async fn login(State(state): State<AppState>, req: Request) -> Result<Response, AppError> {
    let key = client_key(
        state.config.auth_trust_proxy,
        req.headers(),
        req.extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0),
    );

    // 先把 body 读掉，再决定怎么回答：**不消费请求体就直接返回**会让 hyper 关掉这条连接，
    // 客户端拿到的是「连接被重置」而不是我们的 401/429（Windows 上实测就是
    // ConnectionResetError 10054；Linux 上只是碰巧先读到响应，所以 CI 一直没暴露）。
    let user_agent: String = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();

    let bytes = to_bytes(req.into_body(), LOGIN_BODY_LIMIT)
        .await
        .map_err(|_| AppError::bad_request("请求体读取失败或过大"))?;
    let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let given = payload
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 没配口令：登录接口直接说「不需要」，前端也就不会弹遮罩。
    let Some(expected) = state.config.auth_password.clone() else {
        return Ok(json_with_cookie(
            StatusCode::OK,
            None,
            json!({
                "ok": true,
                "required": false,
                "authenticated": true,
                "detail": "未设置 METATIDY_PASSWORD，无需登录",
            }),
        ));
    };

    if let Some(secs) = lock_remaining_secs(&key) {
        return Err(AppError::too_many_requests(format!(
            "密码错误次数过多，请 {secs} 秒后再试"
        )));
    }

    if !password_matches(&expected, given) {
        let left = record_failure(&key);
        warn!("登录失败：来源 {key}，剩余尝试 {left}");
        return Err(AppError::unauthorized(if left > 0 {
            format!("密码不正确（还可尝试 {left} 次）")
        } else {
            format!("密码不正确，已锁定 {LOCK_SECS} 秒")
        }));
    }

    clear_failures(&key);
    let days = state.config.auth_session_days.max(1);
    let token = create_session(&state.db, days, &user_agent).await?;
    info!("登录成功：来源 {key}，会话 {days} 天");
    Ok(json_with_cookie(
        StatusCode::OK,
        Some(session_cookie(
            &token,
            days * 86_400,
            state.config.auth_cookie_secure,
        )),
        json!({
            "ok": true,
            "required": true,
            "authenticated": true,
            "session_days": days,
        }),
    ))
}

/// `POST /api/logout`：删会话 + 让浏览器丢掉 Cookie。未登录时调用也只是空操作。
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    if let Some(token) = token_from_headers(&headers) {
        let _ = destroy_session(&state.db, &token).await;
    }
    Ok(json_with_cookie(
        StatusCode::OK,
        Some(clear_cookie(state.config.auth_cookie_secure)),
        json!({ "ok": true }),
    ))
}

/// 未登录时统一的 401 形状（前端只看 `detail`，`login_required` 给界面做判断）。
fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "detail": "请先登录", "login_required": true })),
    )
        .into_response()
}

/// 保护所有需要登录的 API（health / session / login / logout 不经过这里）。
pub async fn require_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if state.config.auth_password.is_none() {
        return next.run(req).await;
    }
    let authorized = match token_from_headers(req.headers()) {
        Some(token) => match verify(&state.db, &token).await {
            Ok(ok) => ok,
            Err(err) => {
                warn!("校验会话失败：{err}");
                false
            }
        },
        None => false,
    };
    if authorized {
        return next.run(req).await;
    }
    // 拒绝之前把请求体丢掉：不消费 body 就直接返回会让 hyper 关掉这条连接，客户端可能拿到
    // 「连接被重置」而不是干净的 401（登录接口那边实测踩到过，这里一并防住）。
    let (_, body) = req.into_parts();
    drain_body(body).await;
    unauthorized_response()
}

/// 丢掉请求体（最多 256KB，防住「一直发」的客户端），只为让连接能正常收尾。
async fn drain_body(body: axum::body::Body) {
    use futures::StreamExt;

    // Body 不是 Stream，得先 into_data_stream()
    let mut stream = body.into_data_stream();
    let mut dropped = 0usize;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                dropped += bytes.len();
                if dropped > 256 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

// -------------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn constant_time_compare_covers_length_and_content() {
        assert!(constant_time_eq(b"hunter2", b"hunter2"));
        assert!(!constant_time_eq(b"hunter2", b"hunter3"));
        assert!(!constant_time_eq(b"hunter2", b"hunter22"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
        // 长度差正好是 256 的倍数也不能被判等（这里靠 u32 累加，不靠 (len as u8)）
        let long = vec![b'a'; 256];
        assert!(!constant_time_eq(b"", &long));
    }

    #[test]
    fn empty_password_never_matches() {
        assert!(!password_matches("", ""));
        assert!(!password_matches("", "whatever"));
        assert!(!password_matches("secret", ""));
        assert!(password_matches("secret", "secret"));
    }

    #[test]
    fn cookie_parsing_handles_noise_and_empties() {
        let map = headers(&[("cookie", "a=1; metatidy_session=abc123; b=2")]);
        assert_eq!(token_from_headers(&map).as_deref(), Some("abc123"));
        let map = headers(&[("cookie", "metatidy_session=")]);
        assert_eq!(token_from_headers(&map), None);
        let map = headers(&[("cookie", "other=1")]);
        assert_eq!(token_from_headers(&map), None);
        assert_eq!(token_from_headers(&HeaderMap::new()), None);
        // 名字前缀相同但不是一个 cookie，不能被认成会话
        let map = headers(&[("cookie", "metatidy_session_x=zzz")]);
        assert_eq!(token_from_headers(&map), None);
    }

    #[test]
    fn set_cookie_is_httponly_and_optional_secure() {
        let plain = session_cookie("tok", 3600, false);
        assert!(plain.starts_with("metatidy_session=tok;"));
        assert!(plain.contains("HttpOnly"));
        assert!(plain.contains("SameSite=Lax"));
        assert!(plain.contains("Max-Age=3600"));
        assert!(!plain.contains("Secure"));
        assert!(session_cookie("tok", 3600, true).contains("; Secure"));
        // 退出登录：空值 + 立即过期
        let cleared = clear_cookie(false);
        assert!(cleared.contains("metatidy_session=;"));
        assert!(cleared.contains("Max-Age=0"));
        // 负数不产生 Max-Age=-1（浏览器会当成会话 Cookie）
        assert!(session_cookie("tok", -5, false).contains("Max-Age=0"));
    }

    #[test]
    fn client_key_prefers_peer_unless_proxy_is_trusted() {
        let peer: SocketAddr = "192.168.1.9:51000".parse().unwrap();
        let map = headers(&[("x-forwarded-for", "10.0.0.5, 10.0.0.6")]);
        // 默认不信反代头：伪造 XFF 绕不过限速
        assert_eq!(client_key(false, &map, Some(peer)), "192.168.1.9");
        assert_eq!(client_key(true, &map, Some(peer)), "10.0.0.5");
        assert_eq!(
            client_key(true, &headers(&[("x-real-ip", "10.0.0.7")]), Some(peer)),
            "10.0.0.7"
        );
        // 没有对端信息（没挂 connect info）也不能 panic
        assert_eq!(client_key(false, &HeaderMap::new(), None), "unknown");
    }

    #[test]
    fn failures_lock_then_clear() {
        let key = "test-lock-9.9.9.9";
        assert_eq!(lock_remaining_secs(key), None);
        for i in 1..MAX_FAILS {
            let left = record_failure(key);
            assert_eq!(left, MAX_FAILS - i, "第 {i} 次失败后剩余次数不对");
            assert_eq!(lock_remaining_secs(key), None, "还没到阈值不该锁");
        }
        assert_eq!(record_failure(key), 0, "第 {MAX_FAILS} 次失败后剩余应为 0");
        let secs = lock_remaining_secs(key).expect("到阈值必须锁定");
        assert!(secs > 0 && secs <= LOCK_SECS, "锁定时长异常：{secs}");
        // 锁着的时候继续失败不会解锁
        assert_eq!(record_failure(key), 0);
        assert!(lock_remaining_secs(key).is_some());
        // 成功登录（清计数）后立刻可以再试
        clear_failures(key);
        assert_eq!(lock_remaining_secs(key), None);
        assert_eq!(record_failure(key), MAX_FAILS - 1);
        clear_failures(key);
    }

    #[test]
    fn tokens_are_long_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64, "两个 UUID 拼起来应该是 64 个十六进制字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
