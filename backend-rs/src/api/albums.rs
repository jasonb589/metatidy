//! Read-only, index-backed album browsing.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::repo::{self, AlbumQuery};
use crate::AppState;

use super::{ApiError, ApiResult, RawQuery};

/// `/api/albums`: group by normalized album title and album artist, excluding
/// untitled albums. Missing metadata flags count individual tracks in the group.
pub async fn list_albums(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let page_size = query.i64("page_size", 24)?;
    if !(1..=100).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            "每页专辑数须为 1–100",
            json!(page_size),
            Some(json!({"ge": 1, "le": 100})),
        ));
    }
    let albums = repo::list_albums(
        &state.db,
        &AlbumQuery {
            q: query.str("q", ""),
            page: query.i64("page", 1)?,
            page_size,
            sort: query.str("sort", "album"),
            incomplete: query.bool("incomplete", false)?,
        },
    )
    .await?;
    Ok(Json(json!(albums)))
}

/// JSON tuple keeps titles containing quotes, slashes or separators unambiguous.
/// PostgreSQL BTRIM without an explicit character set removes ASCII spaces only.
pub(super) fn parse_album_group(
    raw: Option<&String>,
) -> Result<Option<(String, String)>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let parsed = serde_json::from_str::<Value>(raw).ok();
    if let Some(Value::Array(parts)) = parsed {
        if let [Value::String(album), Value::String(artist)] = parts.as_slice() {
            let album = album.trim_matches(' ');
            let artist = artist.trim_matches(' ');
            if !album.is_empty() && album.chars().count() <= 4000 && artist.chars().count() <= 4000
            {
                return Ok(Some((album.to_string(), artist.to_string())));
            }
        }
    }
    Err(ApiError::unprocessable(
        "value_error",
        vec!["query", "album_group"],
        "专辑分组须为 JSON 数组 [专辑名, 专辑艺术家]，专辑名不能为空且每项最多 4000 字",
        Value::String(raw.clone()),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_album_group;

    #[test]
    fn album_group_preserves_exact_identity_and_allows_an_unknown_artist() {
        assert_eq!(parse_album_group(None).unwrap(), None);
        assert_eq!(
            parse_album_group(Some(&r#"["  A / B \"mix\"  ", "  "]"#.to_string())).unwrap(),
            Some(("A / B \"mix\"".to_string(), "".to_string()))
        );
        // Do not strip unicode whitespace which the SQL BTRIM expression preserves.
        assert_eq!(
            parse_album_group(Some(&"[\"\u{3000}A\u{3000}\",\"艺术家\"]".to_string())).unwrap(),
            Some(("\u{3000}A\u{3000}".to_string(), "艺术家".to_string()))
        );
    }

    #[test]
    fn album_group_rejects_wrong_shapes_and_blank_titles() {
        for value in [
            "",
            "null",
            "{}",
            "[]",
            "[1,2]",
            "[\"A\"]",
            "[\"A\",\"B\",\"C\"]",
            "[\"  \",\"B\"]",
        ] {
            assert!(
                parse_album_group(Some(&value.to_string())).is_err(),
                "{value}"
            );
        }
        let oversized = serde_json::json!(["a".repeat(4001), "artist"]).to_string();
        assert!(parse_album_group(Some(&oversized)).is_err());
    }
}
