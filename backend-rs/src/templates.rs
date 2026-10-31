//! 目录 / 文件名模板引擎（功能 3 的核心）。
//!
//! 语法与 Python 版完全一致，前端不用改：
//! - 占位符 `{artist}` `{album}` …；补零 `{track:02}`；可选段 `{track:02?}`
//! - 目录层级用 `/` 分隔
//!
//! 空值规则：
//! - **有回退文案的字段**（artist / albumartist / album / title）为空时用回退值，
//!   保证文件不会散落在库根目录
//! - **没有回退的字段**（language / albumtype / year / track / disc…）为空时该段**整段丢弃**
//! - 占位符为空时会顺手收掉残留的悬空分隔符：`{track:02} - {title}` → `稻香` 而不是 `- 稻香`

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::models::Track;
use crate::normalize::normalize_artist_credit;

static TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::(\d+))?(\?)?\}").expect("占位符正则必须合法")
});
static LEAD_SEP: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s\-_.]+").expect("正则必须合法"));
static TAIL_SEP: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s\-_.]+$").expect("正则必须合法"));
static DUP_SEP: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s*[-_.]\s*[-_.]\s*").expect("正则必须合法"));
static WHITESPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("正则必须合法"));

const MAX_SEGMENT_LEN: usize = 120;

/// 目录层级模板的默认值。
///
/// CLI 自检、设置接口的默认值、整理移动的兜底、模板自检**四处共用这一份** ——
/// 以前它们各写各的（有的带 `?` 有的不带、文件名兜底甚至写成 `{title}`），
/// 会出现「设置页显示一个模板、整理移动预览按另一个模板算」的错觉。
pub const DEFAULT_DIR_TEMPLATE: &str = "{language?}/{artist}/{album}";

/// 文件名模板的默认值。
///
/// 注意它**不含歌手**：默认布局里歌手已经在目录层级（`{artist}` 那一段），
/// 文件名再带一遍会很长。想让文件名带上歌手，把设置里的文件名模板改成
/// `{title} - {artist}` 即可（设置页的「实时试渲染」会立刻显示结果）。
pub const DEFAULT_FILENAME_TEMPLATE: &str = "{track:02} - {title}";

/// Windows 保留设备名，必须避开。
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 把一段名字清理成合法文件名。
pub fn sanitize_filename(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | '*' | '?' | ':' | '"' | '<' | '>' | '|' => '_',
            '\0' => ' ',
            other => other,
        })
        .collect();
    let mut cleaned = WHITESPACE.replace_all(replaced.trim(), " ").to_string();
    cleaned = cleaned
        .trim_end_matches(|c: char| c == '.' || c == ' ')
        .to_string();

    if cleaned.is_empty() {
        return "Unknown".to_string();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        cleaned = format!("_{cleaned}");
    }
    if cleaned.chars().count() > MAX_SEGMENT_LEN {
        cleaned = cleaned.chars().take(MAX_SEGMENT_LEN).collect::<String>();
        cleaned = cleaned
            .trim_end_matches(|c: char| c == '.' || c == ' ')
            .to_string();
    }
    cleaned
}

/// 从 `3/12`、`03` 这类音轨号里取出数字部分。
fn leading_number(value: &str) -> String {
    value
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect()
}

/// 占位符为空时收掉悬空分隔符（`- 稻香` → `稻香`）。
pub fn tidy_separators(text: &str) -> String {
    let a = LEAD_SEP.replace(text, "").to_string();
    let b = TAIL_SEP.replace(&a, "").to_string();
    let c = DUP_SEP.replace_all(&b, " - ").to_string();
    c.trim().to_string()
}

