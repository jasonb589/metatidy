//! Read-only indexed directory navigation and shared track-scope parsing.

use std::collections::HashMap;
use std::path::Path;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::json;

use crate::folders::{self, FolderQuery, FolderScope};
use crate::AppState;

use super::{ApiError, ApiResult, RawQuery};

pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = parse_list(&state.config.music_dir, &RawQuery(params))?;
    let result = folders::list(&state.db, &state.config.music_dir, &query)
        .await?
        .ok_or_else(|| ApiError::not_found("该目录没有已索引曲目，请返回上级或刷新目录"))?;
    Ok(Json(json!(result)))
}

fn parse_list(root: &Path, query: &RawQuery) -> Result<FolderQuery, ApiError> {
    let q = query.str("q", "");
    if q.chars().count() > 200 || q.contains('\0') {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "q"],
            "目录搜索最多 200 字，不能包含空字符",
            json!(q),
            None,
        ));
    }
    let page_size = query.i64("page_size", 50)?;
    if !(1..=100).contains(&page_size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            "每页目录数须为 1–100",
            json!(page_size),
            Some(json!({"ge":1,"le":100})),
        ));
    }
    Ok(FolderQuery {
        scope: FolderScope::new(root, &query.str("folder", ""), true)
            .map_err(ApiError::bad_request)?,
        q,
        page: query.i64("page", 1)?,
        page_size,
    })
}

pub(super) fn track_scope(root: &Path, query: &RawQuery) -> Result<Option<FolderScope>, ApiError> {
    let recursive = query.bool("folder_recursive", true)?;
    match query.0.get("folder").filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(folder) => FolderScope::new(root, folder, recursive)
            .map(Some)
            .map_err(ApiError::bad_request),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    fn root() -> &'static Path {
        if cfg!(windows) {
            Path::new(r"C:\Music")
        } else {
            Path::new("/music")
        }
    }
    fn query(items: &[(&str, &str)]) -> RawQuery {
        RawQuery(
            items
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
        )
    }

    #[test]
    fn folder_parameters_have_explicit_limits_and_native_path_errors() {
        let default = parse_list(root(), &query(&[])).unwrap();
        assert_eq!((default.page, default.page_size), (1, 50));
        assert!(parse_list(
            root(),
            &query(&[("q", &"艺".repeat(200)), ("page_size", "100")])
        )
        .is_ok());
        for invalid in [
            query(&[("q", &"艺".repeat(201))]),
            query(&[("q", "a\0b")]),
            query(&[("page_size", "0")]),
            query(&[("page_size", "101")]),
            query(&[("page", "NaN")]),
        ] {
            assert_eq!(
                parse_list(root(), &invalid)
                    .unwrap_err()
                    .into_response()
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        assert_eq!(
            parse_list(root(), &query(&[("folder", "relative")]))
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn track_scope_is_optional_and_still_validates_recursive_flag() {
        assert!(track_scope(root(), &query(&[])).unwrap().is_none());
        assert!(track_scope(root(), &query(&[("folder", "")]))
            .unwrap()
            .is_none());
        let path = crate::models::path_key(root());
        assert!(track_scope(root(), &query(&[("folder", &path)]))
            .unwrap()
            .unwrap()
            .recursive());
        for accepted in ["false", "0", "OFF", "no"] {
            assert!(!track_scope(
                root(),
                &query(&[("folder", &path), ("folder_recursive", accepted)])
            )
            .unwrap()
            .unwrap()
            .recursive());
        }
        assert_eq!(
            track_scope(root(), &query(&[("folder_recursive", "bad")]))
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
