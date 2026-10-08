//! 数据模型：与 Postgres 表结构一一对应。
//!
//! 与 Python 版相比多两个字段，用来区分索引的来源：
//! - `tags_loaded`：是否真读过音频标签（false = 只从路径建的索引）
//! - `path_derived`：artist/album/title 是否来自目录结构推断
//!
//! 这两个字段是「云盘快速扫描」的基础：先几秒钟建出全库索引，
//! 等你真要编辑/刮削某几首时，再按需读那几首的标签。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 一条曲目。
#[derive(Debug, Clone, Default, Serialize, Deserialize, sqlx::FromRow)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub dir: String,
    pub filename: String,
    pub ext: String,
    pub mtime: f64,
    pub size: i64,

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

    pub tags_loaded: bool,
    pub path_derived: bool,

    pub indexed_at: Option<DateTime<Utc>>,
    pub edited_at: Option<DateTime<Utc>>,
    pub scraped_at: Option<DateTime<Utc>>,
}

/// 可被用户编辑、也会写进标签的字段名（顺序即写入顺序）。
pub const EDITABLE_FIELDS: &[&str] = &[
    "title",
    "artist",
    "album",
    "albumartist",
    "genre",
    "year",
    "track",
    "disc",
    "language",
    "composer",
    "lyricist",
    "copyright",
    "albumtype",
    "comment",
    "mb_artist_id",
    "release_group_id",
];

impl Track {
    /// 取出某个可编辑字段的当前值。
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

    /// 按字段名写入（只接受可编辑字段，其它忽略）。
    pub fn set_field(&mut self, name: &str, value: String) {
        match name {
            "title" => self.title = value,
            "artist" => self.artist = value,
            "album" => self.album = value,
            "albumartist" => self.albumartist = value,
            "genre" => self.genre = value,
            "year" => self.year = value,
            "track" => self.track = value,
            "disc" => self.disc = value,
            "language" => self.language = value,
            "composer" => self.composer = value,
            "lyricist" => self.lyricist = value,
            "copyright" => self.copyright = value,
            "albumtype" => self.albumtype = value,
            "comment" => self.comment = value,
            "mb_artist_id" => self.mb_artist_id = value,
            "release_group_id" => self.release_group_id = value,
            _ => {}
        }
    }

    /// 批量写入（用于把用户提交的字段合并进索引）。
    pub fn apply(&mut self, fields: &HashMap<String, String>) {
        for (k, v) in fields {
            self.set_field(k, v.clone());
        }
    }

    /// 取某个可编辑字段，转成模板用的值字典。
    pub fn flat_fields(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for name in EDITABLE_FIELDS {
            out.insert((*name).to_string(), self.field(name).to_string());
        }
        out
    }
}

/// 一次扫描的统计结果。
#[derive(Debug, Default, Clone, Serialize)]
pub struct ScanSummary {
    pub root: String,
    pub scanned: usize,
    pub parsed: usize,
    pub skipped: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub fast_mode: bool,
    pub seconds: f64,
}

/// 标签更新的一处差异。
#[derive(Debug, Clone, Serialize)]
pub struct FieldChange {
    pub old: String,
    pub new: String,
}

/// 预览结果：字段 -> (旧值, 新值)。
pub type FieldDiff = HashMap<String, FieldChange>;