/// 把一条曲目转成模板取值字典。
pub fn build_values(
    track: &Track,
    unknown_artist: &str,
    unknown_album: &str,
    unknown_other: &str,
) -> HashMap<String, String> {
    let raw_artist = track.artist.trim();
    let raw_albumartist = if track.albumartist.trim().is_empty() {
        raw_artist
    } else {
        track.albumartist.trim()
    };

    let artist = if raw_artist.is_empty() {
        unknown_artist.to_string()
    } else {
        normalize_artist_credit(raw_artist)
    };
    let albumartist = if raw_albumartist.is_empty() {
        unknown_artist.to_string()
    } else {
        normalize_artist_credit(raw_albumartist)
    };
    let album = if track.album.trim().is_empty() {
        unknown_album.to_string()
    } else {
        track.album.trim().to_string()
    };
    let title = if track.title.trim().is_empty() {
        if track.filename.trim().is_empty() {
            unknown_other.to_string()
        } else {
            track.filename.trim().to_string()
        }
    } else {
        track.title.trim().to_string()
    };
    let original = Path::new(&track.filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| title.clone());

    let mut v = HashMap::new();
    v.insert("artist".to_string(), artist);
    v.insert("albumartist".to_string(), albumartist);
    v.insert("album".to_string(), album);
    v.insert("title".to_string(), title);
    v.insert("genre".to_string(), track.genre.trim().to_string());
    v.insert("language".to_string(), track.language.trim().to_string());
    v.insert("albumtype".to_string(), track.albumtype.trim().to_string());
    v.insert("mb_artist_id".to_string(), track.mb_artist_id.trim().to_string());
    v.insert(
        "release_group_id".to_string(),
        track.release_group_id.trim().to_string(),
    );
    v.insert("ext".to_string(), track.ext.trim_start_matches('.').to_string());
    v.insert("original".to_string(), original);
    v.insert("track".to_string(), leading_number(&track.track));
    v.insert("disc".to_string(), leading_number(&track.disc));
    v.insert("year".to_string(), leading_number(&track.year));
    v
}

/// 渲染单个路径段，返回 (文本, 是否应整段丢弃)。
pub fn render_segment(template: &str, values: &HashMap<String, String>) -> (String, bool) {
    let mut optional_seen = false;
    let mut optional_nonempty = false;
    let mut empty_seen = false;
    let mut literal_rest = template.to_string();

    let rendered = TOKEN
        .replace_all(template, |caps: &regex::Captures| {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let width = caps.get(2).map(|m| m.as_str().to_string());
            let optional = caps.get(3).is_some();

            let mut text = values.get(name).cloned().unwrap_or_default();
            if let Some(w) = width {
                if !text.is_empty() {
                    let width_i: usize = w.parse().unwrap_or(0);
                    if text.chars().all(|c| c.is_ascii_digit()) {
                        while text.chars().count() < width_i {
                            text.insert(0, '0');
                        }
                    } else {
                        text = text.chars().take(width_i).collect();
                    }
                }
            }
            if text.is_empty() {
                empty_seen = true;
            }
            if optional {
                optional_seen = true;
                if !text.is_empty() {
                    optional_nonempty = true;
                }
                let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
                literal_rest = literal_rest.replace(&whole, "");
            }
            text
        })
        .to_string();

    let mut out = rendered;
    if empty_seen {
        out = tidy_separators(&out);
    }
    if optional_seen && !optional_nonempty {
        let leftover = TOKEN.replace_all(&literal_rest, "").to_string();
        let meaningful: String = leftover
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_' && *c != '.')
            .collect();
        if meaningful.is_empty() {
            return (String::new(), true);
        }
    }
    (out, false)
}

/// 把模板切成路径段，兼容 `/`、`\` 与全角斜杠。
pub fn split_segments(template: &str) -> Vec<String> {
    template
        .replace('\\', "/")
        .replace('／', "/")
        .replace('＼', "/")
        .split('/')
        .map(|s| s.to_string())
        .collect()
}

