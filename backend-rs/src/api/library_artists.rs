//! Read-only artist discovery, independent of the portrait tool's old contract.

use super::{light_track_json, ApiError, ApiResult};
use crate::{repo, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::collections::HashMap;

fn error(status: StatusCode, code: &str, message: &str) -> ApiError {
    ApiError::StatusDetail(status, json!({"code":code,"message":message}))
}

fn invalid(message: &str) -> ApiError {
    error(StatusCode::BAD_REQUEST, "invalid_request", message)
}

pub(super) fn parse_artist_group(raw: Option<&String>, required: bool) -> ApiResult<String> {
    let raw = raw.map(String::as_str).unwrap_or("");
    let name = raw.trim_matches(' ');
    if raw.contains('\0') || raw.chars().count() > 4000 || (required && name.is_empty()) {
        return Err(invalid(
            "艺术家分组须为不含空字符且最多 4000 字的名称；详情名称不能为空",
        ));
    }
    Ok(name.to_owned())
}

fn keys(params: &HashMap<String, String>, allowed: &[&str]) -> ApiResult<()> {
    if params.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("不支持这个查询参数"));
    }
    Ok(())
}

fn number(params: &HashMap<String, String>, key: &str, default: i64, max: i64) -> ApiResult<i64> {
    match params.get(key) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|value| (1..=max).contains(value))
            .ok_or_else(|| invalid("页码或每页数量不在允许范围内")),
    }
}

pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    keys(&params, &["q", "sort", "order", "page", "page_size"])?;
    let q = params
        .get("q")
        .map(|value| value.trim())
        .unwrap_or("")
        .to_owned();
    if q.contains('\0') || q.chars().count() > 4000 {
        return Err(invalid("搜索文字最多 4000 字且不能包含空字符"));
    }
    let sort = params.get("sort").map(String::as_str).unwrap_or("name");
    let order = params.get("order").map(String::as_str).unwrap_or("asc");
    if !matches!(sort, "name" | "tracks" | "recent") || !matches!(order, "asc" | "desc") {
        return Err(invalid(
            "排序须为 name、tracks 或 recent，方向须为 asc 或 desc",
        ));
    }
    let page = number(&params, "page", 1, i64::MAX)?;
    let page_size = number(&params, "page_size", 24, 100)?;
    let result =
        repo::list_library_artists(&state.db, &q, sort, order == "desc", page, page_size).await?;
    Ok(Json(
        json!({"q":q,"sort":sort,"order":order,"total":result.total,"page":result.page,
        "page_size":page_size,"pages":result.pages,"items":result.items}),
    ))
}

pub async fn detail(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    keys(
        &params,
        &["artist_group", "section", "page", "page_size", "revision"],
    )?;
    let name = parse_artist_group(params.get("artist_group"), true)?;
    let section = params
        .get("section")
        .map(String::as_str)
        .unwrap_or("albums");
    if !matches!(section, "albums" | "tracks") {
        return Err(invalid("详情内容须为 albums 或 tracks"));
    }
    let page = number(&params, "page", 1, i64::MAX)?;
    let page_size = number(
        &params,
        "page_size",
        if section == "albums" { 24 } else { 50 },
        if section == "albums" { 100 } else { 200 },
    )?;
    let revision = params
        .get("revision")
        .map(|value| value.to_ascii_lowercase());
    if revision
        .as_ref()
        .is_some_and(|value| value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid("版本标识须为详情返回的 32 位十六进制字符串"));
    }
    match repo::library_artist_detail(
        &state.db,
        &name,
        section,
        page,
        page_size,
        revision.as_deref(),
    )
    .await?
    {
        repo::ArtistDetailResult::Missing => Err(error(
            StatusCode::NOT_FOUND,
            "artist_missing",
            "艺术家分组已不存在，请刷新列表",
        )),
        repo::ArtistDetailResult::Changed => Err(error(
            StatusCode::CONFLICT,
            "artist_changed",
            "艺术家或相关专辑的索引资料已改变，请刷新详情",
        )),
        repo::ArtistDetailResult::Ready(detail) => {
            let items = match detail.items {
                repo::ArtistItems::Albums(items) => json!(items),
                repo::ArtistItems::Tracks(items) => {
                    Value::Array(items.iter().map(light_track_json).collect())
                }
            };
            Ok(Json(
                json!({"name":name,"summary":detail.summary,"revision":detail.revision,"section":section,
                "total":detail.total,"page":detail.page,"page_size":page_size,"pages":detail.pages,"items":items}),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_artist_scope_strips_only_ascii_spaces_and_never_splits_names() {
        for (raw, expected) in [
            ("  A & B / C  ", "A & B / C"),
            (" \u{3000}A\u{3000} ", "\u{3000}A\u{3000}"),
            (" \t ", "\t"),
            ("  ", ""),
        ] {
            assert_eq!(
                parse_artist_group(Some(&raw.into()), false).unwrap(),
                expected
            );
        }
        assert!(parse_artist_group(None, true).is_err());
        assert!(parse_artist_group(Some(&" ".into()), true).is_err());
        assert!(parse_artist_group(Some(&"A\0B".into()), false).is_err());
        assert!(parse_artist_group(Some(&"艺".repeat(4001)), false).is_err());
        assert!(parse_artist_group(Some(&"艺".repeat(4000)), true).is_ok());
        assert!(parse_artist_group(Some(&format!(" {}", "艺".repeat(4000))), true).is_err());
    }

    #[test]
    fn bounded_parameters_reject_unknown_and_malformed_inputs() {
        let bad = HashMap::from([("path".into(), "/arbitrary".into())]);
        assert!(keys(&bad, &["q"]).is_err());
        for value in ["0", "-1", "1.0", "101", "word"] {
            assert!(number(
                &HashMap::from([("page_size".into(), value.into())]),
                "page_size",
                24,
                100
            )
            .is_err());
        }
        assert_eq!(number(&HashMap::new(), "page_size", 24, 100).unwrap(), 24);
    }
}
