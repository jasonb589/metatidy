//! 阶段 3：多源刮削搜索层（Python `app/scrapebridge.py` + `metatidy_core/scrapers.py` 的移植）。
//!
//! 权威契约：`stage3_contract.md`（A 节对外 JSON / B 节 27 个候选字段 / C 节打分 / D 节 13 个源 /
//! E 节歌词与封面 / F 节归一复用 / H 节 16 处不确定）。
//!
//! 移植口径（与契约逐条对齐，读源码后确定的取舍）：
//!
//! * 只走 **core 语义**一条路径（契约 H-4）：13 个源全部由本模块直接实现，
//!   不使用桥接层的「内置实现」兜底（那条路在 Python 里只有 core import 失败时才会走到）。
//! * 打分只用 `score_candidate`（core 口径，整数分 + `int()` 截断置信度，契约 H-10/H-11）。
//!   Python 的本地回退打分（`_local_score`）是 float 分且只在 core 打分抛异常时启用，
//!   本实现不会进入那条分支（等价于「core 永远可用」）。
//! * `pixels` 恒为 0（契约 H-2）：`/api/search` 路径不做封面尺寸探测，因此没有封面面积加分。
//! * `context` 不由本层填写（契约 A5.8）：只有别处（MusicBrainz 桥接内置实现）才会给 `studio`，
//!   所以 `filter_album_context` 在搜索路径上是恒等变换；本模块仍然照抄该过滤，语义不变。
//! * `thefuzz` 未列入本仓库 `requirements.txt`（实测 `.venv` 里也没有），Python 侧
//!   `HAS_FUZZ = False` → `is_fuzzy_match` / `_title_sim_score` / `_lyrics_score` / `_kugou_score`
//!   里的 `token_*_ratio` 分支**在真实运行时不会执行**。本模块按「无 fuzz」口径实现
//!   （契约 F3 要求的「明确改规则而不是悄悄丢掉」），并保留 Python 的兜底规则：
//!   包含判定 + 「首字符相同且长度差 ≤ max(len)/2」。
//! * 简繁归一（`simple_convert`）用 `zhconv 1.4.3` 的 zh-cn 表在 BMP 汉字区间逐字导出的映射表
//!   （见文末 `T2S_TRAD`/`T2S_SIMP`），短语级映射退化为逐字映射（唯一有意的近似）。
//! * 每个源都有**明确的一跳 15 秒 / 整源 20 秒超时**（契约 H-16；Python 源码里写死的
//!   `timeout=300` 在实际链路上并不成立）。慢源表现为 `count = 0` + `error = "超时：TimeoutError"`。
//! * 缺 API Key 的源（spotify / genius / discogs）按契约 H-5 表现为 `count = 0` 且**没有** `error`。

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::normalize::normalize_artist_credit;

// ==================== 常量（照抄 Python） ====================

/// 桥接层的 UA（内置实现与封面下载用）。
const APP_USER_AGENT: &str = "metatidy/0.1 (https://github.com/jasonb589/metatidy)";
/// `config.MUSIC_HEADERS` / `SEARCH_HEADERS` 的 Chrome UA。
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/// MusicBrainz 要求可识别 UA（`config.MB_USER_AGENT`）。
const MB_USER_AGENT: &str = "MusicScraper/10.0";
/// `config.LASTFM_API_KEY`：源码里写死的免费 Key（`SOURCE_CREDENTIALS["Last.fm"] = ()`）。
///
/// **2026-10-08 实测：这个 Key 已被 Last.fm 拒绝**（`track.search` → HTTP 403
/// `{"error":10,"message":"Invalid API key - You must be granted a valid key by last.fm"}`），
/// 所以 lastfm 现在只能靠环境变量 `LASTFM_API_KEY` 出候选（见 `search_lastfm` 的可读错误）。
const LASTFM_BUILTIN_API_KEY: &str = "2bd6d4b4f7d439b7c41f0fd8b7e3b8e1";
/// `config.THEAUDIODB_API_KEY`：公开测试 Key。
///
/// **2026-10-08 实测：`"2"` 已被上游拒绝**（`/api/v1/json/2/…` → HTTP 404 `{"Message":"Not found"}`；
/// `search.php` / `searchtrack.php` / `album.php` 都是这样），同一路径换 TheAudioDB 文档里的另一个
/// 公开示例 Key `"123"` 能拿到真实数据（见 `parse_theaudiodb_*` 单测里的真实报文）。用环境变量
/// `THEAUDIODB_API_KEY` 可覆盖。
const THEAUDIODB_BUILTIN_API_KEY: &str = "123";

/// 单个源的整体超时（`scrapebridge.PER_SOURCE_TIMEOUT`）。
pub const PER_SOURCE_TIMEOUT: Duration = Duration::from_secs(20);
/// 单跳 HTTP 超时（Python 写死 `timeout=300`；按契约 H-16 换成真实上限，见模块注释）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Deezer 专辑详情（Python 显式 `timeout=15`）。
const DEEZER_ALBUM_TIMEOUT: Duration = Duration::from_secs(15);
/// 封面下载超时（`scrapebridge.HTTP_TIMEOUT`）。
const COVER_TIMEOUT: Duration = Duration::from_secs(12);
/// 封面最大字节数（`scrapebridge.fetch_cover(max_bytes=6MiB)`）。
const COVER_MAX_BYTES: usize = 6 * 1024 * 1024;
/// MusicBrainz 限速（`MUSICBRAINZ_MIN_INTERVAL = 1.0`）。
const MUSICBRAINZ_MIN_INTERVAL_SECS: f64 = 1.0;
/// 超时错误文案（Python：`f"超时：{type(exc).__name__}"`，那里是 `concurrent.futures.TimeoutError`）。
const TIMEOUT_ERROR: &str = "超时：TimeoutError";

/// 桥接层默认源顺序（`scrapebridge.SEARCH_PRIORITY`，7 项）。
pub const SEARCH_PRIORITY: [&str; 7] = [
    "netease",
    "qq",
    "kugou",
    "kuwo",
    "musicbrainz",
    "itunes",
    "deezer",
];

/// 全部接口源名（顺序 = `SOURCE_REGISTRY`，13 项）。
pub const SOURCE_NAMES: [&str; 13] = [
    "musicbrainz",
    "netease",
    "qq",
    "kugou",
    "kuwo",
    "itunes",
    "deezer",
    "lastfm",
    "theaudiodb",
    "spotify",
    "genius",
    "ytmusic",
    "discogs",
];

// ==================== 正则 ====================

/// `is_fuzzy_match` 里拆多歌手的模式（照抄 `normalize._split_pattern`）。
static FUZZ_SPLIT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*(?:feat\.?|ft\.?|featuring|vs\.?|versus|[x×]\s|with|&|、|,|/)\s*")
        .expect("歌手拆分正则必须合法")
});

/// iTunes 封面放大（`scrapers.py:732`）。
static RE_ITUNES_ARTWORK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"/\d+x\d+[a-z]*\.([a-z]+)").expect("iTunes 封面正则必须合法"));

/// 酷我 `r.s` 响应里被「多层 repr」加倍过的 unicode 转义：真实报文里 `TFBOYS&TF家族` 是
/// `TFBOYS\\\\u0026TF家族`（4 个反斜杠 + `u0026`，2026-10-08 抓取），归一成 `\u0026` 后
/// 由 `parse_repr_dict` 解出 `&`。
static RE_DOUBLED_UNICODE_ESCAPE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\\{2,}u([0-9a-fA-F]{4})").expect("酷我转义正则必须合法"));

/// 从文本里抓 4 位年份（Last.fm / Kugou / Discogs 等）。
static RE_YEAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d{4})").expect("年份正则必须合法"));

/// Genius 的 `full_title` 里的年份：`(...)`。
static RE_PAREN_YEAR: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\((\d{4})\)").expect("Genius 年份正则必须合法"));

// ==================== 对外结构 ====================

/// 一次刮削搜索的入参（阶段 4 的 API 层直接构造）。
#[derive(Debug, Clone, Default)]
pub struct ScrapeQuery {
    /// 搜索关键词（App 层回填成 `track.title or Path(path).stem`）。
    pub title: String,
    /// 歌手提示（App 层回填成 `track.artist`）。
    pub artist: String,
    /// 专辑：**搜索路径不使用**（Python 只在本地回退评分里用到 album，本层不走那条路）。
    #[allow(dead_code)]
    pub album: Option<String>,
    /// 时长提示（秒），用于打分里的时长容差。
    pub duration: Option<f64>,
    /// engine key 列表；空 = 桥接默认优先级 `SEARCH_PRIORITY`。
    pub sources: Vec<String>,
    /// 每源上限（不是全局上限，见契约 A5.3）。
    pub limit: usize,
}

/// 一条候选（27 个键，键名与顺序 = Python `Candidate.as_dict()`）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Candidate {
    pub source: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub albumartist: String,
    pub genre: String,
    pub year: String,
    pub date: String,
    pub track: String,
    pub disc: String,
    pub language: String,
    pub composer: String,
    pub lyricist: String,
    pub albumtype: String,
    pub mb_artist_id: String,
    pub release_group_id: String,
    pub isrc: String,
    pub recording_id: String,
    pub context: String,
    pub cover: String,
    pub artist_country: String,
    pub total_tracks: i64,
    pub lyrics: String,
    pub duration: f64,
    pub score: f64,
    pub confidence: String,
    pub error: String,
}

/// 每源一条状态（`{source, count[, error]}`；`error` 为空时不出现在 JSON 里）。
#[derive(Debug, Clone, Serialize)]
pub struct SourceStatus {
    pub source: String,
    pub count: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
}

/// 搜索总输出。`source_status` 的顺序 = 生效源顺序（Python 用 `as_completed` 是完成序，
/// 不确定；这里固定成生效顺序，阶段 4 可直接拿它当响应里的 `sources` 回显，见契约 H-3）。
#[derive(Debug, Clone, Serialize)]
pub struct ScrapeOutcome {
    pub candidates: Vec<Candidate>,
    pub source_status: Vec<SourceStatus>,
}

/// 供 `/api/status` 的 `scraper.count` 用（契约要求 ≥ 12）。
pub fn known_sources() -> Vec<&'static str> {
    SOURCE_NAMES.to_vec()
}

/// 某源在这次结果里贡献了多少条候选（阶段 4 的 `source_status` / 断言都能用）。
pub fn count_source(outcome: &ScrapeOutcome, source: &str) -> usize {
    outcome.candidates.iter().filter(|c| c.source == source).count()
}

// ==================== 候选内部表示（= core Candidate 的字段子集） ====================

/// 迁移层 `Candidate` 的等价物：各源函数产出的原始字段（打分要吃它）。
///
/// 字段与 core `Candidate` 一一对应；其中少数（song_id / format / disambiguation /
/// release_group_* / explicit / popularity）在当前 App 路径上只写不读 —— 保留是为了与契约
/// B 节的字段清单保持一致（后续合并/写盘可直接用），因此这里显式关掉 dead_code 提示。
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct Raw {
    /// core 引擎名（`Netease` / `iTunes-US` / …），打分按它给基础分。
    source: String,
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    year: String,
    date: String,
    genre: Option<String>,
    album_type: String,
    context: String,
    cover_url: String,
    artist_country: String,
    artist_mbid: String,
    release_group_id: String,
    release_group_primary_type: String,
    release_group_secondary_types: Vec<String>,
    total_tracks: i64,
    duration: f64,
    song_id: String,
    recording_id: String,
    isrc: String,
    track_num: Option<i64>,
    disc_num: Option<i64>,
    format: Option<String>,
    disambiguation: String,
    explicit: bool,
    popularity: i64,
}


/// `_from_core`：core 候选 → 对外候选。
fn from_core(raw: &Raw, source_id: &str) -> Candidate {
    let year = if !raw.year.is_empty() {
        raw.year.clone()
    } else {
        prefix_chars(&raw.date, 4)
    };
    Candidate {
        source: source_id.to_string(),
        title: raw.title.clone(),
        artist: raw.artist.clone(),
        album: raw.album.clone(),
        albumartist: raw.album_artist.clone(),
        genre: raw.genre.clone().unwrap_or_default(),
        year,
        date: raw.date.clone(),
        track: raw.track_num.map(|v| v.to_string()).unwrap_or_default(),
        disc: raw.disc_num.map(|v| v.to_string()).unwrap_or_default(),
        language: String::new(),
        composer: String::new(),
        lyricist: String::new(),
        albumtype: raw.album_type.clone(),
        mb_artist_id: raw.artist_mbid.clone(),
        release_group_id: raw.release_group_id.clone(),
        isrc: raw.isrc.clone(),
        recording_id: raw.recording_id.clone(),
        context: raw.context.clone(),
        cover: raw.cover_url.clone(),
        artist_country: raw.artist_country.clone(),
        total_tracks: raw.total_tracks,
        lyrics: String::new(),
        duration: raw.duration,
        score: 0.0,
        confidence: "待确认".to_string(),
        error: String::new(),
    }
}

// ==================== 小工具（Python 语义） ====================

/// 取前 n 个**字符**（Python 的 `s[:n]` 按码点切，不是字节）。
fn prefix_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Python 切片语义（支持负下标；`end=None` 表示到末尾）。
fn py_slice(chars: &[char], start: i64, end: Option<i64>) -> String {
    let len = chars.len() as i64;
    let idx = |i: i64| -> i64 {
        if i < 0 {
            (len + i).max(0)
        } else {
            i.min(len)
        }
    };
    let a = idx(start);
    let b = match end {
        Some(e) => idx(e),
        None => len,
    };
    if b <= a {
        String::new()
    } else {
        chars[a as usize..b as usize].iter().collect()
    }
}

/// Python 的 `dict`/`list`/`str` 真值判定（`or` 的语义）。
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `a or b or ...`：取第一个真值。
fn first_truthy<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates
        .iter()
        .copied()
        .flatten()
        .find(|v| truthy(Some(*v)))
}

/// Python `str(value)`（None → `""`；数字按 Python 的写法输出）。
fn s_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => (if *b { "True" } else { "False" }).to_string(),
        Some(other) => other.to_string(),
    }
}

/// `scrapebridge._as_text`：列表用 ` & ` 连接，其它 `str(v).strip()`。
/// 生产代码里 `Raw` 已经用强类型字段，这里保留 `_as_text` 的等价实现供单测钉住语义。
#[allow(dead_code)]
fn as_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| s_of(Some(i)))
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" & "),
        other => s_of(other).trim().to_string(),
    }
}

/// Python `int(x)`：数字截断，数字字符串按整数解析。
fn i_of(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().map(|f| f as i64),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}

/// Python `float(x)`。
fn f_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Python `bool(x)`（用于 explicit 之类）。
fn b_of(v: Option<&Value>) -> bool {
    truthy(v)
}

/// Python `str.capitalize()`：首字符大写、其余小写。
fn py_capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out = String::new();
            out.extend(first.to_uppercase());
            out.push_str(&chars.as_str().to_lowercase());
            out
        }
    }
}

/// `str(casefold())` 近似：Python 的 `casefold` 与 `lower` 只在 ß/ﬁ 这类字符上有差异。
fn casefold(text: &str) -> String {
    text.to_lowercase()
}

/// Python `repr(float)` 风格（LRCLIB 的 duration 参数：`223.0` 而不是 `223`）。
fn py_float_str(v: f64) -> String {
    if v.fract() == 0.0 && v.is_finite() {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

/// `is_chinese_text`：只认 `\u4e00-\u9fff`（比 `normalize::has_cjk` 更窄，照抄 Python）。
fn is_chinese_text(text: &str) -> bool {
    text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 取两段文本的字符交集大小（Python `len(set(a) & set(b))`）。
fn char_overlap(a: &str, b: &str) -> i64 {
    let set_a: HashSet<char> = a.chars().collect();
    let set_b: HashSet<char> = b.chars().collect();
    set_a.intersection(&set_b).count() as i64
}

/// 词的集合交集大小（Python `len(set(a.split()) & set(b.split()))`）。
fn word_overlap(a: &str, b: &str) -> i64 {
    let set_a: HashSet<&str> = a.split_whitespace().collect();
    let set_b: HashSet<&str> = b.split_whitespace().collect();
    set_a.intersection(&set_b).count() as i64
}

/// 本地时区的 `(YYYY-MM-DD, YYYY)`（Python `time.localtime` + `strftime`）。
fn local_date_year(ts_secs: f64) -> Option<(String, String)> {
    if !ts_secs.is_finite() {
        return None;
    }
    let dt = Local.timestamp_opt(ts_secs as i64, 0).single()?;
    Some((
        dt.format("%Y-%m-%d").to_string(),
        dt.format("%Y").to_string(),
    ))
}

/// **UTC** 的 `(YYYY-MM-DD, YYYY)`，只给 QQ 新接口的 `pubtime`（unix 秒）用。
///
/// 用 UTC 而不是本地时区：实测《稻香》`pubtime=1224000000`，UTC 解释是 `2008-10-14`，
/// 与老接口同一首歌的 `time_public="2008-10-14"` 一致；按 Asia/Shanghai 会算成
/// `2008-10-15`，反而差一天。
fn utc_date_year(ts_secs: f64) -> Option<(String, String)> {
    if !ts_secs.is_finite() {
        return None;
    }
    let dt = chrono::Utc.timestamp_opt(ts_secs as i64, 0).single()?;
    Some((
        dt.format("%Y-%m-%d").to_string(),
        dt.format("%Y").to_string(),
    ))
}

/// 取歌手列表并归一成 `A & B`（`normalize_artist_credit([...])`）。
fn normalize_artist_credit_list(names: &[String]) -> String {
    let joined = names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join(" & ");
    normalize_artist_credit(&joined)
}

/// 头部构造。
fn hdrs(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            map.insert(name, value);
        }
    }
    map
}

/// 需要运行时拼出来的头部（例如 `Authorization: Bearer …`）。
fn hdrs_owned(pairs: &[(&str, String)]) -> HeaderMap {
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    hdrs(&refs)
}

/// `application/x-www-form-urlencoded` 编码（避免依赖 reqwest 的 form 特性）。
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&pct_encode(k));
        out.push('=');
        out.push_str(&pct_encode(v));
    }
    out
}

fn pct_encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else if c == ' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 把参数拼成查询串（`pct_encode` 自己编码，中文/空格的行为与其余源一致）。
fn with_query(url: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::from(url);
    out.push(if url.contains('?') { '&' } else { '?' });
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&pct_encode(k));
        out.push('=');
        out.push_str(&pct_encode(v));
    }
    out
}

/// 只处理上游实际用到的几个 HTML 实体（酷我 `r.s` 把 `&` 写成 `&nbsp;` / `&amp;` / `&apos;`）。
fn html_unescape_light(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// `\\\\u0026` 这类「反斜杠被多层 repr 加倍」的 unicode 转义收敛回 `\u0026`
/// （酷我 2026-10-08 的真实报文：`'ARTIST':'TFBOYS\\\\u0026TF家族'` → `TFBOYS&TF家族`）。
fn normalize_repr_escapes(text: &str) -> String {
    RE_DOUBLED_UNICODE_ESCAPE
        .replace_all(text, |caps: &regex::Captures| format!("\\u{}", &caps[1]))
        .to_string()
}

/// 从响应体里切出第一个**花括号配平**的对象（字符串里的花括号不参与配平）。
///
/// 不能用非贪婪正则（`\{.*?\}`）——`abslist` 里是嵌套对象，非贪婪会在第一个 `}` 处截断
/// （Python 与旧实现的病灶，见 `kuwo_parse_real_response_json()` 单测）。
fn first_balanced_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (offset, c) in text[start..].char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return text.get(start..start + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// 把已解码的字符写进 JSON 文本（转义 `"`、`\` 与控制字符）。
fn push_json_char(out: &mut String, ch: char) {
    match ch {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
        c => out.push(c),
    }
}

/// 「Python/JS 字面量风格」的字典文本 → 合法 JSON 文本。
///
/// 只做**最小归一**，结构交给 `serde_json`：
/// * 单引号字符串 → 双引号字符串（`\'` `\"` `\\` `\n` `\t` `\xNN` `\uXXXX` 等转义按字面量解出后
///   再按 JSON 规则重新转义，含代理对）；
/// * 反斜杠加倍的 unicode 转义先收敛（`normalize_repr_escapes`）；
/// * 裸词 `True` / `False` / `None` → `true` / `false` / `null`。
fn repr_literal_to_json(text: &str) -> Option<String> {
    let text = normalize_repr_escapes(text);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut quote: Option<char> = None;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        let Some(q) = quote else {
            match c {
                '\'' | '"' => {
                    quote = Some(c);
                    out.push('"');
                }
                _ if c.is_ascii_alphabetic() => {
                    let mut word = String::from(c);
                    while i < chars.len() && chars[i].is_ascii_alphabetic() {
                        word.push(chars[i]);
                        i += 1;
                    }
                    match word.as_str() {
                        "True" => out.push_str("true"),
                        "False" => out.push_str("false"),
                        "None" => out.push_str("null"),
                        other => out.push_str(other),
                    }
                }
                _ => out.push(c),
            }
            continue;
        };
        if c == '\\' {
            let esc = *chars.get(i)?;
            i += 1;
            match esc {
                'u' | 'x' => {
                    let width = if esc == 'u' { 4 } else { 2 };
                    let hex: String = chars.get(i..i + width)?.iter().collect();
                    i += width;
                    let mut code = u32::from_str_radix(&hex, 16).ok()?;
                    // 代理对（`\uD83D\uDE00`）：高代理后紧跟低代理时合成一个码点。
                    if (0xD800..0xDC00).contains(&code)
                        && chars.get(i) == Some(&'\\')
                        && chars.get(i + 1) == Some(&'u')
                    {
                        let low_hex: String = chars.get(i + 2..i + 6)?.iter().collect();
                        if let Ok(low) = u32::from_str_radix(&low_hex, 16) {
                            if (0xDC00..0xE000).contains(&low) {
                                code = 0x1_0000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                i += 6;
                            }
                        }
                    }
                    match char::from_u32(code) {
                        Some(ch) => push_json_char(&mut out, ch),
                        None => out.push('\u{FFFD}'),
                    }
                }
                'n' => out.push_str("\\n"),
                't' => out.push_str("\\t"),
                'r' => out.push_str("\\r"),
                'b' => out.push_str("\\b"),
                'f' => out.push_str("\\f"),
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\'' => out.push('\''),
                '/' => out.push('/'),
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
        } else if c == q {
            quote = None;
            out.push('"');
        } else if c == '"' {
            out.push_str("\\\"");
        } else if (c as u32) < 0x20 {
            out.push_str(&format!("\\u{:04x}", c as u32));
        } else {
            out.push(c);
        }
    }
    if quote.is_some() {
        return None; // 字符串没闭合：响应被截断
    }
    Some(out)
}

/// 酷我响应体 → `Value`：兼容旧的 `jsondata = ` 前缀与现在的「裸单引号字典」两种形态。
fn parse_repr_dict(text: &str) -> Option<Value> {
    let obj = first_balanced_object(text)?;
    let json = repr_literal_to_json(obj)?;
    serde_json::from_str(&json).ok()
}

// ==================== HTTP 助手 ====================

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    params: &[(String, String)],
    headers: HeaderMap,
    timeout: Duration,
) -> Option<(u16, Value)> {
    let mut req = client.get(url).timeout(timeout).headers(headers);
    if !params.is_empty() {
        req = req.query(params);
    }
    let resp = req.send().await.ok()?;
    let status = resp.status().as_u16();
    // 先取文本再解析：语义与 `resp.json()` 一致（不是 JSON 就当请求失败），
    // 与 Python 里 `resp.json()` 抛异常被外层 try 吞掉的语义对齐。
    let body = resp.text().await.ok()?;
    let data: Value = serde_json::from_str(&body).ok()?;
    Some((status, data))
}

async fn post_form_json(
    client: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
    headers: HeaderMap,
    timeout: Duration,
) -> Option<(u16, Value)> {
    let body = form_encode(form);
    let resp = client
        .post(url)
        .timeout(timeout)
        .headers(headers)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .ok()?;
    let status = resp.status().as_u16();
    let body = resp.text().await.ok()?;
    let data: Value = serde_json::from_str(&body).ok()?;
    Some((status, data))
}

async fn get_text(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    timeout: Duration,
) -> Option<(u16, String)> {
    let resp = client.get(url).timeout(timeout).headers(headers).send().await.ok()?;
    let status = resp.status().as_u16();
    let body = resp.text().await.ok()?;
    Some((status, body))
}

/// 一次「带状态码」的 JSON 拉取结果。
///
/// qq / kugou / kuwo / lastfm / theaudiodb 这 5 个源在 2026-10-08 的真实探针里暴露出的是
/// **上游改版**（HTTP 500、404、非 JSON 响应体、Key 被拒），这些都要能把状态码和响应体
/// 一起写进 `SourceStatus`，所以它们不用 `get_json`（那个函数的语义保持不变）。
struct HttpFetch {
    status: u16,
    body: String,
    data: Option<Value>,
}

impl HttpFetch {
    /// 响应体前 n 个字符（写进诊断说明用，避免把整个响应体塞进状态里）。
    fn head(&self, n: usize) -> String {
        // 响应体也可能反过来带上请求串（少数上游会回显），所以同样过一遍遮密钥
        redact_secrets(&prefix_chars(&self.body, n))
    }
}

/// 敏感查询参数（大小写不敏感）：命中就把值遮成 `***`，只留参数名。
static SECRET_QUERY: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(
        r#"(?i)([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|client[_-]?secret|secret|password)=)[^&\s)"']+"#,
    )
    .expect("遮密钥用的正则写错了")
});

/// URL 里的 `user:pass@` 部分（Redis/Postgres 连接串里很常见）。
static URL_USERINFO: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r"(?i)([a-z][a-z0-9+.\-]*://)[^/@\s]+@").expect("遮密钥用的正则写错了")
});

/// 把文本里可能出现的密钥遮成 `***`，参数名与主机名保留。
///
/// 为什么必须有它：`reqwest` 的错误 Display 会带完整 URL，而 Last.fm / Genius / Discogs
/// 的密钥就写在查询串里（`?api_key=…`、`?token=…`）。这些文本会进 `SourceStatus.error`，
/// 也就是会随 `/api/search` 的响应回到前端，还会被日志收走。
/// 遮掉之后排障信息依然够用：看得出是哪个参数、哪台主机出了什么问题。
pub fn redact_secrets(text: &str) -> String {
    let step1 = SECRET_QUERY.replace_all(text, "${1}***");
    URL_USERINFO.replace_all(&step1, "${1}***@").into_owned()
}

