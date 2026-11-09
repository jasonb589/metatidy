//! 标签读写层（lofty）：mp3 / flac / m4a / ogg / opus 全格式读写。
//!
//! 这是选 Rust 的核心理由之一——lofty 是唯一能**读写**全部主流容器格式的编译型标签库
//! （Go 那套 bogem/id3v2 只能写 MP3，dhowden/tag 写入能力也有限）。
//!
//! 对外接口与 Python 版语义一致：
//! - `read_tags` 读回全部字段（失败也返回结构体，错误放在 `error` 里，不抛异常）
//! - `preview_update` 只算不写，返回有效差异与逐字段跳过原因
//! - `apply_update` 只保存有效变化，并读回确认实际结果

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagExt, TagItem, TagType};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{BufReader, Seek};
use std::path::Path;

use crate::models::{FieldChange, EDITABLE_FIELDS};

/// 专辑类型没有标准的 `ItemKey`，只能按自由键写。
///
/// 坑：lofty 的 `Tag::insert_text` / `Tag::insert` 会对 `ItemKey::Unknown` 做映射校验，
/// 校验不过就**静默丢弃**（不报错、文件里也没有）。写自由键必须走 `insert_unchecked`。
const ALBUM_TYPE_KEY: &str = "ALBUMTYPE";

/// 每个容器要写的全部自由键拼写（与 Python 版一致，见 docs/PORT_NOTES.md §3）。
///
/// 为什么写多个：同一个概念各家软件各写各的拼写，只写一个键的话，
/// foobar2000 / MusicBrainz Picard / Navidrome 这类工具读不到。
fn album_type_keys(tag_type: TagType) -> &'static [&'static str] {
    match tag_type {
        // ID3v2：写成 4 个 TXXX，描述分别是下面 4 个
        TagType::Id3v2 => &[
            "ALBUMTYPE",
            "Album Type",
            "RELEASETYPE",
            "MusicBrainz Album Type",
        ],
        // MP4：自由原子 ----:com.apple.iTunes:<key>
        TagType::Mp4Ilst => &["ALBUMTYPE", "RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE"],
        // Vorbis（flac / ogg / opus）：键名按惯例全大写
        _ => &["ALBUMTYPE", "RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE"],
    }
}

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

    raw_from_file(&tagged)
}

fn raw_from_file(tagged: &TaggedFile) -> RawTags {
    let mut out = RawTags {
        duration: tagged.properties().duration().as_secs_f64(),
        format: format!("{:?}", tagged.file_type()).to_lowercase(),
        ..Default::default()
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        out.present = true;
        out.title = tag.title().map(|v| v.to_string()).unwrap_or_default();
        out.artist = tag.artist().map(|v| v.to_string()).unwrap_or_default();
        out.album = tag.album().map(|v| v.to_string()).unwrap_or_default();
        out.genre = tag.genre().map(|v| v.to_string()).unwrap_or_default();
        out.year = tag.year().map(|v| v.to_string()).unwrap_or_default();
        out.track = read_tag_number(tag, ItemKey::TrackNumber, tag.track());
        out.disc = read_tag_number(tag, ItemKey::DiscNumber, tag.disk());
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
        out.albumtype = read_albumtype(tag);

        out.has_cover = !tag.pictures().is_empty();
        out.has_lyrics = tag
            .get_string(&ItemKey::Lyrics)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
    }

    out
}