/// 渲染目录层级（相对路径，不含文件名）。
pub fn render_relative_dir(template: &str, values: &HashMap<String, String>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for seg in split_segments(template) {
        if seg.trim().is_empty() {
            continue;
        }
        let (text, drop) = render_segment(&seg, values);
        if drop || text.trim().is_empty() {
            continue;
        }
        let cleaned = sanitize_filename(&text);
        let only_separators = text
            .trim_matches(|c: char| c.is_whitespace() || c == '.' || c == '-' || c == '_')
            .is_empty();
        if cleaned == "Unknown" && only_separators {
            continue;
        }
        parts.push(cleaned);
    }
    parts.join("/")
}

/// 渲染文件名（含扩展名）。
pub fn render_filename(
    template: &str,
    values: &HashMap<String, String>,
    ext: Option<&str>,
) -> String {
    let effective = if template.trim().is_empty() {
        "{title}"
    } else {
        template
    };
    let (text, _) = render_segment(effective, values);
    let mut stem = sanitize_filename(&text);
    if stem == "Unknown" && text.trim().is_empty() {
        let fallback = values
            .get("title")
            .cloned()
            .unwrap_or_else(|| "Unknown".to_string());
        stem = sanitize_filename(&fallback);
    }
    let suffix = ext
        .map(|e| e.trim_start_matches('.').to_string())
        .or_else(|| values.get("ext").cloned())
        .unwrap_or_default();
    if suffix.is_empty() {
        stem
    } else {
        format!("{stem}.{suffix}")
    }
}

/// 算出这条曲目按模板应有的完整目标路径。
pub fn target_path(
    track: &Track,
    library_root: &Path,
    dir_template: &str,
    filename_template: &str,
    unknown_artist: &str,
    unknown_album: &str,
    unknown_other: &str,
) -> PathBuf {
    let values = build_values(track, unknown_artist, unknown_album, unknown_other);
    let rel_dir = render_relative_dir(dir_template, &values);
    let filename = render_filename(filename_template, &values, Some(track.ext.as_str()));
    // 逐段 push，而不是 `library_root.join(rel_dir)`：
    // rel_dir 是「中文/周杰伦/魔杰座」这种带 `/` 的整串，Windows 上 join 会保留内层 `/`，
    // 得到 `root\中文/周杰伦/魔杰座` 这种**混用分隔符**的路径——它在文件系统上没问题，
    // 但和索引里存的（原生分隔符）按字符串比就不相等，端到端验收第 30 项因此挂过。
    let mut target = library_root.to_path_buf();
    for segment in rel_dir.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue; // 段已由 render_relative_dir/sanitize_filename 过滤，这里再兜一层
        }
        target.push(segment);
    }
    target.push(filename);
    target
}