/// 失败时把 reqwest 的原始错误文本带出来（TLS 根证书 / DNS / 连接被重置 / URL 不合法
/// 都会走到这里，2026-10-08 的探针就是靠它定位酷狗与 TheAudioDB 的间歇性失败）。
async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    timeout: Duration,
) -> Result<HttpFetch, String> {
    let resp = client
        .get(url)
        .timeout(timeout)
        .headers(headers)
        .send()
        .await
        // reqwest 的错误文本会带完整 URL，而 Last.fm / Genius / Discogs 的密钥就在
        // 查询串里，所以出去之前先遮掉（见 redact_secrets）。
        .map_err(|e| redact_secrets(&format!("{e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| redact_secrets(&format!("{e}")))?;
    let data = serde_json::from_str(&body).ok();
    Ok(HttpFetch {
        status,
        body,
        data,
    })
}

// ==================== 归一：模糊匹配 / 简繁 ====================

/// 传统字 → 简体字映射（由 zhconv 1.4.3 导出，见文件末尾常量）。
static T2S: Lazy<HashMap<char, char>> = Lazy::new(|| {
    let trad: Vec<char> = T2S_TRAD.chars().collect();
    let simp: Vec<char> = T2S_SIMP.chars().collect();
    trad.into_iter().zip(simp).collect()
});

/// `normalize.simple_convert`：繁 → 简（逐字版；短语级映射退化为逐字映射）。
fn simple_convert(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    text.chars()
        .map(|c| *T2S.get(&c).unwrap_or(&c))
        .collect::<String>()
}

/// `scrapers.py` 里的 `norm_simple` 别名。
fn norm_simple(text: &str) -> String {
    simple_convert(text)
}

/// `normalize.is_fuzzy_match`（无 thefuzz 时的真实行为，见模块注释）。
fn is_fuzzy_match(filename_artist: &str, result_artist: &str) -> bool {
    if filename_artist.is_empty() && result_artist.is_empty() {
        return true;
    }
    if filename_artist.is_empty() {
        return true; // 无歌手信息 → 信任标题闸门
    }
    if result_artist.is_empty() {
        return false; // 有歌手预期但结果无歌手
    }
    let fa_parts: Vec<String> = FUZZ_SPLIT
        .split(filename_artist)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let ra_parts: Vec<String> = FUZZ_SPLIT
        .split(result_artist)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    for fa in &fa_parts {
        for ra in &ra_parts {
            let f_a = simple_convert(&fa.to_lowercase().replace(' ', ""));
            let r_a = simple_convert(&ra.to_lowercase().replace(' ', ""));
            if f_a.is_empty() || r_a.is_empty() {
                continue;
            }
            if f_a.contains(&r_a) || r_a.contains(&f_a) {
                return true;
            }
            // HAS_FUZZ = False：源码里的 token_sort_ratio(f_a, r_a) >= 75 分支不执行
        }
    }
    // 兜底：首字符相同 + 长度差 ≤ max(len) / 2
    let f_a = simple_convert(&filename_artist.to_lowercase().replace(' ', ""));
    let r_a = simple_convert(&result_artist.to_lowercase().replace(' ', ""));
    if !f_a.is_empty() && !r_a.is_empty() {
        let (lf, lr) = (f_a.chars().count() as i64, r_a.chars().count() as i64);
        if f_a.chars().next() == r_a.chars().next() && (lf - lr).abs() <= lf.max(lr) / 2 {
            return true;
        }
    }
    false
}

// ==================== 打分（C 节） ====================

/// `scrapers._title_sim_score`（-50 ~ +60；无 fuzz 分支）。
fn title_sim_score(title: &str, keyword: &str, title_hint: Option<&str>) -> i64 {
    let res_title = title.to_lowercase();
    if res_title.is_empty() || keyword.is_empty() {
        return 0;
    }
    let kw = keyword.to_lowercase();
    if res_title == kw {
        return 60;
    }
    let kw_len = kw.chars().count() as i64;
    let res_len = res_title.chars().count() as i64;
    if kw.contains(&res_title) || res_title.contains(&kw) {
        if kw_len <= 2 && res_len > kw_len + 2 {
            return 10;
        }
        return 50;
    }
    if let Some(hint) = title_hint.filter(|h| !h.is_empty()) {
        let th = hint.to_lowercase();
        if th == res_title {
            return 55;
        }
        let th_len = th.chars().count() as i64;
        if th.contains(&res_title) || res_title.contains(&th) {
            if th_len <= 2 && res_len > th_len + 2 {
                return 15;
            }
            return 45;
        }
        if is_chinese_text(&th) && is_chinese_text(&res_title) {
            let common = char_overlap(&th, &res_title);
            if common > 0 {
                return 20 + common * 5;
            }
        }
        // HAS_FUZZ = False：token_set_ratio(th, res_title) >= 80 → 35 分支不执行
    }
    let kw_words: Vec<&str> = kw
        .split_whitespace()
        .filter(|w| w.chars().count() >= 2)
        .collect();
    let title_words: Vec<&str> = res_title.split_whitespace().collect();
    let hits = kw_words
        .iter()
        .filter(|k| {
            title_words
                .iter()
                .any(|t| t.contains(**k) || k.contains(t))
        })
        .count() as i64;
    if hits > 0 {
        return 25 + hits * 5;
    }
    -50
}

/// 上下文加成表（`scrapers.py:1701`）。
fn context_bonus(context: &str) -> i64 {
    match context {
        "studio" => 30,
        "single" => 15,
        "soundtrack" => 5,
        "live" => -15,
        "compilation" => -40,
        _ => 0,
    }
}

/// `scrapers.score_candidate`（本层不走本地回退打分，所以分数恒为这个整数分）。
fn score_candidate(
    raw: &Raw,
    keyword: &str,
    artist_hint: &str,
    title_hint: Option<&str>,
    duration_hint: Option<f64>,
) -> i64 {
    let mut score: i64 = 0;
    let src = raw.source.as_str();
    let is_cn_song = is_chinese_text(artist_hint) || is_chinese_text(keyword);
    if src.contains("iTunes") {
        score = 80;
    } else if src.contains("MusicBrainz") {
        score = 78;
    } else if src == "Netease" {
        score = if is_cn_song { 75 } else { 65 };
    } else if src == "QQMusic" {
        score = if is_cn_song { 72 } else { 55 };
    } else if src == "Kuwo" {
        score = if is_cn_song { 68 } else { 45 };
    } else if src == "Kugou" {
        score = if is_cn_song { 65 } else { 35 };
    } else if src == "Deezer" {
        score = 65;
    } else if src == "Last.fm" {
        score = 72;
    } else if src == "TheAudioDB" {
        score = 68;
    } else if src == "Spotify" {
        score = 85;
    } else if src == "Genius" {
        score = 70;
    } else if src == "YouTubeMusic" {
        score = 68;
    } else if src == "Discogs" {
        score = 78;
    }
    // 封面面积：本路径 pixels 恒 0（契约 H-2）→ 不加分
    if !raw.year.is_empty() {
        score += 10;
    }
    if let Some(hint) = duration_hint.filter(|d| *d != 0.0) {
        if raw.duration != 0.0 {
            let delta = (raw.duration as i64 - hint as i64).abs();
            if delta <= 2 {
                score += 25;
            } else if delta <= 5 {
                score += 15;
            } else if delta <= 10 {
                score += 5;
            } else {
                score -= (delta - 10).div_euclid(5).min(30);
            }
        }
    }
    let title_sim = title_sim_score(&raw.title, keyword, title_hint);
    score += title_sim;
    let bonus = context_bonus(raw.context.as_str());
    if title_sim >= 0 {
        score += bonus;
    } else {
        score += bonus - 30;
    }
    score
}

/// `scrapers.confidence_level`：`int(score)` 截断后 ≥120 高 / ≥70 中 / 其余待确认。
fn confidence_level(score: i64) -> &'static str {
    if score >= 120 {
        "高"
    } else if score >= 70 {
        "中"
    } else {
        "待确认"
    }
}

/// 正规录音室专辑优先（`normalize.filter_album_context`）。
/// 搜索路径上 `context` 恒为 `""`（契约 A5.8），所以这是恒等变换。
fn filter_album_context(pairs: &mut Vec<(Raw, Candidate)>) {
    if pairs.is_empty() {
        return;
    }
    let studio: Vec<usize> = pairs
        .iter()
        .enumerate()
        .filter(|(_, (raw, _))| raw.context == "studio")
        .map(|(i, _)| i)
        .collect();
    if !studio.is_empty() {
        let mut keep = std::collections::HashSet::new();
        keep.extend(studio);
        let mut idx = 0usize;
        pairs.retain(|_| {
            let here = idx;
            idx += 1;
            keep.contains(&here)
        });
        return;
    }
    let non_compilation: Vec<usize> = pairs
        .iter()
        .enumerate()
        .filter(|(_, (raw, _))| raw.context != "compilation")
        .map(|(i, _)| i)
        .collect();
    if !non_compilation.is_empty() && non_compilation.len() < pairs.len() {
        let mut keep = std::collections::HashSet::new();
        keep.extend(non_compilation);
        let mut idx = 0usize;
        pairs.retain(|_| {
            let here = idx;
            idx += 1;
            keep.contains(&here)
        });
    }
}

/// 排序键：分数降序，同分按生效源顺序（`order`），未知源按 99。
fn sort_scored(pairs: &mut [(Raw, Candidate)], order: &HashMap<String, usize>) {
    pairs.sort_by(|(_, a), (_, b)| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let oa = order.get(a.source.as_str()).copied().unwrap_or(99);
                let ob = order.get(b.source.as_str()).copied().unwrap_or(99);
                oa.cmp(&ob)
            })
    });
}

// ==================== 13 个源：解析函数（纯函数，便于单测） ====================

/// 网易云 `_build_result`（第 1/2 跳共用）。
fn parse_netease_song(song: &Value, artist_name: &str) -> Option<Raw> {
    let al = first_truthy(&[song.get("al"), song.get("album")]).cloned();
    let al = al.unwrap_or(Value::Object(Default::default()));
    let raw_pic = s_of(al.get("picUrl"));
    if raw_pic.is_empty() {
        return None;
    }
    let mut cover_url = raw_pic.split('?').next().unwrap_or("").to_string();
    if cover_url.starts_with("http://") {
        cover_url = cover_url.replacen("http://", "https://", 1);
    }
    let mut pub_time = f_of(song.get("publishTime")).unwrap_or(0.0);
    if pub_time == 0.0 {
        pub_time = f_of(al.get("publishTime")).unwrap_or(0.0);
    }
    let (date, year) = if pub_time != 0.0 {
        local_date_year(pub_time / 1000.0).unwrap_or_default()
    } else {
        (String::new(), String::new())
    };
    let s_title = norm_simple(&s_of(song.get("name")));
    let s_album = norm_simple(&s_of(al.get("name")));
    let is_single = s_title == s_album;
    let dt = i_of(song.get("dt")).unwrap_or(0);
    let duration_ms = if dt != 0 {
        dt
    } else {
        i_of(song.get("duration")).unwrap_or(0)
    };
    let album_type_raw = s_of(al.get("type"));
    let album_type = if !album_type_raw.is_empty() {
        album_type_raw
    } else if is_single {
        "单曲".to_string()
    } else {
        "专辑".to_string()
    };
    Some(Raw {
        source: "Netease".to_string(),
        cover_url,
        song_id: s_of(song.get("id")),
        date,
        year,
        album_type,
        total_tracks: i_of(al.get("trackCount")).unwrap_or(0),
        title: s_title,
        artist: norm_simple(artist_name),
        album: s_album,
        album_artist: norm_simple(artist_name),
        duration: duration_ms.div_euclid(1000) as f64,
        ..Default::default()
    })
}

/// 网易云引擎内部排序分（`_title_score`）。
fn netease_title_score(title: &str, keyword: &str) -> i64 {
    if title.is_empty() {
        return 0;
    }
    let t = title.to_lowercase();
    let kw = keyword.to_lowercase();
    if t == kw || kw.contains(&t) || t.contains(&kw) {
        return 100;
    }
    if is_chinese_text(&t) && is_chinese_text(&kw) {
        return char_overlap(&t, &kw) * 10;
    }
    word_overlap(&kw, &t) * 15
}

/// QQ 音乐引擎内部排序分（`_qq_score`；注意没有「完全相等」分支）。
fn qq_score(title: &str, keyword: &str) -> i64 {
    let t = title.to_lowercase();
    let kw = keyword.to_lowercase();
    if kw.contains(&t) || t.contains(&kw) {
        return 100;
    }
    if is_chinese_text(&t) && is_chinese_text(&kw) {
        return char_overlap(&t, &kw) * 10;
    }
    word_overlap(&t, &kw) * 15
}

fn parse_qq(data: &Value, keyword: &str, hint: &str) -> Option<Raw> {
    let song_list = data
        .pointer("/data/song/list")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut all: Vec<Raw> = Vec::new();
    for song in &song_list {
        let artist_name = song
            .get("singer")
            .and_then(|v| v.as_array())
            .and_then(|s| s.first())
            .map(|s| s_of(s.get("name")))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Unknown".to_string());
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        let album_mid = s_of(song.get("albummid"));
        let cover_url = if album_mid.is_empty() {
            String::new()
        } else {
            format!("https://y.gtimg.cn/music/photo_new/T002R1000x1000M000{album_mid}.jpg?max_age=2592000")
        };
        // 三个候选字段：老版 `time_public`（"2008-10-14"）、`pub_time`（字符串），
        // 以及新接口 `search_for_qq_cp` 的 `pubtime`（unix 秒，实测 1224000000 → 2008-10-14）。
        let (pub_time, year) = {
            let text_time = {
                let t = s_of(song.get("time_public"));
                if !t.is_empty() {
                    t
                } else {
                    s_of(song.get("pub_time"))
                }
            };
            if !text_time.is_empty() {
                let y = prefix_chars(&text_time, 4);
                (text_time, y)
            } else if let Some(ts) = i_of(song.get("pubtime")).filter(|v| *v > 1_000_000_000) {
                let (d, y) = utc_date_year(ts as f64).unwrap_or_default();
                (d, y)
            } else {
                (String::new(), String::new())
            }
        };
        let s_title = norm_simple(&s_of(song.get("songname")));
        let s_album = norm_simple(&s_of(song.get("albumname")));
        let is_single = s_title == s_album || s_album.is_empty();
        all.push(Raw {
            source: "QQMusic".to_string(),
            cover_url,
            song_id: s_of(song.get("songmid")),
            date: pub_time,
            year,
            album_type: if is_single {
                "单曲".to_string()
            } else {
                "专辑".to_string()
            },
            title: s_title,
            artist: norm_simple(&artist_name),
            album: s_album,
            album_artist: norm_simple(&artist_name),
            duration: i_of(song.get("interval")).unwrap_or(0) as f64,
            ..Default::default()
        });
    }
    if all.is_empty() {
        return None;
    }
    all.sort_by(|a, b| qq_score(&b.title, keyword).cmp(&qq_score(&a.title, keyword)));
    all.into_iter().next()
}

/// 酷我 `r.s` 响应 → 候选。
///
/// **2026-10-08 上游改版实测**：
/// * 响应体不再有 `jsondata = ` 前缀，直接就是「单引号风格字典」
///   （`{'ARTISTPIC':'','HIT':'1317',…,'abslist':[{…}]}`），所以改成配平切片 + 字面量归一 +
///   `serde_json`（旧的非贪婪正则 `\{.*?\}` 会被 `abslist` 的嵌套对象截断）；
/// * 不带 `rn`/`pn` 时上游返回 `HIT=0 / HITMODE=nores`（调用方必须带，见 `search_kuwo`）；
/// * `'ARTIST':'TFBOYS\\\\u0026TF家族'` 这类转义要解出 `&`（`normalize_repr_escapes`）。
///
/// 封面：`ALBUMID` 能拼出封面 URL 就填（best effort，见 `kuwo_cover_url`）；拼不出就留空。
///
/// 两条对 Python 的**有意偏离**（Python 都是整条丢弃，于是这个源对中文歌恒为 0 条）：
/// 1. 不再要求「必须有封面」——实测 `稻香` 下 `周杰伦` 的条目全是用户上传，`ALBUMID='0'`；
/// 2. 不再为了封面去挑「某个带 `ALBUMID` 的条目」，因为那个 URL 模式 2026-10-08 实测已 404
///    （见 `kuwo_cover_url`），挑它只会把「翻唱合辑」这类元数据更差的条目顶上来。
///
/// 文本入口（单测 / 取证测试用；生产路径 `search_kuwo` 直接吃已解析的 `Value`，省一次解析）。
#[allow(dead_code)]
fn parse_kuwo(text: &str, hint: &str) -> Option<Raw> {
    let data = parse_repr_dict(text)?;
    kuwo_from_value(&data, hint)
}
/// 已解析的酷我响应 → 候选（返回**第一个**歌手匹配的命中，见 `parse_kuwo` 的封面说明）。
fn kuwo_from_value(data: &Value, hint: &str) -> Option<Raw> {
    let songs = data.get("abslist").and_then(|v| v.as_array())?;
    for song in songs {
        let artist_name = norm_simple(&html_unescape_light(&s_of(song.get("ARTIST"))));
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        let s_title = norm_simple(&html_unescape_light(&s_of(song.get("SONGNAME"))));
        let s_album = norm_simple(&html_unescape_light(&s_of(song.get("ALBUM"))));
        let release_date = {
            let a = s_of(song.get("RELEASE_DATE"));
            if !a.is_empty() {
                a
            } else {
                s_of(song.get("ALBUMDATE"))
            }
        };
        let date_str = prefix_chars(&release_date, 10);
        let year_str = prefix_chars(&date_str, 4);
        let duration_val = {
            let d = i_of(song.get("DURATION")).unwrap_or(0);
            if d != 0 {
                d
            } else {
                i_of(song.get("PLAYTIME")).unwrap_or(0)
            }
        };
        return Some(Raw {
            source: "Kuwo".to_string(),
            cover_url: kuwo_cover_url(&s_of(song.get("ALBUMID"))),
            song_id: s_of(song.get("MUSICRID")).replace("MUSIC_", ""),
            album_type: "专辑".to_string(),
            title: s_title,
            artist: artist_name.clone(),
            album: s_album,
            album_artist: artist_name,
            date: date_str,
            year: year_str,
            duration: duration_val as f64,
            ..Default::default()
        });
    }
    None
}

/// 酷我封面 URL：`ALBUMID` 后两位/中两位不一定是数字，失败即 `""`（Python 同款口径）。
///
/// **2026-10-08 实测：这个 URL 模式已经 404**（`img4.kuwo.cn` / `img1.kuwo.cn` / `star.kuwo.cn`
/// 上的 `.../star/albumcover/1080/{a}/{b}/{ALBUMID}.jpg`，以及去掉 `1080`、换成 `.webp` 的变体
/// 全是 404），搜索响应里的 `PICPATH`/`MVPIC` 也恒为空。这里保留拼接是为了「上游修好后自动生效」，
/// 但调用方不再拿它当筛条（见 `parse_kuwo`）——候选宁可封面留空也照样返回。
fn kuwo_cover_url(album_id: &str) -> String {
    if album_id.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = album_id.chars().collect();
    let last2 = py_slice(&chars, -2, None);
    let mid2 = py_slice(&chars, -4, Some(-2));
    match (last2.parse::<i64>(), mid2.parse::<i64>()) {
        (Ok(a), Ok(b)) => format!("https://img4.kuwo.cn/star/albumcover/1080/{a}/{b}/{album_id}.jpg"),
        _ => String::new(),
    }
}

/// 酷狗第 2 跳详情 → 候选（无封面返回 `None`，调用方继续下一条）。
///
/// **2026-10-08 上游改版实测**：`www.kugou.com/yy/index.php?r=play/getdata`（旧路径）现在固定返回
/// `{"status":0,"err_code":30020}`（要签名 Cookie），改用手机版
/// `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<hash>`：响应是**扁平的**
/// （没有 `data` 包一层），字段名是 `songName` / `author_name` / `album_img` / `imgUrl` /
/// `timeLength`（毫秒）；专辑名/发行日期/时长要拿第 1 跳搜索命中（`hit`）当兜底，
/// 因为手机版详情里没有 `album_name`、`timeLength` 对部分歌曲是 0（实测周杰伦《稻香》
/// 的 `timeLength=0`，但 `extra.320timelength=223503`）。
fn parse_kugou_detail(body: &Value, hit: Option<&Value>) -> Option<Raw> {
    // 兼容旧的两层形态（`{"data": {...}}`）与现在的扁平形态。
    let d = body.get("data").unwrap_or(body);
    let hit = hit.cloned().unwrap_or(Value::Object(Default::default()));
    let cover_url = {
        let candidates = [
            s_of(d.get("album_img")),
            s_of(d.get("imgUrl")),
            s_of(d.get("img")),
            s_of(first_truthy(&[d.get("trans_param")]).and_then(|t| t.get("union_cover"))),
        ];
        let picked = candidates
            .into_iter()
            .find(|u| !u.is_empty())
            .unwrap_or_default();
        picked.replace("{size}", "480")
    };
    if cover_url.is_empty() {
        return None;
    }
    // 手机版详情用 `songName`，旧形态用 `song_name`；都没有就用搜索命中的歌名。
    let s_title = {
        let a = norm_simple(&s_of(d.get("songName")));
        if !a.is_empty() {
            a
        } else {
            let b = norm_simple(&s_of(d.get("song_name")));
            if !b.is_empty() {
                b
            } else {
                norm_simple(&s_of(hit.get("SongName")))
            }
        }
    };
    let mut s_album = norm_simple(&s_of(hit.get("AlbumName")));
    if s_album.is_empty() {
        s_album = norm_simple(&s_of(d.get("album_name")));
    }
    if s_album.is_empty() {
        s_album = s_title.clone();
    }
    let trans_param = first_truthy(&[d.get("trans_param")])
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let extra = first_truthy(&[d.get("extra")])
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let millis = {
        // 手机版 `timeLength`（毫秒）→ 旧形态 `timelength` → `extra.320/128timelength`
        // → 最后才用第 1 跳搜索命中的 `Duration`（**秒**）。
        let candidates = [
            f_of(d.get("timeLength")).unwrap_or(0.0),
            f_of(d.get("timelength")).unwrap_or(0.0),
            f_of(extra.get("320timelength")).unwrap_or(0.0),
            f_of(extra.get("128timelength")).unwrap_or(0.0),
        ];
        let picked = candidates
            .into_iter()
            .find(|v| *v > 0.0)
            .unwrap_or(0.0);
        if picked > 0.0 {
            picked
        } else {
            f_of(hit.get("Duration")).unwrap_or(0.0) * 1000.0
        }
    };
    let (mut date_str, mut year_str) = (String::new(), String::new());
    // 优先级：搜索命中的 `PublishDate`（"2012-11-08"）→ trans_param 时间戳 → publish_info/pub_time。
    let publish_date = s_of(hit.get("PublishDate"));
    if !publish_date.is_empty() {
        date_str = prefix_chars(&publish_date, 10);
        year_str = prefix_chars(&date_str, 4);
    }
    if year_str.is_empty() {
        let mut pub_time = f_of(trans_param.get("publish_time")).unwrap_or(0.0);
        if pub_time == 0.0 {
            pub_time = f_of(trans_param.get("ctime")).unwrap_or(0.0);
        }
        if pub_time != 0.0 {
            let ts = if pub_time as i64 > 1_000_000_000_000 {
                pub_time / 1000.0
            } else {
                pub_time
            };
            if let Some((d_str, y_str)) = local_date_year(ts) {
                date_str = d_str;
                year_str = y_str;
            }
        }
    }
    if year_str.is_empty() {
        let pub_info = {
            let a = s_of(d.get("publish_info"));
            if !a.is_empty() {
                a
            } else {
                s_of(d.get("pub_time"))
            }
        };
        if !pub_info.is_empty() {
            if let Some(caps) = RE_YEAR.captures(&pub_info) {
                year_str = caps[1].to_string();
                date_str = if pub_info.chars().count() >= 10 {
                    prefix_chars(&pub_info, 10)
                } else {
                    year_str.clone()
                };
            }
        }
    }
    let author = {
        let a = norm_simple(&s_of(d.get("author_name")));
        if !a.is_empty() {
            a
        } else {
            let b = norm_simple(&s_of(d.get("singerName")));
            if !b.is_empty() {
                b
            } else {
                norm_simple(&s_of(hit.get("SingerName")))
            }
        }
    };
    Some(Raw {
        source: "Kugou".to_string(),
        cover_url,
        album_type: "单曲".to_string(),
        title: s_title,
        artist: author.clone(),
        album: s_album,
        album_artist: author,
        date: date_str,
        year: year_str,
        duration: (millis as i64).div_euclid(1000) as f64,
        ..Default::default()
    })
}

/// iTunes 单地区解析（返回第一个通过 fuzzy 且有封面的结果）。
fn parse_itunes(data: &Value, region: &str, hint: &str) -> Option<Raw> {
    if i_of(data.get("resultCount")).unwrap_or(0) <= 0 {
        return None;
    }
    let results = data.get("results").and_then(|v| v.as_array())?;
    for res in results {
        if !is_fuzzy_match(hint, &s_of(res.get("artistName"))) {
            continue;
        }
        let raw_url = s_of(res.get("artworkUrl100"));
        if raw_url.is_empty() {
            continue;
        }
        let cover_url = RE_ITUNES_ARTWORK
            .replace_all(&raw_url, "/10000x10000bb.$1")
            .to_string();
        let genre = translate_raw_genre(&s_of(res.get("primaryGenreName")));
        let release_date = s_of(res.get("releaseDate"));
        let date = prefix_chars(&release_date, 10);
        let year = prefix_chars(&date, 4);
        let s_album = norm_simple(&s_of(res.get("collectionName")));
        let s_title = norm_simple(&s_of(res.get("trackName")));
        let track_count = i_of(res.get("trackCount")).unwrap_or(0);
        let is_single = s_album.contains("Single") || (s_title == s_album && track_count == 1);
        let collection_type = s_of(res.get("collectionType"));
        let album_type = if !collection_type.is_empty() {
            collection_type
        } else if is_single {
            "单曲".to_string()
        } else {
            "专辑".to_string()
        };
        // Python：res.get('collectionArtistName', res.get('artistName'))（按键存在与否取默认值）
        let album_artist_src = res
            .get("collectionArtistName")
            .map(|v| s_of(Some(v)))
            .unwrap_or_else(|| s_of(res.get("artistName")));
        return Some(Raw {
            source: format!("iTunes-{region}"),
            cover_url,
            genre: Some(genre),
            date,
            year,
            album_type,
            title: s_title,
            artist: norm_simple(&s_of(res.get("artistName"))),
            album: s_album,
            album_artist: norm_simple(&album_artist_src),
            total_tracks: track_count,
            track_num: i_of(res.get("trackNumber")),
            ..Default::default()
        });
    }
    None
}

/// Deezer 解析：返回 `(候选, album_id)`；`date_override` 由专辑详情那一跳提供。
fn deezer_candidate(
    data: &Value,
    hint: &str,
    date_override: Option<&str>,
) -> Option<(Raw, Option<String>)> {
    let results = data.get("data").and_then(|v| v.as_array())?;
    if results.is_empty() {
        return None;
    }
    for res in results {
        let artist_name = s_of(res.get("artist").and_then(|a| a.get("name")));
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        let album = res.get("album").cloned().unwrap_or(Value::Object(Default::default()));
        let cover_base = s_of(first_truthy(&[album.get("cover_xl"), album.get("cover_medium")]));
        if cover_base.is_empty() {
            continue;
        }
        let cover_url = cover_base.replace("1000x1000", "1400x1400");
        let s_title = norm_simple(&s_of(res.get("title")));
        let s_album = norm_simple(&s_of(album.get("title")));
        let mut release_date = {
            let a = s_of(album.get("release_date"));
            if !a.is_empty() {
                a
            } else {
                s_of(res.get("release_date"))
            }
        };
        if let Some(ov) = date_override.filter(|s| !s.is_empty()) {
            release_date = ov.to_string();
        }
        let date_str = prefix_chars(&release_date, 10);
        let year_str = prefix_chars(&date_str, 4);
        let album_id = album.get("id").filter(|v| truthy(Some(v))).map(|v| s_of(Some(v)));
        let duration_val = f_of(res.get("duration")).unwrap_or(0.0);
        let raw = Raw {
            source: "Deezer".to_string(),
            cover_url,
            genre: None,
            title: s_title.clone(),
            artist: norm_simple(&artist_name),
            album: s_album.clone(),
            album_artist: norm_simple(&artist_name),
            album_type: if s_title == s_album {
                "单曲".to_string()
            } else {
                "专辑".to_string()
            },
            date: date_str,
            year: year_str,
            total_tracks: i_of(album.get("track_count")).unwrap_or(0),
            duration: duration_val as i64 as f64,
            ..Default::default()
        };
        return Some((raw, album_id));
    }
    None
}