/// Vorbis comments may store "2/12" verbatim, which lofty's generic numeric
/// accessor cannot parse. Keep its standard result first, then read the number
/// before the total without changing the original file or accepting bad values.
fn read_tag_number(tag: &Tag, key: ItemKey, parsed: Option<u32>) -> String {
    parsed
        .or_else(|| {
            let raw = tag.get_string(&key)?;
            let number = raw.split('/').next()?.trim();
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            number.parse::<u32>().ok()
        })
        .map(|number| number.to_string())
        .unwrap_or_default()
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkippedField {
    pub field: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl SkippedField {
    pub fn new(field: impl Into<String>, reason: &str) -> Self {
        Self {
            field: field.into(),
            reason: reason.to_string(),
            detail: None,
        }
    }

    pub fn unavailable(field: &str, detail: &str) -> Self {
        Self {
            field: field.to_string(),
            reason: "unavailable".to_string(),
            detail: Some(detail.to_string()),
        }
    }
}

/// Per-file decisions shared by the preview and the actual writer. Lyrics are
/// an explicit edit and intentionally do not depend on the overwrite switch.
pub struct UpdatePlan {
    pub current: RawTags,
    pub effective_fields: HashMap<String, String>,
    pub changes: HashMap<String, FieldChange>,
    pub skipped: Vec<SkippedField>,
    pub lyrics: Option<String>,
    sync_keys: Vec<String>,
}

/// Confirmed disk values, never the unverified candidate/request values.
pub struct UpdateOutcome {
    pub written: Vec<String>,
    pub skipped: Vec<SkippedField>,
    pub changes: HashMap<String, FieldChange>,
    pub readback_fields: HashMap<String, String>,
    pub has_cover: bool,
    pub has_lyrics: bool,
    pub cover_written: bool,
    pub lyrics_written: bool,
    pub file_changed: bool,
}

/// Private, persisted precondition for a reviewed write. Never accept this
/// structure from a client: only the server's immutable plan may supply it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GuardedBaseline {
    version: u8,
    file: FileFingerprint,
    tags_digest: String,
    desired: HashMap<String, String>,
    overwrite: bool,
    effective_fields: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct FileFingerprint {
    requested_path: String,
    canonical_path: String,
    length: u64,
    modified_ns: String,
    identity: String,
}

fn file_identity(meta: &Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Stable Rust exposes creation time on Windows. Unix also checks the
        // inode/device; real tag content is independently checked on both.
        format!("{}:{}", meta.creation_time(), meta.file_attributes())
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("{:?}", meta.created().ok())
    }
}

fn fingerprint(path: &Path, file: &File) -> Result<FileFingerprint, UpdateError> {
    let result = (|| -> std::io::Result<FileFingerprint> {
        let opened = file.metadata()?;
        let named = std::fs::metadata(path)?;
        if !opened.is_file()
            || !named.is_file()
            || opened.len() != named.len()
            || opened.modified()? != named.modified()?
            || file_identity(&opened) != file_identity(&named)
        {
            return Err(std::io::Error::other("路径指向的文件在读取期间发生变化"));
        }
        let modified = opened.modified()?;
        let modified_ns = match modified.duration_since(std::time::UNIX_EPOCH) {
            Ok(value) => value.as_nanos().to_string(),
            Err(value) => format!("-{}", value.duration().as_nanos()),
        };
        Ok(FileFingerprint {
            requested_path: path.to_string_lossy().into_owned(),
            canonical_path: path.canonicalize()?.to_string_lossy().into_owned(),
            length: opened.len(),
            modified_ns,
            identity: file_identity(&opened),
        })
    })();
    result.map_err(|err| update_error("stale", false, format!("文件状态已改变，请重新预览：{err}")))
}

fn read_open_file(path: &Path, file: &mut File) -> Result<TaggedFile, UpdateError> {
    file.rewind()
        .map_err(|err| update_error("read", false, err.to_string()))?;
    let reader = BufReader::new(file);
    let probe = match FileType::from_path(path) {
        Some(kind) => Probe::with_file_type(reader, kind),
        None => Probe::new(reader),
    };
    probe
        .read()
        .map_err(|err| update_error("read", false, format!("读取标签失败：{err}")))
}

/// Hash tag values, including custom fields, lyrics and artwork, without
/// copying large binary pictures into debug strings or reading all audio data.
fn tags_digest(tagged: &TaggedFile) -> String {
    fn part(hash: &mut Sha256, bytes: &[u8]) {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    let mut hash = Sha256::new();
    part(&mut hash, b"metatidy-reviewed-tags-v1");
    for tag in tagged.tags() {
        part(&mut hash, format!("{:?}", tag.tag_type()).as_bytes());
        for item in tag.items() {
            part(&mut hash, format!("{:?}", item.key()).as_bytes());
            part(&mut hash, item.lang());
            part(&mut hash, item.description().as_bytes());
            match item.value() {
                ItemValue::Text(text) => {
                    part(&mut hash, b"text");
                    part(&mut hash, text.as_bytes());
                }
                ItemValue::Locator(text) => {
                    part(&mut hash, b"locator");
                    part(&mut hash, text.as_bytes());
                }
                ItemValue::Binary(bytes) => {
                    part(&mut hash, b"binary");
                    part(&mut hash, bytes);
                }
            }
        }
        for picture in tag.pictures() {
            part(&mut hash, format!("{:?}", picture.pic_type()).as_bytes());
            part(
                &mut hash,
                picture
                    .mime_type()
                    .map(|value| value.as_str())
                    .unwrap_or("")
                    .as_bytes(),
            );
            part(&mut hash, picture.description().unwrap_or("").as_bytes());
            part(&mut hash, picture.data());
        }
    }
    format!("{:x}", hash.finalize())
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct UpdateError {
    pub stage: &'static str,
    /// True also means a save failed midway and may have changed the file.
    pub file_changed: bool,
    pub message: String,
}

fn update_error(
    stage: &'static str,
    file_changed: bool,
    message: impl Into<String>,
) -> UpdateError {
    UpdateError {
        stage,
        file_changed,
        message: message.into(),
    }
}

fn open_for_update(path: &Path) -> Result<TaggedFile, UpdateError> {
    Probe::open(path)
        .and_then(|probe| probe.read())
        .map_err(|err| update_error("read", false, format!("读取标签失败：{err}")))
}

fn canonical_field(key: &str, value: &str) -> Result<String, &'static str> {
    if !EDITABLE_FIELDS.contains(&key) {
        return Err("unsupported");
    }
    let value = value.trim();
    if value.is_empty() {
        return Err("blank");
    }
    match key {
        "track" | "disc" => {
            if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("invalid");
            }
            value
                .parse::<u32>()
                .map(|number| number.to_string())
                .map_err(|_| "invalid")
        }
        "year" => {
            let year = value.get(..4).ok_or("invalid")?;
            if !year.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("invalid");
            }
            let number = year.parse::<u32>().map_err(|_| "invalid")?;
            if number < 1000 {
                return Err("invalid");
            }
            Ok(number.to_string())
        }
        _ => Ok(value.to_string()),
    }
}

fn lyrics_in(tag: Option<&Tag>) -> String {
    tag.and_then(|tag| tag.get_string(&ItemKey::Lyrics))
        .unwrap_or("")
        .to_string()
}

fn plan_update(
    tagged: &TaggedFile,
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
    lyrics: Option<&str>,
) -> UpdatePlan {
    let current = raw_from_file(tagged);
    let original = tagged.primary_tag().or_else(|| tagged.first_tag());
    let mut planned_tag = original
        .cloned()
        .unwrap_or_else(|| Tag::new(pick_tag_type(path)));
    let mut plan = UpdatePlan {
        current,
        effective_fields: HashMap::new(),
        changes: HashMap::new(),
        skipped: Vec::new(),
        lyrics: None,
        sync_keys: Vec::new(),
    };
    let mut keys: Vec<_> = desired.keys().collect();
    keys.sort();
    for key in keys {
        let value = match canonical_field(key, &desired[key]) {
            Ok(value) => value,
            Err(reason) => {
                plan.skipped.push(SkippedField::new(key, reason));
                continue;
            }
        };
        let old = plan.current.field(key).trim().to_string();
        // Keep valid requested fields in the readback set even when their disk
        // value is retained: this repairs stale indexes without overwriting tags.
        plan.sync_keys.push(key.clone());
        if old == value {
            plan.skipped.push(SkippedField::new(key, "unchanged"));
        } else if !overwrite && !old.is_empty() {
            plan.skipped.push(SkippedField::new(key, "existing"));
        } else if set_one(&mut planned_tag, key, &value) {
            plan.changes.insert(
                key.clone(),
                FieldChange {
                    old,
                    new: value.clone(),
                },
            );
            plan.effective_fields.insert(key.clone(), value);
        } else {
            plan.sync_keys.pop();
            plan.skipped.push(SkippedField::new(key, "unsupported"));
        }
    }
    if let Some(text) = lyrics {
        let new = text.trim();
        let old = lyrics_in(original);
        if new.is_empty() {
            plan.skipped.push(SkippedField::new("lyrics", "blank"));
        } else if old.trim() == new {
            plan.skipped.push(SkippedField::new("lyrics", "unchanged"));
        } else if planned_tag.insert_text(ItemKey::Lyrics, new.to_string()) {
            plan.lyrics = Some(new.to_string());
            plan.changes.insert(
                "lyrics".to_string(),
                FieldChange {
                    old,
                    new: new.to_string(),
                },
            );
        } else {
            plan.skipped
                .push(SkippedField::new("lyrics", "unsupported"));
        }
    }
    plan
}

