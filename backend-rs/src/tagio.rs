//! 标签读写层（lofty）：mp3 / flac / m4a / ogg / opus 全格式读写。
//!
//! 这是选 Rust 的核心理由之一——lofty 是唯一能**读写**全部主流容器格式的编译型标签库
//! （Go 那套 bogem/id3v2 只能写 MP3，dhowden/tag 写入能力也有限）。
//!
//! 对外接口与 Python 版语义一致：
//! - `read_tags` 读回全部字段（失败也返回结构体，错误放在 `error` 里，不抛异常）
//! - `preview_update` 只算不写，返回 `字段 -> (旧值, 新值)`
//! - `apply_update` 真正落盘，`overwrite=false` 时跳过已有非空值

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag, TagExt, TagType};
use std::collections::HashMap;
use std::path::Path;

use crate::models::{FieldChange, EDITABLE_FIELDS};

/// 专辑类型没有标准的 ItemKey，用自由键（与 Python 版写入的 TXXX/Vorbis 键一致）。
const ALBUM_TYPE_KEY: &str = "ALBUMTYPE";

/// 从文件读回来的原始标签。
#[derive(Debug, Clone, Default)]
pub struct RawTags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub albumartist: String,
    pub genre: String,
    pub year: String,
    pub track: String,
    pub disc: String,
    pub language: String,
    pub composer: String,
    pub lyricist: String,
    pub copyright: String,
    pub albumtype: String,
    pub comment: String,
    pub mb_artist_id: String,
    pub release_group_id: String,
    pub has_cover: bool,
    pub has_lyrics: bool,
    pub duration: f64,
    pub format: String,
    /// 解析失败时的原因（文件损坏、格式不支持、磁盘读不出来）
    pub error: Option<String>,
    /// 文件里是否真的有标签块
    pub present: bool,
}

impl RawTags {
    pub fn field(&self, name: &str) -> &str {
        match name {
            "title" => &self.title,
            "artist" => &self.artist,
            "album" => &self.album,
            "albumartist" => &self.albumartist,
            "genre" => &self.genre,
            "year" => &self.year,
            "track" => &self.track,
            "disc" => &self.disc,
            "language" => &self.language,
            "composer" => &self.composer,
            "lyricist" => &self.lyricist,
            "copyright" => &self.copyright,
            "albumtype" => &self.albumtype,
            "comment" => &self.comment,
            "mb_artist_id" => &self.mb_artist_id,
            "release_group_id" => &self.release_group_id,
            _ => "",
        }
    }
}

/// 按扩展名选择合适的标签类型（新建标签时用）。
fn pick_tag_type(path: &Path) -> TagType {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp3" => TagType::Id3v2,
        "m4a" | "mp4" => TagType::Mp4Ilst,
        _ => TagType::VorbisComments,
    }
}

/// 读一个文件的标签。任何失败都体现在 `error` 里，不 panic、不抛异常。
pub fn read_tags(path: &Path) -> RawTags {
    let mut out = RawTags {
        format: path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
        ..Default::default()
    };

    let tagged = match Probe::open(path).and_then(|probe| probe.read()) {
        Ok(tagged) => tagged,
        Err(err) => {
            out.error = Some(format!("{err}"));
            return out;
        }
    };

    out.duration = tagged.properties().duration().as_secs_f64();
    out.format = format!("{:?}", tagged.file_type()).to_lowercase();

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        out.present = true;
        out.title = tag.title().map(|v| v.to_string()).unwrap_or_default();
        out.artist = tag.artist().map(|v| v.to_string()).unwrap_or_default();
        out.album = tag.album().map(|v| v.to_string()).unwrap_or_default();
        out.genre = tag.genre().map(|v| v.to_string()).unwrap_or_default();
        out.year = tag.year().map(|v| v.to_string()).unwrap_or_default();
        out.track = tag.track().map(|v| v.to_string()).unwrap_or_default();
        out.disc = tag.disk().map(|v| v.to_string()).unwrap_or_default();
        out.comment = tag.comment().map(|v| v.to_string()).unwrap_or_default();

        out.albumartist = tag
            .get_string(&ItemKey::AlbumArtist)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.composer = tag
            .get_string(&ItemKey::Composer)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.lyricist = tag
            .get_string(&ItemKey::Lyricist)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.copyright = tag
            .get_string(&ItemKey::CopyrightMessage)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.language = tag
            .get_string(&ItemKey::Language)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.mb_artist_id = tag
            .get_string(&ItemKey::MusicBrainzArtistId)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.release_group_id = tag
            .get_string(&ItemKey::MusicBrainzReleaseGroupId)
            .map(|v| v.to_string())
            .unwrap_or_default();
        out.albumtype = tag
            .get_string(&ItemKey::Unknown(ALBUM_TYPE_KEY.to_string()))
            .map(|v| v.to_string())
            .unwrap_or_default();

        out.has_cover = !tag.pictures().is_empty();
        out.has_lyrics = tag
            .get_string(&ItemKey::Lyrics)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
    }

    out
}