/// MusicBrainz 解析（发行选择 / 年份取最早 / tags 排序全照抄）。
fn parse_musicbrainz(data: &Value, hint: &str) -> Option<Raw> {
    let recordings = data
        .get("recordings")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())?;
    for rec in recordings {
        let credit_items = rec
            .get("artist-credit")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let names: Vec<String> = credit_items
            .iter()
            .map(|item| {
                let name = s_of(item.get("name"));
                if !name.trim().is_empty() {
                    name
                } else {
                    s_of(item.get("artist").and_then(|a| a.get("name")))
                }
            })
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .collect();
        let artist_credit = normalize_artist_credit_list(&names);
        let artist_info = credit_items
            .first()
            .and_then(|c| c.get("artist"))
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        if !is_fuzzy_match(hint, &artist_credit) {
            continue;
        }
        let releases = match rec.get("releases").and_then(|v| v.as_array()) {
            Some(r) if !r.is_empty() => r,
            _ => continue,
        };
        let mut ordered: Vec<&Value> = releases
            .iter()
            .filter(|item| s_of(item.get("status")).to_lowercase() == "official")
            .collect();
        if ordered.is_empty() {
            ordered = releases.iter().collect();
        }
        ordered.sort_by(|a, b| {
            let key = |item: &Value| {
                let date = {
                    let d = s_of(item.get("date"));
                    if d.is_empty() {
                        "9999".to_string()
                    } else {
                        d
                    }
                };
                let media = if truthy(item.get("media")) { 0 } else { 1 };
                let title = s_of(item.get("title"));
                (date, media, title)
            };
            key(a).cmp(&key(b))
        });
        let release = ordered[0];
        let release_group = release
            .get("release-group")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let release_group_id = s_of(release_group.get("id"));
        let cover_url = if release_group_id.is_empty() {
            String::new()
        } else {
            format!("https://coverartarchive.org/release-group/{release_group_id}/front")
        };
        let mut date_str = String::new();
        let mut year_str = String::new();
        for rel in &ordered {
            let d = s_of(rel.get("date"));
            if d.chars().count() >= 4 {
                let y = prefix_chars(&d, 4);
                if year_str.is_empty() || y < year_str {
                    year_str = y;
                    date_str = d;
                }
            }
        }
        let secondary: Vec<String> = release_group
            .get("secondary-types")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|i| s_of(Some(i))).collect())
            .unwrap_or_default();
        let raw_release_type = if secondary.is_empty() {
            s_of(release_group.get("primary-type"))
        } else {
            secondary.join(", ")
        };
        let raw_primary_type = s_of(release_group.get("primary-type"));
        let total_tracks: i64 = release
            .get("media")
            .and_then(|v| v.as_array())
            .map(|media| {
                media
                    .iter()
                    .map(|m| i_of(m.get("track-count")).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0);
        // tags：同名 tag 后出现的覆盖分值，排序按 count 降序（稳定 → 保留首次出现顺序）
        let mut tags: Vec<(String, i64)> = Vec::new();
        if let Some(arr) = rec.get("tags").and_then(|v| v.as_array()) {
            for tag in arr.iter().take(5) {
                let name = s_of(tag.get("name")).trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let count = i_of(tag.get("count")).unwrap_or(0);
                match tags.iter().position(|(n, _)| n == &name) {
                    Some(pos) => tags[pos].1 = count,
                    None => tags.push((name, count)),
                }
            }
        }
        let mut order: Vec<usize> = (0..tags.len()).collect();
        order.sort_by(|a, b| tags[*b].1.cmp(&tags[*a].1));
        let genre = order
            .iter()
            .map(|i| tags[*i].0.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let isrcs = rec
            .get("isrcs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let format_str = release
            .get("media")
            .and_then(|v| v.as_array())
            .map(|media| {
                media
                    .iter()
                    .map(|m| s_of(m.get("format")))
                    .filter(|f| !f.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        return Some(Raw {
            source: "MusicBrainz".to_string(),
            title: norm_simple(&s_of(rec.get("title"))),
            artist: artist_credit.clone(),
            album: s_of(release.get("title")),
            album_artist: artist_credit,
            cover_url,
            genre: Some(genre),
            recording_id: s_of(rec.get("id")),
            date: date_str,
            year: year_str,
            album_type: raw_release_type,
            artist_country: s_of(artist_info.get("country")),
            artist_mbid: s_of(artist_info.get("id")),
            release_group_id,
            release_group_primary_type: raw_primary_type,
            release_group_secondary_types: secondary,
            total_tracks,
            duration: i_of(rec.get("length")).unwrap_or(0).div_euclid(1000) as f64,
            isrc: isrcs.first().map(|v| s_of(Some(v))).unwrap_or_default(),
            disambiguation: s_of(rec.get("disambiguation")),
            format: if format_str.is_empty() {
                None
            } else {
                Some(format_str)
            },
            ..Default::default()
        });
    }
    None
}

/// Last.fm `track.getInfo` 解析（封面优先级 extralarge > large > medium）。
fn parse_lastfm_info(info: Option<&Value>, track: &Value, artist_name: &str) -> Option<Raw> {
    let fallback_name = s_of(track.get("name"));
    let mut cover_url = String::new();
    if let Some(info) = info {
        let album = info.get("album").cloned().unwrap_or(Value::Object(Default::default()));
        for size in ["extralarge", "large", "medium"] {
            let img = album
                .get("image")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.iter().find(|i| s_of(i.get("size")) == size))
                .map(|i| s_of(i.get("#text")))
                .unwrap_or_default();
            if !img.is_empty() {
                cover_url = img;
                break;
            }
        }
    }
    if cover_url.is_empty() {
        return None;
    }
    let s_title = match info {
        Some(info) => {
            let name = info
                .get("name")
                .map(|v| s_of(Some(v)))
                .unwrap_or_else(|| fallback_name.clone());
            norm_simple(&name)
        }
        None => norm_simple(&fallback_name),
    };
    let s_artist = norm_simple(artist_name);
    let genre_tags: Vec<String> = info
        .and_then(|i| i.pointer("/toptags/tag"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().take(5).map(|t| s_of(t.get("name"))).collect())
        .unwrap_or_default();
    let mut album_name = String::new();
    if let Some(info) = info {
        if truthy(info.get("album")) {
            album_name = s_of(info.pointer("/album/title"));
        }
    }
    if album_name.is_empty() {
        album_name = s_title.clone();
    }
    let mut date_str = String::new();
    let mut year_str = String::new();
    if let Some(info) = info {
        let wiki = info.get("wiki").cloned().unwrap_or(Value::Object(Default::default()));
        let published = {
            let p = s_of(wiki.get("published"));
            if !p.is_empty() {
                p
            } else {
                s_of(wiki.get("summary"))
            }
        };
        if !published.is_empty() {
            if let Some(caps) = RE_YEAR.captures(&published) {
                year_str = caps[1].to_string();
                date_str = year_str.clone();
            }
        }
        if year_str.is_empty() && truthy(info.get("album")) {
            for key in ["releasedate", "release_date", "intYearReleased"] {
                let val = info
                    .get("album")
                    .and_then(|a| a.get(key))
                    .map(|v| s_of(Some(v)))
                    .unwrap_or_default();
                if !val.is_empty() {
                    if let Some(caps) = RE_YEAR.captures(&val) {
                        year_str = caps[1].to_string();
                        date_str = val.trim().to_string();
                        break;
                    }
                }
            }
        }
    }
    let duration_val = info
        .and_then(|i| i.get("duration"))
        .and_then(|v| f_of(Some(v)))
        .unwrap_or(0.0);
    Some(Raw {
        source: "Last.fm".to_string(),
        cover_url,
        genre: if genre_tags.is_empty() {
            None
        } else {
            Some(genre_tags.join(", "))
        },
        title: s_title.clone(),
        artist: s_artist.clone(),
        album: norm_simple(&album_name),
        album_artist: s_artist,
        album_type: if s_title == album_name {
            "单曲".to_string()
        } else {
            "专辑".to_string()
        },
        date: date_str,
        year: year_str,
        duration: duration_val as i64 as f64,
        ..Default::default()
    })
}

/// TheAudioDB 解析（封面优先级 ThumbHD > Thumb > CDart；无 date/duration/total_tracks）。
fn parse_theaudiodb(track: &Value, album_info: Option<&Value>) -> Option<Raw> {
    let cover_url = album_info
        .map(|album| {
            let hd = s_of(album.get("strAlbumThumbHD"));
            if !hd.is_empty() {
                hd
            } else {
                let thumb = s_of(album.get("strAlbumThumb"));
                if !thumb.is_empty() {
                    thumb
                } else {
                    s_of(album.get("strAlbumCDart"))
                }
            }
        })
        .unwrap_or_default();
    if cover_url.is_empty() {
        return None;
    }
    let s_title = norm_simple(&s_of(track.get("strTrack")));
    let s_artist = norm_simple(&s_of(track.get("strArtist")));
    let album_src = album_info
        .map(|album| {
            let v = album
                .get("strAlbum")
                .map(|x| s_of(Some(x)))
                .unwrap_or_else(|| s_of(track.get("strAlbum")));
            v
        })
        .unwrap_or_else(|| s_of(track.get("strAlbum")));
    let s_album = norm_simple(&album_src);
    let genre = album_info.and_then(|album| {
        let g = s_of(album.get("strGenre"));
        if !g.is_empty() {
            Some(g)
        } else {
            let style = s_of(album.get("strStyle"));
            if style.is_empty() {
                None
            } else {
                Some(style)
            }
        }
    });
    let year = album_info
        .map(|album| {
            album
                .get("intYearReleased")
                .map(|v| s_of(Some(v)))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    Some(Raw {
        source: "TheAudioDB".to_string(),
        cover_url,
        genre,
        year,
        title: s_title.clone(),
        artist: s_artist.clone(),
        album: if s_album.is_empty() { s_title } else { s_album },
        album_artist: s_artist,
        album_type: "专辑".to_string(),
        ..Default::default()
    })
}

/// Spotify 解析（`album.album_type.capitalize()`、逗号连接的多歌手）。
fn parse_spotify(data: &Value, hint: &str) -> Option<Raw> {
    let tracks = data.pointer("/tracks/items").and_then(|v| v.as_array())?;
    for track in tracks {
        let artists = track
            .get("artists")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let combined_artist = artists
            .iter()
            .map(|a| s_of(a.get("name")))
            .collect::<Vec<_>>()
            .join(", ");
        if !is_fuzzy_match(hint, &combined_artist) {
            continue;
        }
        let album = track.get("album").cloned().unwrap_or(Value::Object(Default::default()));
        let cover_url = album
            .get("images")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .map(|i| s_of(i.get("url")))
            .unwrap_or_default();
        if cover_url.is_empty() {
            continue;
        }
        let s_title = norm_simple(&s_of(track.get("name")));
        let s_album = norm_simple(&s_of(album.get("name")));
        let release_date = s_of(album.get("release_date"));
        let date_str = prefix_chars(&release_date, 10);
        let year_str = prefix_chars(&release_date, 4);
        let duration_val = (f_of(track.get("duration_ms")).unwrap_or(0.0) as i64).div_euclid(1000);
        let album_type_raw = album
            .get("album_type")
            .map(|v| s_of(Some(v)))
            .unwrap_or_else(|| "album".to_string());
        let album_artist = album
            .get("artists")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|x| s_of(x.get("name"))).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        return Some(Raw {
            source: "Spotify".to_string(),
            cover_url,
            song_id: s_of(track.get("id")),
            date: date_str,
            year: year_str,
            album_type: py_capitalize(&album_type_raw),
            title: s_title,
            artist: norm_simple(&combined_artist),
            album: s_album,
            album_artist: norm_simple(&album_artist),
            track_num: Some(i_of(track.get("track_number")).unwrap_or(0)),
            disc_num: Some(i_of(track.get("disc_number")).unwrap_or(0)),
            duration: duration_val as f64,
            isrc: s_of(track.pointer("/external_ids/isrc")),
            explicit: b_of(track.get("explicit")),
            popularity: i_of(track.get("popularity")).unwrap_or(0),
            ..Default::default()
        });
    }
    None
}

/// Genius 解析。
fn parse_genius(data: &Value, hint: &str) -> Option<Raw> {
    let hits = data.pointer("/response/hits").and_then(|v| v.as_array())?;
    for hit in hits {
        let result = hit.get("result").cloned().unwrap_or(Value::Object(Default::default()));
        let artist_name = s_of(result.pointer("/primary_artist/name"));
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        let s_title = norm_simple(&s_of(result.get("title")));
        let s_artist = norm_simple(&artist_name);
        let mut cover_url = s_of(result.get("song_art_image_url"));
        if cover_url.is_empty() {
            cover_url = s_of(result.get("header_image_url"));
        }
        if cover_url.is_empty() {
            cover_url = s_of(result.pointer("/primary_artist/image_url"));
        }
        if cover_url.is_empty() {
            continue;
        }
        let full_title = s_of(result.get("full_title"));
        let year_str = if full_title.is_empty() {
            String::new()
        } else {
            RE_PAREN_YEAR
                .captures(&full_title)
                .map(|c| c[1].to_string())
                .unwrap_or_default()
        };
        let album = if truthy(result.get("album")) {
            let name = s_of(result.pointer("/album/name"));
            if name.is_empty() {
                s_title.clone()
            } else {
                norm_simple(&name)
            }
        } else {
            s_title.clone()
        };
        return Some(Raw {
            source: "Genius".to_string(),
            cover_url,
            song_id: s_of(result.get("id")),
            genre: None,
            title: s_title,
            artist: s_artist.clone(),
            album,
            album_artist: s_artist,
            album_type: "单曲".to_string(),
            year: year_str.clone(),
            date: year_str,
            ..Default::default()
        });
    }
    None
}

/// Discogs 解析（`"歌手 - 标题"` 切分；`discogs_artist == ""` 时 fuzzy 为 False → 丢弃）。
fn parse_discogs(data: &Value, hint: &str) -> Option<Raw> {
    let results = data.get("results").and_then(|v| v.as_array())?;
    for r in results {
        let title_full = s_of(r.get("title"));
        let (discogs_artist, discogs_title) = match title_full.find(" - ") {
            Some(idx) if idx > 0 => {
                let artist = title_full[..idx].trim().to_string();
                let title = title_full[idx + 3..].trim().to_string();
                (artist, title)
            }
            _ => (String::new(), title_full.clone()),
        };
        if !is_fuzzy_match(hint, &discogs_artist) {
            continue;
        }
        let cover_url = s_of(r.get("cover_image"));
        if cover_url.is_empty() {
            continue;
        }
        let year_str = r
            .get("year")
            .filter(|v| truthy(Some(v)))
            .map(|v| s_of(Some(v)))
            .unwrap_or_default();
        let formats: Vec<String> = r
            .get("format")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|i| s_of(Some(i))).collect())
            .unwrap_or_default();
        let genres: Vec<String> = r
            .get("genre")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|i| s_of(Some(i))).collect())
            .unwrap_or_default();
        let styles: Vec<String> = r
            .get("style")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|i| s_of(Some(i))).collect())
            .unwrap_or_default();
        let genres_joined = genres.join(", ");
        let genres_combined = if styles.is_empty() {
            genres_joined.clone()
        } else {
            format!("{genres_joined} ({})", styles.join(", "))
        };
        let format_joined = formats.join(", ");
        return Some(Raw {
            source: "Discogs".to_string(),
            cover_url,
            song_id: s_of(r.get("id")),
            genre: if genres_combined.is_empty() {
                None
            } else {
                Some(genres_combined)
            },
            title: norm_simple(&discogs_title),
            artist: norm_simple(&discogs_artist),
            album: norm_simple(&discogs_title),
            album_artist: norm_simple(&discogs_artist),
            album_type: "专辑".to_string(),
            date: year_str.clone(),
            year: year_str,
            format: if format_joined.is_empty() {
                None
            } else {
                Some(format_joined)
            },
            ..Default::default()
        });
    }
    None
}

// ==================== 13 个源：联网入口 ====================

const NETEASE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async fn search_netease(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    let headers = hdrs(&[
        ("User-Agent", NETEASE_UA),
        ("Referer", "https://music.163.com/"),
    ]);
    let mut all: Vec<Raw> = Vec::new();

    // 第 1 跳：新版 cloudsearch
    if let Some((status, data)) = post_form_json(
        client,
        "https://music.163.com/api/cloudsearch/pc",
        &[
            ("s", keyword),
            ("type", "1"),
            ("offset", "0"),
            ("limit", "10"),
        ],
        headers.clone(),
        REQUEST_TIMEOUT,
    )
    .await
    {
        if status == 200 {
            if let Some(songs) = data.pointer("/result/songs").and_then(|v| v.as_array()) {
                for song in songs {
                    let names: Vec<String> = song
                        .get("ar")
                        .and_then(|v| v.as_array())
                        .map(|ar| ar.iter().map(|item| s_of(item.get("name"))).collect())
                        .unwrap_or_default();
                    let artist_name = normalize_artist_credit_list(&names);
                    if is_fuzzy_match(hint, &artist_name) {
                        if let Some(r) = parse_netease_song(song, &artist_name) {
                            all.push(r);
                        }
                    }
                }
            }
        }
    }

    // 第 2 跳：旧版 search（仅当第 1 跳一无所获）
    if all.is_empty() {
        let form = [
            ("s", keyword),
            ("type", "1"),
            ("offset", "0"),
            ("total", "true"),
            ("limit", "10"),
        ];
        let mut hop = post_form_json(
            client,
            "https://music.163.com/api/search/get/web",
            &form,
            headers.clone(),
            REQUEST_TIMEOUT,
        )
        .await;
        if let Some((status, _)) = &hop {
            if *status != 200 {
                let params: Vec<(String, String)> = form
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
                hop = get_json(
                    client,
                    "https://music.163.com/api/search/get/web",
                    &params,
                    headers.clone(),
                    REQUEST_TIMEOUT,
                )
                .await;
            }
        }
        if let Some((status, data)) = hop {
            if status == 200 {
                if let Some(songs) = data.pointer("/result/songs").and_then(|v| v.as_array()) {
                    for song in songs {
                        let names: Vec<String> = song
                            .get("artists")
                            .and_then(|v| v.as_array())
                            .map(|ar| ar.iter().map(|item| s_of(item.get("name"))).collect())
                            .unwrap_or_default();
                        let artist_name = normalize_artist_credit_list(&names);
                        if !is_fuzzy_match(hint, &artist_name) {
                            continue;
                        }
                        // 旧版字段适配：song['al'] = song.get('album', {})
                        let mut patched = song.clone();
                        if let Some(obj) = patched.as_object_mut() {
                            let album = song.get("album").cloned().unwrap_or(Value::Null);
                            obj.insert("al".to_string(), album);
                        }
                        if let Some(r) = parse_netease_song(&patched, &artist_name) {
                            all.push(r);
                        }
                    }
                }
            }
        }
    }

    if all.is_empty() {
        return None;
    }
    all.sort_by(|a, b| {
        netease_title_score(&b.title, keyword).cmp(&netease_title_score(&a.title, keyword))
    });
    all.into_iter().next()
}

/// 单源结果：候选 + 上游诊断 + 结构性失败原因。
///
/// * `note`：一行「上游情况」（HTTP 状态 / 命中数 / 失败原因），正常时也填。
///   `live_verify_extra_sources` 直接打印它，`SourceStatus` 不展示。
/// * `error`：**只在结构性失败**时非空（接口下线 / 凭据被拒 / 响应无法解析），会进
///   `SourceStatus.error`；单纯「没命中」不算错误。
#[derive(Debug, Default, Clone)]
struct SourceRun {
    raws: Vec<Raw>,
    /// 生产路径只写不读（`--selftest-scrape` 走 `print_scrape_statuses` 打的是 `error`）；
    /// 真实读数的人是 `live_verify_extra_sources`，所以这里显式关掉 dead_code 提示。
    #[allow(dead_code)]
    note: String,
    error: String,
}

impl SourceRun {
    /// 没有异常（可能命中 0 条）。
    fn ok(raws: Vec<Raw>, note: impl Into<String>) -> Self {
        SourceRun {
            raws,
            note: note.into(),
            error: String::new(),
        }
    }

    /// 单个候选的包装。
    fn single(raw: Option<Raw>, note: impl Into<String>) -> Self {
        SourceRun::ok(raw.into_iter().collect(), note)
    }

    /// 结构性失败：同一句话同时进 `note` 与 `error`。
    fn fail(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        SourceRun {
            raws: Vec::new(),
            note: reason.clone(),
            error: reason,
        }
    }
}

/// QQ 音乐搜索。
///
/// **2026-10-08 上游改版实测**：老的 `https://c.y.qq.com/soso/fcgi-bin/client_search_cp`
/// 现在固定返回 **HTTP 500 + 空响应体**（带不带参数、Referer、UA 都一样）——这就是这个源
/// 「有解析单测但真实联网恒为 0」的原因。同域下的 `search_for_qq_cp` 仍然可用
/// （200 + `data.song.list`，形状与原实现一致），只是发布时间字段从 `time_public`
/// 变成 `pubtime`（unix 秒，`parse_qq` 已兼容）。
async fn search_qq(client: &reqwest::Client, keyword: &str, hint: &str) -> SourceRun {
    let url = with_query(
        "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
        &[
            ("w", keyword),
            ("n", "10"),
            ("p", "1"),
            ("format", "json"),
            ("cr", "1"),
            ("t", "0"),
            ("remoteplace", "txt.yqq.center"),
            ("g_tk", "5381"),
            ("loginUin", "0"),
            ("hostUin", "0"),
            ("inCharset", "utf8"),
            ("outCharset", "utf-8"),
            ("notice", "0"),
            ("platform", "yqq.json"),
            ("needNewCode", "0"),
        ],
    );
    let headers = hdrs(&[("Referer", "https://y.qq.com/"), ("User-Agent", CHROME_UA)]);
    let fetch = match fetch_json(client, &url, headers, REQUEST_TIMEOUT).await {
        Ok(fetch) => fetch,
        Err(err) => return SourceRun::fail(format!("QQ 音乐：请求失败（{err}）")),
    };
    if fetch.status != 200 {
        return SourceRun::fail(format!(
            "QQ 音乐：HTTP {}（上游改版？响应前 80 字符：{}）",
            fetch.status,
            fetch.head(80)
        ));
    }
    let Some(data) = fetch.data.as_ref() else {
        return SourceRun::fail(format!(
            "QQ 音乐：HTTP 200 但响应不是 JSON（前 80 字符：{}）",
            fetch.head(80)
        ));
    };
    let hits = data
        .pointer("/data/song/list")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let raw = parse_qq(data, keyword, hint);
    SourceRun::single(
        raw,
        format!("HTTP 200，data.song.list={hits} 条（关键词只用标题）"),
    )
}

/// 酷我搜索。
///
/// **2026-10-08 上游改版实测**：`search.kuwo.cn/r.s` 仍然可用，但**必须带 `rn`/`pn`**——不带时
/// 上游返回 `HIT=0 / HITMODE=nores`（这是老实现恒为 0 的第二个原因，第一个是响应体不再有
/// `jsondata = ` 前缀）。关键词只用**标题**：真实探针里 `all=稻香` 命中 1317 条，
/// `all=稻香 周杰伦` 命中 1564 条但把用户上传（`ALBUMID=0`）顶到前面、附带信息反而更少。
async fn search_kuwo(client: &reqwest::Client, keyword: &str, hint: &str) -> SourceRun {
    let mut failure = String::new();
    for proto in ["https", "http"] {
        let url = format!(
            "{proto}://search.kuwo.cn/r.s?all={}&ft=music&itemset=web_2013&client=kt&rformat=json&encoding=utf8&rn=30&pn=0",
            pct_encode(keyword)
        );
        let Some((status, body)) = get_text(client, &url, HeaderMap::new(), REQUEST_TIMEOUT).await
        else {
            failure = format!("酷我：{proto} 请求失败（网络 / DNS / TLS）");
            continue;
        };
        if status != 200 {
            failure = format!(
                "酷我：HTTP {status}（响应前 80 字符：{}）",
                prefix_chars(&body, 80)
            );
            continue;
        }
        let Some(data) = parse_repr_dict(&body) else {
            failure = format!(
                "酷我：响应不是可解析的字面量字典（前 80 字符：{}）",
                prefix_chars(&body, 80)
            );
            continue;
        };
        let hits = i_of(data.get("HIT")).unwrap_or(0);
        let hitmode = s_of(data.get("HITMODE"));
        let list_len = data
            .get("abslist")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let raw = kuwo_from_value(&data, hint);
        return SourceRun::single(
            raw,
            format!("HTTP 200，HIT={hits} HITMODE={hitmode}，abslist={list_len} 条"),
        );
    }
    // 两个协议都失败（契约 H-6：不复刻 Python 的隐式 NameError）
    SourceRun::fail(failure)
}

