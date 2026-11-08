//! Directory browsing from tracks.dir only. Paths are validated lexically;
//! neither browsing nor filtering stats, resolves symlinks, or walks a mount.

use std::path::{Component, Path, PathBuf, MAIN_SEPARATOR};

use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct FolderScope {
    root: String,
    current: String,
    recursive: bool,
}

impl FolderScope {
    pub fn new(music_dir: &Path, folder: &str, recursive: bool) -> Result<Self, String> {
        let root = configured_root(music_dir)?;
        let current = if folder.is_empty() {
            root.clone()
        } else {
            folder.to_owned()
        };
        let canonical = canonical_path(&current)?;
        if current != canonical {
            return Err(
                "目录须使用服务端返回的规范绝对路径，不能包含重复分隔符、点路径或末尾分隔符".into(),
            );
        }
        if current != root && !current.starts_with(&directory_prefix(&root)) {
            return Err("目录必须在已配置的音乐目录内".into());
        }
        Ok(Self {
            root,
            current,
            recursive,
        })
    }

    pub fn directory(&self) -> &str {
        &self.current
    }
    pub fn recursive(&self) -> bool {
        self.recursive
    }
    pub fn descendant_pattern(&self) -> String {
        format!("{}%", escape_like(&directory_prefix(&self.current)))
    }
}

fn canonical_path(value: &str) -> Result<String, String> {
    if value.contains('\0') || !Path::new(value).is_absolute() {
        return Err("目录须为不含空字符的本机绝对路径".into());
    }
    let mut path = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::ParentDir | Component::CurDir => {
                return Err("目录不能包含 . 或 .. 路径段".into());
            }
            other => path.push(other.as_os_str()),
        }
    }
    Ok(crate::models::path_key(&path))
}

fn configured_root(music_dir: &Path) -> Result<String, String> {
    canonical_path(&crate::models::path_key(music_dir))
}