/// 取内嵌封面原图。
pub fn read_cover(path: &Path) -> Option<(Vec<u8>, String)> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let picture = tag.pictures().first()?;
    let mime = picture
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some((picture.data().to_vec(), mime))
}

/// 读内嵌歌词（没有则空串）。
pub fn read_lyrics(path: &Path) -> String {
    let tagged = match Probe::open(path).and_then(|p| p.read()) {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None => return String::new(),
    };
    tag.get_string(&ItemKey::Lyrics)
        .map(|v| v.to_string())
        .unwrap_or_default()
}

/// 只算不写：返回 `字段 -> (旧值, 新值)`，只包含真正会变化的字段。
pub fn preview_update(path: &Path, desired: &HashMap<String, String>) -> HashMap<String, FieldChange> {
    let current = read_tags(path);
    let mut diff = HashMap::new();
    for (key, value) in desired {
        if !EDITABLE_FIELDS.contains(&key.as_str()) {
            continue;
        }
        let old = current.field(key).trim().to_string();
        let new = value.trim().to_string();
        if old == new {
            continue;
        }
        diff.insert(key.clone(), FieldChange { old, new });
    }
    diff
}

/// 把单个字段写进标签对象。
fn set_one(tag: &mut Tag, key: &str, value: &str) {
    match key {
        "title" => tag.set_title(value.to_string()),
        "artist" => tag.set_artist(value.to_string()),
        "album" => tag.set_album(value.to_string()),
        "genre" => tag.set_genre(value.to_string()),
        "comment" => tag.set_comment(value.to_string()),
        "year" => {
            // 年份可能是 "2008" 或 "2008-11-01"：能解析成数字就用标准字段，否则写自由文本
            match value.get(0..4).and_then(|y| y.parse::<u32>().ok()) {
                Some(y) => tag.set_year(y),
                None => {
                    tag.insert_text(ItemKey::Year, value.to_string());
                }
            }
        }
        "track" => {
            if let Ok(n) = value.trim().parse::<u32>() {
                tag.set_track(n);
            }
        }
        "disc" => {
            if let Ok(n) = value.trim().parse::<u32>() {
                tag.set_disk(n);
            }
        }
        "albumartist" => {
            tag.insert_text(ItemKey::AlbumArtist, value.to_string());
        }
        "composer" => {
            tag.insert_text(ItemKey::Composer, value.to_string());
        }
        "lyricist" => {
            tag.insert_text(ItemKey::Lyricist, value.to_string());
        }
        "copyright" => {
            tag.insert_text(ItemKey::CopyrightMessage, value.to_string());
        }
        "language" => {
            tag.insert_text(ItemKey::Language, value.to_string());
        }
        "mb_artist_id" => {
            tag.insert_text(ItemKey::MusicBrainzArtistId, value.to_string());
        }
        "release_group_id" => {
            tag.insert_text(ItemKey::MusicBrainzReleaseGroupId, value.to_string());
        }
        "albumtype" => {
            tag.insert_text(ItemKey::Unknown(ALBUM_TYPE_KEY.to_string()), value.to_string());
        }
        _ => {}
    }
}