/// 酷狗搜索 + 详情（第 1 跳搜索，第 2 跳手机版详情）。
///
/// **2026-10-08 上游改版实测**：
/// * 旧第 1 跳 `https://mobilecdn.kugou.com/api/v3/search/song` 的证书是 `*.kugou.com`，
///   **不匹配 `mobilecdn.kugou.com`**（curl -k 能拿到 200 + 真实数据，但 rustls/schannel
///   校验失败 `SEC_E_WRONG_PRINCIPAL`）→ 换成 TLS 正常的
///   `https://songsearch.kugou.com/song_search_v2`（200 + `data.lists[]`）；
/// * 旧第 2 跳 `https://www.kugou.com/yy/index.php?r=play/getdata` 现在要签名 Cookie，
///   固定返回 `{"status":0,"err_code":30020}`（`wwwapi` 同款也一样）→ 换成
///   `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<hash>`（200，扁平 JSON）。
async fn search_kugou(client: &reqwest::Client, keyword: &str, hint: &str) -> SourceRun {
    let search_url = with_query(
        "https://songsearch.kugou.com/song_search_v2",
        &[
            ("format", "json"),
            ("keyword", keyword),
            ("page", "1"),
            ("pagesize", "20"),
        ],
    );
    let headers = hdrs(&[
        ("Referer", "https://www.kugou.com/"),
        ("User-Agent", CHROME_UA),
    ]);
    let fetch = match fetch_json(client, &search_url, headers, REQUEST_TIMEOUT).await {
        Ok(fetch) => fetch,
        Err(err) => return SourceRun::fail(format!("酷狗：搜索请求失败（{err}）")),
    };
    if fetch.status != 200 {
        return SourceRun::fail(format!(
            "酷狗：搜索 HTTP {}（响应前 80 字符：{}）",
            fetch.status,
            fetch.head(80)
        ));
    }
    let Some(data) = fetch.data.as_ref() else {
        return SourceRun::fail(format!(
            "酷狗：搜索 HTTP 200 但响应不是 JSON（前 80 字符：{}）",
            fetch.head(80)
        ));
    };
    let candidates = data
        .pointer("/data/lists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let detail_headers = hdrs(&[("Referer", "https://m.kugou.com/"), ("User-Agent", CHROME_UA)]);
    let mut matched = 0usize;
    let mut detail_error = String::new();
    for song in &candidates {
        let artist_name = norm_simple(&s_of(song.get("SingerName")));
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        matched += 1;
        let file_hash = s_of(song.get("FileHash"));
        if file_hash.is_empty() {
            continue;
        }
        let detail_url = with_query(
            "https://m.kugou.com/app/i/getSongInfo.php",
            &[("cmd", "playInfo"), ("hash", &file_hash)],
        );
        let detail = match fetch_json(
            client,
            &detail_url,
            detail_headers.clone(),
            REQUEST_TIMEOUT,
        )
        .await
        {
            Ok(detail) => detail,
            Err(err) => {
                detail_error = format!("酷狗：详情请求失败（{err}）");
                continue;
            }
        };
        if detail.status != 200 {
            detail_error = format!(
                "酷狗：详情 HTTP {}（前 80 字符：{}）",
                detail.status,
                detail.head(80)
            );
            continue;
        }
        let Some(detail_data) = detail.data.as_ref() else {
            detail_error = format!(
                "酷狗：详情 HTTP 200 但响应不是 JSON（前 80 字符：{}）",
                detail.head(80)
            );
            continue;
        };
        if let Some(raw) = parse_kugou_detail(detail_data, Some(song)) {
            return SourceRun::single(
                Some(raw),
                format!(
                    "HTTP {}，lists={} 条（歌手匹配 {matched} 条），详情 HTTP {}",
                    fetch.status,
                    candidates.len(),
                    detail.status
                ),
            );
        }
    }
    if candidates.is_empty() {
        return SourceRun::fail(format!(
            "酷狗：HTTP 200 但 data.lists 为空（上游改版？前 80 字符：{}）",
            fetch.head(80)
        ));
    }
    if !detail_error.is_empty() {
        return SourceRun {
            raws: Vec::new(),
            note: detail_error.clone(),
            error: detail_error,
        };
    }
    SourceRun::single(
        None,
        format!(
            "HTTP {}，lists={} 条，歌手匹配 {matched} 条，但没有带封面的详情",
            fetch.status,
            candidates.len()
        ),
    )
}

async fn search_musicbrainz(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    mb_throttle().await;
    let query = format!("recording:\"{keyword}\" AND artist:\"{hint}\"");
    let params = vec![
        ("query".to_string(), query),
        ("fmt".to_string(), "json".to_string()),
        ("limit".to_string(), "3".to_string()),
    ];
    let (_, data) = get_json(
        client,
        "https://musicbrainz.org/ws/2/recording",
        &params,
        hdrs(&[("User-Agent", MB_USER_AGENT)]),
        REQUEST_TIMEOUT,
    )
    .await?;
    parse_musicbrainz(&data, hint)
}

/// 跨地区合并去重：键 = `(title.casefold(), artist.casefold())`（`scrapebridge.py:454`）。
fn push_unique(found: &mut Vec<Raw>, seen: &mut HashSet<(String, String)>, raw: Raw) -> bool {
    let key = (casefold(&raw.title), casefold(&raw.artist));
    if seen.insert(key) {
        found.push(raw);
        true
    } else {
        false
    }
}

/// 每源上限：`found[:max(1, limit)]`（契约 A5.3）。
fn truncate_per_source(mut found: Vec<Raw>, limit: usize) -> Vec<Raw> {
    found.truncate(limit.max(1));
    found
}

/// iTunes：按 US → CN → TW → HK 依次跑，`(title, artist)` 去重，够 limit 就停。
async fn search_itunes(client: &reqwest::Client, keyword: &str, hint: &str, limit: usize) -> Vec<Raw> {
    let mut found: Vec<Raw> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for region in ["US", "CN", "TW", "HK"] {
        let params = vec![
            ("term".to_string(), keyword.to_string()),
            ("media".to_string(), "music".to_string()),
            ("entity".to_string(), "song".to_string()),
            ("limit".to_string(), "5".to_string()),
            ("country".to_string(), region.to_string()),
            ("lang".to_string(), "zh_cn".to_string()),
        ];
        if let Some((_, data)) = get_json(
            client,
            "https://itunes.apple.com/search",
            &params,
            hdrs(&[("User-Agent", CHROME_UA)]),
            REQUEST_TIMEOUT,
        )
        .await
        {
            if let Some(raw) = parse_itunes(&data, region, hint) {
                push_unique(&mut found, &mut seen, raw);
            }
        }
        if found.len() >= limit {
            break;
        }
    }
    truncate_per_source(found, limit)
}

async fn search_deezer(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    let params = vec![
        ("q".to_string(), keyword.to_string()),
        ("limit".to_string(), "3".to_string()),
    ];
    let (_, data) = get_json(
        client,
        "https://api.deezer.com/search",
        &params,
        HeaderMap::new(),
        REQUEST_TIMEOUT,
    )
    .await?;
    let (_, album_id) = deezer_candidate(&data, hint, None)?;
    let mut date_override: Option<String> = None;
    if let Some(album_id) = album_id.filter(|id| !id.is_empty()) {
        let url = format!("https://api.deezer.com/album/{album_id}");
        if let Some((status, album_data)) = get_json(
            client,
            &url,
            &[],
            HeaderMap::new(),
            DEEZER_ALBUM_TIMEOUT,
        )
        .await
        {
            if status == 200 {
                let value = s_of(album_data.get("release_date"));
                if !value.is_empty() {
                    date_override = Some(value);
                }
            }
        }
    }
    let (raw, _) = deezer_candidate(&data, hint, date_override.as_deref())?;
    Some(raw)
}

fn lastfm_api_key() -> String {
    match std::env::var("LASTFM_API_KEY") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => LASTFM_BUILTIN_API_KEY.to_string(),
    }
}

/// Last.fm 的错误响应 → 可读原因（真实报文：HTTP 403 +
/// `{"message":"Invalid API key - You must be granted a valid key by last.fm","error":10}`）。
fn lastfm_error_reason(status: u16, body: &Value) -> String {
    let message = s_of(body.get("message"));
    let code = i_of(body.get("error")).unwrap_or(0);
    if code == 10 {
        return format!(
            "Last.fm：API Key 被上游拒绝（HTTP {status} / error 10：{message}）；\
             请设置环境变量 LASTFM_API_KEY"
        );
    }
    if !message.is_empty() {
        return format!("Last.fm：HTTP {status} / error {code}：{message}");
    }
    format!("Last.fm：HTTP {status}（上游没给 message 字段）")
}

/// Last.fm 搜索（`track.search` → `track.getInfo`）。
///
/// **2026-10-08 实测**：内置 Key（`LASTFM_BUILTIN_API_KEY`）已被上游拒绝，`track.search`
/// 恒定返回 HTTP 403 + `error:10`，所以**不提供 `LASTFM_API_KEY` 时这个源恒为 0 条**
/// （这里如实暴露成 `SourceStatus.error`，不假装成功）。带有效 Key 时链路与原来一致。
async fn search_lastfm(client: &reqwest::Client, keyword: &str, hint: &str) -> SourceRun {
    let api_key = lastfm_api_key();
    let search_url = with_query(
        "https://ws.audioscrobbler.com/2.0/",
        &[
            ("method", "track.search"),
            ("track", keyword),
            ("api_key", &api_key),
            ("format", "json"),
            ("limit", "5"),
        ],
    );
    let headers = hdrs(&[("User-Agent", CHROME_UA)]);
    let fetch = match fetch_json(client, &search_url, headers.clone(), REQUEST_TIMEOUT).await {
        Ok(fetch) => fetch,
        Err(err) => return SourceRun::fail(format!("Last.fm：请求失败（{err}）")),
    };
    let Some(data) = fetch.data.as_ref() else {
        return SourceRun::fail(format!(
            "Last.fm：HTTP {} 响应不是 JSON（前 80 字符：{}）",
            fetch.status,
            fetch.head(80)
        ));
    };
    // 鉴权/参数错误：上游用非 200 + `error` 字段表达
    if data.get("error").is_some() {
        return SourceRun::fail(lastfm_error_reason(fetch.status, data));
    }
    let results = data
        .pointer("/results/trackmatches/track")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut matched = 0usize;
    for track in &results {
        let artist_name = s_of(track.get("artist"));
        if !is_fuzzy_match(hint, &artist_name) {
            continue;
        }
        matched += 1;
        let info_url = with_query(
            "https://ws.audioscrobbler.com/2.0/",
            &[
                ("method", "track.getInfo"),
                ("api_key", &api_key),
                ("artist", &artist_name),
                ("track", &s_of(track.get("name"))),
                ("format", "json"),
            ],
        );
        let track_info: Option<Value> = fetch_json(client, &info_url, headers.clone(), REQUEST_TIMEOUT)
            .await
            .ok()
            .and_then(|f| f.data)
            .map(|v| {
                v.get("track")
                    .cloned()
                    .unwrap_or(Value::Object(Default::default()))
            });
        if let Some(raw) = parse_lastfm_info(track_info.as_ref(), track, &artist_name) {
            return SourceRun::single(
                Some(raw),
                format!(
                    "HTTP {}，trackmatches={} 条（歌手匹配 {matched} 条）",
                    fetch.status,
                    results.len()
                ),
            );
        }
    }
    SourceRun::single(
        None,
        format!(
            "HTTP {}，trackmatches={} 条（歌手匹配 {matched} 条）",
            fetch.status,
            results.len()
        ),
    )
}

/// TheAudioDB Key（环境变量 `THEAUDIODB_API_KEY` 优先）。
fn theaudiodb_api_key() -> String {
    match std::env::var("THEAUDIODB_API_KEY") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => THEAUDIODB_BUILTIN_API_KEY.to_string(),
    }
}

/// TheAudioDB 搜索（`searchtrack.php` → `album.php` 取封面/年份）。
///
/// **2026-10-08 上游改版实测**：
/// * 内置 Key `"2"` 现在被拒绝（`/api/v1/json/2/…` → HTTP 404 `{"Message":"Not found"}`），
///   换成公开示例 Key `"123"`（200 + 真实数据）；
/// * `searchtrack.php` 现在**必须同时给 `s`（歌手）与 `t`（曲名）**：只给 `s` 时上游回
///   HTTP 200 + **0 字节**（旧实现只给 `s`，所以恒为 0 条）；
/// * 该库以欧美曲目为主，中文歌（如周杰伦《稻香》）上游本身没有数据（`search.php` 返回
///   `{"artists":null}`），这时是「没命中」而不是错误。
async fn search_theaudiodb(client: &reqwest::Client, keyword: &str, hint: &str) -> SourceRun {
    let key = theaudiodb_api_key();
    let artist_query = if hint.is_empty() { keyword } else { hint };
    let url = with_query(
        &format!("https://www.theaudiodb.com/api/v1/json/{key}/searchtrack.php"),
        &[("s", artist_query), ("t", keyword)],
    );
    let headers = hdrs(&[("User-Agent", CHROME_UA)]);
    let fetch = match fetch_json(client, &url, headers.clone(), REQUEST_TIMEOUT).await {
        Ok(fetch) => fetch,
        Err(err) => return SourceRun::fail(format!("TheAudioDB：请求失败（{err}）")),
    };
    if fetch.status != 200 {
        return SourceRun::fail(format!(
            "TheAudioDB：HTTP {}（API Key 被拒？响应前 80 字符：{}）",
            fetch.status,
            fetch.head(80)
        ));
    }
    let Some(data) = fetch.data.as_ref() else {
        return SourceRun::fail(format!(
            "TheAudioDB：HTTP 200 但响应不是 JSON（空响应体？前 80 字符：{}）",
            fetch.head(80)
        ));
    };
    let tracks = data
        .get("track")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut matched = 0usize;
    for track in &tracks {
        let track_artist = s_of(track.get("strArtist"));
        if !is_fuzzy_match(hint, &track_artist) {
            continue;
        }
        matched += 1;
        let album_id = s_of(track.get("idAlbum"));
        let mut album_info: Option<Value> = None;
        if !album_id.is_empty() {
            let album_url = with_query(
                &format!("https://www.theaudiodb.com/api/v1/json/{key}/album.php"),
                &[("m", &album_id)],
            );
            if let Ok(album_fetch) =
                fetch_json(client, &album_url, headers.clone(), REQUEST_TIMEOUT).await
            {
                if let Some(first) = album_fetch
                    .data
                    .as_ref()
                    .and_then(|v| v.get("album"))
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                {
                    album_info = Some(first.clone());
                }
            }
        }
        if let Some(raw) = parse_theaudiodb(track, album_info.as_ref()) {
            return SourceRun::single(
                Some(raw),
                format!(
                    "HTTP 200，s={artist_query} t={keyword}，track={} 条（歌手匹配 {matched} 条）",
                    tracks.len()
                ),
            );
        }
    }
    SourceRun::single(
        None,
        format!(
            "HTTP 200，s={artist_query} t={keyword}，track={} 条（歌手匹配 {matched} 条）",
            tracks.len()
        ),
    )
}

/// Spotify access token（进程内缓存 + 提前 60 秒刷新）。
static SPOTIFY_TOKEN: Lazy<Mutex<(String, f64)>> = Lazy::new(|| Mutex::new((String::new(), 0.0)));

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

async fn spotify_token(client: &reqwest::Client) -> Option<String> {
    let now = now_secs();
    {
        let guard = SPOTIFY_TOKEN.lock().await;
        if !guard.0.is_empty() && now < guard.1 - 60.0 {
            return Some(guard.0.clone());
        }
    }
    let client_id = std::env::var("SPOTIFY_CLIENT_ID").unwrap_or_default();
    let client_secret = std::env::var("SPOTIFY_CLIENT_SECRET").unwrap_or_default();
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return None;
    }
    let auth = b64_encode(format!("{client_id}:{client_secret}").as_bytes());
    let headers = hdrs_owned(&[
        ("Authorization", format!("Basic {auth}")),
        ("Content-Type", "application/x-www-form-urlencoded".to_string()),
    ]);
    let (status, data) = post_form_json(
        client,
        "https://accounts.spotify.com/api/token",
        &[("grant_type", "client_credentials")],
        headers,
        Duration::from_secs(30),
    )
    .await?;
    if status == 200 {
        let token = s_of(data.get("access_token"));
        let expires_in = f_of(data.get("expires_in")).unwrap_or(3600.0);
        let mut guard = SPOTIFY_TOKEN.lock().await;
        guard.0 = token.clone();
        guard.1 = now + expires_in;
        if token.is_empty() {
            return None;
        }
        return Some(token);
    }
    None
}

async fn search_spotify(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    let token = spotify_token(client).await?;
    let headers = hdrs_owned(&[("Authorization", format!("Bearer {token}"))]);
    let q = if hint.is_empty() {
        keyword.to_string()
    } else {
        format!("track:{keyword} artist:{hint}")
    };
    let params = vec![
        ("q".to_string(), q),
        ("type".to_string(), "track".to_string()),
        ("limit".to_string(), "5".to_string()),
        ("market".to_string(), "from_token".to_string()),
    ];
    let (status, mut data) = get_json(
        client,
        "https://api.spotify.com/v1/search",
        &params,
        headers.clone(),
        Duration::from_secs(30),
    )
    .await?;
    if status != 200 {
        return None;
    }
    let empty = data
        .pointer("/tracks/items")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if empty && !hint.is_empty() {
        let params2 = vec![
            ("q".to_string(), keyword.to_string()),
            ("type".to_string(), "track".to_string()),
            ("limit".to_string(), "5".to_string()),
            ("market".to_string(), "from_token".to_string()),
        ];
        if let Some((status2, data2)) = get_json(
            client,
            "https://api.spotify.com/v1/search",
            &params2,
            headers.clone(),
            Duration::from_secs(30),
        )
        .await
        {
            if status2 == 200 {
                data = data2;
            }
        }
    }
    parse_spotify(&data, hint)
}