fn directory_prefix(path: &str) -> String {
    if path.ends_with(MAIN_SEPARATOR) {
        path.to_owned()
    } else {
        format!("{path}{MAIN_SEPARATOR}")
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_")
}

/// Shared by folder summaries and /api/tracks. The descendant pattern always
/// includes the native separator, so /music never also matches /music2.
pub fn dir_predicate(exact_bind: usize, descendant_bind: Option<usize>) -> String {
    match descendant_bind {
        Some(prefix) => format!("(dir = ${exact_bind} OR dir LIKE ${prefix} ESCAPE '!')"),
        None => format!("dir = ${exact_bind}"),
    }
}

#[derive(Debug)]
pub struct FolderQuery {
    pub scope: FolderScope,
    pub q: String,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Breadcrumb {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct FolderItem {
    pub name: String,
    pub path: String,
    pub track_count: i64,
    pub direct_tracks: i64,
    pub bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct FolderPage {
    pub root: String,
    pub current: String,
    pub parent: Option<String>,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub pages: i64,
    pub total_tracks: i64,
    pub direct_tracks: i64,
    pub bytes: i64,
    pub items: Vec<FolderItem>,
    pub scan_root: String,
    pub can_scan: bool,
}

fn breadcrumbs(scope: &FolderScope) -> Vec<Breadcrumb> {
    let mut result = vec![Breadcrumb {
        name: Path::new(&scope.root)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| scope.root.clone()),
        path: scope.root.clone(),
    }];
    if scope.current != scope.root {
        let prefix = directory_prefix(&scope.root);
        let relative = scope
            .current
            .strip_prefix(&prefix)
            .expect("validated folder prefix");
        let mut path = scope.root.clone();
        for name in relative.split(MAIN_SEPARATOR) {
            path = format!("{}{name}", directory_prefix(&path));
            result.push(Breadcrumb {
                name: name.to_owned(),
                path: path.clone(),
            });
        }
    }
    result
}

fn scan_compatible(music_dir: &Path, folder: &str) -> bool {
    // The scan form uses an HTML text input, which removes CR/LF on assignment.
    // Keep these indexed directories browsable, but never prefill another path.
    if folder.contains(['\r', '\n']) {
        return false;
    }
    crate::scanner::resolve_scan_root(music_dir, folder)
        .is_ok_and(|path| crate::models::path_key(&path) == folder)
}

fn page_bounds(total: i64, requested: i64, size: i64) -> (i64, i64, i64) {
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / size + 1
    };
    let page = requested.clamp(1, pages.max(1));
    (page, pages, (page - 1) * size)
}

pub async fn list(
    pool: &PgPool,
    music_dir: &Path,
    query: &FolderQuery,
) -> anyhow::Result<Option<FolderPage>> {
    let scope = &query.scope;
    let prefix = directory_prefix(&scope.current);
    let pattern = scope.descendant_pattern();
    let search = format!("%{}%", escape_like(query.q.trim()));
    let predicate = dir_predicate(1, Some(2));
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let (total_tracks, direct_tracks, bytes): (i64, i64, i64) = sqlx::query_as(&format!(
        "SELECT count(*), count(*) FILTER (WHERE dir=$1), COALESCE(sum(size),0)::bigint \
         FROM tracks WHERE {predicate}"
    ))
    .bind(&scope.current)
    .bind(&pattern)
    .fetch_one(&mut *tx)
    .await?;
    if total_tracks == 0 && scope.current != scope.root {
        return Ok(None);
    }
    // Each descendant contributes to exactly its immediate child. The overview
    // above intentionally remains unfiltered when q narrows the child names.
    let grouped = format!(
        "SELECT name, $3::text || name AS path, count(*) AS track_count, \
         count(*) FILTER (WHERE dir=$3::text || name) AS direct_tracks, \
         COALESCE(sum(size),0)::bigint AS bytes FROM (\
             SELECT dir,size,split_part(substring(dir FROM char_length($3::text)+1),$4,1) AS name \
             FROM tracks WHERE {predicate} AND dir<>$1\
         ) AS children WHERE name<>'' AND name NOT IN ('.','..') AND name ILIKE $5 ESCAPE '!' \
         GROUP BY name"
    );
    let separator = MAIN_SEPARATOR.to_string();
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM ({grouped}) AS folders"))
        .bind(&scope.current)
        .bind(&pattern)
        .bind(&prefix)
        .bind(&separator)
        .bind(&search)
        .fetch_one(&mut *tx)
        .await?;
    let page_size = query.page_size.clamp(1, 100);
    let (page, pages, offset) = page_bounds(total, query.page, page_size);
    let items = sqlx::query_as::<_, FolderItem>(&format!(
        "SELECT * FROM ({grouped}) AS folders ORDER BY name COLLATE \"C\", path COLLATE \"C\" \
         LIMIT $6 OFFSET $7"
    ))
    .bind(&scope.current)
    .bind(&pattern)
    .bind(&prefix)
    .bind(&separator)
    .bind(&search)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let breadcrumbs = breadcrumbs(scope);
    let parent = breadcrumbs
        .iter()
        .rev()
        .nth(1)
        .map(|item| item.path.clone());
    Ok(Some(FolderPage {
        root: scope.root.clone(),
        current: scope.current.clone(),
        parent,
        breadcrumbs,
        total,
        page,
        page_size,
        pages,
        total_tracks,
        direct_tracks,
        bytes,
        items,
        scan_root: scope.current.clone(),
        can_scan: scan_compatible(music_dir, &scope.current),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Music")
        } else {
            PathBuf::from("/music")
        }
    }

    #[test]
    fn scopes_preserve_native_identity_spaces_and_literal_search_characters() {
        let root = root();
        let value = crate::models::path_key(&root.join("  %_!'艺人  ").join("专辑"));
        let scope = FolderScope::new(&root, &value, true).unwrap();
        assert_eq!(scope.directory(), value);
        assert!(scope.recursive());
        assert_eq!(
            scope.descendant_pattern(),
            format!("{}%", escape_like(&format!("{value}{MAIN_SEPARATOR}")))
        );
        assert!(scope.descendant_pattern().contains("!%!_!!'"));
        let crumbs = breadcrumbs(&scope);
        assert_eq!(
            crumbs
                .iter()
                .map(|part| part.name.as_str())
                .collect::<Vec<_>>(),
            [
                if cfg!(windows) { "Music" } else { "music" },
                "  %_!'艺人  ",
                "专辑"
            ]
        );
        assert_eq!(crumbs.last().unwrap().path, value);
    }

    #[test]
    fn scopes_reject_relative_traversal_outside_and_noncanonical_separators() {
        let root = root();
        let key = crate::models::path_key(&root);
        for value in [
            "relative".to_owned(),
            " ".to_owned(),
            format!("{key}\0"),
            format!("{key}{MAIN_SEPARATOR}..{MAIN_SEPARATOR}Other"),
            format!("{key}{MAIN_SEPARATOR}.{MAIN_SEPARATOR}Album"),
            format!("{key}{MAIN_SEPARATOR}{MAIN_SEPARATOR}Album"),
            format!("{key}{MAIN_SEPARATOR}Album{MAIN_SEPARATOR}"),
            format!("{key}2{MAIN_SEPARATOR}Album"),
        ] {
            assert!(FolderScope::new(&root, &value, true).is_err(), "{value:?}");
        }
        assert_eq!(FolderScope::new(&root, "", true).unwrap().directory(), key);
    }

    #[test]
    fn scan_compatibility_never_trims_a_real_directory_name() {
        let root = root();
        for (name, expected) in [
            (" leading", true),
            ("trailing ", false),
            ("wide\u{3000}", false),
            ("normal", true),
        ] {
            let path = crate::models::path_key(&root.join(name));
            let scope = FolderScope::new(&root, &path, true).unwrap();
            assert_eq!(scope.directory(), path);
            assert_eq!(scan_compatible(&root, &path), expected, "{name}");
        }
    }

    #[test]
    fn scan_compatibility_rejects_line_breaks_that_text_inputs_would_remove() {
        let root = root();
        for name in ["A\nB", "A\rB", "A\r\nB"] {
            let path = crate::models::path_key(&root.join(name));
            let scope = FolderScope::new(&root, &path, true).unwrap();
            assert_eq!(scope.directory(), path, "browsing preserves the indexed path");
            assert_eq!(breadcrumbs(&scope).last().unwrap().name, name);
            assert_eq!(
                crate::models::path_key(&crate::scanner::resolve_scan_root(&root, &path).unwrap()),
                path,
                "the lexical scanner alone cannot detect HTML input sanitization"
            );
            assert!(!scan_compatible(&root, &path));
        }
    }

    #[test]
    fn folder_page_bounds_and_filesystem_roots_are_safe() {
        assert_eq!(page_bounds(0, 9, 50), (1, 0, 0));
        assert_eq!(page_bounds(51, -5, 50), (1, 2, 0));
        assert_eq!(page_bounds(51, i64::MAX, 50), (2, 2, 50));
        let root = if cfg!(windows) {
            Path::new(r"C:\")
        } else {
            Path::new("/")
        };
        let scope = FolderScope::new(root, "", true).unwrap();
        assert_eq!(breadcrumbs(&scope).len(), 1);
        assert_eq!(
            scope.descendant_pattern(),
            format!("{}%", escape_like(&crate::models::path_key(root)))
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_backslash_is_a_filename_character() {
        let scope = FolderScope::new(Path::new("/music"), "/music/A\\B/C", true).unwrap();
        assert_eq!(breadcrumbs(&scope)[1].name, "A\\B");
        assert!(scan_compatible(Path::new("/music"), scope.directory()));
    }

    #[cfg(windows)]
    #[test]
    fn windows_scope_accepts_native_unc_and_rejects_alternate_separators() {
        let scope = FolderScope::new(
            Path::new(r"\\server\share\Music"),
            r"\\server\share\Music\Artist",
            true,
        )
        .unwrap();
        assert_eq!(breadcrumbs(&scope)[1].name, "Artist");
        assert!(FolderScope::new(&root(), "C:/Music/Artist", true).is_err());
        assert!(FolderScope::new(&root(), r"C:Music\Artist", true).is_err());
    }
}