/// 真正把字段写进文件。
///
/// - `overwrite = false` 时跳过「文件里已有非空值」的字段
/// - `cover` / `lyrics` 是可选附加内容
/// - 返回实际写入的字段数
pub fn apply_update(
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
    cover: Option<(Vec<u8>, String)>,
    lyrics: Option<&str>,
) -> anyhow::Result<usize> {
    let tagged = Probe::open(path)
        .map_err(|e| anyhow::anyhow!("打开失败：{e}"))?
        .read()
        .map_err(|e| anyhow::anyhow!("解析标签失败：{e}"))?;

    let tag_type = pick_tag_type(path);
    let mut tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(existing) => existing.clone(),
        None => Tag::new(tag_type),
    };

    let current = read_tags(path);
    let mut written = 0usize;
    for (key, value) in desired {
        if !EDITABLE_FIELDS.contains(&key.as_str()) || value.trim().is_empty() {
            continue;
        }
        if !overwrite && !current.field(key).trim().is_empty() {
            continue;
        }
        set_one(&mut tag, key, value.trim());
        written += 1;
    }

    if let Some(text) = lyrics {
        if !text.trim().is_empty() {
            tag.insert_text(ItemKey::Lyrics, text.to_string());
            written += 1;
        }
    }

    if let Some((data, mime)) = cover {
        if !data.is_empty() {
            let mime_type = if mime.to_lowercase().contains("png") {
                MimeType::Png
            } else {
                MimeType::Jpeg
            };
            let picture = Picture::new_unchecked(mime_type, PictureType::CoverFront, None, data);
            tag.push_picture(picture);
            written += 1;
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| anyhow::anyhow!("写入标签失败：{e}"))?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("metatidy-tagio-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn flac_roundtrip() {
        let path = tmp("roundtrip.flac");
        fixtures::make_flac(&path).unwrap();

        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "稻香".to_string());
        desired.insert("artist".to_string(), "周杰伦 & 费玉清".to_string());
        desired.insert("album".to_string(), "魔杰座".to_string());
        desired.insert("year".to_string(), "2008".to_string());
        desired.insert("track".to_string(), "3".to_string());
        desired.insert("albumartist".to_string(), "周杰伦".to_string());

        let written = apply_update(&path, &desired, true, None, None).unwrap();
        assert!(written >= 5, "至少写了 5 个字段，实际 {written}");

        let back = read_tags(&path);
        assert_eq!(back.title, "稻香");
        assert_eq!(back.artist, "周杰伦 & 费玉清");
        assert_eq!(back.album, "魔杰座");
        assert_eq!(back.year, "2008");
        assert_eq!(back.track, "3");
        assert_eq!(back.albumartist, "周杰伦");
        assert!(back.error.is_none());
        assert!(back.present);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn preview_does_not_write() {
        let path = tmp("preview.flac");
        fixtures::make_flac(&path).unwrap();

        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "新名字".to_string());
        let diff = preview_update(&path, &desired);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff["title"].old, "");
        assert_eq!(diff["title"].new, "新名字");

        // 文件不能被改动
        let after = read_tags(&path);
        assert_eq!(after.title, "");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn overwrite_false_keeps_existing_value() {
        let path = tmp("overwrite.flac");
        fixtures::make_flac(&path).unwrap();

        let mut first = HashMap::new();
        first.insert("album".to_string(), "原专辑".to_string());
        apply_update(&path, &first, true, None, None).unwrap();

        let mut second = HashMap::new();
        second.insert("album".to_string(), "新专辑".to_string());
        apply_update(&path, &second, false, None, None).unwrap();
        assert_eq!(read_tags(&path).album, "原专辑");

        apply_update(&path, &second, true, None, None).unwrap();
        assert_eq!(read_tags(&path).album, "新专辑");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lyrics_roundtrip() {
        let path = tmp("lyrics.flac");
        fixtures::make_flac(&path).unwrap();
        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "带歌词".to_string());
        apply_update(&path, &desired, true, None, Some("测试歌词第一行")).unwrap();
        assert_eq!(read_lyrics(&path), "测试歌词第一行");
        assert!(read_tags(&path).has_lyrics);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mp3_roundtrip() {
        let path = tmp("roundtrip.mp3");
        fixtures::make_mp3(&path, 8).unwrap();
        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "七里香".to_string());
        desired.insert("artist".to_string(), "周杰伦".to_string());
        desired.insert("albumtype".to_string(), "专辑".to_string());
        apply_update(&path, &desired, true, None, None).unwrap();
        let back = read_tags(&path);
        assert_eq!(back.title, "七里香");
        assert_eq!(back.artist, "周杰伦");
        assert_eq!(back.albumtype, "专辑");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_reports_error_without_panicking() {
        let tags = read_tags(Path::new("/definitely/not/here.flac"));
        assert!(tags.error.is_some());
    }
}