/// Genius Token：Python 读 `GENIUS_ACCESS_TOKEN`（配置文件键 `genius_access_token`）；
/// 这里同时认 Rust 侧的 `GENIUS_TOKEN`（`config.rs` 里的名字）。
fn genius_token() -> String {
    for key in ["GENIUS_ACCESS_TOKEN", "GENIUS_TOKEN"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

async fn search_genius(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    let token = genius_token();
    if token.is_empty() {
        return None;
    }
    let headers = hdrs_owned(&[("Authorization", format!("Bearer {token}"))]);
    let q = if hint.is_empty() {
        keyword.to_string()
    } else {
        format!("{keyword} {hint}")
    };
    let (status, data) = get_json(
        client,
        "https://api.genius.com/search",
        &[("q".to_string(), q)],
        headers,
        Duration::from_secs(30),
    )
    .await?;
    if status != 200 {
        return None;
    }
    parse_genius(&data, hint)
}

/// YouTube Music：Python 侧依赖可选的 `ytmusicapi` 库，本仓库既没有这个库也没有
/// 稳定的公开 HTTP 接口可复刻 → 恒返回 0 条（与 Python 在缺库时的可观测行为一致）。
async fn search_ytmusic(_client: &reqwest::Client, _keyword: &str, _hint: &str) -> Option<Raw> {
    None
}

async fn search_discogs(client: &reqwest::Client, keyword: &str, hint: &str) -> Option<Raw> {
    let token = match std::env::var("DISCOGS_TOKEN") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return None,
    };
    let headers = hdrs_owned(&[
        ("Authorization", format!("Discogs token={token}")),
        ("User-Agent", "CyberMediaToolkit/3.0".to_string()),
    ]);
    let q = if hint.is_empty() {
        keyword.to_string()
    } else {
        format!("{keyword} {hint}")
    };
    let params = vec![
        ("q".to_string(), q),
        ("type".to_string(), "master".to_string()),
        ("per_page".to_string(), "3".to_string()),
    ];
    let (status, data) = get_json(
        client,
        "https://api.discogs.com/database/search",
        &params,
        headers,
        Duration::from_secs(30),
    )
    .await?;
    if status != 200 {
        return None;
    }
    parse_discogs(&data, hint)
}

/// MusicBrainz 限速：两次请求间隔 ≥ 1.0s（`RateLimiter(MUSICBRAINZ_MIN_INTERVAL)`）。
static MB_LIMITER: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

async fn mb_throttle() {
    let mut guard = MB_LIMITER.lock().await;
    if let Some(last) = *guard {
        let elapsed = last.elapsed().as_secs_f64();
        if elapsed < MUSICBRAINZ_MIN_INTERVAL_SECS {
            let wait = MUSICBRAINZ_MIN_INTERVAL_SECS - elapsed;
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
        }
    }
    *guard = Some(Instant::now());
}

/// 单源执行（engine key → 候选 + 诊断）。
///
/// qq / kugou / kuwo / lastfm / theaudiodb 这 5 个源自己返回 `SourceRun`（带 HTTP 诊断与
/// 结构性失败原因），其余源仍然只是「候选」，这里统一包成 `SourceRun`（note/error 为空）。
async fn run_source(
    client: &reqwest::Client,
    name: &str,
    keyword: &str,
    hint: &str,
    limit: usize,
) -> SourceRun {
    let single = |raw: Option<Raw>| -> SourceRun { SourceRun::single(raw, "") };
    match name {
        "musicbrainz" => single(search_musicbrainz(client, keyword, hint).await),
        "netease" => single(search_netease(client, keyword, hint).await),
        "qq" => search_qq(client, keyword, hint).await,
        "kugou" => search_kugou(client, keyword, hint).await,
        "kuwo" => search_kuwo(client, keyword, hint).await,
        "itunes" => {
            let found = search_itunes(client, keyword, hint, limit.max(1)).await;
            SourceRun::ok(truncate_per_source(found, limit), "")
        }
        "deezer" => single(search_deezer(client, keyword, hint).await),
        "lastfm" => search_lastfm(client, keyword, hint).await,
        "theaudiodb" => search_theaudiodb(client, keyword, hint).await,
        "spotify" => single(search_spotify(client, keyword, hint).await),
        "genius" => single(search_genius(client, keyword, hint).await),
        "ytmusic" => single(search_ytmusic(client, keyword, hint).await),
        "discogs" => single(search_discogs(client, keyword, hint).await),
        _ => SourceRun::default(),
    }
}

// ==================== 对外搜索 ====================

/// 生效源列表：未知名字剔除；剔完为空则回退 `SEARCH_PRIORITY`（契约 H-3）。
fn effective_sources(requested: &[String]) -> Vec<String> {
    let valid: HashSet<&str> = SOURCE_NAMES.iter().copied().collect();
    let mut enabled: Vec<String> = if requested.is_empty() {
        SEARCH_PRIORITY.iter().map(|s| s.to_string()).collect()
    } else {
        requested
            .iter()
            .filter(|s| valid.contains(s.as_str()))
            .cloned()
            .collect()
    };
    if enabled.is_empty() {
        enabled = SEARCH_PRIORITY.iter().map(|s| s.to_string()).collect();
    }
    enabled
}

/// 并发扇出到多个源并打分排序。单源失败/超时只进 `source_status`，不影响整体。
pub async fn search_all(client: &reqwest::Client, q: &ScrapeQuery) -> ScrapeOutcome {
    let enabled = effective_sources(&q.sources);
    let limit = q.limit.max(1);
    let keyword = q.title.as_str();
    let hint = q.artist.as_str();
    let title_hint = Some(q.title.as_str());
    let duration_hint = q.duration;

    let mut futures = Vec::with_capacity(enabled.len());
    for name in &enabled {
        let name = name.clone();
        futures.push(async move {
            match tokio::time::timeout(
                PER_SOURCE_TIMEOUT,
                run_source(client, &name, keyword, hint, limit),
            )
            .await
            {
                Ok(run) => (name, run, String::new()),
                Err(_) => (name, SourceRun::default(), TIMEOUT_ERROR.to_string()),
            }
        });
    }
    let results = futures::future::join_all(futures).await;

    let mut source_status: Vec<SourceStatus> = Vec::with_capacity(results.len());
    let mut pairs: Vec<(Raw, Candidate)> = Vec::new();
    for (name, run, timeout_error) in results {
        let mut count = 0usize;
        for raw in run.raws {
            let cand = from_core(&raw, &name);
            pairs.push((raw, cand));
            count += 1;
        }
        // 超时优先；否则用源自己给出的结构性失败原因（lastfm 的 Key 被拒、qq 的 500 …）。
        let error = if timeout_error.is_empty() {
            run.error
        } else {
            timeout_error
        };
        source_status.push(SourceStatus {
            source: name,
            count,
            error,
        });
    }

    // 打分（core 口径）。本层没有本地回退打分，所以不存在「半途回退」的中间态（契约 H-10）。
    for (raw, cand) in pairs.iter_mut() {
        let score = score_candidate(raw, keyword, hint, title_hint, duration_hint);
        cand.score = score as f64;
        cand.confidence = confidence_level(score).to_string();
    }

    // 录音室专辑优先（搜索路径上候选的 context 恒为 ""，这里实际是恒等变换）
    filter_album_context(&mut pairs);

    let order: HashMap<String, usize> = enabled
        .iter()
        .enumerate()
        .map(|(i, name)| (name.clone(), i))
        .collect();
    sort_scored(&mut pairs, &order);

    ScrapeOutcome {
        candidates: pairs.into_iter().map(|(_, cand)| cand).collect(),
        source_status,
    }
}

// ==================== 歌词（E 节） ====================

/// LRCLIB 单条评分（`_lyrics_score`；无 fuzz 分支）。
fn lyrics_score(res: &Value, title: &str, artist: &str, duration: Option<f64>) -> i64 {
    let res_artist = s_of(res.get("artistName")).to_lowercase();
    let res_title = s_of(res.get("trackName")).to_lowercase();
    let res_duration = f_of(res.get("duration")).unwrap_or(0.0);
    let mut score = 0i64;
    if !artist.is_empty() {
        let art = artist.to_lowercase();
        if art.contains(&res_artist) || res_artist.contains(&art) {
            score += 30;
        }
    }
    if !title.is_empty() {
        let tit = title.to_lowercase();
        if tit == res_title {
            score += 40;
        } else if tit.contains(&res_title) || res_title.contains(&tit) {
            score += 30;
        }
    }
    if let Some(dur) = duration.filter(|d| *d != 0.0) {
        if res_duration != 0.0 {
            let diff = (res_duration as i64 - dur as i64).abs();
            if diff <= 3 {
                score += 20;
            } else if diff <= 10 {
                score += 10;
            } else if diff > 30 {
                score -= 15;
            }
        }
    }
    if truthy(res.get("syncedLyrics")) {
        score += 5;
    }
    score
}

/// 酷狗歌词候选评分（`_kugou_score`；无 fuzz 分支）。
fn kugou_lyrics_score(candidate: &Value, kw_title: &str, kw_artist: &str, keyword: &str, duration: Option<f64>) -> i64 {
    let s_name = s_of(candidate.get("songname")).to_lowercase();
    let s_artist = s_of(candidate.get("singername")).to_lowercase();
    let mut score = 0i64;
    if kw_title.contains(&s_name) || s_name.contains(kw_title) {
        score += 4;
    }
    if !kw_artist.is_empty() {
        if kw_artist.contains(&s_artist) || s_artist.contains(kw_artist) {
            score += 3;
        }
    }
    let kw_lower = keyword.to_lowercase();
    if kw_lower.contains(&s_name) || s_name.contains(&kw_lower) {
        score += 2;
    }
    if kw_lower.contains(&s_artist) || s_artist.contains(&kw_lower) {
        score += 1;
    }
    if let Some(dur) = duration.filter(|d| *d != 0.0) {
        if let Some(cand_duration) = f_of(candidate.get("duration")).filter(|d| *d != 0.0) {
            let diff = (cand_duration as i64 - dur as i64).abs();
            if diff <= 5 {
                score += 2;
            } else if diff <= 15 {
                score += 1;
            } else if diff > 30 {
                score -= 3;
            }
        }
    }
    score
}

async fn lrclib_lyrics(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration: Option<f64>,
) -> Option<String> {
    let mut params: Vec<(String, String)> = vec![
        ("track_name".to_string(), title.to_string()),
        ("artist_name".to_string(), artist.to_string()),
    ];
    if let Some(album) = album.filter(|a| !a.trim().is_empty()) {
        params.push(("album_name".to_string(), album.to_string()));
    }
    if let Some(duration) = duration.filter(|d| *d != 0.0) {
        params.push(("duration".to_string(), py_float_str(duration)));
    }
    if let Some((status, data)) = get_json(
        client,
        "https://lrclib.net/api/get",
        &params,
        HeaderMap::new(),
        Duration::from_secs(15),
    )
    .await
    {
        if status == 200 {
            // Python：return data.get('syncedLyrics', data.get('plainLyrics'))，**不再走搜索兜底**
            let value = data
                .get("syncedLyrics")
                .or_else(|| data.get("plainLyrics"))
                .cloned()
                .unwrap_or(Value::Null);
            let text = s_of(Some(&value));
            return if text.is_empty() { None } else { Some(text) };
        }
    }
    let search_params = vec![("q".to_string(), format!("{title} {artist}"))];
    let (status, data) = get_json(
        client,
        "https://lrclib.net/api/search",
        &search_params,
        HeaderMap::new(),
        Duration::from_secs(15),
    )
    .await?;
    if status != 200 {
        return None;
    }
    let results = data.as_array().filter(|a| !a.is_empty())?;
    let mut scored: Vec<(usize, i64)> = results
        .iter()
        .enumerate()
        .map(|(i, res)| (i, lyrics_score(res, title, artist, duration)))
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    for (i, _) in &scored {
        if truthy(results[*i].get("syncedLyrics")) {
            return Some(s_of(results[*i].get("syncedLyrics")));
        }
    }
    for (i, _) in &scored {
        if truthy(results[*i].get("plainLyrics")) {
            return Some(s_of(results[*i].get("plainLyrics")));
        }
    }
    None
}

async fn kugou_lyrics(client: &reqwest::Client, keyword: &str, duration: Option<f64>) -> Option<String> {
    let search_url = format!(
        "https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={keyword}&page=1&pagesize=5"
    );
    let (_, data) = get_json(
        client,
        &search_url,
        &[],
        HeaderMap::new(),
        Duration::from_secs(15),
    )
    .await?;
    let candidates = data
        .pointer("/data/info")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if candidates.is_empty() {
        return None;
    }
    let kw_lower = keyword.to_lowercase();
    let parts: Vec<&str> = kw_lower.split_whitespace().collect();
    let kw_title = parts.first().copied().unwrap_or(kw_lower.as_str()).to_string();
    let kw_artist = parts.iter().skip(1).copied().collect::<Vec<_>>().join(" ");
    let mut best_idx = 0usize;
    let mut best_score = -1i64;
    for (idx, candidate) in candidates.iter().enumerate() {
        let score = kugou_lyrics_score(candidate, &kw_title, &kw_artist, keyword, duration);
        if score > best_score {
            best_score = score;
            best_idx = idx;
        }
    }
    let best_hash = s_of(candidates[best_idx].get("hash"));
    if best_hash.is_empty() {
        return None;
    }
    let lrc_url = format!(
        "https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash={best_hash}&album_audio_id="
    );
    let (_, lrc_data) = get_json(
        client,
        &lrc_url,
        &[],
        HeaderMap::new(),
        Duration::from_secs(15),
    )
    .await?;
    let status_ok = i_of(lrc_data.get("status")).unwrap_or(0) == 200;
    let first = lrc_data
        .get("candidates")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());
    if !status_ok || first.is_none() {
        return None;
    }
    let info = first?;
    let access_key = s_of(info.get("accesskey"));
    let id_val = s_of(info.get("id"));
    let dl_url = format!(
        "https://lyrics.kugou.com/download?ver=1&client=pc&id={id_val}&accesskey={access_key}&fmt=lrc&charset=utf8"
    );
    let (_, json_res) = get_json(
        client,
        &dl_url,
        &[],
        HeaderMap::new(),
        Duration::from_secs(15),
    )
    .await?;
    let b64 = s_of(json_res.get("content"));
    if b64.is_empty() {
        return None;
    }
    let bytes = b64_decode(&b64)?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

/// 歌词链：LRCLIB → 酷狗（本 App 路径上拿不到 netease_id / qq_mid，所以只有第 3、4 段）。
///
/// 注意契约 H-1：Python 的 `/api/scrape/apply` 把 duration 当 album 传（参数错位），
/// 这里按批量路径的**正确**语义实现（album 是专辑名，duration 是秒数）。
pub async fn fetch_lyrics(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration: Option<f64>,
) -> Option<(String, String)> {
    if let Some(text) = lrclib_lyrics(client, title, artist, album, duration).await {
        return Some((text, "Lrclib.net".to_string()));
    }
    if let Some(text) = kugou_lyrics(client, &format!("{title} {artist}"), duration).await {
        return Some((text, "酷狗音乐".to_string()));
    }
    None
}

// ==================== 封面（E 节） ====================

/// 下载封面：`Content-Type` 取分号前一段（默认 `image/jpeg`），超过 6 MiB 直接放弃。
pub async fn fetch_cover(client: &reqwest::Client, url: &str) -> Option<(Vec<u8>, String)> {
    if url.is_empty() {
        return None;
    }
    let resp = client
        .get(url)
        .timeout(COVER_TIMEOUT)
        .headers(hdrs(&[("User-Agent", APP_USER_AGENT)]))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let mut body: Vec<u8> = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() > COVER_MAX_BYTES {
                    return None;
                }
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some((body, mime))
}

// ==================== base64（自己写，不引依赖） ====================

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64 编码（带 padding）。
fn b64_encode(input: &[u8]) -> String {
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 标准 base64 解码（忽略空白，遇 `=` 结束；非法字符 → `None`）。
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for ch in input.chars() {
        if ch == '=' {
            break;
        }
        if ch.is_whitespace() {
            continue;
        }
        let byte = ch as u8;
        let value = B64_ALPHABET.iter().position(|c| *c == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

// ==================== iTunes 流派翻译（normalize.RAW_GENRE_TRANSLATE） ====================

/// `translate_raw_genre`：全表照抄，空输入 → `未知`。
fn translate_raw_genre(text: &str) -> String {
    if text.is_empty() {
        return "未知".to_string();
    }
    if let Some(hit) = raw_genre_table(text) {
        return simple_convert(hit);
    }
    let normalized = text.replace('&', "/");
    let parts: Vec<String> = normalized
        .split('/')
        .map(|p| {
            let p = p.trim();
            match raw_genre_table(p) {
                Some(hit) => hit.to_string(),
                None => p.to_string(),
            }
        })
        .collect();
    simple_convert(&parts.join(" / "))
}

fn raw_genre_table(key: &str) -> Option<&'static str> {
    let table: &[(&str, &str)] = &[
        ("韩国流行乐", "韩流·悸动"),
        ("K-Pop", "韩流·悸动"),
        ("Kpop", "韩流·悸动"),
        ("Korean Pop", "韩流·悸动"),
        ("日本流行乐", "日系·元气"),
        ("J-Pop", "日系·元气"),
        ("Jpop", "日系·元气"),
        ("Japanese Pop", "日系·元气"),
        ("华语流行", "华语·经典"),
        ("C-Pop", "华语·流行"),
        ("Cantopop", "粤语·风华"),
        ("Mandopop", "华语·经典"),
        ("嘻哈/说唱", "嘻哈·街头"),
        ("Hip-Hop/Rap", "嘻哈·街头"),
        ("Rap", "嘻哈·街头"),
        ("Hip Hop", "嘻哈·街头"),
        ("R&B/Soul", "R&B·丝滑"),
        ("R&B/索尔", "R&B·丝滑"),
        ("节奏布鲁斯", "R&B·丝滑"),
        ("Soundtrack", "影视·原声"),
        ("Original Soundtrack", "影视·原声"),
        ("TV Soundtrack", "剧集·原声"),
        ("Movie Soundtrack", "光影·原声"),
        ("Score", "配乐·史诗"),
        ("OST", "影视·原声"),
        ("原声带", "影视·原声"),
        ("Anime", "二次元·羁绊"),
        ("Animation", "二次元·羁绊"),
        ("Game", "游戏·史诗"),
        ("Video Game", "游戏·史诗"),
        ("Rock", "摇滚·热血"),
        ("Alternative", "另类·独白"),
        ("Alternative Rock", "另类·摇滚"),
        ("Indie", "独立·微醺"),
        ("Indie Rock", "独立·躁动"),
        ("Indie Pop", "独立·微醺"),
        ("Punk", "朋克·叛逆"),
        ("Post-Punk", "后朋·阴郁"),
        ("Heavy Metal", "金属·狂潮"),
        ("Metal", "金属·狂潮"),
        ("Electronic", "电子·脉冲"),
        ("Electronica", "电子·实验"),
        ("Dance", "舞曲·狂欢"),
        ("Club", "舞曲·夜店"),
        ("House", "浩室·深邃"),
        ("Deep House", "浩室·深邃"),
        ("Techno", "工业·科技"),
        ("Trance", "出神·迷离"),
        ("Dubstep", "低音·轰炸"),
        ("EDM", "电音·狂潮"),
        ("Disco", "迪斯科·复古"),
        ("Synthwave", "赛博·霓虹"),
        ("Vaporwave", "蒸汽·波"),
        ("Folk", "民谣·故事"),
        ("Country", "乡村·公路"),
        ("Acoustic", "原声·纯粹"),
        ("Jazz", "爵士·醇酒"),
        ("Blues", "蓝调·忧愁"),
        ("Vocal", "人声·天籁"),
        ("Singer/Songwriter", "唱作·独白"),
        ("Ballad", "流行·深情"),
        ("Dream Pop", "梦幻·空灵"),
        ("Shoegaze", "梦幻·自赏"),
        ("Classical", "古典·永恒"),
        ("Instrumental", "纯音·意境"),
        ("New Age", "新世纪·灵性"),
        ("World", "世界·风情"),
        ("Children's Music", "儿歌·纯真"),
        ("Holiday", "节日·庆典"),
        ("Gufeng", "古风·江湖"),
        ("Zhongguo Feng", "中国风·雅韵"),
        ("Country Music", "乡村·公路"),
        ("乡村", "乡村·公路"),
        ("乡村乐", "乡村·公路"),
        ("Christmas", "节日·庆典"),
        ("Xmas", "节日·庆典"),
        ("Festive", "节日·庆典"),
        ("节庆", "节日·庆典"),
        ("原声配乐", "影视·原声"),
        ("电影原声", "光影·原声"),
    ];
    table
        .iter()
        .find(|(key_name, _)| *key_name == key)
        .map(|(_, value)| *value)
}

// ==================== 简繁归一表（zhconv 1.4.3 导出） ====================

/// 传统字 → 简体字（由 zhconv 1.4.3 的 zh-cn 表在 BMP CJK 区间逐字导出，4056 对）。
const T2S_TRAD: &str = concat!(
    "丟丣並乗乹乾亁亂亙亝亞亱亷亾佇佈佔併來侖侶侷俁係俓俔俠俥俬俻倀倆倈倉個倐們倖倣倫倲倸偉偑側偵偽傌傑傖傘備傚傢傭傯傳傴債傷傾僂僅僉",
    "僊働僑僕僞僤僥僨僱價儀儁儂億儈儉儌儎儐儔儕儘償儣優儭儲儷儸儺儻儼兇兌兎兒兗兠內兩冄冊冐冑冪冺凈凍凙凜凢凱凴別刦刧刪刼剄則剉剋剎剏",
    "剗剙剛剝剮剳剴創剷剹剾劃劄劇劉劊劌劍劏劑劒劚効勁勅勌勑動務勛勝勞勢勣勦勩勱勳勵勸勻匟匭匯匱匲匳區協卹卻卽厀厙厠厤厭厰厲厴參叄叢吒",
    "吚吳吶呂呌呪咊咼員哯哶唄唓唕唘唚唸啎問啑啓啗啞啟啢啣喎喚喪喫喬單喲嗁嗆嗇嗊嗎嗚嗩嗰嗶嗹嘆嘍嘑嘓嘔嘖嘗嘜嘠嘩嘪嘮嘯嘰嘳嘵嘷嘸嘺嘽噁",
    "噅噉噓噚噝噞噠噥噦噯噲噴噸噹嚀嚇嚌嚐嚕嚙嚛嚥嚦嚧嚨嚮嚲嚳嚴嚶嚽囀囁囂囃囅囈囉囌囑囒囓囙囪圅圇國圍園圓圖團圞坿垜垻埡埨埬埰執堅堊堖",
    "堚堝堯報場塊塋塏塒塗塚塟塢塤塲塵塸塹塿墊墖墜墠墮墰墲墳墶墻墾壇壈壋壎壓壗壘壙壚壜壞壟壠壢壣壩壪壯壺壻壼壽夘夠夢夥夾奐奧奩奪奬奮奼",
    "妝妬妳妷姉姍姙姦姪姸娙娛婁婡婣婦婬婭媈媍媧媯媰媼媽媿嫋嫗嫰嫵嫺嫻嫿嬀嬃嬇嬈嬋嬌嬙嬝嬡嬣嬤嬦嬪嬭嬰嬸嬻嬾孃孄孆孇孋孌孎孫學孻孼孾孿",
    "宂宮寀寃寑寠寢實寧審寫寬寳寵寶尅將專尋對導尒尙尟尠尷屆屍屓屛屜屢層屨屩屬屭岅岡峝峯峴島峽崍崑崗崙崢崬嵐嵗嵼嵽嵾嶁嶃嶄嶇嶈嶔嶗嶘嶠",
    "嶢嶧嶨嶮嶸嶹嶺嶼嶽巊巋巒巔巖巗巘巠巰巵巹帀帋帥師帬帳帶幀幃幇幑幓幗幘幙幚幝幟幣幩幫幬幹幾庫庻庽廁廂廄廈廎廐廕廚廝廞廟廠廡廢廣廧廩",
    "廬廳廵廹廻弒弔弳張強彃彄彆彈彌彎彔彙彞彠彥彫彲彿徃後徑從徠徧復徵徹徿怱怳恆恠恡恥悅悞悤悵悶悽惏惡惥惱惲惷惻愛愜愨愴愷愻愽愾慄態慍",
    "慘慙慚慟慣慤慪慫慮慳慴慶慺慼慽慾憂憇憊憍憐憑憒憖憚憢憤憫憮憲憶憸憹懀懇應懌懍懎懞懟懣懤懧懨懲懶懷懸懺懼懾戀戇戔戞戧戩戰戱戲戶戹扞",
    "抝拋拚挩挱挵挾捄捨捫捱捲掃掄掆掗掙掚掛採掽揀揑揚換揫揮揯揷揹搆搇搉損搖搗搤搥搨搯搵搶搾摃摋摐摑摜摟摯摳摶摺摻撈撊撏撐撓撝撟撡撣撥",
    "撦撧撫撲撳撻撾撿擁擄擇擊擋擓擔擕據擟擠擣擥擧擫擬擯擰擱擲擴擷擺擻擼擽擾攄攆攋攏攔攖攙攛攜攝攢攣攤攩攪攬攷敂敍敎敓敗敘敵數敺斂斃斅",
    "斆斕斬斷斸於旂旣旤旹旾昇昬時晉晛晝暈暉暐暘暢暫暱曄曆曇曉曊曏曖曠曡曥曨曬書會朞朢朥朧朮朶東杴枱枴柵柺査栁栞栢栰桒桮桱桺桿梔梖梘梜",
    "條梟梲棄棊棖棗棟棡棧棲棶椏椗椲椶椷椾楇楊楓楥楨業極榘榦榪榮榲榿構槍槓槕槤槧槨槫槮槳槶槼樁樂樅樑樓標樞樠樢樣樤樧樫樳樸樹樺樿橈橋橜",
    "機橢橫橯檁檉檔檜檟檢檣檭檮檯檳檵檸檻櫃櫅櫈櫍櫓櫚櫛櫝櫞櫟櫠櫥櫧櫨櫪櫫櫬櫱櫳櫸櫻欄欅欇權欍欏欐欑欒欓欖欘欝欞欵欽歎歐歛歟歡歲歴歷歸",
    "歿殀殘殞殢殤殨殫殭殮殯殰殲殺殻殼毀毆毊毧毬毿氂氈氊氌氣氫氬氭氳氷氾汎汙汚決沒沖況泝洩洶浹浿涇涖涗涼淒淚淛淥淨淩淪淵淶淺渖渙減渢渦",
    "測渾湊湋湞湧湯湼溈準溝溡溫溮溳溼滄滅滌滎滙滛滬滯滲滷滸滻滾滿漁漊漍漚漢漣漬漲漵漸漿潁潄潑潔潕潙潚潛潣潤潯潰潷潿澀澁澅澆澇澐澗澠澤",
    "澦澩澫澬澮澱澾濁濃濄濆濇濕濘濚濛濜濟濤濧濫濰濱濶濺濼濾濿瀂瀃瀅瀆瀇瀉瀋瀏瀕瀘瀝瀟瀠瀦瀧瀨瀰瀲瀾灃灄灋灍灑灒灕灘灙灝灠灡灣灤灧灩災",
    "為烏烖烴無煇煉煑煒煗煙煢煥煩煬煱熂熅熈熉熌熒熓熗熚熡熰熱熲熾燀燁燄燈燉燒燖燙燜營燦燬燭燴燶燻燼燾爃爄爇爍爐爖爗爛爥爧爭爲爺爾牀牆",
    "牋牎牐牓牕牘牠牴牽犖犛犞犢犧狀狥狹狽猂猌猙猨猶猻獁獃獄獅獊獎獘獧獨獩獪獫獮獰獱獲獵獷獸獺獻獼玀玁玅珼現琖琱琺琿瑇瑋瑒瑣瑤瑩瑪瑯瑲",
    "瑻瑽璉璊璕璗璝璡璢璣璦璫璯環璵璸璼璽璾璿瓄瓅瓊瓏瓔瓕瓚瓛甌甎甕甖甞產産甦甯畂畆畝畢畧畫畮異畱畵當畼疇疊疎疘疿痐痙痠痮痲痺痾瘂瘉瘋",
    "瘍瘓瘖瘞瘡瘧瘮瘱瘲瘺瘻療癄癅癆癇癈癉癐癒癘癟癡癢癤癥癧癩癬癭癮癰癱癲發皁皐皚皜皟皰皷皸皺盃盇盌盜盞盡監盤盧盨盪眎眝眞眡眥眾睍睏睜",
    "睞睠睪瞇瞖瞘瞜瞞瞤瞭瞶瞼矁矇矉矑矓矙矚矯矽砲硃硜硤硨硯碕碙碩碪碭碸確碼碽磑磚磟磠磣磧磯磽磾礄礆礎礐礒礙礦礪礫礬礮礱祕祘祿禍禎禕禡",
    "禦禪禮禰禱禿秈秊秌秖稅稈稉稏稜稟稬稭種稱稾穀穇穌積穎穠穡穢穤穨穩穫穭穽窓窩窪窮窯窰窵窶窺窻竄竅竇竈竊竚竝竢竪竱競筆筍筞筧筩筯筴箇",
    "箋箏箒箠節範築篋篔篘篛篠篢篤篩篳篸簀簂簍簑簒簞簡簢簣簫簮簷簹簽簾籃籅籋籌籐籔籙籛籜籟籠籤籩籪籬籮籲粃粧粵糉糝糞糧糰糲糴糶糹糺糾紀",
    "紂紃約紅紆紇紈紉紋納紐紓純紕紖紗紘紙級紛紜紝紞紟紡紥紬紮細紱紲紳紵紹紺紼紿絀絁終絃組絅絆絍絎絏結絕絙絛絝絞絡絢絥給絧絨絪絰統絲絳",
    "絶絹絺綀綁綃綄綆綇綈綉綋綌綎綏綐綑經綖綜綝綞綟綠綡綢綣綧綪綫綬維綯綰綱網綳綴綵綸綹綺綻綽綾綿緄緇緊緋緍緐緑緒緓緔緗緘緙線緜緝緞緟",
    "締緡緣緤緥緦編緩緬緮緯緰緱緲練緶緷緸緹緻緼縈縉縊縋縍縎縐縑縕縗縛縝縞縟縣縧縫縬縭縮縯縰縱縲縳縴縵縶縷縸縹縺總績繂繃繅繆繈繏繐繒繓",
    "織繕繖繙繚繞繟繡繢繦繨繩繪繫繬繭繮繯繰繳繶繷繸繹繻繼繽繾繿纁纆纇纈纊續纍纏纓纔纕纖纗纘纚纜缐缽罃罇罈罋罌罎罰罵罷罸羅羆羈羋羗羢羣",
    "羥羨義羵羶翄習翫翬翶翹翽耡耬耮聖聞聯聰聲聳聵聶職聹聻聽聾肅肎肐肧胷脃脅脇脈脗脛脣脥脩脫脹腁腎腖腡腦腪腫腳腸膃膓膕膚膞膠膢膩膹膽膾",
    "膿臈臉臋臍臏臕臗臘臙臚臝臟臠臢臥臨臯臺與興舉舊舖舘舩艙艢艣艤艦艪艫艱艷芲芻茘茲荊荳莊莖莢莧菕菫華菴菸萇萊萬萲萴萵葉葒葝葠葤葦葯葷",
    "蒍蒐蒓蒔蒕蒞蒭蒼蓀蓆蓋蓡蓧蓮蓯蓴蓽蔄蔔蔕蔘蔞蔣蔥蔦蔭蔯蔿蕁蕆蕎蕒蕓蕕蕘蕚蕝蕢蕩蕪蕭蕳蕷蕽蕿薀薆薈薊薌薑薔薘薟薦薩薳薴薵薹薺藍藎藝",
    "藥藪藭藴藶藷藹藺藼蘀蘄蘆蘇蘊蘋蘐蘓蘚蘞蘟蘢蘤蘭蘺蘿虆虉處虛虜號虧虯蚘蛕蛺蛻蜆蜋蜖蜨蝀蝕蝟蝦蝨蝯蝱蝸螄螎螞螡螢螮螻螿蟁蟂蟄蟇蟈蟎蟘",
    "蟜蟣蟬蟯蟲蟳蟶蟻蠀蠁蠅蠆蠍蠏蠐蠑蠒蠔蠙蠟蠣蠦蠨蠭蠱蠶蠻蠾衂衆衇衊術衕衚衛衝衞衺袞袟袵裊裌裏補裝裠裡製複褌褘褭褲褳褸褻襀襃襇襉襍襏",
    "襓襖襗襘襝襠襤襪襬襯襰襲襴襵覇覈覊見覎規覓覔視覘覛覡覥覦覩親覬覯覲覷覹覺覼覽覿觀觝觴觶觸訁訂訃計訊訌討訏訐訑訒訓訕訖託記訛訜訝訞",
    "訟訢訣訥訨訩訪設許訴訶診註証詀詁詆詊詎詐詑詒詓詔評詖詗詘詛詝詞詠詡詢詣試詩詪詫詬詭詮詰話該詳詵詶詷詼詿誂誄誅誆誇誋誌認誑誒誕誖誘",
    "誚語誠誡誣誤誥誦誨說誫説誰課誳誴誶誷誹誺誼誾調諂諄談諉請諍諏諑諒諓論諗諛諜諝諞諟諡諢諣諤諥諦諧諫諭諮諯諰諱諲諳諴諶諷諸諺諼諾謀謁",
    "謂謄謅謆謉謊謌謎謏謐謔謖謗謙謚講謝謠謡謨謫謬謭謯謱謳謸謹謾譁譂譅譆證譊譌譎譏譑譓譔譖識譙譚譜譞譟譨譫譭譯議譴護譸譼譽譾讀讁讅變讋",
    "讌讎讐讒讓讕讖讚讜讞讬谘豈豎豐豓豔豬豵豶貍貓貗貙貛貝貞貟負財貢貧貨販貪貫責貯貰貲貳貴貶買貸貺費貼貽貿賀賁賂賃賄賅資賈賉賊賑賒賓賕",
    "賙賚賛賜賝賞賟賠賡賢賣賤賦賧質賫賬賭賰賴賵賷賺賻購賽賾贃贄贅贇贈贉贊贋贍贏贐贑贓贔贖贗贚贛贜赬趂趕趙趨趲跡跥踁踐踫踰踴蹌蹏蹔蹕蹟",
    "蹠蹣蹤蹧蹳蹵蹺蹻躂躉躊躋躍躎躑躒躓躕躘躚躝躡躥躦躪躭躳躶軀軉車軋軌軍軏軑軒軔軕軗軛軜軝軟軤軨軫軬軲軷軸軹軺軻軼軾軿較輄輅輇輈載輊",
    "輋輒輓輔輕輖輗輙輛輜輝輞輟輢輥輦輨輩輪輬輭輮輯輳輶輷輸輻輼輾輿轀轂轄轅轆轇轉轊轍轎轐轔轗轟轠轡轢轣轤辠辢辤辦辭辮辯農辳迴迻逈逕這",
    "連逥逩逬週進遉遊運過達違遙遜遞遠遡適遯遱遲遶遷選遺遼邁還邇邊邏邐郟郵鄆鄉鄒鄔鄖鄟鄧鄩鄭鄰鄲鄳鄴鄶鄺酇酈酖酧醃醆醕醖醜醞醟醣醫醬醯",
    "醱醲醶醻醼釀釁釃釅釋釐釒釓釔釕釗釘釙釚針釟釣釤釦釧釨釩釬釲釳釴釵釷釹釺釾釿鈀鈁鈃鈄鈅鈆鈇鈈鈉鈋鈍鈎鈐鈑鈒鈔鈕鈖鈗鈛鈞鈠鈡鈣鈥鈦鈧",
    "鈮鈯鈰鈲鈳鈴鈷鈸鈹鈺鈽鈾鈿鉀鉁鉄鉅鉆鉈鉉鉊鉋鉍鉑鉔鉕鉗鉚鉛鉝鉞鉠鉢鉤鉥鉦鉧鉨鉬鉭鉮鉲鉳鉶鉷鉸鉺鉻鉽鉾鉿銀銁銂銃銅銈銊銍銏銑銓銖銘",
    "銚銛銜銠銣銥銦銨銩銪銫銬銱銲銳銶銷銹銻銼鋁鋂鋃鋅鋇鋉鋌鋏鋐鋒鋗鋙鋝鋟鋠鋣鋤鋥鋦鋨鋩鋪鋭鋮鋯鋰鋱鋶鋸鋹鋼錀錁錂錄錆錇錈錏錐錒錕錘錙",
    "錚錛錜錝錞錟錠錡錢錤錥錦錨錩錫錮錯録錳錶錸錼錽鍀鍁鍃鍄鍅鍆鍇鍈鍉鍊鍋鍍鍒鍔鍘鍚鍛鍠鍤鍥鍩鍫鍬鍭鍮鍰鍳鍵鍶鍺鍼鍾鎂鎄鎇鎈鎊鎌鎍鎓鎔",
    "鎖鎗鎘鎙鎚鎛鎝鎞鎡鎢鎣鎦鎧鎩鎪鎬鎭鎮鎯鎰鎲鎳鎵鎶鎷鎸鎻鎿鏃鏆鏇鏈鏉鏌鏍鏏鏐鏑鏗鏘鏚鏜鏝鏞鏟鏡鏢鏤鏥鏦鏨鏰鏵鏷鏹鏺鏻鏽鏾鐃鐄鐇鐈鐋",
    "鐍鐎鐏鐐鐒鐓鐔鐘鐙鐝鐠鐥鐦鐧鐨鐩鐪鐫鐮鐯鐲鐳鐵鐶鐸鐺鐼鐽鐿鑀鑄鑈鑉鑊鑌鑑鑒鑔鑕鑚鑛鑞鑠鑣鑤鑥鑪鑭鑰鑱鑲鑴鑵鑷鑹鑼鑽鑾鑿钁钂钜锺镟",
    "長門閂閃閆閈閉開閌閍閎閏閐閑閒間閔閗閘閙閝閞閡閣閤閥閧閨閩閫閬閭閱閲閵閶閹閻閼閽閾閿闃闆闇闈闉闊闋闌闍闐闑闒闓闔闕闖闚關闞闠闡闢",
    "闤闥阨阬陗陘陜陝陞陣陰陳陸陻陽陿隂隄隉隊階隑隕隖際隣隤隨險隮隯隱隴隷隸隻雋雖雙雛雜雞離難雲電霑霢霣霧霼霽靂靄靆靈靉靚靜靝靦靧靨靭",
    "靱鞀鞏鞝鞦鞵鞽鞾韁韃韆韈韉韋韌韍韓韙韚韛韜韝韞韠韤韮韻響頁頂頃項順頇須頊頌頍頎頏預頑頒頓頔頗領頜頟頠頡頤頦頫頭頮頰頲頴頵頷頸頹頻",
    "頼頽顂顃顅顆顇顋題額顎顏顒顓顔顗願顙顛類顢顣顥顦顧顫顬顯顰顱顳顴風颭颮颯颰颱颳颶颷颸颺颻颼颾飀飃飄飆飈飋飛飜飠飢飣飤飥飦飩飪飫飭",
    "飯飱飲飴飵飶飼飽飾飿餁餃餄餅餈餉養餌餎餏餑餒餓餔餕餖餗餘餚餛餜餞餡餦餧館餪餫餬餭餱餳餵餶餷餸餹餺餻餼餽餾餿饁饃饅饈饉饊饋饌饍饑饒",
    "饗饘饜饝饞饟饠饢馀馬馭馮馯馱馳馴馹馼駁駃駈駉駊駎駐駑駒駓駔駕駘駙駚駛駝駞駟駡駢駤駧駩駪駫駭駰駱駶駸駻駼駿騁騂騃騄騅騉騊騌騍騎騏騐",
    "騑騔騖騙騚騜騝騞騟騠騣騤騧騪騫騭騮騰騱騴騵騶騷騸騻騼騾驀驁驂驃驄驅驊驋驌驍驎驏驓驕驗驘驙驚驛驟驢驤驥驦驨驪驫骯骽骾髈髏髒體髕髖髥",
    "髮鬀鬆鬉鬍鬖鬚鬠鬢鬥鬦鬧鬨鬩鬪鬮鬰鬱鬹魎魘魚魛魟魢魥魦魨魯魴魵魷魺魽鮀鮁鮃鮄鮅鮆鮈鮊鮋鮍鮎鮐鮑鮒鮓鮚鮜鮝鮞鮟鮠鮡鮣鮤鮦鮪鮫鮭鮮鮯",
    "鮰鮳鮵鮶鮸鮺鮿鯀鯁鯄鯆鯇鯉鯊鯒鯔鯕鯖鯗鯛鯝鯞鯡鯢鯤鯧鯨鯪鯫鯬鯰鯱鯴鯶鯷鯻鯽鯾鯿鰁鰂鰃鰆鰈鰉鰊鰋鰌鰍鰏鰐鰑鰒鰓鰕鰛鰜鰟鰠鰣鰤鰥鰦鰧",
    "鰨鰩鰫鰭鰮鰱鰲鰳鰵鰶鰷鰹鰺鰻鰼鰽鰾鱀鱂鱄鱅鱆鱇鱈鱉鱊鱒鱔鱖鱗鱘鱚鱝鱟鱠鱢鱣鱤鱧鱨鱭鱮鱯鱲鱷鱸鱺鳥鳧鳩鳬鳲鳳鳴鳶鳷鳼鳽鳾鴀鴃鴅鴆鴇",
    "鴈鴉鴐鴒鴔鴕鴗鴛鴜鴝鴞鴟鴣鴥鴦鴨鴮鴯鴰鴲鴳鴴鴷鴻鴽鴿鵁鵂鵃鵊鵏鵐鵑鵒鵓鵚鵜鵝鵞鵟鵠鵡鵧鵩鵪鵫鵬鵮鵯鵰鵲鵶鵷鵾鶄鶇鶉鶊鶌鶒鶓鶖鶗鶘",
    "鶚鶠鶡鶥鶦鶩鶪鶬鶭鶯鶰鶱鶲鶴鶹鶺鶻鶼鶿鷀鷁鷂鷄鷅鷈鷉鷊鷐鷓鷔鷖鷗鷙鷚鷟鷣鷤鷥鷦鷨鷩鷫鷭鷯鷰鷲鷳鷴鷷鷸鷹鷺鷽鷿鸂鸇鸊鸋鸌鸎鸏鸑鸕鸗",
    "鸘鸚鸛鸝鸞鹵鹹鹺鹻鹼鹽麗麥麨麩麪麫麬麯麲麳麴麵麷麹麺麼麽黃黌點黨黲黴黶黷黽黿鼂鼃鼇鼈鼉鼕鼴齊齋齎齏齒齔齕齗齘齙齜齟齠齡齣齦齧齩齪",
    "齬齭齮齯齰齲齴齶齷齼齾龍龎龐龑龓龔龕龜龭龯鿁鿐鿓",
);
/// 与 `T2S_TRAD` 等长的简体字表。
const T2S_SIMP: &str = concat!(
    "丢卯并乘干干干乱亘斋亚夜廉亡伫布占并来仑侣局俣系𠇹伣侠伡私备伥俩俫仓个倏们幸仿伦㑈睬伟㐽侧侦伪㐷杰伧伞备效家佣偬传伛债伤倾偻仅佥",
    "仙动侨仆伪𫢸侥偾雇价仪俊侬亿侩俭侥傤傧俦侪尽偿𠆲优𠋆储俪㑩傩傥俨凶兑兔儿兖兜内两冉册冒胄幂泯净冻𪞝凛凡凯凭别劫劫删劫刭则锉克刹创",
    "刬创刚剥剐札剀创铲戮𠛅划札剧刘刽刿剑㓥剂剑㔉效劲敕倦𠡠动务勋胜劳势𪟝剿勚劢勋励劝匀炕匦汇匮奁奁区协恤却即膝厍厕历厌厂厉厣参叁丛咤",
    "咿吴呐吕叫咒和呙员𠯟咩呗𪠳唣启吣念忤问喋启啖哑启唡衔㖞唤丧吃乔单哟啼呛啬唝吗呜唢𠮶哔𪡏叹喽呼啯呕啧尝唛嘎哗𪡃唠啸叽𪡞哓嗥呒𪡀啴恶",
    "𠯠啖嘘㖊咝𪡋哒哝哕嗳哙喷吨当咛吓哜尝噜啮𪠸咽呖𠰷咙向亸喾严嘤𪢕啭嗫嚣𠱞冁呓啰苏嘱𪢠啮因囱函囵国围园圆图团𪢮附垛坝垭𫭢𪣆采执坚垩垴",
    "𪣒埚尧报场块茔垲埘涂冢葬坞埙场尘𫭟堑𪣻垫塔坠𫮃堕坛𪢸坟垯墙垦坛𡒄垱埙压𡋤垒圹垆坛坏垄垅坜𪤚坝塆壮壶婿壸寿卯够梦伙夹奂奥奁夺奖奋姹",
    "妆妒你侄姊姗妊奸侄妍𫰛娱娄𫝫姻妇淫娅𫝨妇娲妫㛀媪妈愧袅妪嫩妩娴娴婳妫媭𫝬娆婵娇嫱袅嫒𪥰嬷𫝩嫔奶婴婶𪥿懒娘𫝮𫝭𪥫㛤娈𡠟孙学𡥧孽𪧀孪",
    "冗宫采冤寝𪧘寝实宁审写宽宝宠宝克将专寻对导尔尚鲜鲜尴届尸屃屏屉屡层屦𪨗属屃坂冈峒峰岘岛峡崃昆岗仑峥岽岚岁𡶴𫶇㟥嵝崭崭岖𡺃嵚崂𡺄峤",
    "峣峄峃崄嵘𫝵岭屿岳𪩎岿峦巅岩𪨷𪩘𢀖巯卮卺匝纸帅师裙帐带帧帏帮徽㡎帼帻幕帮𪩷帜币𪩸帮帱干几库庶寓厕厢厩厦庼厩荫厨厮𫷷庙厂庑废广𪪞廪",
    "庐厅巡迫回弑吊弪张强𪪼𫸩别弹弥弯录汇彝彟彦雕彨佛往后径从徕遍复征彻𪫌匆恍恒怪吝耻悦悮匆怅闷凄婪恶恿恼恽蠢恻爱惬悫怆恺𢙏博忾栗态愠",
    "惨惭惭恸惯悫怄怂虑悭慑庆㥪戚戚欲忧憩惫㤭怜凭愦慭惮𢙒愤悯怃宪忆𪫺𢙐𢙓恳应怿懔𢠁蒙怼懑㤽㤖恹惩懒怀悬忏惧慑恋戆戋戛戗戬战戯戏户厄捍",
    "拗抛拼捝挲弄挟救舍扪挨卷扫抡㧏挜挣𪭵挂采碰拣捏扬换揪挥搄插背构揿榷损摇捣扼捶拓掏揾抢榨扛𢫬𪭢掴掼搂挚抠抟折掺捞𪭾挦撑挠㧑挢操掸拨",
    "扯𪮖抚扑揿挞挝捡拥掳择击挡㧟担携据𪭧挤捣㧛举𢬍拟摈拧搁掷扩撷摆擞撸㧰扰摅撵𪮶拢拦撄搀撺携摄攒挛摊挡搅揽考叩叙教敚败叙敌数驱敛毙𢽾",
    "敩斓斩断𣃁于旗既祸时春升昏时晋𬀪昼晕晖𬀩旸畅暂昵晔历昙晓𪰶向暧旷叠𣆐昽晒书会期望𦛨胧术朵东锨台拐栅拐查柳刊柏筏桑杯𣐕柳杆栀𪱷枧𬂩",
    "条枭棁弃棋枨枣栋㭎栈栖梾桠碇㭏棕缄笺𣒌杨枫楦桢业极矩干杩荣榅桤构枪杠桌梿椠椁𣏢椮桨椢椝桩乐枞梁楼标枢𣗊㭤样𣔌榝㭴桪朴树桦椫桡桥橛",
    "机椭横𣓿檩柽档桧槚检樯𣘴梼台槟𪲛柠槛柜𪲎凳𬃊橹榈栉椟橼栎𪲮橱槠栌枥橥榇蘖栊榉樱栏榉𪳍权𣐤椤𪲔𪴙栾𣗋榄𣚚郁棂款钦叹欧敛欤欢岁历历归",
    "殁夭残殒𣨼殇㱮殚僵殓殡㱩歼杀壳壳毁殴𪵑绒球毵牦毡毡氇气氢氩𣱝氲冰泛泛污污决没冲况溯泄汹浃𬇙泾莅涚凉凄泪浙渌净凌沦渊涞浅沈涣减沨涡",
    "测浑凑𣲗浈涌汤涅沩准沟𪶄温浉涢湿沧灭涤荥汇淫沪滞渗卤浒浐滚满渔溇𬇹沤汉涟渍涨溆渐浆颍漱泼洁𣲘沩㴋潜𫞗润浔溃滗涠涩涩𣶩浇涝沄涧渑泽",
    "滪泶𬇕𫞚浍淀㳠浊浓㳡𣸣涩湿泞溁蒙浕济涛㳔滥潍滨阔溅泺滤𪵱澛𣽷滢渎㲿泻沈浏濒泸沥潇潆潴泷濑弥潋澜沣滠法𫞝洒𪷽漓滩𣺼灏漤㳕湾滦滟滟灾",
    "为乌灾烃无𪸩炼煮炜暖烟茕焕烦炀㶽𪸕煴熙𤈶𤇄荧𤆡炝𤇹𤋏𬉼热颎炽𬊤烨焰灯炖烧𬊈烫焖营灿毁烛烩㶶熏烬焘𫞡𤇃𦶟烁炉𤇭烨烂𪹳𫞠争为爷尔床墙",
    "笺窗闸榜窗牍它抵牵荦牦𪺭犊牺状徇狭狈悍𪺽狰猿犹狲犸呆狱狮𪺷奖毙狷独𤞃狯猃狝狞㺍获猎犷兽獭献猕猡𤞤妙𫞥现盏雕珐珲玳玮玚琐瑶莹玛琅玱",
    "𪻲𪻐琏𫞩𬍤𬍡𪻺琎瑠玑瑷珰㻅环玙瑸𫞨玺𫞦璇𪻨𬍛琼珑璎𤦀瓒𤩽瓯砖瓮罂尝产产苏宁亩亩亩毕略画亩异留画当𪽈畴叠疏肛痱蛔痉酸𪽪痳痹疴痖愈疯",
    "疡痪喑瘗疮疟瘆𪽷疭瘘瘘疗憔瘤痨痫废瘅𤶊愈疠瘪痴痒疖症疬癞癣瘿瘾痈瘫癫发皂皋皑皓𤾀疱鼓皲皱杯盍碗盗盏尽监盘卢𪾔荡视𪾣真视眦众𪾢困睁",
    "睐眷睾眯翳眍䁖瞒𥆧了瞆睑瞅蒙𪾸𪾦眬瞰瞩矫硅炮朱硁硖砗砚埼𥐻硕砧砀砜确码䂵硙砖碌硵碜碛矶硗䃅硚硷础𬒈𥐟碍矿砺砾矾𪿫砻秘算禄祸祯祎祃",
    "御禅礼祢祷秃籼年秋只税秆粳䅉棱禀糯秸种称稿谷䅟稣积颖秾穑秽糯颓稳获穞阱窗窝洼穷窑窑窎窭窥窗窜窍窦灶窃𥩟并俟竖𫁟竞笔笋策笕筒箸䇲个",
    "笺筝帚棰节范筑箧筼𥬠箬筿𬕂笃筛筚𥮾箦𫂆篓蓑篡箪简𫂃篑箫簪檐筜签帘篮𥫣𥬞筹藤䉤箓篯箨籁笼签笾簖篱箩吁秕妆粤粽糁粪粮团粝籴粜纟𫄙纠纪",
    "纣𬘓约红纡纥纨纫纹纳纽纾纯纰纼纱纮纸级纷纭纴𬘘𫄛纺扎䌷扎细绂绁绅纻绍绀绋绐绌𫄟终弦组䌹绊𫟃绗绁结绝𫄠绦绔绞络绚𫄢给𫄡绒𬘡绖统丝绛",
    "绝绢𫄨𦈌绑绡𬘫绠𦈋绨绣𫟄绤𬘩绥䌼捆经𫄧综𬘭缍𫄫绿𫟅绸绻𬘯𬘬线绶维绹绾纲网绷缀彩纶绺绮绽绰绫绵绲缁紧绯𦈏繁绿绪绬绱缃缄缂线绵缉缎𫟆",
    "缔缗缘𫄬褓缌编缓缅𫄭纬𦈕缑缈练缏𦈉𦈑缇致缊萦缙缢缒𫄰𦈔绉缣缊缞缚缜缟缛县绦缝𦈚缡缩𬙂𫄳纵缧䌸纤缦絷缕𫄲缥𦈐总绩𫄴绷缫缪𫄶𦈝𰬸缯𦈛",
    "织缮伞翻缭绕𦈎绣缋襁𫄤绳绘系𫄱茧缰缳缲缴𫄷𫄣䍁绎𦈡继缤缱䍀𫄸𬙊颣缬纩续累缠缨才𬙋纤𫄹缵𫄥缆线钵䓨樽坛瓮罂坛罚骂罢罚罗罴羁芈羌绒群",
    "羟羡义𫅗膻翅习玩翚翱翘翙锄耧耢圣闻联聪声耸聩聂职聍𫆏听聋肃肯胳胚胸脆胁胁脉吻胫唇𣍰修脱胀胼肾胨脶脑𣍯肿脚肠腽肠腘肤䏝胶𦝼腻𪱥胆脍",
    "脓腊脸臀脐膑膘𣎑腊胭胪裸脏脔臜卧临皋台与兴举旧铺馆船舱樯𫇛舣舰橹舻艰艳花刍荔兹荆豆庄茎荚苋𰰨堇华庵烟苌莱万萱荝莴叶荭𫈎参荮苇药荤",
    "𫇭搜莼莳蒀莅𫇴苍荪席盖参𦰏莲苁莼荜𬜬卜蒂参蒌蒋葱茑荫𫈟𫇭荨蒇荞荬芸莸荛萼𫈵蒉荡芜萧𫈉蓣𫇽萱蕰𫉁荟蓟芗姜蔷荙莶荐萨䓕苧䓓苔荠蓝荩艺",
    "药薮䓖蕴苈𫉄蔼蔺萱萚蕲芦苏蕴苹萱苏藓蔹𦻕茏花兰蓠萝蔂𬟁处虚虏号亏虬蛔蛔蛱蜕蚬螂蛔蝶𬟽蚀猬虾虱猿虻蜗蛳融蚂蚊萤䗖蝼螀蚊𫋇蛰蟆蝈螨𫋌",
    "𫊸虮蝉蛲虫𫊻蛏蚁𧏗蚃蝇虿蝎蟹蛴蝾茧蚝𧏖蜡蛎𫊮蟏蜂蛊蚕蛮𧑏衄众脉蔑术同胡卫冲卫邪衮帙衽袅袷里补装裙里制复裈袆袅裤裢褛亵𫌀褒裥裥杂袯",
    "𫋹袄𫋷𫋻裣裆褴袜摆衬𧝝袭襕𫌇霸核羁见觃规觅觅视觇𫌪觋觍觎睹亲觊觏觐觑𫌭觉𫌨览觌观抵觞觯触讠订讣计讯讧讨𬣙讦𫍙讱训讪讫托记讹𫍛讶𫍚",
    "讼䜣诀讷𫟞讻访设许诉诃诊注证𧮪诂诋𫟟讵诈𫍡诒𫍜诏评诐诇诎诅𬣞词咏诩询诣试诗𬣳诧诟诡诠诘话该详诜酬𫍣诙诖𫍥诔诛诓夸𫍪志认诳诶诞悖诱",
    "诮语诚诫诬误诰诵诲说𫍨说谁课𫍮𫟡谇𫍬诽𫍧谊訚调谄谆谈诿请诤诹诼谅𬣡论谂谀谍谞谝𬤊谥诨𫍩谔𫍳谛谐谏谕咨𫍱𫍰讳𬤇谙𫍯谌讽诸谚谖诺谋谒",
    "谓誊诌𫍸𫍷谎歌谜𫍲谧谑谡谤谦谥讲谢谣谣谟谪谬谫𫍹𫍴讴𫍵谨谩哗𫟠𰶎𫍻证𫍢讹谲讥𫍤𬤝撰谮识谯谭谱𫍽噪𫍦谵毁译议谴护诪䛓誉谫读谪谉变詟",
    "䜩雠雠谗让谰谶赞谠谳托咨岂竖丰艳艳猪𫎆豮狸猫𫎌䝙獾贝贞贠负财贡贫货贩贪贯责贮贳赀贰贵贬买贷贶费贴贻贸贺贲赂赁贿赅资贾恤贼赈赊宾赇",
    "赒赉赞赐𫎩赏𧹖赔赓贤卖贱赋赕质赍账赌䞐赖赗赍赚赙购赛赜𧹗贽赘赟赠𫎫赞赝赡赢赆𫎬赃赑赎赝𫎦赣赃赪趁赶赵趋趱迹跺胫践碰逾踊跄蹄𫏐跸迹",
    "跖蹒踪糟𫏆蹴跷𫏋跶趸踌跻跃䟢踯跞踬蹰𨀁跹𨅬蹑蹿躜躏耽躬裸躯𨉗车轧轨军𫐄轪轩轫𫐅𨐅轭𫐇𬨂软轷𫐉轸𫐊轱𫐈轴轵轺轲轶轼𫐌较𨐈辂辁辀载轾",
    "𪨶辄挽辅轻𫐏𫐐辄辆辎辉辋辍𫐎辊辇𫐑辈轮辌软𫐓辑辏𬨎𫐒输辐辒辗舆辒毂辖辕辘𫐖转𫐕辙轿𫐗辚𫐘轰𫐙辔轹𫐆轳罪辣辞办辞辫辩农农回移迥迳这",
    "连回奔迸周进侦游运过达违遥逊递远溯适遁𫐷迟绕迁选遗辽迈还迩边逻逦郏邮郓乡邹邬郧𫑘邓𬩽郑邻郸𫑡邺郐邝酂郦鸩酬腌盏醇酝丑酝蒏糖医酱酰",
    "酦𬪩𫑷酬宴酿衅酾酽释厘钅钆钇钌钊钉钋𫟲针𫓥钓钐扣钏𫓦钒焊𫟳𨰿𬬩钗钍钕钎䥺𬬱钯钫钘钭钥𫓪𫓧钚钠𨱂钝钩钤钣钑钞钮𫟴𫟵𫓨钧𨱁钟钙钬钛钪",
    "铌𨱄铈𨱃钶铃钴钹铍钰钚铀钿钾𨱅铁巨钻铊铉𬬿铇铋铂𫓬钷钳铆铅𫟷钺𫓭钵钩𬬸钲𬭁鿭钼钽𬬹锎锫铏𫟹铰铒铬𫟸𫓴铪银𫓲𫟻铳铜𫓯𫓰铚𫟶铣铨铢铭",
    "铫铦衔铑铷铱铟铵铥铕铯铐铞焊锐𨱇销锈锑锉铝镅锒锌钡𨱈铤铗𬭎锋𫓶铻锊锓𫓵铘锄锃锔锇铓铺锐铖锆锂铽锍锯𬬮钢𬬭锞𨱋录锖锫锩铔锥锕锟锤锱",
    "铮锛𫓻𫓽𬭚锬锭锜钱𫓹𫓾锦锚锠锡锢错录锰表铼镎𫓸锝锨锪𨱉钫钔锴锳𫔂炼锅镀𫔄锷铡钖锻锽锸锲锘锹锹𬭤𨱎锾鉴键锶锗针钟镁锿镅𫟿镑镰𫔅𬭩镕",
    "锁枪镉𫔈锤镈锝𫔇镃钨蓥镏铠铩锼镐镇镇𨱍镒镋镍镓鿔𨰾镌锁镎镞𨱌旋链𨱒镆镙𬭬镠镝铿锵𬭭镗镘镛铲镜镖镂𫔊𫓩錾镚铧镤镪䥽𬭸锈𫔌铙𨱑𫔍𫓱铴",
    "𫔎𨱓𨱔镣铹镦镡钟镫镢镨䦅锎锏镄𬭼𫓺镌镰䦃镯镭铁镮铎铛𫔁𫟼镱锿铸鿭𫠁镬镔鉴鉴镲锧钻矿镴铄镳刨镥𬬻镧钥镵镶𫔔罐镊镩锣钻銮凿镢镋巨钟旋",
    "长门闩闪闫闬闭开闶𨸂闳闰𨸃闲闲间闵𫔯闸闹𫠂𫔰阂阁合阀哄闺闽阃阆闾阅阅𫔴阊阉阎阏阍阈阌阒板暗闱𬮱阔阕阑阇阗𫔶阘闿阖阙闯窥关阚阓阐辟",
    "阛闼厄坑峭陉陕陕升阵阴陈陆堙阳狭阴堤陧队阶𬮿陨坞际邻𬯎随险𬯀陦隐陇隶隶只隽虽双雏杂鸡离难云电沾霡𫕥雾𪵣霁雳霭叇灵叆靓静靔腼𫖃靥韧",
    "韧鼗巩绱秋鞋鞒𫖇缰鞑千袜鞯韦韧韨韩韪𫠅𫖔韬鞲韫𫖒袜韭韵响页顶顷项顺顸须顼颂𫠆颀颃预顽颁顿𬱖颇领颌额𬱟颉颐颏𫖯头颒颊颋颕𫖳颔颈颓频",
    "赖颓𩓋𩖖𫖶颗悴腮题额颚颜颙颛颜𫖮愿颡颠类颟𫖹颢憔顾颤颥显颦颅颞颧风飐飑飒𩙥台刮飓𩙪飔飏飖飕𩙫飗飘飘飙飚𫗋飞翻饣饥饤饲饦𫗞饨饪饫饬",
    "饭飧饮饴𫗢𫗣饲饱饰饳饪饺饸饼糍饷养饵饹饻饽馁饿𫗦馂饾𫗧余肴馄馃饯馅𫗠𫗪馆𫗬𫗥糊𫗮糇饧喂馉馇𩠌糖馎糕饩馈馏馊馌馍馒馐馑馓馈馔膳饥饶",
    "飨𫗴餍馍馋𫗵𫗩馕余马驭冯𫘛驮驰驯驲𫘜驳𫘝驱𬳶𫘟𩧨驻驽驹𬳵驵驾骀驸𩧫驶驼𫘞驷骂骈𫘠𩧲𩧴𬳽𫘡骇骃骆𩧺骎𫘣𬳿骏骋骍𫘤𫘧骓𫘥𫘦骔骒骑骐验",
    "𬴂𩨀骛骗𩨊𫘩𩨃𬴃𩨈𫘨鬃骙䯄𩨄骞骘骝腾𫘬𫘫𫘪驺骚骟𫘭𫠋骡蓦骜骖骠骢驱骅𩧯骕骁𬴊骣𫘯骄验骡𫘰惊驿骤驴骧骥骦𫘱骊骉肮腿鲠膀髅脏体髌髋髯",
    "发剃松鬃胡𩭹须𫘽鬓斗斗闹哄阋斗阄郁郁鬶魉魇鱼鱽𫚉鱾𩽹𫚌鲀鲁鲂𫚍鱿鲄𫠐𬶍鲅鲆𫚒𫚑𫚖𬶋鲌鲉鲏鲇鲐鲍鲋鲊鲒鲘鲞鲕𩽾𬶏𬶐䲟𫚓鲖鲔鲛鲑鲜𫚗",
    "𫚔鲓𫚛鲪𩾃鲝𫚚鲧鲠𩾁𫚙鲩鲤鲨鲬鲻鲯鲭鲞鲷鲴𫚡鲱鲵鲲鲳鲸鲮鲰𫚞鲶𩾇鲺𩽼鳀𬶟鲫𫚣鳊鳈鲗鳂䲠鲽鳇𬶠𫚢䲡鳅鲾鳄𫚊鳆鳃𫚥鳁鳒鳑鳋鲥𫚕鳏𫚤䲢",
    "鳎鳐𫚦鳍鳁鲢鳌鳓鳘𬶭鲦鲣鲹鳗鳛𫚧鳔𬶨鳉𫚋鳙𫠒𩾌鳕鳖𫚪鳟鳝鳜鳞鲟𬶮鲼鲎鲙𫚫鳣鳡鳢鲿鲚𫚈鳠𫚭鳄鲈鲡鸟凫鸠凫鸤凤鸣鸢𫛛𪉃𫛚䴓𫛜𫛞𫛝鸩鸨",
    "雁鸦𫛤鸰𫛡鸵𫁡鸳𪉈鸲鸮鸱鸪𫛣鸯鸭𫛦鸸鸹𪉆𫛩鸻䴕鸿𫛪鸽䴔鸺鸼𫛥𬷕鹀鹃鹆鹁𪉍鹈鹅鹅𫛭鹄鹉𫛨𫛳鹌𫛱鹏鹐鹎雕鹊鸦鹓鹍䴖鸫鹑鹒𫛵𫛶鹋鹙𫛸鹕",
    "鹗𬸘鹖鹛𫛷鹜䴗鸧𫛯莺𫛫𬸣鹟鹤鹠鹡鹘鹣鹚鹚鹢鹞鸡𫛽䴘䴘鹝𫜀鹧𪉑鹥鸥鸷鹨𬸦𫜃𫛴鸶鹪𪉊𫜁鹔𬸪鹩燕鹫鹇鹇𫜄鹬鹰鹭鸴𬸯㶉鹯䴙𫛢鹱莺鹲𬸚鸬𫛟",
    "鹴鹦鹳鹂鸾卤咸鹾碱碱盐丽麦𪎊麸面面𤿲曲𪎉𪎌曲面𫜑曲面么么黄黉点党黪霉黡黩黾鼋鼌蛙鳌鳖鼍冬鼹齐斋赍齑齿龀龁龂𬹼龅龇龃龆龄出龈啮𫜪龊",
    "龉𫜭𬺈𫠜𫜬龋𫜮腭龌𬺓𫜰龙厐庞䶮𫜲龚龛龟𩨎𨱆䜤䲤鿒",
);

// ==================== 单元测试（全部离线；网络入口只做「解析函数」级别的验证） ====================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 造一个只填必要字段的 core 候选。
    fn raw(source: &str, title: &str, year: &str, duration: f64) -> Raw {
        Raw {
            source: source.to_string(),
            title: title.to_string(),
            year: year.to_string(),
            duration,
            ..Default::default()
        }
    }

    fn pair(source_id: &str, raw: Raw) -> (Raw, Candidate) {
        let cand = from_core(&raw, source_id);
        (raw, cand)
    }

    // ---------- 归一 / 简繁 / 模糊匹配 ----------

    #[test]
    fn simple_convert_handles_traditional() {
        assert_eq!(simple_convert("週杰倫"), "周杰伦");
        assert_eq!(simple_convert("說好的幸福呢"), "说好的幸福呢");
        assert_eq!(simple_convert("魔杰座"), "魔杰座");
        assert_eq!(simple_convert(""), "");
        assert_eq!(norm_simple("週杰倫"), "周杰伦");
    }

    #[test]
    fn is_chinese_text_only_han_range() {
        assert!(is_chinese_text("周杰伦"));
        assert!(is_chinese_text("Jay 周"));
        // Python 只认 \u4e00-\u9fff：假名 / 谚文不算中文
        assert!(!is_chinese_text("カタカナ"));
        assert!(!is_chinese_text("한국어"));
        assert!(!is_chinese_text("Jay Chou"));
    }

    #[test]
    fn fuzzy_match_python_rules() {
        assert!(is_fuzzy_match("", "")); // 两侧都空 → True
        assert!(is_fuzzy_match("", "任何人")); // 无歌手信息 → 信任标题闸门
        assert!(!is_fuzzy_match("周杰伦", "")); // 有预期但结果无歌手 → False
        assert!(is_fuzzy_match("周杰伦", "周杰倫")); // 简繁归一后互相包含
        assert!(is_fuzzy_match("周杰伦 & 费玉清", "费玉清"));
        assert!(is_fuzzy_match("周杰伦/费玉清", "费玉清"));
        assert!(!is_fuzzy_match("周杰伦", "林俊杰"));
        assert!(is_fuzzy_match("Jay Chou", "jay chou"));
        // 兜底分支（无 thefuzz 时）：首字符相同 + 长度差 ≤ max(len)/2
        assert!(is_fuzzy_match("abcde", "abxy"));
        assert!(!is_fuzzy_match("abcde", "zz"));
    }

    // ---------- 打分（C 节） ----------

    #[test]
    fn title_sim_score_table() {
        assert_eq!(title_sim_score("稻香", "稻香", None), 60); // 完全相等
        assert_eq!(title_sim_score("稻香啊 (Live)", "稻香啊", None), 50); // 互相包含
        assert_eq!(title_sim_score("abcdef", "a", None), 10); // 短关键词例外
        assert_eq!(title_sim_score("稻香", "xyz", Some("稻香")), 55); // title_hint 相等
        assert_eq!(title_sim_score("稻香夏天", "xyz", Some("夏天稻香")), 40); // 中文逐字重叠 4 字
        assert_eq!(title_sim_score("chou jay", "jay chou", None), 35); // 词元命中 2 个
        assert_eq!(title_sim_score("xyz", "稻香", None), -50); // 完全不相关
        assert_eq!(title_sim_score("", "稻香", None), 0);
        assert_eq!(title_sim_score("稻香", "", None), 0);
    }

    #[test]
    fn score_engine_base_year_duration_title() {
        // 基础分 + 年份 +10 + 时长 ±2 → +25 + 歌名 60
        assert_eq!(
            score_candidate(
                &raw("MusicBrainz", "稻香", "2008", 223.0),
                "稻香",
                "周杰伦",
                Some("稻香"),
                Some(223.0)
            ),
            173
        );
        assert_eq!(
            score_candidate(
                &raw("iTunes-CN", "稻香", "2008", 223.0),
                "稻香",
                "周杰伦",
                Some("稻香"),
                Some(223.0)
            ),
            175
        );
        assert_eq!(
            score_candidate(
                &raw("Netease", "稻香", "2008", 223.0),
                "稻香",
                "周杰伦",
                Some("稻香"),
                Some(223.0)
            ),
            170
        );
        // 非中文场景的国内源基础分更低
        let english = raw("Netease", "Yellow", "", 0.0);
        assert_eq!(
            score_candidate(&english, "Yellow", "Coldplay", Some("Yellow"), None),
            125
        );
        assert_eq!(confidence_level(125), "高");
    }

    #[test]
    fn score_duration_tolerance_table() {
        // delta ≤2 → +25；≤5 → +15；≤10 → +5；否则 −min(30, (delta-10)//5)
        let cases = [
            (202.0, 85),
            (205.0, 75),
            (210.0, 65),
            (214.0, 60),
            (220.0, 58),
            (400.0, 30),
        ];
        for (duration, want) in cases {
            let got = score_candidate(
                &raw("", "稻香", "", duration),
                "稻香",
                "",
                Some("稻香"),
                Some(200.0),
            );
            assert_eq!(got, want, "候选时长 {duration} 期望 {want} 实际 {got}");
        }
        // 候选没有时长（如 iTunes / TheAudioDB）→ 不加不减
        assert_eq!(
            score_candidate(&raw("", "稻香", "", 0.0), "稻香", "", Some("稻香"), Some(200.0)),
            60
        );
    }

    #[test]
    fn score_context_bonus_and_penalty() {
        let mut r = raw("", "稻香", "", 0.0);
        assert_eq!(score_candidate(&r, "稻香", "", Some("稻香"), None), 60);
        r.context = "studio".to_string();
        assert_eq!(score_candidate(&r, "稻香", "", Some("稻香"), None), 90);
        r.context = "compilation".to_string();
        assert_eq!(score_candidate(&r, "稻香", "", Some("稻香"), None), 20);
        // 歌名完全不匹配 → 上下文加成再 −30（不会被 studio 救回来）
        let mut bad = raw("", "xyz", "", 0.0);
        bad.context = "studio".to_string();
        assert_eq!(score_candidate(&bad, "稻香", "", Some("稻香"), None), -50);
        // 未知源（含桥接内置源的 source 名）没有基础分
        assert_eq!(
            score_candidate(&raw("musicbrainz", "稻香", "", 0.0), "稻香", "", Some("稻香"), None),
            60
        );
    }

    #[test]
    fn confidence_thresholds_truncate_like_int() {
        assert_eq!(confidence_level(120), "高");
        assert_eq!(confidence_level(119), "中"); // int(119.9) → 119 → 中
        assert_eq!(confidence_level(70), "中");
        assert_eq!(confidence_level(69), "待确认");
        assert_eq!(confidence_level(0), "待确认");
        assert_eq!(confidence_level(-120), "待确认");
    }

    // ---------- 候选映射 / JSON 契约 ----------

    #[test]
    fn from_core_maps_fields_like_python() {
        let mut r = raw("MusicBrainz", "稻香", "", 223.0);
        r.date = "2009-05-06".to_string();
        r.album = "魔杰座".to_string();
        r.album_artist = "周杰伦".to_string();
        r.cover_url = "https://coverartarchive.org/release-group/x/front".to_string();
        r.track_num = Some(3);
        r.disc_num = Some(1);
        r.artist_mbid = "mbid".to_string();
        r.release_group_id = "rg".to_string();
        r.recording_id = "rec".to_string();
        r.isrc = "TWK970801030".to_string();
        r.artist_country = "TW".to_string();
        r.total_tracks = 11;
        let c = from_core(&r, "musicbrainz");
        assert_eq!(c.source, "musicbrainz"); // 接口源名覆盖 core 引擎名
        assert_eq!(c.title, "稻香");
        assert_eq!(c.year, "2009"); // 无 year 时取 date[:4]
        assert_eq!(c.date, "2009-05-06");
        assert_eq!(c.track, "3");
        assert_eq!(c.disc, "1");
        assert_eq!(c.albumartist, "周杰伦");
        assert_eq!(c.cover, "https://coverartarchive.org/release-group/x/front");
        assert_eq!(c.mb_artist_id, "mbid");
        assert_eq!(c.release_group_id, "rg");
        assert_eq!(c.isrc, "TWK970801030");
        assert_eq!(c.recording_id, "rec");
        assert_eq!(c.artist_country, "TW");
        assert_eq!(c.total_tracks, 11);
        assert_eq!(c.duration, 223.0);
        assert_eq!(c.confidence, "待确认"); // 默认值，打分阶段才回写
        assert_eq!(c.error, ""); // 搜索路径从不赋值（H-12）
        assert_eq!(c.language, ""); // 13 个源都不填
        assert_eq!(c.lyrics, ""); // 搜索路径不取歌词
        assert_eq!(c.genre, "");
    }

    #[test]
    fn candidate_serializes_27_keys_without_raw() {
        let c = from_core(&raw("Netease", "稻香", "2008", 223.0), "netease");
        let text = serde_json::to_string(&c).unwrap();
        let keys = [
            "source",
            "title",
            "artist",
            "album",
            "albumartist",
            "genre",
            "year",
            "date",
            "track",
            "disc",
            "language",
            "composer",
            "lyricist",
            "albumtype",
            "mb_artist_id",
            "release_group_id",
            "isrc",
            "recording_id",
            "context",
            "cover",
            "artist_country",
            "total_tracks",
            "lyrics",
            "duration",
            "score",
            "confidence",
            "error",
        ];
        for key in keys {
            let needle = format!("\"{key}\":");
            assert!(text.contains(&needle), "缺少字段 {key}");
        }
        assert!(!text.contains("\"raw\""), "对外 JSON 不该有 raw 键");
        assert!(
            text.starts_with("{\"source\":"),
            "键顺序应从 source 开始：{text}"
        );
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 27);
    }

    #[test]
    fn scrape_query_and_outcome_shape() {
        let q = ScrapeQuery {
            title: "稻香".to_string(),
            artist: "周杰伦".to_string(),
            album: Some("魔杰座".to_string()),
            duration: Some(223.0),
            sources: vec![],
            limit: 5,
        };
        assert_eq!(effective_sources(&q.sources).len(), SEARCH_PRIORITY.len());
        let outcome = ScrapeOutcome {
            candidates: vec![from_core(&raw("Netease", "稻香", "2008", 223.0), "netease")],
            source_status: vec![SourceStatus {
                source: "netease".to_string(),
                count: 1,
                error: String::new(),
            }],
        };
        let text = serde_json::to_string(&outcome).unwrap();
        assert!(text.contains("\"candidates\""));
        assert!(text.contains("\"source_status\""));
        // error 为空时不该出现在 JSON 里（shape: {source, count[, error]}）
        // source_status: {source, count[, error]} —— 空 error 不该出现（契约 A3）
        let value: Value = serde_json::from_str(&text).unwrap();
        let status = &value["source_status"][0];
        assert_eq!(status["count"], 1);
        assert!(status.get("error").is_none(), "空 error 不该出现在 source_status 里");
        // 但候选里必须保留 error 键（H-12）
        assert!(value["candidates"][0].get("error").is_some());
    }

    // ---------- 各源解析（内联真实响应结构片段） ----------

    #[test]
    fn parse_netease_cloudsearch_json() {
        let data: Value = serde_json::from_str(
            r#"{"result": {"songs": [{
                 "id": 1330348068,
                 "name": "稻香",
                 "ar": [{"name": "周杰伦"}],
                 "al": {"name": "魔杰座", "picUrl": "http://p1.music.126.net/abc.jpg?param=130y130",
                        "trackCount": 11, "type": "Album"},
                 "dt": 223453
               }]}}"#,
        )
        .unwrap();
        let raw = parse_netease_song(&data["result"]["songs"][0], "周杰伦").unwrap();
        assert_eq!(raw.source, "Netease");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_artist, "周杰伦");
        assert_eq!(raw.cover_url, "https://p1.music.126.net/abc.jpg"); // 去查询串 + http→https
        assert_eq!(raw.total_tracks, 11);
        assert_eq!(raw.album_type, "Album");
        assert_eq!(raw.duration, 223.0);
        assert_eq!(raw.song_id, "1330348068");
        assert_eq!(raw.year, ""); // 没有 publishTime → 空
        assert_eq!(netease_title_score("稻香", "稻香"), 100);
        assert_eq!(netease_title_score("晴天", "稻香"), 0);
    }

    #[test]
    fn parse_netease_without_pic_is_dropped() {
        let data = json!({"name": "稻香", "al": {"name": "魔杰座"}, "dt": 223000});
        assert!(parse_netease_song(&data, "周杰伦").is_none());
        // 老接口兜底字段（artists + album）也能解析
        let legacy = json!({"name": "稻香", "album": {"name": "魔杰座", "picUrl": "https://x/y.jpg"},
                            "duration": 223453, "id": 1});
        let mut patched = legacy.clone();
        patched["al"] = legacy["album"].clone();
        assert_eq!(
            parse_netease_song(&patched, "周杰伦").unwrap().duration,
            223.0
        );
    }

    #[test]
    fn parse_musicbrainz_recording_json() {
        let data: Value = serde_json::from_str(
            r#"{"recordings": [{
                 "id": "rec-1",
                 "title": "稻香",
                 "length": 223453,
                 "isrcs": ["TWK970801030"],
                 "artist-credit": [{"name": "周杰伦",
                                    "artist": {"id": "mbid-1", "name": "周杰伦", "country": "TW"}}],
                 "tags": [{"name": "pop", "count": 3}, {"name": "mandarin pop", "count": 5}],
                 "releases": [{
                   "id": "rel-1", "title": "魔杰座", "status": "Official", "date": "2008-10-14",
                   "media": [{"track-count": 11, "format": "CD"}],
                   "release-group": {"id": "rg-1", "primary-type": "Album"}
                 }]
               }]}"#,
        )
        .unwrap();
        let raw = parse_musicbrainz(&data, "周杰伦").unwrap();
        assert_eq!(raw.source, "MusicBrainz");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_artist, "周杰伦");
        assert_eq!(raw.album_type, "Album");
        assert_eq!(
            raw.cover_url,
            "https://coverartarchive.org/release-group/rg-1/front"
        );
        assert_eq!(raw.genre.as_deref(), Some("mandarin pop, pop")); // count 降序
        assert_eq!(raw.total_tracks, 11);
        assert_eq!(raw.isrc, "TWK970801030");
        assert_eq!(raw.recording_id, "rec-1");
        assert_eq!(raw.artist_country, "TW");
        assert_eq!(raw.artist_mbid, "mbid-1");
        assert_eq!(raw.release_group_id, "rg-1");
        assert_eq!(raw.release_group_primary_type, "Album");
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.duration, 223.0);
        assert_eq!(raw.format.as_deref(), Some("CD"));
    }

    #[test]
    fn parse_musicbrainz_prefers_official_and_earliest() {
        let data = json!({"recordings": [{
            "title": "稻香",
            "artist-credit": [{"name": "周杰伦", "artist": {"id": "m"}}],
            "releases": [
                {"title": "B-Side", "date": "2009-01-01", "media": [{"track-count": 2}],
                 "release-group": {"id": "rg-9", "primary-type": "Single"}},
                {"title": "魔杰座", "status": "Official", "date": "2008-10-14", "media": [{"track-count": 11}],
                 "release-group": {"id": "rg-1", "primary-type": "Album"}}
            ]
        }]});
        let raw = parse_musicbrainz(&data, "周杰伦").unwrap();
        assert_eq!(raw.release_group_id, "rg-1"); // official 且日期最早
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.album_type, "Album");
    }

    #[test]
    fn parse_musicbrainz_skips_artist_mismatch() {
        let data = json!({"recordings": [{
            "title": "稻香",
            "artist-credit": [{"name": "林俊杰", "artist": {"id": "x"}}],
            "releases": [{"title": "魔杰座", "status": "Official", "date": "2008"}]
        }]});
        assert!(parse_musicbrainz(&data, "周杰伦").is_none());
    }

    #[test]
    fn parse_itunes_search_json() {
        let data: Value = serde_json::from_str(
            r#"{"resultCount": 1, "results": [{
                 "artistName": "周杰伦",
                 "collectionName": "魔杰座",
                 "collectionType": "Album",
                 "collectionArtistName": "周杰伦",
                 "trackName": "稻香",
                 "trackNumber": 1,
                 "trackCount": 11,
                 "releaseDate": "2008-10-14T07:00:00Z",
                 "artworkUrl100": "https://is1.mzstatic.com/image/thumb/x/100x100bb.jpg",
                 "primaryGenreName": "Mandopop"
               }]}"#,
        )
        .unwrap();
        let raw = parse_itunes(&data, "CN", "周杰伦").unwrap();
        assert_eq!(raw.source, "iTunes-CN");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_artist, "周杰伦");
        // 封面放大：/\d+x\d+[a-z]*\.([a-z]+) → /10000x10000bb.$1
        assert_eq!(
            raw.cover_url,
            "https://is1.mzstatic.com/image/thumb/x/10000x10000bb.jpg"
        );
        assert_eq!(raw.genre.as_deref(), Some("华语·经典"));
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.album_type, "Album");
        assert_eq!(raw.total_tracks, 11);
        assert_eq!(raw.track_num, Some(1));
        assert_eq!(raw.duration, 0.0); // iTunes 源不带时长
    }

    #[test]
    fn parse_itunes_requires_positive_result_count() {
        let data = json!({"resultCount": 0, "results": []});
        assert!(parse_itunes(&data, "US", "周杰伦").is_none());
        // 没有封面 → 跳过该条
        let no_art =
            json!({"resultCount": 1, "results": [{"artistName": "周杰伦", "trackName": "稻香"}]});
        assert!(parse_itunes(&no_art, "US", "周杰伦").is_none());
    }

    #[test]
    fn itunes_merge_dedups_and_truncates() {
        let mut found: Vec<Raw> = Vec::new();
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let a = Raw {
            title: "稻香".to_string(),
            artist: "周杰伦".to_string(),
            source: "iTunes-US".to_string(),
            ..Default::default()
        };
        assert!(push_unique(&mut found, &mut seen, a.clone()));
        assert!(
            !push_unique(&mut found, &mut seen, a.clone()),
            "完全重复必须被丢掉"
        );
        // 键只做 casefold，不做简繁归一 → 写法不同视为不同条目（与 Python 一致）
        let b = Raw {
            title: "稻香".to_string(),
            artist: "周杰倫".to_string(),
            source: "iTunes-TW".to_string(),
            ..Default::default()
        };
        assert!(push_unique(&mut found, &mut seen, b));
        let c = Raw {
            title: "稻香".to_string(),
            artist: "周杰伦".to_string(),
            source: "iTunes-CN".to_string(),
            ..Default::default()
        };
        assert!(!push_unique(&mut found, &mut seen, c));
        assert_eq!(found.len(), 2);
        assert_eq!(truncate_per_source(found.clone(), 1).len(), 1);
        assert_eq!(truncate_per_source(found.clone(), 0).len(), 1); // max(1, limit)
        assert_eq!(truncate_per_source(found, 5).len(), 2);
    }

    #[test]
    fn deezer_parse_search_json_and_date_override() {
        let data: Value = serde_json::from_str(
            r#"{"data": [{
                 "title": "稻香",
                 "duration": 223,
                 "artist": {"name": "周杰伦"},
                 "album": {"id": 12345, "title": "魔杰座",
                           "cover_xl": "https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg",
                           "cover_medium": "https://cdn-images.dzcdn.net/images/cover/x/500x500-000000-80-0-0.jpg",
                           "track_count": 11, "release_date": "2008-10-14"}
               }]}"#,
        )
        .unwrap();
        let (raw, album_id) = deezer_candidate(&data, "周杰伦", None).unwrap();
        assert_eq!(album_id.as_deref(), Some("12345"));
        assert_eq!(raw.source, "Deezer");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album, "魔杰座");
        assert!(
            raw.cover_url.contains("1400x1400"),
            "封面应被放大：{}",
            raw.cover_url
        );
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.album_type, "专辑");
        assert_eq!(raw.total_tracks, 11);
        assert_eq!(raw.duration, 223.0);
        assert_eq!(raw.genre, None);

        // 专辑详情那一跳的发行日期覆盖搜索结果
        let (overridden, _) = deezer_candidate(&data, "周杰伦", Some("2008-11-01")).unwrap();
        assert_eq!(overridden.date, "2008-11-01");
        assert_eq!(overridden.year, "2008");

        // 无封面 → 整条丢弃
        let empty = json!({"data": [{"title": "x", "artist": {"name": "周杰伦"}, "album": {"title": "y"}}]});
        assert!(deezer_candidate(&empty, "周杰伦", None).is_none());
        // data 为空 → None
        assert!(deezer_candidate(&json!({"data": []}), "周杰伦", None).is_none());
    }

    #[test]
    fn parse_qq_ranks_by_title_score() {
        let data = json!({"data": {"song": {"list": [
            {"songname": "晴天", "albumname": "叶惠美", "albummid": "mid-a", "time_public": "2003-07-31",
             "interval": 269, "songmid": "song-a", "singer": [{"name": "周杰伦"}]},
            {"songname": "稻香", "albumname": "魔杰座", "albummid": "mid-b", "time_public": "2008-10-14",
             "interval": 223, "songmid": "song-b", "singer": [{"name": "周杰伦"}, {"name": "袁咏琳"}]}
        ]}}});
        let raw = parse_qq(&data, "稻香", "周杰伦").unwrap();
        assert_eq!(raw.title, "稻香"); // 歌名匹配度更高 → 选它（不是遍历顺序第一条）
        assert_eq!(raw.song_id, "song-b");
        assert_eq!(raw.artist, "周杰伦"); // 只取第一位歌手
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_type, "专辑");
        assert_eq!(
            raw.cover_url,
            "https://y.gtimg.cn/music/photo_new/T002R1000x1000M000mid-b.jpg?max_age=2592000"
        );
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.duration, 223.0);
        assert_eq!(qq_score("稻香", "稻香"), 100);
        assert_eq!(qq_score("晴天", "稻香"), 0);
    }

    /// 真实报文（截小）：**2026-10-08** 抓自
    /// `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=稻香&n=10&p=1&format=json&cr=1&t=0`
    /// （HTTP 200，9428 字节）。
    ///
    /// 这里只留了第 1 条 `data.song.list[0]` 里与本实现相关的字段：新接口把发布时间从
    /// `time_public`（字符串）换成了 `pubtime`（unix 秒），所以 `parse_qq` 必须能吃掉它。
    #[test]
    fn parse_qq_real_search_for_qq_cp_response() {
        let data: Value = serde_json::from_str(
            r#"{"code":0,"data":{"keyword":"稻香","song":{"curnum":10,"curpage":1,"list":[
                {"albumid":36062,"albummid":"002Neh8l0uciQZ","albumname":"魔杰座",
                 "interval":223,"pubtime":1224000000,"pure":0,
                 "singer":[{"id":4558,"mid":"0025NhlN2yWrP4","name":"周杰伦"}],
                 "songid":449205,"songmid":"003aAYrm3GE0Ac","songname":"稻香","type":0}
            ]}}}"#,
        )
        .unwrap();
        let raw = parse_qq(&data, "稻香", "周杰伦").expect("真实报文应能出候选");
        assert_eq!(raw.source, "QQMusic");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_type, "专辑"); // 歌名 != 专辑名
        assert_eq!(raw.song_id, "003aAYrm3GE0Ac");
        assert_eq!(raw.duration, 223.0);
        assert_eq!(
            raw.cover_url,
            "https://y.gtimg.cn/music/photo_new/T002R1000x1000M000002Neh8l0uciQZ.jpg?max_age=2592000"
        );
        // 1224000000 → 本地时区 2008-10-14（与老接口的 time_public 一致）
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.year, "2008");
    }

    /// 真实报文（截小）：**2026-10-08** 抓自
    /// `https://search.kuwo.cn/r.s?all=稻香&ft=music&itemset=web_2013&client=kt&rformat=json&encoding=utf8&rn=30&pn=0`
    /// （HTTP 200，68780 字节）。
    ///
    /// 真实响应**没有** `jsondata = ` 前缀，而且 `'ARTIST':'TFBOYS\\\\u0026TF家族'` 这种「反斜杠被
    /// 多层 repr 加倍」的 `\\u0026` 必须解成 `&`；`abslist` 里是嵌套对象，所以旧的
    /// `jsondata\s*=\s*(\{.*?\})` 非贪婪正则在真实报文上必然截断（Python 与本实现都是 0 条）。
    #[test]
    fn kuwo_parse_real_response_json() {
        let real = r#"{'ARTISTPIC':'','HIT':'1317','HITMODE':'song','HIT_BUT_OFFLINE':'0','MSHOW':'0','NEW':'0','PN':'0','RN':'10','SHOW':'10','TOTAL':'1317','UK':'b4994e51-a2c0-4c2e-aaac-dc5b997ef96f','abslist':[{'AARTIST':'','ALBUM':'','ALBUMID':'0','ARTIST':'TFBOYS\\\\u0026TF家族','ARTISTID':'128294','DURATION':'209','MKVRID':'MV_0','MUSICRID':'MUSIC_91637031','PICPATH':'','SONGNAME':'稻香&nbsp;(TF少年GO！第二十期LiveShow现场)','SUBLIST':[]}]}"#;
        assert_eq!(i_of(parse_repr_dict(real).unwrap().get("HIT")), Some(1317));

        // 命中歌手 + `ALBUMID='0'`（拼不出封面）→ 退化为「封面留空」的候选，而不是整条丢弃
        let raw = parse_kuwo(real, "TFBOYS").expect("真实报文应能出候选");
        assert_eq!(raw.source, "Kuwo");
        assert_eq!(raw.artist, "TFBOYS&TF家族"); // `\\u0026` 解成 `&`
        assert_eq!(raw.title, "稻香 (TF少年GO！第二十期LiveShow现场)"); // `&nbsp;` 解成空格
        assert_eq!(raw.cover_url, ""); // ALBUMID=0 → 无封面
        assert_eq!(raw.song_id, "91637031");
        assert_eq!(raw.duration, 209.0);

        // `ALBUMID` 能拼出封面 URL 时照样填（best effort：这个 URL 模式 2026-10-08 实测 404，
        // 所以调用方不再拿封面当筛条，见 `kuwo_cover_url` 的说明）
        let with_album_id = real.replace("'ALBUMID':'0'", "'ALBUMID':'88781504'");
        assert_eq!(
            parse_kuwo(&with_album_id, "TFBOYS").unwrap().cover_url,
            "https://img4.kuwo.cn/star/albumcover/1080/4/15/88781504.jpg"
        );

        // `ALBUM` 字段（真实报文里是 `''`，这里换成真专辑名看归一）
        let with_album = real
            .replace("'ALBUM':''", "'ALBUM':'魔杰座'")
            .replace("'ALBUMID':'0'", "'ALBUMID':'88781504'");
        assert_eq!(parse_kuwo(&with_album, "TFBOYS").unwrap().album, "魔杰座");

        let nores = "{'PN':'0','RN':'0','HIT':'0','TOTAL':'0','SHOW':'0','MSHOW':'0','HITMODE':'nores','ARTISTPIC':'','abslist':[]}";
        assert!(parse_kuwo(nores, "周杰伦").is_none());
        assert!(parse_kuwo("<html>抓取失败</html>", "周杰伦").is_none());

        // 封面 URL 拼接：`{{ALBUMID[-2:]}}/{{ALBUMID[-4:-2]}}`（int() 失败即拼不出）
        assert_eq!(
            kuwo_cover_url("123456"),
            "https://img4.kuwo.cn/star/albumcover/1080/56/34/123456.jpg"
        );
        assert_eq!(kuwo_cover_url("12ab"), "");
        assert_eq!(kuwo_cover_url("7"), ""); // ALBUMID[-4:-2] 为空 → int('') 失败
        assert_eq!(kuwo_cover_url("0"), "");
        assert_eq!(kuwo_cover_url(""), "");
    }

    #[test]
    fn kugou_detail_parses_mobile_songinfo() {
        // 真实报文（截小）：**2026-10-08** 抓自
        // `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=8909e1809908cd8e3bf6cf85d98b93f0`
        // （HTTP 200，2648 字节，周杰伦《稻香》）。手机版详情是**扁平**的、没有 `data` 包一层，
        // 字段名也不同（`songName` / `author_name` / `album_img` / `timeLength`），而且这条
        // `timeLength=0`（付费/受限条目），时长要从 `extra.320timelength` 兜底。
        let body: Value = serde_json::from_str(
            r#"{"authors":[{"author_name":"周杰伦","author_id":3520}],"hash":"8909E1809908CD8E3BF6CF85D98B93F0",
                "author_name":"周杰伦","imgUrl":"http://singerimg.kugou.com/uploadpic/softhead/{size}/20260324203006202058.jpg",
                "errcode":0,"req_albumid":"960399","fail_process":12,"timeLength":0,"bitRate":0,
                "singerName":"周杰伦","fileName":"周杰伦 - 稻香",
                "extra":{"320hash":"21AC928E1D68EC3632EF2CAE68718201","320timelength":223503,"128filesize":3576668},
                "album_img":"http://imge.kugou.com/stdmusic/{size}/20241118/20241118160622508429.jpg",
                "albumid":960399,"songName":"稻香",
                "trans_param":{"language":"国语","union_cover":"http://imge.kugou.com/stdmusic/{size}/20241118/20241118160622508429.jpg"}}"#,
        )
        .unwrap();
        // 第 1 跳搜索命中（截自 `songsearch.kugou.com/song_search_v2?...keyword=稻香&pagesize=20`）
        let hit: Value = serde_json::from_str(
            r#"{"SongName":"稻香","OriSongName":"稻香","FileHash":"8909e1809908cd8e3bf6cf85d98b93f0",
                "SingerName":"周杰伦","AlbumName":"魔杰座","AlbumID":"960399","Duration":223,
                "PublishDate":"2008-10-14","Scid":1}"#,
        )
        .unwrap();

        let raw = parse_kugou_detail(&body, Some(&hit)).unwrap();
        assert_eq!(raw.source, "Kugou");
        assert_eq!(
            raw.cover_url, // album_img 优先，`{size}` → 480
            "http://imge.kugou.com/stdmusic/480/20241118/20241118160622508429.jpg"
        );
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.album, "魔杰座"); // 专辑名只能来自第 1 跳命中
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album_type, "单曲");
        assert_eq!(raw.date, "2008-10-14"); // 第 1 跳命中的 PublishDate
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.duration, 223.0); // timeLength=0 → extra.320timelength

        // 旧形态（`{"data": {...}}` + `song_name`/`album_name`/`timelength`）仍然兼容
        let legacy = json!({"data": {
            "img": "http://imge.kugou.com/soft/collection/{size}/x.jpg",
            "song_name": "稻香", "album_name": "魔杰座", "author_name": "周杰伦",
            "timelength": 223453, "publish_info": "2008-10-14", "trans_param": {}
        }});
        let raw_legacy = parse_kugou_detail(&legacy, None).unwrap();
        assert_eq!(
            raw_legacy.cover_url,
            "http://imge.kugou.com/soft/collection/480/x.jpg"
        );
        assert_eq!(raw_legacy.album, "魔杰座");
        assert_eq!(raw_legacy.duration, 223.0);

        // 没有专辑名 → 用标题；毫秒时间戳（> 1e12）走 /1000 分支
        let no_album = json!({"img": "http://x/{size}.jpg", "songName": "稻香",
                              "author_name": "周杰伦"});
        assert_eq!(parse_kugou_detail(&no_album, None).unwrap().album, "稻香");
        let ms_ts = json!({"img": "http://x/{size}.jpg", "songName": "稻香",
                           "author_name": "周杰伦",
                           "trans_param": {"publish_time": 1223904000000i64}});
        let raw3 = parse_kugou_detail(&ms_ts, None).unwrap();
        assert_eq!(raw3.year.len(), 4, "年份应是 4 位：{}", raw3.year);
        assert_eq!(raw3.date.len(), 10, "日期应是 YYYY-MM-DD：{}", raw3.date);
        // 时长只能来自第 1 跳命中的秒数
        let hit_only = json!({"songName": "稻香", "author_name": "周杰伦",
                              "album_img": "http://x/{size}.jpg"});
        assert_eq!(
            parse_kugou_detail(&hit_only, Some(&hit)).unwrap().duration,
            223.0
        );
        // 无封面 → drop
        assert!(parse_kugou_detail(&json!({"songName": "稻香"}), None).is_none());
    }

    #[test]
    fn parse_lastfm_info_json() {
        let track = json!({"name": "稻香", "artist": "周杰伦"});
        let info = json!({
            "name": "稻香",
            "duration": 223,
            "album": {"title": "魔杰座",
                      "image": [{"size": "small", "#text": "s"}, {"size": "extralarge", "#text": "xl"}],
                      "releasedate": "14 October 2008"},
            "toptags": {"tag": [{"name": "mandopop"}, {"name": "pop"}]}
        });
        let raw = parse_lastfm_info(Some(&info), &track, "周杰伦").unwrap();
        assert_eq!(raw.source, "Last.fm");
        assert_eq!(raw.cover_url, "xl"); // extralarge > large > medium
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.genre.as_deref(), Some("mandopop, pop"));
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.date, "14 October 2008"); // 备用分支保留原值
        assert_eq!(raw.duration, 223.0);
        assert_eq!(raw.album_type, "专辑");

        // 没有封面 → 丢弃
        let no_cover = json!({"name": "稻香", "album": {"title": "魔杰座"}});
        assert!(parse_lastfm_info(Some(&no_cover), &track, "周杰伦").is_none());
    }

    /// 真实报文（截小）：**2026-10-08** 抓自
    /// `https://ws.audioscrobbler.com/2.0/?method=track.search&track=稻香&api_key=<内置 Key>&format=json&limit=5`
    /// —— HTTP 403 + 这 85 字节的响应体。
    ///
    /// 这就是 lastfm 现在恒为 0 条的原因：内置 Key 被上游吊销，只有 `LASTFM_API_KEY`
    /// 提供有效 Key 时这个源才可能出候选。所以这里断言的是**可读错误**而不是「假装没命中」。
    #[test]
    fn lastfm_invalid_key_is_reported() {
        let body: Value = serde_json::from_str(
            r#"{"message":"Invalid API key - You must be granted a valid key by last.fm","error":10}"#,
        )
        .unwrap();
        let reason = lastfm_error_reason(403, &body);
        assert!(reason.contains("403"), "{reason}");
        assert!(reason.contains("error 10"), "{reason}");
        assert!(reason.contains("Invalid API key"), "{reason}");
        assert!(reason.contains("LASTFM_API_KEY"), "{reason}");

        // 其它错误码（例如 artist/track 缺失时的 error 6）也要能读出来
        let other = json!({"message": "Track not found", "error": 6});
        let reason2 = lastfm_error_reason(404, &other);
        assert!(reason2.contains("404") && reason2.contains("error 6"), "{reason2}");
        // 没有 message → 也不能 panic
        let bare = json!({"error": 29});
        assert!(lastfm_error_reason(429, &bare).contains("429"));
    }

    #[test]
    fn parse_theaudiodb_cover_priority() {
        let track = json!({"strTrack": "稻香", "strArtist": "周杰伦", "idAlbum": "123",
                           "strAlbum": "魔杰座"});
        let album = json!({"strAlbum": "魔杰座", "strGenre": "Pop", "intYearReleased": 2008,
                           "strAlbumThumbHD": "https://x/hd.jpg", "strAlbumThumb": "https://x/t.jpg",
                           "strAlbumCDart": "https://x/cd.png"});
        let raw = parse_theaudiodb(&track, Some(&album)).unwrap();
        assert_eq!(raw.source, "TheAudioDB");
        assert_eq!(raw.cover_url, "https://x/hd.jpg"); // HD > Thumb > CDart
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.genre.as_deref(), Some("Pop"));
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.album_type, "专辑");
        assert_eq!(raw.duration, 0.0); // 该源不返回时长
        assert_eq!(raw.date, ""); // 该源不返回日期

        let only_thumb = json!({"strAlbum": "魔杰座", "strAlbumThumb": "https://x/t.jpg"});
        assert_eq!(
            parse_theaudiodb(&track, Some(&only_thumb)).unwrap().cover_url,
            "https://x/t.jpg"
        );
        let only_cd = json!({"strAlbum": "魔杰座", "strAlbumCDart": "https://x/cd.png"});
        assert_eq!(
            parse_theaudiodb(&track, Some(&only_cd)).unwrap().cover_url,
            "https://x/cd.png"
        );
        // 全空 → 丢弃
        assert!(parse_theaudiodb(&track, Some(&json!({"strAlbum": "魔杰座"}))).is_none());
    }

    /// 真实报文（截小）：**2026-10-08** 抓自
    /// `https://www.theaudiodb.com/api/v1/json/123/searchtrack.php?s=coldplay&t=yellow`（HTTP 200）
    /// 与 `https://www.theaudiodb.com/api/v1/json/123/album.php?m=2109615`（HTTP 200）。
    ///
    /// 两处要点：`searchtrack.php` **必须同时给 `s` 和 `t`**（只给 `s` 时上游回 200 + 0 字节），
    /// 真实专辑响应里 `strAlbumThumbHD` / `strAlbumThumbHQ` 是 `null`，只能落到 `strAlbumThumb`。
    #[test]
    fn parse_theaudiodb_real_response() {
        let track: Value = serde_json::from_str(
            r#"{"idTrack":"32724184","idAlbum":"2109615","idArtist":"111239","idLyric":"102256",
                "strTrack":"Yellow","strAlbum":"Parachutes","strArtist":"Coldplay",
                "strArtistAlternate":null,"intCD":"1","intDuration":"269240","strGenre":"Pop-Rock",
                "strMood":"Relaxed","strStyle":"Rock/Pop","intTempo":"86","strTheme":"In Love"}"#,
        )
        .unwrap();
        let album: Value = serde_json::from_str(
            r#"{"idAlbum":"2109615","idArtist":"111239","strAlbum":"Parachutes","strArtist":"Coldplay",
                "intYearReleased":"2000","strStyle":"Rock/Pop","strGenre":"Pop-Rock",
                "strLabel":"Parlophone UK","strReleaseFormat":"Album","intSales":"8500000",
                "strAlbumThumb":"https://r2.theaudiodb.com/images/media/album/thumb/swxywp1367234202.jpg",
                "strAlbumThumbHQ":null,
                "strAlbumCDart":"https://r2.theaudiodb.com/images/media/album/cdart/vtuxpp1429197083.png"}"#,
        )
        .unwrap();
        let raw = parse_theaudiodb(&track, Some(&album)).unwrap();
        assert_eq!(raw.source, "TheAudioDB");
        assert_eq!(raw.title, "Yellow");
        assert_eq!(raw.artist, "Coldplay");
        assert_eq!(raw.album, "Parachutes");
        assert_eq!(raw.album_type, "专辑");
        assert_eq!(raw.genre.as_deref(), Some("Pop-Rock"));
        assert_eq!(raw.year, "2000");
        assert_eq!(
            raw.cover_url,
            "https://r2.theaudiodb.com/images/media/album/thumb/swxywp1367234202.jpg"
        );
        assert_eq!(raw.duration, 0.0); // 该源解析里不取 intDuration
        assert_eq!(raw.date, "");

        // 没有专辑详情（`album.php` 拿不到）→ 无封面，整条丢弃（与 Python 一致）
        assert!(parse_theaudiodb(&track, None).is_none());
    }

    #[test]
    fn parse_spotify_track_json() {
        let data = json!({"tracks": {"items": [{
            "id": "sp-1",
            "name": "稻香",
            "duration_ms": 223453,
            "track_number": 1,
            "disc_number": 1,
            "explicit": false,
            "popularity": 80,
            "external_ids": {"isrc": "TWK970801030"},
            "artists": [{"name": "周杰伦"}],
            "album": {"name": "魔杰座", "album_type": "album", "release_date": "2008-10-14",
                      "images": [{"url": "https://i.scdn.co/image/x"}],
                      "artists": [{"name": "周杰伦"}]}
        }]}});
        let raw = parse_spotify(&data, "周杰伦").unwrap();
        assert_eq!(raw.source, "Spotify");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album_artist, "周杰伦");
        assert_eq!(raw.album_type, "Album"); // capitalize()
        assert_eq!(raw.cover_url, "https://i.scdn.co/image/x");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.date, "2008-10-14");
        assert_eq!(raw.duration, 223.0);
        assert_eq!(raw.track_num, Some(1));
        assert_eq!(raw.disc_num, Some(1));
        assert_eq!(raw.isrc, "TWK970801030");
        assert_eq!(raw.popularity, 80);
        assert!(!raw.explicit);
    }

    #[test]
    fn parse_genius_hit_json() {
        let data = json!({"response": {"hits": [{"result": {
            "id": 123, "title": "稻香", "full_title": "稻香 (2008)",
            "song_art_image_url": "https://images.genius.com/x.jpg",
            "primary_artist": {"name": "周杰伦", "image_url": "https://images.genius.com/a.jpg"},
            "album": {"name": "魔杰座"}
        }}]}});
        let raw = parse_genius(&data, "周杰伦").unwrap();
        assert_eq!(raw.source, "Genius");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.album, "魔杰座");
        assert_eq!(raw.album_type, "单曲");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.date, "2008");
        assert_eq!(raw.cover_url, "https://images.genius.com/x.jpg");
        assert_eq!(raw.song_id, "123");
        assert_eq!(raw.duration, 0.0); // 该源不返回时长
    }

    #[test]
    fn parse_discogs_result_json() {
        let data = json!({"results": [{
            "id": 456, "title": "周杰伦 - 稻香", "year": 2008,
            "cover_image": "https://img.discogs.com/x.jpg",
            "genre": ["Pop"], "style": ["Mandopop"], "format": ["CD"]
        }]});
        let raw = parse_discogs(&data, "周杰伦").unwrap();
        assert_eq!(raw.source, "Discogs");
        assert_eq!(raw.artist, "周杰伦");
        assert_eq!(raw.title, "稻香");
        assert_eq!(raw.album, "稻香");
        assert_eq!(raw.album_artist, "周杰伦");
        assert_eq!(raw.album_type, "专辑");
        assert_eq!(raw.year, "2008");
        assert_eq!(raw.date, "2008");
        assert_eq!(raw.genre.as_deref(), Some("Pop (Mandopop)"));
        assert_eq!(raw.format.as_deref(), Some("CD"));
        assert_eq!(raw.song_id, "456");

        // 标题里没有 " - " → 歌手为空 → fuzzy 为 False → 该条被丢
        let no_artist = json!({"results": [{"title": "稻香", "cover_image": "https://x/y.jpg"}]});
        assert!(parse_discogs(&no_artist, "周杰伦").is_none());
        // 无封面 → 丢
        let no_cover = json!({"results": [{"title": "周杰伦 - 稻香"}]});
        assert!(parse_discogs(&no_cover, "周杰伦").is_none());
    }

    // ---------- 歌词评分 ----------

    #[test]
    fn lyrics_score_rewards_artist_title_duration() {
        let exact = json!({"artistName": "周杰伦", "trackName": "稻香", "duration": 223,
                           "syncedLyrics": "[00:01.00]x"});
        let wrong = json!({"artistName": "某人", "trackName": "别的歌", "duration": 400,
                           "plainLyrics": "y"});
        assert_eq!(
            lyrics_score(&exact, "稻香", "周杰伦", Some(223.0)),
            30 + 40 + 20 + 5
        );
        assert_eq!(lyrics_score(&wrong, "稻香", "周杰伦", Some(223.0)), -15);
        // 时长差 ≤10 → +10
        let close = json!({"artistName": "周杰伦", "trackName": "稻香", "duration": 230});
        assert_eq!(lyrics_score(&close, "稻香", "周杰伦", Some(223.0)), 30 + 40 + 10);
    }

    #[test]
    fn kugou_lyrics_score_table() {
        let candidate = json!({"songname": "稻香", "singername": "周杰伦", "duration": 223});
        assert_eq!(
            kugou_lyrics_score(&candidate, "稻香", "周杰伦", "稻香 周杰伦", Some(223.0)),
            4 + 3 + 2 + 1 + 2
        );
        let far = json!({"songname": "别的歌", "singername": "某人", "duration": 400});
        assert_eq!(
            kugou_lyrics_score(&far, "稻香", "周杰伦", "稻香 周杰伦", Some(223.0)),
            -3
        );
    }

    // ---------- 源过滤 / 排序 / 上下文过滤 ----------

    #[test]
    fn effective_sources_filters_and_falls_back() {
        assert_eq!(
            effective_sources(&[]),
            SEARCH_PRIORITY
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            effective_sources(&["musicbrainz".to_string(), "bogus".to_string()]),
            vec!["musicbrainz".to_string()]
        );
        // 全是未知名 → 回退 SEARCH_PRIORITY（契约 H-3 / tests/test_integration.py:124-127）
        assert_eq!(
            effective_sources(&["bogus".to_string()]).len(),
            SEARCH_PRIORITY.len()
        );
        // 请求顺序即优先级（同分排序用）
        assert_eq!(
            effective_sources(&["deezer".to_string(), "musicbrainz".to_string()]),
            vec!["deezer".to_string(), "musicbrainz".to_string()]
        );
    }

    #[test]
    fn known_sources_covers_engine_keys() {
        let names = known_sources();
        assert!(
            names.len() >= 12,
            "e2e 要求 scraper.count ≥ 12，实际 {}",
            names.len()
        );
        for required in [
            "musicbrainz",
            "itunes",
            "deezer",
            "netease",
            "qq",
            "kuwo",
            "kugou",
            "lastfm",
            "theaudiodb",
            "spotify",
            "genius",
            "ytmusic",
        ] {
            assert!(names.contains(&required), "缺少源 {required}");
        }
    }

    #[test]
    fn sort_is_score_desc_then_source_priority() {
        let mut pairs = vec![
            pair("deezer", raw("Deezer", "a", "", 0.0)),
            pair("musicbrainz", raw("MusicBrainz", "b", "", 0.0)),
            pair("itunes", raw("iTunes-CN", "c", "", 0.0)),
        ];
        for (_, cand) in pairs.iter_mut() {
            cand.score = 100.0;
        }
        let order: HashMap<String, usize> = ["deezer", "musicbrainz", "itunes"]
            .iter()
            .enumerate()
            .map(|(i, s)| (s.to_string(), i))
            .collect();
        sort_scored(&mut pairs, &order);
        assert_eq!(pairs[0].1.source, "deezer");
        assert_eq!(pairs[1].1.source, "musicbrainz");
        assert_eq!(pairs[2].1.source, "itunes");
        // 分数优先于源顺序
        pairs[2].1.score = 200.0;
        sort_scored(&mut pairs, &order);
        assert_eq!(pairs[0].1.source, "itunes");
    }

    #[test]
    fn filter_album_context_matches_python() {
        let mut pairs = vec![pair("a", raw("", "1", "", 0.0)), pair("b", raw("", "2", "", 0.0))];
        pairs[0].0.context = "studio".to_string();
        pairs[1].0.context = "compilation".to_string();
        filter_album_context(&mut pairs);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1.title, "1");

        // 只有 compilation → 不削减（Python：non_compilation or candidates）
        let mut only_comp = vec![pair("a", raw("", "1", "", 0.0))];
        only_comp[0].0.context = "compilation".to_string();
        filter_album_context(&mut only_comp);
        assert_eq!(only_comp.len(), 1);

        // 搜索路径上 context 恒为 "" → 恒等变换（契约 A5.8）
        let mut plain = vec![pair("a", raw("", "1", "", 0.0)), pair("b", raw("", "2", "", 0.0))];
        filter_album_context(&mut plain);
        assert_eq!(plain.len(), 2);
    }

    // ---------- 工具函数（Python 语义） ----------

    #[test]
    fn python_helpers_semantics() {
        assert_eq!(as_text(Some(&json!(["A", "B"]))), "A & B");
        assert_eq!(as_text(Some(&json!(["A", ""]))), "A");
        assert_eq!(as_text(Some(&json!(" x "))), "x");
        assert_eq!(as_text(None), "");
        assert!(truthy(Some(&json!({"a": 1}))));
        assert!(!truthy(Some(&json!({}))));
        assert!(!truthy(Some(&json!(0))));
        assert_eq!(
            first_truthy(&[Some(&json!(0)), Some(&json!("real"))]),
            Some(&json!("real"))
        );
        assert_eq!(i_of(Some(&json!(223.9))), Some(223)); // int() 截断
        assert_eq!(i_of(Some(&json!("223"))), Some(223));
        assert_eq!(i_of(None), None);
        assert_eq!(prefix_chars("2008-10-14", 4), "2008");
        assert_eq!(prefix_chars("abc", 10), "abc");
        assert_eq!(py_capitalize("album"), "Album");
        assert_eq!(py_capitalize(""), "");
        assert_eq!(py_float_str(223.0), "223.0"); // LRCLIB 的 duration 参数写法
        assert_eq!(kuwo_cover_url(""), "");
    }

    #[test]
    fn translate_raw_genre_matches_table() {
        assert_eq!(translate_raw_genre(""), "未知");
        assert_eq!(translate_raw_genre("Mandopop"), "华语·经典");
        assert_eq!(translate_raw_genre("Hip-Hop/Rap"), "嘻哈·街头");
        assert_eq!(translate_raw_genre("Pop"), "Pop"); // 表里没有的原样保留
        assert_eq!(translate_raw_genre("Rock&Pop"), "摇滚·热血 / Pop"); // & 先当分隔符
    }

    #[test]
    fn base64_roundtrip() {
        assert_eq!(b64_encode(b"metatidy"), "bWV0YXRpZHk=");
        assert_eq!(b64_decode("bWV0YXRpZHk=").unwrap(), b"metatidy");
        assert_eq!(b64_decode("bWV0\nYXRpZHk=").unwrap(), b"metatidy"); // 忽略空白
        assert!(b64_decode("!!!!").is_none());
    }

    /// 取证测试（**真实联网**，默认被 `#[ignore]` 跳过，所以 CI 的离线测试不受影响）。
    ///
    /// 依次查 qq / kugou / kuwo / lastfm / theaudiodb，打印每源的 HTTP 情况（`run.note`）、
    /// 候选数、首条标题/歌手；**五个源全都 0 条就 panic**——这是一颗有牙齿的自检：
    /// 上游再改版（接口下线、参数必需、Key 被拒）时它会红，而不是静默变成「永远空」。
    ///
    /// 跑法：`cargo test --release live_verify_extra_sources -- --ignored --nocapture`
    ///
    /// 关键词固定「周杰伦 / 稻香」（2026-10-08 实测 QQ / 酷狗 / 酷我都能出候选）；
    /// 末尾额外用 Coldplay / Yellow 给 TheAudioDB 做一次英文旁证——该库以欧美曲目为主，
    /// 对中文歌它上游自己就没有数据（`search.php?s=周杰伦` → `{"artists":null}`）。
    #[test]
    #[ignore]
    fn live_verify_extra_sources() {
        let client = reqwest::Client::builder()
            .user_agent(APP_USER_AGENT)
            .build()
            .expect("构建 reqwest client 失败");
        let runtime = tokio::runtime::Runtime::new().expect("构建 tokio runtime 失败");
        runtime.block_on(async {
            let mut non_empty = 0usize;
            for name in ["qq", "kugou", "kuwo", "lastfm", "theaudiodb"] {
                let run = run_source(&client, name, "稻香", "周杰伦", 5).await;
                let count = run.raws.len();
                if count > 0 {
                    non_empty += 1;
                }
                let first = run
                    .raws
                    .first()
                    .map(|raw| {
                        format!(
                            "{} / {}（专辑 {} {}，时长 {}s，封面 {}）",
                            raw.title,
                            raw.artist,
                            if raw.album.is_empty() { "-" } else { &raw.album },
                            if raw.year.is_empty() { "-" } else { &raw.year },
                            raw.duration,
                            if raw.cover_url.is_empty() { "-" } else { "有" }
                        )
                    })
                    .unwrap_or_else(|| "<无候选>".to_string());
                println!(
                    "[live] {:<11} count={count} 上游={} 首条={first}",
                    name, run.note
                );
                if !run.error.is_empty() {
                    println!("[live] {:<11} SourceStatus.error={}", name, run.error);
                }
            }

            // 英文旁证：TheAudioDB 确实可用（中文歌是上游没数据，不是本实现坏）
            let en = run_source(&client, "theaudiodb", "Yellow", "Coldplay", 5).await;
            println!(
                "[live] {:<11} count={} 上游={} 首条={}",
                "theaudiodb*",
                en.raws.len(),
                en.note,
                en.raws
                    .first()
                    .map(|r| format!("{} / {}（封面 {}）", r.title, r.artist, r.cover_url))
                    .unwrap_or_else(|| "<无候选>".to_string())
            );

            println!("[live] 五个源里有候选的：{non_empty}/5");
            assert!(
                non_empty > 0,
                "qq/kugou/kuwo/lastfm/theaudiodb 在这次真实联网探针里全部 0 条候选（见上面的 [live] 行）"
            );
        });
    }
}

