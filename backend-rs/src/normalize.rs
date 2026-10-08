//! 多歌手归一化：统一用 ` & ` 连接（与 Python 版行为一致）。
//!
//! 规则来自原始需求：「歌手之间用 & 连接，而且要同时作用到文件名和标签里」。
//! - 显式分隔符：`/ 、 ， , ; ； & ＆ feat. ft. featuring with`
//! - 空格拆分**只在同书写体系相邻时**生效：CJK↔CJK、CJK↔拉丁 才拆，
//!   所以 "Jay Chou" 不会被拆成两个人，而 "周杰伦 五月天" 会
//! - feature 参与者保留，主歌手排第一

use once_cell::sync::Lazy;
use regex::Regex;

static SEPARATORS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*(?:/|、|，|,|;|；|&|＆|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*")
        .expect("分隔符正则必须合法")
});

/// 是否含 CJK（中日韩）字符。
pub fn has_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        let u = c as u32;
        (0x3400..=0x4DBF).contains(&u)
            || (0x4E00..=0x9FFF).contains(&u)
            || (0x3040..=0x30FF).contains(&u)
            || (0xAC00..=0xD7AF).contains(&u)
            || (0xF900..=0xFAFF).contains(&u)
    })
}

/// 空格拆分：只要相邻两侧有一侧含 CJK 就拆。
fn split_on_spaces(part: &str) -> Vec<String> {
    let tokens: Vec<&str> = part.split_whitespace().filter(|t| !t.is_empty()).collect();
    if tokens.len() <= 1 {
        return tokens.into_iter().map(|s| s.to_string()).collect();
    }
    let mut groups: Vec<String> = vec![tokens[0].to_string()];
    for pair in tokens.windows(2) {
        let (prev, cur) = (pair[0], pair[1]);
        if has_cjk(prev) || has_cjk(cur) {
            groups.push(cur.to_string());
        } else if let Some(last) = groups.last_mut() {
            last.push(' ');
            last.push_str(cur);
        }
    }
    groups
}

/// 把任意写法归一成 `A & B & C`；空输入返回空串。
pub fn normalize_artist_credit(name: &str) -> String {
    let text = name.trim();
    if text.is_empty() {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();
    for chunk in SEPARATORS.split(text) {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        parts.extend(split_on_spaces(chunk));
    }

    let mut seen: Vec<String> = Vec::new();
    let mut ordered: Vec<String> = Vec::new();
    for part in parts {
        let cleaned = part.trim_matches(|c: char| c.is_whitespace() || ".-&、，,".contains(c));
        if cleaned.is_empty() {
            continue;
        }
        let key = cleaned.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        ordered.push(cleaned.to_string());
    }
    ordered.join(" & ")
}

/// 按旧规则重组 `标题 - 歌手` 文件名：仅当恰好一个 " - " 时才重建。
pub fn normalize_filename_artist_credit(stem: &str) -> String {
    let text = stem.trim();
    if text.matches(" - ").count() != 1 {
        return text.to_string();
    }
    let mut it = text.splitn(2, " - ");
    let title = it.next().unwrap_or("").trim();
    let artist = it.next().unwrap_or("").trim();
    let normalized = normalize_artist_credit(artist);
    if normalized.is_empty() {
        return text.to_string();
    }
    format!("{title} - {normalized}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separators_become_ampersand() {
        let cases = [
            ("A & B", "A & B"),
            ("A/B", "A & B"),
            ("A、B", "A & B"),
            ("A feat. B", "A & B"),
            ("A ft. B", "A & B"),
            ("A featuring B", "A & B"),
            ("A with B", "A & B"),
            ("周杰伦 五月天", "周杰伦 & 五月天"),
            ("Jay Chou 周杰伦", "Jay Chou & 周杰伦"),
            ("周杰伦 Jay Chou", "周杰伦 & Jay Chou"),
            ("A & A", "A"),
            ("", ""),
            ("   陈奕迅   ", "陈奕迅"),
            ("A、B，C;D；E with F", "A & B & C & D & E & F"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_artist_credit(input), want, "输入 {input:?}");
        }
    }

    #[test]
    fn latin_spaces_are_not_split() {
        // 关键回归：全拉丁名字里的空格不能当分隔符
        assert_eq!(normalize_artist_credit("Olivia Rodrigo"), "Olivia Rodrigo");
        assert_eq!(normalize_artist_credit("Jay Chou"), "Jay Chou");
        assert_eq!(normalize_artist_credit("Taylor Swift"), "Taylor Swift");
    }

    #[test]
    fn filename_rebuild_only_with_single_separator() {
        assert_eq!(
            normalize_filename_artist_credit("稻香 - 周杰伦/费玉清"),
            "稻香 - 周杰伦 & 费玉清"
        );
        assert_eq!(normalize_filename_artist_credit("A - B - C"), "A - B - C");
    }

    #[test]
    fn cjk_detection() {
        assert!(has_cjk("周杰伦"));
        assert!(has_cjk("カタカナ"));
        assert!(!has_cjk("Jay Chou"));
    }
}