pub fn preview_update(
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
    lyrics: Option<&str>,
) -> Result<UpdatePlan, UpdateError> {
    let tagged = open_for_update(path)?;
    Ok(plan_update(&tagged, path, desired, overwrite, lyrics))
}

/// Read-only, real-file preview. Callers hold the shared library lock through
/// index lookup and this call so an in-process move cannot change the path.
pub fn preview_guarded(
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
) -> Result<(UpdatePlan, GuardedBaseline), UpdateError> {
    let mut file = File::open(path)
        .map_err(|err| update_error("read", false, format!("读取文件失败：{err}")))?;
    let before = fingerprint(path, &file)?;
    let tagged = read_open_file(path, &mut file)?;
    if fingerprint(path, &file)? != before {
        return Err(update_error(
            "stale",
            false,
            "文件在预览期间发生变化，请重新预览",
        ));
    }
    let plan = plan_update(&tagged, path, desired, overwrite, None);
    let baseline = GuardedBaseline {
        version: 1,
        file: before,
        tags_digest: tags_digest(&tagged),
        desired: desired.clone(),
        overwrite,
        effective_fields: plan.effective_fields.clone(),
    };
    Ok((plan, baseline))
}

/// Verify and save using the same opened file, then read that handle back.
/// This detects normal external edits/replacements; it is not an operating
/// system transaction against arbitrary external software. Application writers
/// must hold the shared library lock until index synchronization completes.
pub fn apply_guarded(
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
    baseline: &GuardedBaseline,
) -> Result<UpdateOutcome, UpdateError> {
    if baseline.version != 1 || baseline.desired != *desired || baseline.overwrite != overwrite {
        return Err(update_error(
            "stale",
            false,
            "写入参数与已预览计划不一致，请重新预览",
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| update_error("read", false, format!("打开文件失败：{err}")))?;
    if fingerprint(path, &file)? != baseline.file {
        return Err(update_error(
            "stale",
            false,
            "文件在预览后发生变化，请重新预览",
        ));
    }
    let tagged = read_open_file(path, &mut file)?;
    let plan = plan_update(&tagged, path, desired, overwrite, None);
    if fingerprint(path, &file)? != baseline.file
        || tags_digest(&tagged) != baseline.tags_digest
        || plan.effective_fields != baseline.effective_fields
    {
        return Err(update_error(
            "stale",
            false,
            "真实标签与已预览内容不一致，请重新预览",
        ));
    }
    write_plan(path, tagged, plan, None, Some((&mut file, baseline)))
}

/// 把单个字段写进标签对象。
fn set_one(tag: &mut Tag, key: &str, value: &str) -> bool {
    let item_key = match key {
        "title" => ItemKey::TrackTitle,
        "artist" => ItemKey::TrackArtist,
        "album" => ItemKey::AlbumTitle,
        "genre" => ItemKey::Genre,
        "comment" => ItemKey::Comment,
        "track" => ItemKey::TrackNumber,
        "disc" => ItemKey::DiscNumber,
        "albumartist" => ItemKey::AlbumArtist,
        "composer" => ItemKey::Composer,
        "lyricist" => ItemKey::Lyricist,
        "copyright" => ItemKey::CopyrightMessage,
        "language" => ItemKey::Language,
        "mb_artist_id" => ItemKey::MusicBrainzArtistId,
        "release_group_id" => ItemKey::MusicBrainzReleaseGroupId,
        "year" => {
            if let Ok(year) = value.parse::<u32>() {
                tag.set_year(year);
                return tag.year() == Some(year);
            }
            return false;
        }
        "albumtype" => {
            for key in album_type_keys(tag.tag_type()) {
                tag.insert_unchecked(TagItem::new(
                    ItemKey::Unknown((*key).to_string()),
                    ItemValue::Text(value.to_string()),
                ));
            }
            return true;
        }
        _ => return false,
    };
    tag.insert_text(item_key, value.to_string())
}

/// Write only effective changes, then read back the actual values for the index.
/// Lyrics are explicit replacements; existing artwork follows `overwrite`.
pub fn apply_update(
    path: &Path,
    desired: &HashMap<String, String>,
    overwrite: bool,
    cover: Option<(Vec<u8>, String)>,
    lyrics: Option<&str>,
) -> Result<UpdateOutcome, UpdateError> {
    let tagged = open_for_update(path)?;
    let plan = plan_update(&tagged, path, desired, overwrite, lyrics);
    write_plan(
        path,
        tagged,
        plan,
        cover.map(|cover| (cover, overwrite)),
        None,
    )
}

fn write_plan(
    path: &Path,
    tagged: TaggedFile,
    mut plan: UpdatePlan,
    cover: Option<((Vec<u8>, String), bool)>,
    guarded_file: Option<(&mut File, &GuardedBaseline)>,
) -> Result<UpdateOutcome, UpdateError> {
    let original = tagged.primary_tag().or_else(|| tagged.first_tag());
    let mut tag = original
        .cloned()
        .unwrap_or_else(|| Tag::new(pick_tag_type(path)));
    for (key, value) in &plan.effective_fields {
        if !set_one(&mut tag, key, value) {
            return Err(update_error(
                "plan",
                false,
                format!("标签格式不支持字段：{key}"),
            ));
        }
    }
    if let Some(text) = &plan.lyrics {
        if !tag.insert_text(ItemKey::Lyrics, text.clone()) {
            return Err(update_error("plan", false, "标签格式不支持歌词"));
        }
    }

    let mut cover_written = false;
    let mut expected_cover = None;
    if let Some(((data, mime), overwrite)) = cover {
        if data.is_empty() {
            plan.skipped.push(SkippedField::new("cover", "blank"));
        } else if !overwrite && !tag.pictures().is_empty() {
            plan.skipped.push(SkippedField::new("cover", "existing"));
        } else if tag
            .pictures()
            .first()
            .map(|picture| picture.data() == data.as_slice())
            .unwrap_or(false)
        {
            plan.skipped.push(SkippedField::new("cover", "unchanged"));
        } else {
            while !tag.pictures().is_empty() {
                let _ = tag.remove_picture(0);
            }
            expected_cover = Some(data.clone());
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(MimeType::from_str(&mime)),
                None,
                data,
            ));
            cover_written = true;
        }
    }
    let lyrics_written = plan.lyrics.is_some();
    let file_changed = !plan.effective_fields.is_empty() || lyrics_written || cover_written;
    let after = if file_changed {
        let readback = if let Some((file, baseline)) = guarded_file {
            if fingerprint(path, file)? != baseline.file {
                return Err(update_error(
                    "stale",
                    false,
                    "文件在写入前发生变化，请重新预览",
                ));
            }
            file.rewind()
                .map_err(|err| update_error("read", false, err.to_string()))?;
            tag.save_to(file, WriteOptions::default()).map_err(|err| {
                update_error(
                    "write",
                    true,
                    format!("保存标签失败，文件可能已部分改变：{err}"),
                )
            })?;
            let after = read_open_file(path, file);
            // A renamed/replaced path after saving must not be synchronized to
            // the index as if it still referred to the file we just wrote.
            let named =
                fingerprint(path, file).map_err(|err| update_error("verify", true, err.message))?;
            if named.requested_path != baseline.file.requested_path
                || named.canonical_path != baseline.file.canonical_path
            {
                return Err(update_error(
                    "verify",
                    true,
                    "标签已保存，但文件路径已变化；请核对文件并重新扫描",
                ));
            }
            after
        } else {
            tag.save_to_path(path, WriteOptions::default())
                .map_err(|err| {
                    update_error(
                        "write",
                        true,
                        format!("保存标签失败，文件可能已部分改变：{err}"),
                    )
                })?;
            open_for_update(path)
        };
        readback.map_err(|err| {
            update_error(
                "verify",
                true,
                format!("文件已保存，但读回验证失败；请重新扫描：{}", err.message),
            )
        })?
    } else {
        tagged
    };
    let readback = raw_from_file(&after);
    let after_tag = after.primary_tag().or_else(|| after.first_tag());
    for (key, expected) in &plan.effective_fields {
        if readback.field(key).trim() != expected {
            return Err(update_error(
                "verify",
                true,
                format!("文件已保存，但字段 {key} 读回值与预期不符；请重新扫描并检查文件",),
            ));
        }
    }
    if let Some(expected) = &plan.lyrics {
        if lyrics_in(after_tag).trim() != expected {
            return Err(update_error(
                "verify",
                true,
                "文件已保存，但歌词读回验证不一致；请重新扫描",
            ));
        }
    }
    if let Some(expected) = expected_cover {
        if !after_tag
            .and_then(|tag| tag.pictures().first())
            .map(|picture| picture.data() == expected.as_slice())
            .unwrap_or(false)
        {
            return Err(update_error(
                "verify",
                true,
                "文件已保存，但封面读回验证不一致；请重新扫描",
            ));
        }
    }
    let mut written: Vec<String> = plan.effective_fields.keys().cloned().collect();
    written.sort();
    let readback_fields = plan
        .sync_keys
        .iter()
        .map(|key| (key.clone(), readback.field(key).trim().to_string()))
        .collect();
    for key in &written {
        if let Some(change) = plan.changes.get_mut(key) {
            change.new = readback.field(key).trim().to_string();
        }
    }
    Ok(UpdateOutcome {
        written,
        skipped: plan.skipped,
        changes: plan.changes,
        readback_fields,
        has_cover: readback.has_cover,
        has_lyrics: readback.has_lyrics,
        cover_written,
        lyrics_written,
        file_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    /// 真实编码器产出的样本由 CI 提供（ffmpeg 生成）；没有就跳过，但 CI 里必须有。
    fn require(kind: &str) -> Option<std::path::PathBuf> {
        let got = match kind {
            "flac" => fixtures::real_fixture("METATIDY_TEST_FLAC", "tagio.flac"),
            _ => fixtures::real_fixture("METATIDY_TEST_MP3", "tagio.mp3"),
        };
        if got.is_none() {
            eprintln!("跳过：未提供真实 {kind} 样本（METATIDY_TEST_FLAC / METATIDY_TEST_MP3）");
        }
        got
    }
    /// CI 里必须提供真实样本，否则下面的写入测试会静默跳过、丢掉覆盖率。
    #[test]
    fn real_fixtures_present_in_ci() {
        if std::env::var("CI").is_ok() {
            assert!(
                fixtures::real_fixture("METATIDY_TEST_FLAC", "guard.flac").is_some(),
                "CI 必须提供 METATIDY_TEST_FLAC"
            );
            assert!(
                fixtures::real_fixture("METATIDY_TEST_MP3", "guard.mp3").is_some(),
                "CI 必须提供 METATIDY_TEST_MP3"
            );
        }
    }

    /// 合成样本至少要能被解析（读取路径用它跑，写入路径用真实样本跑）。
    #[test]
    fn synthetic_flac_is_readable() {
        let path = std::env::temp_dir().join("metatidy-tagio-synthetic.flac");
        fixtures::make_flac(&path).unwrap();
        let tags = read_tags(&path);
        assert!(
            tags.error.is_none(),
            "合成 FLAC 应能被解析：{:?}",
            tags.error
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn tag_numbers_handle_totals_and_reject_invalid_prefixes() {
        let mut tag = Tag::new(TagType::VorbisComments);
        for (raw, expected) in [
            ("3", "3"),
            ("10/12", "10"),
            (" 02 / 12 ", "2"),
            ("", ""),
            ("/12", ""),
            ("side A/2", ""),
            ("-1/12", ""),
            ("4294967296/12", ""),
        ] {
            tag.insert_text(ItemKey::TrackNumber, raw.to_string());
            assert_eq!(
                read_tag_number(&tag, ItemKey::TrackNumber, tag.track()),
                expected,
                "raw track number: {raw:?}"
            );
        }
    }

    #[test]
    fn flac_slash_numbers_are_read_without_rewriting_audio() {
        let path = std::env::temp_dir().join(format!(
            "metatidy-slash-numbers-{}.flac",
            uuid::Uuid::new_v4()
        ));
        fixtures::make_flac(&path).unwrap();
        let audio = std::fs::read(&path).unwrap();
        // Add raw Vorbis comments before the audio frame. This exercises the
        // exact on-disk "number/total" encoding, independently of lofty setters.
        let mut comments = Vec::new();
        comments.extend_from_slice(&0u32.to_le_bytes()); // Empty vendor string.
        comments.extend_from_slice(&2u32.to_le_bytes());
        for item in ["TRACKNUMBER=10/12", "DISCNUMBER= 1 / 2 "] {
            comments.extend_from_slice(&(item.len() as u32).to_le_bytes());
            comments.extend_from_slice(item.as_bytes());
        }
        let mut tagged = audio[..42].to_vec();
        tagged[4] = 0; // STREAMINFO is no longer the final metadata block.
        tagged.push(0x84); // Final metadata block: VORBIS_COMMENT.
        tagged.extend_from_slice(&(comments.len() as u32).to_be_bytes()[1..]);
        tagged.extend_from_slice(&comments);
        tagged.extend_from_slice(&audio[42..]);
        std::fs::write(&path, &tagged).unwrap();

        let read = read_tags(&path);
        assert!(read.error.is_none(), "read failed: {:?}", read.error);
        assert_eq!(read.track, "10");
        assert_eq!(read.disc, "1");
        assert_eq!(std::fs::read(&path).unwrap(), tagged);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn flac_roundtrip() {
        let Some(path) = require("flac") else { return };

        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "稻香".to_string());
        desired.insert("artist".to_string(), "周杰伦 & 费玉清".to_string());
        desired.insert("album".to_string(), "魔杰座".to_string());
        desired.insert("year".to_string(), "2008".to_string());
        desired.insert("track".to_string(), "3".to_string());
        desired.insert("albumartist".to_string(), "周杰伦".to_string());
        desired.insert("albumtype".to_string(), "专辑".to_string());

        let written = apply_update(&path, &desired, true, None, None).unwrap();
        assert!(
            written.written.len() >= 6,
            "至少写了 6 个字段，实际 {:?}",
            written.written
        );

        let back = read_tags(&path);
        assert!(back.error.is_none(), "读回失败：{:?}", back.error);
        assert!(back.present, "文件里应该有标签块");
        assert_eq!(back.title, "稻香");
        assert_eq!(back.artist, "周杰伦 & 费玉清");
        assert_eq!(back.album, "魔杰座");
        assert_eq!(back.year, "2008");
        assert_eq!(back.track, "3");
        assert_eq!(back.albumartist, "周杰伦");
        assert_eq!(back.albumtype, "专辑", "Vorbis 注释支持自由键，应能读回");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn preview_does_not_write() {
        let path = std::env::temp_dir().join("metatidy-tagio-preview.flac");
        fixtures::make_flac(&path).unwrap();

        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "新名字".to_string());
        let diff = preview_update(&path, &desired, true, None).unwrap().changes;
        assert_eq!(diff.len(), 1);
        assert_eq!(diff["title"].old, "");
        assert_eq!(diff["title"].new, "新名字");
        assert_eq!(read_tags(&path).title, "", "预览不能改动文件");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn overwrite_false_keeps_existing_value() {
        let Some(path) = require("flac") else { return };

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
    fn plan_and_outcome_match_for_flac_and_mp3() {
        for kind in ["flac", "mp3"] {
            let Some(path) = require(kind) else { continue };
            let first = HashMap::from([
                ("title".to_string(), "保留原题".to_string()),
                ("album".to_string(), "保留原专辑".to_string()),
                ("comment".to_string(), "不能改变的注释".to_string()),
            ]);
            apply_update(&path, &first, true, None, Some("原歌词")).unwrap();
            let desired = HashMap::from([
                ("title".to_string(), "不应覆盖".to_string()),
                ("album".to_string(), "   ".to_string()),
                ("genre".to_string(), "  Ambient  ".to_string()),
                ("track".to_string(), "003".to_string()),
                ("disc".to_string(), "02".to_string()),
                ("year".to_string(), "2004-11-01".to_string()),
                ("unknown".to_string(), "不能写入".to_string()),
            ]);
            let before = std::fs::read(&path).unwrap();
            let plan = preview_update(&path, &desired, false, Some("新歌词")).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(
                plan.effective_fields.get("track").map(String::as_str),
                Some("3")
            );
            assert_eq!(
                plan.effective_fields.get("year").map(String::as_str),
                Some("2004")
            );
            assert!(plan
                .skipped
                .iter()
                .any(|item| item.field == "title" && item.reason == "existing"));
            assert!(plan
                .skipped
                .iter()
                .any(|item| item.field == "album" && item.reason == "blank"));
            let result = apply_update(&path, &desired, false, None, Some("新歌词")).unwrap();
            assert!(result.file_changed && result.lyrics_written);
            let mut expected: Vec<_> = plan.effective_fields.keys().cloned().collect();
            expected.sort();
            assert_eq!(result.written, expected);
            assert_eq!(result.readback_fields["title"], "保留原题");
            assert!(!result.readback_fields.contains_key("comment"));
            let back = read_tags(&path);
            assert_eq!(
                (back.track.as_str(), back.disc.as_str(), back.year.as_str()),
                ("3", "2", "2004")
            );
            assert_eq!(back.comment, "不能改变的注释");
            assert_eq!(read_lyrics(&path), "新歌词");

            let before = std::fs::read(&path).unwrap();
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            let noop = apply_update(&path, &desired, false, None, Some("新歌词")).unwrap();
            assert!(!noop.file_changed && !noop.lyrics_written && noop.written.is_empty());
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                modified
            );
            std::fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn invalid_and_blank_values_never_save_or_reach_readback_fields() {
        let path =
            std::env::temp_dir().join(format!("metatidy-noop-{}.flac", uuid::Uuid::new_v4()));
        fixtures::make_flac(&path).unwrap();
        let desired = HashMap::from([
            ("album".to_string(), "  ".to_string()),
            ("track".to_string(), "2/12".to_string()),
            ("disc".to_string(), "4294967296".to_string()),
            ("year".to_string(), "not-year".to_string()),
            ("unsupported".to_string(), "value".to_string()),
        ]);
        let before = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let result = apply_update(&path, &desired, true, None, Some(" ")).unwrap();
        assert!(
            !result.file_changed && result.written.is_empty() && result.readback_fields.is_empty()
        );
        assert_eq!(result.skipped.len(), 6);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn lyrics_roundtrip() {
        let Some(path) = require("flac") else { return };
        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "带歌词".to_string());
        apply_update(&path, &desired, true, None, Some("测试歌词第一行")).unwrap();
        assert_eq!(read_lyrics(&path), "测试歌词第一行");
        assert!(read_tags(&path).has_lyrics);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn cover_roundtrip() {
        let Some(path) = require("flac") else { return };
        // 只要字节能原样存回即可，不校验图片内容
        let png = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02, 0x03,
        ];
        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "带封面".to_string());
        apply_update(
            &path,
            &desired,
            true,
            Some((png.clone(), "image/png".to_string())),
            None,
        )
        .unwrap();
        let got = read_cover(&path).expect("应能读回封面");
        assert_eq!(got.0, png);
        assert!(read_tags(&path).has_cover);
        std::fs::remove_file(&path).ok();
    }

    /// 写封面必须是「替换」而不是「追加」。
    ///
    /// lofty 的 `push_picture` 只会再塞一张：文件里攒两张之后 `read_cover` 仍取
    /// `pictures()[0]`（旧的那张），界面上看起来就像「写了封面没生效」。Python 参考实现
    /// 对 mp3/flac/ogg/m4a 都是覆盖写，这里必须对齐；同时遵守「覆盖已有值」开关。
    #[test]
    fn cover_write_replaces_instead_of_appending() {
        let Some(path) = require("flac") else { return };
        let first = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x01];
        let second = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x02];
        let desired = HashMap::new();

        // 1) 文件里本来没有封面 → 写上
        apply_update(
            &path,
            &desired,
            true,
            Some((first.clone(), "image/png".to_string())),
            None,
        )
        .unwrap();
        assert_eq!(read_cover(&path).map(|c| c.0), Some(first.clone()));

        // 2) 再写一张（覆盖开关打开）→ 必须换掉，而不是攒成两张
        apply_update(
            &path,
            &desired,
            true,
            Some((second.clone(), "image/png".to_string())),
            None,
        )
        .unwrap();
        assert_eq!(
            read_cover(&path).map(|c| c.0),
            Some(second.clone()),
            "封面应被替换成新的那张"
        );
        let tagged = Probe::open(&path).unwrap().read().unwrap();
        let count = tagged
            .primary_tag()
            .or_else(|| tagged.first_tag())
            .map(|tag| tag.pictures().len())
            .unwrap_or(0);
        assert_eq!(count, 1, "文件里只应有一张封面，实际 {count} 张");

        // 3) 覆盖开关关闭 + 已有封面 → 原样不动
        apply_update(
            &path,
            &desired,
            false,
            Some((first.clone(), "image/png".to_string())),
            None,
        )
        .unwrap();
        assert_eq!(
            read_cover(&path).map(|c| c.0),
            Some(second.clone()),
            "不勾「覆盖已有值」时不该动已有封面"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mp3_roundtrip() {
        let Some(path) = require("mp3") else { return };
        let mut desired = HashMap::new();
        desired.insert("title".to_string(), "七里香".to_string());
        desired.insert("artist".to_string(), "周杰伦".to_string());
        desired.insert("album".to_string(), "七里香".to_string());
        desired.insert("track".to_string(), "1".to_string());
        desired.insert("albumtype".to_string(), "专辑".to_string());
        apply_update(&path, &desired, true, None, None).unwrap();

        let back = read_tags(&path);
        assert!(back.error.is_none(), "读回失败：{:?}", back.error);
        assert_eq!(back.title, "七里香");
        assert_eq!(back.artist, "周杰伦");
        assert_eq!(back.album, "七里香");
        assert_eq!(back.track, "1");
        // 自由键（ALBUMTYPE 的 TXXX）现在能写也能读了：写入走 insert_unchecked，
        // 读取按已知拼写兜底（见 read_albumtype 与 docs/PORT_NOTES.md §10）。
        assert_eq!(back.albumtype, "专辑");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_reports_error_without_panicking() {
        let tags = read_tags(Path::new("/definitely/not/here.flac"));
        assert!(tags.error.is_some());
    }

    struct GuardedFixture(std::path::PathBuf);

    impl Drop for GuardedFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Local guarded tests always execute. CI must use the real encoder
    /// fixtures, so a missing CI fixture is a failure instead of a silent skip.
    fn guarded_fixture(kind: &str) -> GuardedFixture {
        let env_key = if kind == "flac" {
            "METATIDY_TEST_FLAC"
        } else {
            "METATIDY_TEST_MP3"
        };
        if let Some(path) = fixtures::real_fixture(env_key, &format!("guarded.{kind}")) {
            return GuardedFixture(path);
        }
        assert!(
            std::env::var("CI").is_err(),
            "CI guarded tests require a real {kind} fixture in {env_key}"
        );
        let path = std::env::temp_dir().join(format!(
            "metatidy-guarded-{}.{kind}",
            uuid::Uuid::new_v4()
        ));
        if kind == "flac" {
            fixtures::make_flac(&path).unwrap();
            // Lofty 0.21's writer expects a metadata block after STREAMINFO
            // when adding padding. Give the synthetic file a valid PADDING
            // block like real encoder output, without changing the audio frame.
            let bytes = std::fs::read(&path).unwrap();
            let mut padded = bytes[..42].to_vec();
            padded[4] = 0;
            padded.extend_from_slice(&[0x81, 0, 0x10, 0]);
            padded.resize(padded.len() + 4096, 0);
            padded.extend_from_slice(&bytes[42..]);
            std::fs::write(&path, padded).unwrap();
        } else {
            fixtures::make_mp3(&path, 16).unwrap();
        }
        GuardedFixture(path)
    }

    fn seed_guarded_tags(path: &Path) {
        let tagged = open_for_update(path).unwrap();
        let mut tag = tagged
            .primary_tag()
            .or_else(|| tagged.first_tag())
            .cloned()
            .unwrap_or_else(|| Tag::new(pick_tag_type(path)));
        for key in [
            ItemKey::TrackArtist,
            ItemKey::AlbumTitle,
            ItemKey::TrackNumber,
            ItemKey::DiscNumber,
        ] {
            tag.remove_key(&key);
        }
        tag.remove_year();
        tag.insert_text(ItemKey::TrackTitle, "原曲名 e\u{301} 🎼".into());
        tag.insert_text(ItemKey::Comment, "保留注释".into());
        tag.insert_text(ItemKey::Lyrics, "[00:01.00] 原歌词\n第二行".into());
        tag.insert_unchecked(TagItem::new(
            ItemKey::Unknown("METATIDY_TEST_CUSTOM".into()),
            ItemValue::Text("自定义资料 e\u{301} 🎵".into()),
        ));
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Png),
            Some("保留封面".into()),
            vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3],
        ));
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }

    fn untouched_payload(path: &Path) -> serde_json::Value {
        let tagged = open_for_update(path).unwrap();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag()).unwrap();
        let custom: Vec<_> = tag
            .items()
            .filter(|item| {
                matches!(item.key(), ItemKey::Unknown(key) if key == "METATIDY_TEST_CUSTOM")
            })
            .map(|item| item.value().text().unwrap().to_owned())
            .collect();
        assert_eq!(custom, vec!["自定义资料 e\u{301} 🎵"]);
        let pictures: Vec<_> = tag
            .pictures()
            .iter()
            .map(|picture| {
                serde_json::json!({
                    "kind":format!("{:?}", picture.pic_type()),
                    "mime":picture.mime_type().map(|value| value.as_str()),
                    "description":picture.description(),
                    "data":picture.data(),
                })
            })
            .collect();
        assert_eq!(pictures.len(), 1);
        serde_json::json!({
            "custom":custom,
            "comment":tag.get_string(&ItemKey::Comment),
            "lyrics":lyrics_in(Some(tag)),
            "pictures":pictures,
        })
    }

    fn guarded_error(
        path: &Path,
        desired: &HashMap<String, String>,
        overwrite: bool,
        baseline: &GuardedBaseline,
    ) -> UpdateError {
        match apply_guarded(path, desired, overwrite, baseline) {
            Ok(_) => panic!("changed reviewed preconditions must reject the write"),
            Err(error) => error,
        }
    }

    #[test]
    fn guarded_preview_is_read_only_and_persisted_baseline_roundtrips() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([("artist".into(), "新艺术家 🎹".into())]);
            let bytes = std::fs::read(path).unwrap();
            let modified = std::fs::metadata(path).unwrap().modified().unwrap();
            let (plan, baseline) = preview_guarded(path, &desired, false).unwrap();
            assert_eq!(plan.changes["artist"].old, "");
            assert_eq!(plan.changes["artist"].new, "新艺术家 🎹");
            assert_eq!(std::fs::read(path).unwrap(), bytes, "{kind} preview wrote bytes");
            assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), modified);
            let serialized = serde_json::to_value(&baseline).unwrap();
            let restored: GuardedBaseline = serde_json::from_value(serialized.clone()).unwrap();
            assert_eq!(serde_json::to_value(&restored).unwrap(), serialized);
            let outcome = apply_guarded(path, &desired, false, &restored).unwrap();
            assert_eq!(outcome.written, vec!["artist"]);
            assert_eq!(read_tags(path).artist, "新艺术家 🎹");
        }
    }

    #[test]
    fn guarded_fill_blank_canonicalizes_numbers_and_preserves_unrequested_payloads() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let retained = untouched_payload(path);
            let desired = HashMap::from([
                ("title".into(), "不得覆盖".into()),
                ("artist".into(), "  新艺术家 e\u{301} 🎹  ".into()),
                ("album".into(), "  ".into()),
                ("track".into(), "003".into()),
                ("disc".into(), "02".into()),
                ("year".into(), "2004-11-01".into()),
                ("unsupported".into(), "不会写入".into()),
            ]);
            let (plan, baseline) = preview_guarded(path, &desired, false).unwrap();
            assert_eq!(plan.effective_fields["track"], "3");
            assert_eq!(plan.effective_fields["disc"], "2");
            assert_eq!(plan.effective_fields["year"], "2004");
            assert!(plan.skipped.iter().any(|item| item.field == "title" && item.reason == "existing"));
            assert!(plan.skipped.iter().any(|item| item.field == "album" && item.reason == "blank"));
            assert!(plan.skipped.iter().any(|item| item.field == "unsupported" && item.reason == "unsupported"));
            let outcome = apply_guarded(path, &desired, false, &baseline).unwrap();
            assert!(outcome.file_changed);
            assert!(!outcome.lyrics_written && !outcome.cover_written);
            assert_eq!(outcome.written, vec!["artist", "disc", "track", "year"]);
            assert_eq!(outcome.readback_fields["title"], "原曲名 e\u{301} 🎼");
            assert!(!outcome.readback_fields.contains_key("album"));
            assert!(!outcome.readback_fields.contains_key("comment"));
            assert_eq!(untouched_payload(path), retained, "{kind} changed unrequested tags");
            let tags = read_tags(path);
            assert_eq!((tags.track.as_str(), tags.disc.as_str(), tags.year.as_str()), ("3", "2", "2004"));
            assert_eq!(tags.artist, "新艺术家 e\u{301} 🎹");
            assert_eq!(tags.title, "原曲名 e\u{301} 🎼");
        }
    }

    #[test]
    fn guarded_noop_never_saves_or_changes_file_times() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([
                ("title".into(), "保持已有标题".into()),
                ("album".into(), " ".into()),
                ("track".into(), "2/12".into()),
                ("disc".into(), "4294967296".into()),
            ]);
            let (plan, baseline) = preview_guarded(path, &desired, false).unwrap();
            assert!(plan.effective_fields.is_empty() && plan.changes.is_empty());
            let bytes = std::fs::read(path).unwrap();
            let modified = std::fs::metadata(path).unwrap().modified().unwrap();
            let outcome = apply_guarded(path, &desired, false, &baseline).unwrap();
            assert!(!outcome.file_changed && outcome.written.is_empty());
            assert_eq!(outcome.readback_fields, HashMap::from([("title".into(), "原曲名 e\u{301} 🎼".into())]));
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), modified);
        }
    }

    #[test]
    fn guarded_rejects_changed_request_and_persisted_preconditions_without_writing() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([("artist".into(), "已预览艺术家".into())]);
            let (_, baseline) = preview_guarded(path, &desired, false).unwrap();
            let before = std::fs::read(path).unwrap();
            let modified = std::fs::metadata(path).unwrap().modified().unwrap();
            let other = HashMap::from([("artist".into(), "未预览艺术家".into())]);
            let mut wrong_version = baseline.clone();
            wrong_version.version += 1;
            let mut wrong_digest = baseline.clone();
            wrong_digest.tags_digest = "invalid persisted tag digest".into();
            let mut wrong_effective = baseline.clone();
            wrong_effective.effective_fields.insert("artist".into(), "被篡改的计划".into());
            for error in [
                guarded_error(path, &other, false, &baseline),
                guarded_error(path, &desired, true, &baseline),
                guarded_error(path, &desired, false, &wrong_version),
                guarded_error(path, &desired, false, &wrong_digest),
                guarded_error(path, &desired, false, &wrong_effective),
            ] {
                assert_eq!(error.stage, "stale");
                assert!(!error.file_changed);
            }
            assert_eq!(std::fs::read(path).unwrap(), before);
            assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), modified);
        }
    }

    #[test]
    fn guarded_rejects_external_tag_edit_and_keeps_that_edit() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([("artist".into(), "准备写入".into())]);
            let (_, baseline) = preview_guarded(path, &desired, false).unwrap();
            apply_update(path, &HashMap::from([("comment".into(), "外部的新注释".into())]), true, None, None).unwrap();
            let before = std::fs::read(path).unwrap();
            let error = guarded_error(path, &desired, false, &baseline);
            assert_eq!(error.stage, "stale");
            assert!(!error.file_changed);
            assert_eq!(std::fs::read(path).unwrap(), before);
            assert_eq!(read_tags(path).comment, "外部的新注释");
            assert_eq!(read_tags(path).artist, "");
        }
    }

    #[test]
    fn guarded_tag_digest_detects_edit_even_when_current_file_stat_is_supplied() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([("artist".into(), "准备写入".into())]);
            let (_, mut baseline) = preview_guarded(path, &desired, false).unwrap();
            apply_update(path, &HashMap::new(), true, None, Some("外部替换的歌词")).unwrap();
            // Isolate the content guard independently from mtime/inode checks.
            // The HTTP API never accepts or modifies this private baseline.
            baseline.file = fingerprint(path, &File::open(path).unwrap()).unwrap();
            let before = std::fs::read(path).unwrap();
            let error = guarded_error(path, &desired, false, &baseline);
            assert_eq!(error.stage, "stale");
            assert!(!error.file_changed);
            assert_eq!(read_lyrics(path), "外部替换的歌词");
            assert_eq!(std::fs::read(path).unwrap(), before);
        }
    }

    #[test]
    fn guarded_rejects_mtime_only_change_without_saving() {
        for kind in ["flac", "mp3"] {
            let fixture = guarded_fixture(kind);
            let path = &fixture.0;
            seed_guarded_tags(path);
            let desired = HashMap::from([("artist".into(), "准备写入".into())]);
            let (_, baseline) = preview_guarded(path, &desired, false).unwrap();
            let before = std::fs::read(path).unwrap();
            let file = OpenOptions::new().write(true).open(path).unwrap();
            let modified = file.metadata().unwrap().modified().unwrap() + std::time::Duration::from_secs(5);
            file.set_times(std::fs::FileTimes::new().set_modified(modified)).unwrap();
            drop(file);
            let changed_time = std::fs::metadata(path).unwrap().modified().unwrap();
            let error = guarded_error(path, &desired, false, &baseline);
            assert_eq!(error.stage, "stale");
            assert!(!error.file_changed);
            assert_eq!(std::fs::read(path).unwrap(), before);
            assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), changed_time);
        }
    }

    #[test]
    fn guarded_rejects_source_path_change_and_replacement() {
        for kind in ["flac", "mp3"] {
            let source = guarded_fixture(kind);
            seed_guarded_tags(&source.0);
            let desired = HashMap::from([("artist".into(), "准备写入".into())]);
            let (_, baseline) = preview_guarded(&source.0, &desired, false).unwrap();
            let moved = GuardedFixture(source.0.with_file_name(format!("moved-{}.{kind}", uuid::Uuid::new_v4())));
            std::fs::rename(&source.0, &moved.0).unwrap();
            let original = std::fs::read(&moved.0).unwrap();
            let error = guarded_error(&moved.0, &desired, false, &baseline);
            assert_eq!(error.stage, "stale");
            assert!(!error.file_changed);
            assert_eq!(std::fs::read(&moved.0).unwrap(), original);

            let replacement = guarded_fixture(kind);
            seed_guarded_tags(&replacement.0);
            apply_update(&replacement.0, &HashMap::from([("title".into(), "替换后的文件".into())]), true, None, None).unwrap();
            std::fs::rename(&replacement.0, &source.0).unwrap();
            let replaced = std::fs::read(&source.0).unwrap();
            let error = guarded_error(&source.0, &desired, false, &baseline);
            assert_eq!(error.stage, "stale");
            assert!(!error.file_changed);
            assert_eq!(std::fs::read(&source.0).unwrap(), replaced);
            assert_eq!(read_tags(&source.0).title, "替换后的文件");
            assert_eq!(std::fs::read(&moved.0).unwrap(), original);
        }
    }
}