#[cfg(test)]
mod redact_tests {
    use super::*;

    /// 真实形态：Last.fm / Genius / Discogs 的密钥都在查询串里，Redis 连接串在 userinfo 里。
    #[test]
    fn redacts_secrets_in_urls() {
        let cases = [
            (
                "error sending request for url (https://ws.audioscrobbler.com/2.0/?method=track.search&api_key=abcSECRET123&format=json)",
                "api_key=***",
            ),
            (
                "url (https://api.genius.com/search?q=x&access_token=tok_9f8e7d6c)",
                "access_token=***",
            ),
            (
                "url (https://api.discogs.com/database/search?q=y&token=dscSECRETVAL&type=release)",
                "token=***",
            ),
            ("连接失败 redis://:p4ssw0rd@127.0.0.1:6379", "://***@"),
        ];
        for (raw, expect) in cases {
            let out = redact_secrets(raw);
            assert!(out.contains(expect), "「{raw}」遮后是「{out}」，应含「{expect}」");
            assert!(
                !out.contains("SECRET") && !out.contains("9f8e7d6c") && !out.contains("p4ssw0rd"),
                "还有敏感值没遮住：{out}"
            );
        }
    }

    /// 不含密钥的文本必须原样保留（否则排障信息会被误伤）。
    #[test]
    fn leaves_normal_text_untouched() {
        for plain in [
            "url (https://musicbrainz.org/ws/2/recording?query=dao&fmt=json)",
            "HTTP 403 / error 10：Invalid API key",
            "url (http://search.kuwo.cn/r.s?all=dao&rn=30&pn=0)",
        ] {
            assert_eq!(redact_secrets(plain), plain, "不该被改动：{plain}");
        }
    }

    /// 用**真 reqwest 错误**跑一遍，确认整条链路是遮住的（而不是只测了纯字符串函数）。
    #[tokio::test]
    async fn real_reqwest_error_carries_no_key() {
        let client = reqwest::Client::new();
        let url = "http://127.0.0.1:1/2.0/?method=track.search&api_key=SENTINELLEAKPROBE&format=json";
        let raw = client
            .get(url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .expect_err("127.0.0.1:1 应该连不上");
        let redacted = redact_secrets(&format!("{raw}"));
        println!("reqwest 原始：{raw}\n遮后：{redacted}");
        assert!(
            !redacted.contains("SENTINELLEAKPROBE"),
            "密钥还是漏出去了：{redacted}"
        );
    }
}
