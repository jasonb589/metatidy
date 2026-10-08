//! 从路径推断语言（离线、零成本、无网络）。
//!
//! 用户的库通常**已经按语言分好目录**（`.../【Music】/俄文/ADÉLA/PRIMA/x.flac`），
//! 但标签里的 language 字段经常是空的。不兜底的话，按 `{language}` 整理时
//! 会把整棵语言目录压平——这是不可接受的破坏。
//!
//! 规则：取「库根目录下的第一层目录名」，只有命中已知语言名（或形如 `XX文`）才采用；
//! 拿不准就返回空串，让模板的 `{language?}` 把整段丢掉。

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;

static KNOWN: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "中文", "国语", "华语", "粤语", "英文", "英语", "日文", "日语", "韩文", "韩语",
        "泰文", "俄文", "俄语", "法文", "法语", "德文", "德语", "西文", "西班牙文", "西班牙语",
        "意文", "意大利文", "意大利语", "越南文", "越语", "尼泊尔文", "土耳其文", "葡萄牙文",
        "葡文", "阿拉伯文", "印地文", "印度文", "印尼文", "马来文", "菲律宾文", "波兰文",
        "荷兰文", "瑞典文", "挪威文", "丹麦文", "芬兰文", "冰岛文", "希腊文", "希伯来文",
        "波斯文", "乌克兰文", "捷克文", "斯洛伐克文", "匈牙利文", "罗马尼亚文", "保加利亚文",
        "塞尔维亚文", "克罗地亚文", "斯洛文尼亚文", "立陶宛文", "拉脱维亚文", "爱沙尼亚文",
        "爱尔兰文", "威尔士文", "加泰罗尼亚文", "拉丁文", "世界语", "蒙古文", "藏文",
        "维吾尔文", "哈萨克文", "孟加拉文", "泰米尔文", "乌尔都文", "僧伽罗文", "缅甸文",
        "高棉文", "老挝文", "阿姆哈拉文", "斯瓦希里文", "祖鲁文", "南非荷兰文", "纯音乐",
        "instrumental", "chinese", "english", "japanese", "korean",
    ]
    .into_iter()
    .collect()
});

/// 同义目录名归一：只处理「同一概念两种常见写法」，其余原样返回（不擅自改用户目录名）。
static ALIASES: Lazy<HashSet<(&'static str, &'static str)>> = Lazy::new(|| {
    [
        ("国语", "中文"),
        ("华语", "中文"),
        ("英语", "英文"),
        ("日语", "日文"),
        ("韩语", "韩文"),
    ]
    .into_iter()
    .collect()
});

/// 兜底：形如「俄文」「土耳其文」的目录名（1-5 个汉字 + 文）。
static GENERIC: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[\u{4e00}-\u{9fff}]{1,5}文$").expect("语言正则必须合法"));

/// 按「库根下第一层目录名」推断语言；拿不准返回空串。
pub fn infer_language(path: &Path, root: &Path) -> String {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => return String::new(),
    };
    let mut comps = rel.components();
    let first = match comps.next() {
        Some(c) => c.as_os_str().to_string_lossy().trim().to_string(),
        None => return String::new(),
    };
    // 只有一层（就是文件名本身）说明文件直接在库根下，没有语言目录
    if comps.next().is_none() {
        return String::new();
    }
    for (from, to) in ALIASES.iter() {
        if first == *from {
            return (*to).to_string();
        }
    }
    if KNOWN.contains(first.as_str()) {
        return first;
    }
    if GENERIC.is_match(&first) {
        return first;
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn infers_from_first_level_directory() {
        let root = PathBuf::from("/lib");
        let cases = [
            ("/lib/俄文/ADÉLA/PRIMA/song.flac", "俄文"),
            ("/lib/尼泊尔文/Ekdev/album/song.flac", "尼泊尔文"),
            ("/lib/土耳其文/Gülşen/BAL/song.flac", "土耳其文"),
            ("/lib/中文/周杰伦/魔杰座/稻香.flac", "中文"),
            ("/lib/英文/ADELE/25/Hello.flac", "英文"),
            ("/lib/国语/某歌手/专辑/x.flac", "中文"),
            ("/lib/未分类/某歌手/专辑/x.flac", ""),
            ("/lib/song.flac", ""),
        ];
        for (path, want) in cases {
            assert_eq!(infer_language(Path::new(path), &root), want, "路径 {path}");
        }
    }

    #[test]
    fn returns_empty_for_path_outside_root() {
        let root = PathBuf::from("/lib");
        assert_eq!(infer_language(Path::new("/elsewhere/俄文/x.flac"), &root), "");
    }
}
