//! Index-only duplicate candidates with explicit, single-row review selection.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::duplicates::{self, DetailResult, Group, ListQuery, SelectionResult};
use crate::AppState;

use super::{light_track_json, ApiError, ApiResult, RawQuery};

pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = parse_list(&RawQuery(params))?;
    Ok(Json(json!(duplicates::list(&state.db, &query).await?)))
}

pub async fn detail(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let request = parse_detail(&RawQuery(params))?;
    match duplicates::detail(
        &state.db,
        &request.group,
        request.page,
        request.page_size,
        request.revision.as_deref(),
    )
    .await?
    {
        DetailResult::Missing => Err(ApiError::not_found("疑似重复分组已不存在，请刷新核对列表")),
        DetailResult::Changed => Err(changed()),
        DetailResult::Ready(detail) => {
            let items: Vec<_> = detail.items.iter().map(light_track_json).collect();
            Ok(Json(json!({
                "group": request.group, "total": detail.total, "revision": detail.revision,
                "page": detail.page, "page_size": detail.page_size, "pages": detail.pages,
                "summary": detail.summary, "items": items,
            })))
        }
    }
}

pub async fn selection(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request = parse_selection(&super::parse_body(&body)?)?;
    match duplicates::selection(
        &state.db,
        &request.group,
        &request.revision,
        request.track_id,
    )
    .await?
    {
        SelectionResult::Changed => Err(changed()),
        SelectionResult::Ready {
            total,
            revision,
            track,
        } => Ok(Json(json!({
            "group": request.group, "revision": revision, "total": total,
            "track": light_track_json(&track),
            "selected_at": chrono::Utc::now().timestamp_millis() as f64 / 1000.0,
        }))),
    }
}

fn changed() -> ApiError {
    ApiError::conflict("疑似重复分组或比较信息已变化，请刷新详情后重新核对")
}

fn parse_list(query: &RawQuery) -> Result<ListQuery, ApiError> {
    let q = query.str("q", "");
    if q.chars().count() > 200 || q.contains('\0') {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "q"],
            "搜索内容最多 200 字且不能包含空字符",
            json!(q),
            None,
        ));
    }
    Ok(ListQuery {
        q,
        page: query.i64("page", 1)?,
        page_size: parse_page_size(query, 20, 50)?,
    })
}

fn parse_page_size(query: &RawQuery, default: i64, max: i64) -> Result<i64, ApiError> {
    let size = query.i64("page_size", default)?;
    if !(1..=max).contains(&size) {
        return Err(ApiError::unprocessable(
            "value_error",
            vec!["query", "page_size"],
            &format!("每页数量须为 1–{max}"),
            json!(size),
            Some(json!({"ge": 1, "le": max})),
        ));
    }
    Ok(size)
}

struct DetailRequest {
    group: Group,
    page: i64,
    page_size: i64,
    revision: Option<String>,
}

fn parse_detail(query: &RawQuery) -> Result<DetailRequest, ApiError> {
    let raw_group = query
        .0
        .get("group")
        .ok_or_else(|| missing("query", "group"))?;
    let value: Value =
        serde_json::from_str(raw_group).map_err(|_| group_error("query", json!(raw_group)))?;
    let group = parse_group(&value).ok_or_else(|| group_error("query", value.clone()))?;
    let page = query.i64("page", 1)?;
    let page_size = parse_page_size(query, 50, 100)?;
    let revision = query
        .0
        .get("revision")
        .map(|value| parse_revision(&Value::String(value.clone()), "query"))
        .transpose()?;
    if page > 1 && revision.is_none() {
        return Err(missing("query", "revision"));
    }
    Ok(DetailRequest {
        group,
        page,
        page_size,
        revision,
    })
}

struct SelectionRequest {
    group: Group,
    revision: String,
    track_id: i64,
}

fn parse_selection(payload: &Map<String, Value>) -> Result<SelectionRequest, ApiError> {
    let value = payload
        .get("group")
        .ok_or_else(|| missing("body", "group"))?;
    let group = parse_group(value).ok_or_else(|| group_error("body", value.clone()))?;
    let revision = parse_revision(
        payload
            .get("revision")
            .ok_or_else(|| missing("body", "revision"))?,
        "body",
    )?;
    let value = payload
        .get("track_id")
        .ok_or_else(|| missing("body", "track_id"))?;
    let track_id = value.as_i64().filter(|id| *id > 0).ok_or_else(|| {
        ApiError::unprocessable(
            "value_error",
            vec!["body", "track_id"],
            "曲目 ID 须为正整数",
            value.clone(),
            None,
        )
    })?;
    Ok(SelectionRequest {
        group,
        revision,
        track_id,
    })
}

/// Round-trip the database's canonical keys without applying another language's
/// Unicode lowercasing or trimming rules. PostgreSQL BTRIM removes ASCII spaces.
/// Tags are unbounded TEXT; a listed group must not fail a new 4,000-char limit.
fn parse_group(value: &Value) -> Option<Group> {
    let parts = value.as_array()?;
    let [Value::String(artist), Value::String(title)] = parts.as_slice() else {
        return None;
    };
    if [artist, title]
        .iter()
        .any(|value| value.trim_matches(' ').is_empty() || value.contains('\0'))
    {
        return None;
    }
    Some((artist.clone(), title.clone()))
}

