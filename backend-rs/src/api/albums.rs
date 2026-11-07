//! Read-only, index-backed album browsing.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::repo::{self, AlbumQuery};
use crate::AppState;

use super::{light_track_json, ApiError, ApiResult, RawQuery};

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

pub async fn detail(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let group = parse_album_group(query.0.get("album_group"))?.ok_or_else(|| {
        ApiError::unprocessable(
            "missing",
            vec!["query", "album_group"],
            "Field required",
            Value::Null,
            None,
        )
    })?;
    let page_size = query.i64("page_size", 100)?;
    if !(1..=200).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            "每页专辑曲目数须为 1–200",
            json!(page_size),
            Some(json!({"ge": 1, "le": 200})),
        ));
    }
    let detail = repo::album_detail(&state.db, &group, query.i64("page", 1)?, page_size)
        .await?
        .ok_or_else(|| ApiError::not_found("专辑分组已不存在，请刷新专辑收藏"))?;
    let items: Vec<_> = detail.items.iter().map(light_track_json).collect();
    Ok(Json(json!({
        "group": group, "total": detail.summary.track_count, "summary": detail.summary,
        "revision": detail.revision, "page": detail.page, "page_size": detail.page_size,
        "pages": detail.pages, "items": items,
    })))
}

/// Return an explicit membership snapshot, never start a write or change the
/// user's stored selection. Clients review and adopt the complete ID set.
pub async fn selection(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let (group, revision) = parse_selection(&payload)?;
    match repo::album_selection(&state.db, &group, &revision).await? {
        repo::AlbumSelection::Missing => {
            Err(ApiError::not_found("专辑分组已不存在，请刷新专辑收藏"))
        }
        repo::AlbumSelection::Changed => Err(ApiError::conflict(
            "专辑成员或曲序已变化，请刷新详情后重新加入已选",
        )),
        repo::AlbumSelection::Ready { revision, ids } => Ok(Json(json!({
            "group": group, "revision": revision, "total": ids.len(), "ids": ids,
            "selected_at": chrono::Utc::now().timestamp_millis() as f64 / 1000.0,
        }))),
    }
}

fn normalized_group(value: &Value) -> Option<(String, String)> {
    if let Value::Array(parts) = value {
        if let [Value::String(album), Value::String(artist)] = parts.as_slice() {
            let album = album.trim_matches(' ');
            let artist = artist.trim_matches(' ');
            if !album.is_empty() && album.chars().count() <= 4000 && artist.chars().count() <= 4000
            {
                return Some((album.to_string(), artist.to_string()));
            }
        }
    }
    None
}

fn parse_selection(
    payload: &serde_json::Map<String, Value>,
) -> Result<((String, String), String), ApiError> {
    let raw_group = payload.get("album_group").ok_or_else(|| {
        ApiError::unprocessable(
            "missing",
            vec!["body", "album_group"],
            "Field required",
            Value::Null,
            None,
        )
    })?;
    let group = normalized_group(raw_group).ok_or_else(|| {
        ApiError::unprocessable(
            "value_error",
            vec!["body", "album_group"],
            "专辑分组须为数组 [专辑名, 专辑艺术家]，专辑名不能为空且每项最多 4000 字",
            raw_group.clone(),
            None,
        )
    })?;
    let raw_revision = payload.get("revision").ok_or_else(|| {
        ApiError::unprocessable(
            "missing",
            vec!["body", "revision"],
            "Field required",
            Value::Null,
            None,
        )
    })?;
    let revision = raw_revision
        .as_str()
        .filter(|value| value.len() == 32 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ApiError::unprocessable(
                "value_error",
                vec!["body", "revision"],
                "请提供专辑详情返回的 32 位版本标识",
                raw_revision.clone(),
                None,
            )
        })?;
    Ok((group, revision.to_ascii_lowercase()))
}

/// JSON tuple keeps titles containing quotes, slashes or separators unambiguous.
/// PostgreSQL BTRIM without an explicit character set removes ASCII spaces only.
pub(super) fn parse_album_group(
    raw: Option<&String>,
) -> Result<Option<(String, String)>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let parsed = serde_json::from_str::<Value>(raw).ok();
    if let Some(group) = parsed.as_ref().and_then(normalized_group) {
        return Ok(Some(group));
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
    use super::*;

    #[test]
    fn selection_requires_an_array_group_and_an_explicit_revision() {
        let valid = json!({"album_group": [" A / B \"mix\" ", " "], "revision": "A123456789ABCDEF0123456789ABCDEF"});
        assert_eq!(
            parse_selection(valid.as_object().unwrap()).unwrap(),
            (
                ("A / B \"mix\"".into(), String::new()),
                "a123456789abcdef0123456789abcdef".into()
            )
        );
        for invalid in [
            json!({}),
            json!({"album_group": ["A", "B"]}),
            json!({"album_group": "[\"A\",\"B\"]", "revision": "0".repeat(32)}),
            json!({"album_group": ["A", "B"], "revision": null}),
            json!({"album_group": ["A", "B"], "revision": "0".repeat(31)}),
            json!({"album_group": ["A", "B"], "revision": "x".repeat(32)}),
            json!({"album_group": ["A", "B"], "revision": 123}),
        ] {
            assert!(parse_selection(invalid.as_object().unwrap()).is_err());
        }
    }

    #[test]
    fn query_and_selection_share_group_identity_and_unicode_length_rules() {
        let group = json!([
            format!(" {} ", "专".repeat(4000)),
            "\u{3000} artist \u{3000}"
        ]);
        let expected = ("专".repeat(4000), "\u{3000} artist \u{3000}".to_string());
        assert_eq!(
            parse_album_group(Some(&group.to_string())).unwrap(),
            Some(expected.clone())
        );
        let payload = json!({"album_group": group, "revision": "0".repeat(32)});
        assert_eq!(
            parse_selection(payload.as_object().unwrap()).unwrap().0,
            expected
        );
        assert!(normalized_group(&json!(["A", "艺".repeat(4001)])).is_none());
        assert!(normalized_group(&json!([" ", "artist"])).is_none());
    }

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