/// 检查模板里的未知占位符，返回警告（不抛异常）。
pub fn validate_template(template: &str, known_keys: &[&str]) -> Vec<String> {
    let mut warnings = Vec::new();
    if template.trim().is_empty() {
        warnings.push("模板为空".to_string());
    }
    for caps in TOKEN.captures_iter(template) {
        let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        if !known_keys.contains(&name) {
            warnings.push(format!("未知占位符 {{{name}}} —— 将被替换为空"));
        }
    }
    if template.split('/').any(|s| s == "..") {
        warnings.push("模板包含 .. 段，已被安全过滤".to_string());
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> Track {
        Track {
            id: 1,
            path: "/lib/稻香.flac".into(),
            filename: "稻香.flac".into(),
            ext: ".flac".into(),
            title: "稻香".into(),
            artist: "周杰伦".into(),
            albumartist: "周杰伦".into(),
            album: "魔杰座".into(),
            year: "2008".into(),
            track: "3/12".into(),
            disc: "1/1".into(),
            genre: "流行".into(),
            language: "中文".into(),
            albumtype: "专辑".into(),
            ..Default::default()
        }
    }

    fn values_of(t: &Track) -> HashMap<String, String> {
        build_values(t, "未知艺术家", "未知专辑", "未知")
    }

    #[test]
    fn sanitize_handles_illegal_and_reserved() {
        assert_eq!(sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_filename("  trailing.  "), "trailing");
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename(""), "Unknown");
        assert_eq!(sanitize_filename("   "), "Unknown");
    }

    #[test]
    fn renders_directory_layers() {
        let v = values_of(&track());
        assert_eq!(render_relative_dir("{language}/{artist}/{album}", &v), "中文/周杰伦/魔杰座");
    }

    #[test]
    fn pads_and_splits_track_number() {
        let v = values_of(&track());
        assert_eq!(render_filename("{track:02} - {title}", &v, Some(".flac")), "03 - 稻香.flac");
        assert_eq!(render_filename("{disc:02}.{track:03}", &v, Some(".mp3")), "01.003.mp3");
    }

    #[test]
    fn empty_optional_segment_is_dropped() {
        let mut t = track();
        t.language = String::new();
        let v = values_of(&t);
        assert_eq!(render_relative_dir("{language?}/{artist}/{album}", &v), "周杰伦/魔杰座");
        assert_eq!(render_relative_dir("{language}/{artist}", &v), "周杰伦");
    }

    #[test]
    fn empty_track_number_leaves_no_dangling_dash() {
        // 关键回归：这条是 Python 版上线后被端到端验收抓出来的真 bug
        let mut t = track();
        t.track = String::new();
        let v = values_of(&t);
        assert_eq!(render_filename("{track:02} - {title}", &v, Some(".flac")), "稻香.flac");
        assert_eq!(render_filename("{track:02}. {title}", &v, Some(".flac")), "稻香.flac");
    }

    #[test]
    fn artist_can_be_put_into_filename_by_template() {
        // 用户的实际诉求：文件名要是「探故知 - 浅影阿」。
        // 默认模板不含歌手（默认布局里歌手已经在目录层级），想让文件名带上歌手就改模板。
        let t = track();
        let mut v = values_of(&t);
        v.insert("title".to_string(), "探故知".to_string());
        v.insert("artist".to_string(), "浅影阿".to_string());
        assert_eq!(
            render_filename("{title} - {artist}", &v, Some(".flac")),
            "探故知 - 浅影阿.flac"
        );
        // 默认模板确实不含歌手（这条断言是给以后改默认值的人看的）
        assert!(!DEFAULT_FILENAME_TEMPLATE.contains("{artist}"));
    }

    #[test]
    fn tidy_separators_keeps_normal_dashes() {
        assert_eq!(tidy_separators("- 稻香"), "稻香");
        assert_eq!(tidy_separators("A - - B"), "A - B");
        assert_eq!(tidy_separators("KGB - ADÉLA"), "KGB - ADÉLA");
        assert_eq!(tidy_separators("   "), "");
    }

    #[test]
    fn unknown_fields_fall_back() {
        let t = Track {
            filename: "x.flac".into(),
            ext: ".flac".into(),
            album: String::new(),
            albumartist: String::new(),
            artist: "周杰伦".into(),
            ..Default::default()
        };
        let v = values_of(&t);
        assert_eq!(render_relative_dir("{artist}/{album}", &v), "周杰伦/未知专辑");
    }

    #[test]
    fn target_path_stays_inside_root() {
        let t = track();
        let target = target_path(
            &t,
            Path::new("/lib"),
            "{language}/{artist}/{album}",
            "{track:02} - {title}",
            "未知艺术家",
            "未知专辑",
            "未知",
        );
        assert_eq!(target, PathBuf::from("/lib/中文/周杰伦/魔杰座/03 - 稻香.flac"));
    }

    #[test]
    fn path_traversal_is_neutralised() {
        let mut t = track();
        t.artist = "../../etc".into();
        let target = target_path(&t, Path::new("/lib"), "{artist}", "{title}", "未知", "未知", "未知");
        // sanitize 会把 / 换成 _，所以不会真的跳出库根
        assert!(target.starts_with("/lib"));
        assert!(!target.to_string_lossy().contains(".."));
    }

    #[test]
    fn validate_reports_unknown_placeholder() {
        let w = validate_template("{nope}/{artist}", &["artist", "album", "title"]);
        assert!(w.iter().any(|s| s.contains("nope")));
    }
}