fn group_error(location: &str, input: Value) -> ApiError {
    ApiError::unprocessable(
        "value_error",
        vec![location, "group"],
        "分组须为服务端返回的 JSON 数组 [艺人, 标题]，两项均不能为空或包含空字符",
        input,
        None,
    )
}

fn parse_revision(value: &Value, location: &str) -> Result<String, ApiError> {
    value
        .as_str()
        .filter(|value| value.len() == 32 && value.bytes().all(|ch| ch.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "value_error",
                vec![location, "revision"],
                "请提供疑似重复详情返回的 32 位版本标识",
                value.clone(),
                None,
            )
        })
}

fn missing(location: &str, field: &str) -> ApiError {
    ApiError::unprocessable(
        "missing",
        vec![location, field],
        "Field required",
        Value::Null,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(values: &[(&str, &str)]) -> RawQuery {
        RawQuery(
            values
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
        )
    }

    #[test]
    fn group_round_trips_unicode_quotes_long_tags_and_exact_canonical_identity() {
        let values = [
            json!(["艺人", "A / B \\\" mix"]),
            json!(["İ ", "\u{3000}歌名\u{3000}"]),
            json!(["艺".repeat(8000), "曲".repeat(8000)]),
        ];
        for value in values {
            let parsed = parse_group(&value).unwrap();
            assert_eq!(json!(parsed), value);
        }
    }

    #[test]
    fn group_rejects_wrong_shapes_ascii_blanks_and_nul() {
        for value in [
            Value::Null,
            json!({}),
            json!([]),
            json!(["artist"]),
            json!(["artist", "title", "extra"]),
            json!([1, "title"]),
            json!(["artist", false]),
            json!(["", "title"]),
            json!(["artist", "  "]),
            json!(["a\0", "title"]),
            json!(["artist", "t\0"]),
        ] {
            assert!(parse_group(&value).is_none(), "{value}");
        }
    }

    #[test]
    fn list_search_uses_unicode_length_and_rejects_nul() {
        let valid = "艺".repeat(200);
        assert_eq!(parse_list(&query(&[("q", &valid)])).unwrap().q, valid);
        for invalid in ["艺".repeat(201), "a\0b".into()] {
            assert!(parse_list(&query(&[("q", &invalid)])).is_err());
        }
        let defaults = parse_list(&RawQuery::default()).unwrap();
        assert_eq!((defaults.page, defaults.page_size), (1, 20));
        assert_eq!(
            parse_list(&query(&[("page_size", "50")]))
                .unwrap()
                .page_size,
            50
        );
        for invalid in ["0", "-1", "51", "abc", "9223372036854775808"] {
            assert!(parse_list(&query(&[("page_size", invalid)])).is_err());
        }
    }

    #[test]
    fn detail_requires_revision_before_every_later_page() {
        let group = json!(["artist", "title"]).to_string();
        let defaults = parse_detail(&query(&[("group", &group)])).unwrap();
        assert_eq!((defaults.page, defaults.page_size), (1, 50));
        assert!(defaults.revision.is_none());
        assert!(parse_detail(&query(&[("group", &group), ("page", "2")])).is_err());
        assert!(parse_detail(&query(&[("group", &group), ("page", "0")])).is_ok());
        let revision = "ABCDEF0123456789ABCDEF0123456789";
        let parsed = parse_detail(&query(&[
            ("group", &group),
            ("page", "2"),
            ("page_size", "100"),
            ("revision", revision),
        ]))
        .unwrap();
        assert_eq!(
            parsed.revision.as_deref(),
            Some("abcdef0123456789abcdef0123456789")
        );
        for invalid in ["0", "-1", "101", "abc"] {
            assert!(parse_detail(&query(&[("group", &group), ("page_size", invalid)])).is_err());
        }
        assert!(parse_detail(&RawQuery::default()).is_err());
        assert!(parse_detail(&query(&[("group", "invalid JSON")])).is_err());
        assert!(parse_detail(&query(&[("group", &group), ("revision", "")])).is_err());
    }

    #[test]
    fn single_selection_requires_exact_group_revision_and_positive_integer_id() {
        let payload =
            json!({"group": ["artist", "title"], "revision": "A".repeat(32), "track_id": 7});
        let parsed = parse_selection(payload.as_object().unwrap()).unwrap();
        assert_eq!(parsed.group, ("artist".into(), "title".into()));
        assert_eq!(parsed.revision, "a".repeat(32));
        assert_eq!(parsed.track_id, 7);
        for key in ["group", "revision", "track_id"] {
            let mut invalid = payload.as_object().unwrap().clone();
            invalid.remove(key);
            assert!(parse_selection(&invalid).is_err());
        }
        for value in [
            json!(0),
            json!(-1),
            json!(1.2),
            json!("7"),
            json!(true),
            Value::Null,
        ] {
            let mut invalid = payload.as_object().unwrap().clone();
            invalid.insert("track_id".into(), value);
            assert!(parse_selection(&invalid).is_err());
        }
        for value in [
            json!("0".repeat(31)),
            json!("0".repeat(33)),
            json!("x".repeat(32)),
            json!(12),
            Value::Null,
        ] {
            assert!(parse_revision(&value, "body").is_err());
        }
    }
}