/// 从 `ItemKey::Unknown("X")` 里取出原始键名（其它变体返回 None）。
fn unknown_key_name(key: &ItemKey) -> Option<&str> {
    match key {
        ItemKey::Unknown(name) => Some(name.as_str()),
        _ => None,
    }
}

/// 读专辑类型。
///
/// 为什么不能只按一个键取：同一个概念在不同容器、不同软件里落成的键名不一样
/// （ID3v2 的 TXXX 描述、Vorbis 的原生键、MP4 的自由原子），
/// 所以先按已知拼写（大小写不敏感）逐个精确匹配，再扫一遍带 `ALBUMTYPE` 的自由键兜底。
fn read_albumtype(tag: &Tag) -> String {
    const WANTED: [&str; 4] = [
        "ALBUMTYPE",
        "MUSICBRAINZ_ALBUMTYPE",
        "RELEASETYPE",
        "Album Type",
    ];

    for want in WANTED {
        for item in tag.items() {
            let Some(name) = unknown_key_name(item.key()) else {
                continue;
            };
            if !name.eq_ignore_ascii_case(want) {
                continue;
            }
            if let Some(text) = item.value().text() {
                if !text.trim().is_empty() {
                    return text.to_string();
                }
            }
        }
    }

    for item in tag.items() {
        let Some(name) = unknown_key_name(item.key()) else {
            continue;
        };
        if !name.to_uppercase().contains(ALBUM_TYPE_KEY) {
            continue;
        }
        if let Some(text) = item.value().text() {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }

    String::new()
}
