//! A whole-filter selection is an explicit, bounded index snapshot. Preparation
//! and confirmation use one identical query; neither touches the music mount.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::models::Track;
use crate::repo::{self, TrackQuery, FILTERED_SELECTION_LIMIT};
use crate::AppState;

use super::{light_track_json, ApiError, ApiResult, RawQuery};

const MAX_SAFE_ID: i64 = 9_007_199_254_740_991;
const TEXT_FIELDS: &[&str] = &[
    "q",
    "artist",
    "album",
    "language",
    "albumtype",
    "genre",
    "year",
];
const BOOL_FIELDS: &[&str] = &[
    "folder_recursive",
    "missing_cover",
    "missing_lyrics",
    "no_artist",
    "no_album",
    "not_loaded",
];
const SORTS: &[&str] = &[
    "artist",
    "title",
    "album",
    "year",
    "path",
    "track",
    "indexed",
    "edited",
    "disc_track",
];

#[derive(Debug)]
struct Request {
    query: TrackQuery,
    canonical: Value,
    revision: Option<String>,
}

pub async fn prepare(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let request = parse_request(&state.config.music_dir, &super::parse_body(&body)?)?;
    let tracks = repo::filtered_track_snapshot(&state.db, &request.query).await?;
    Ok(Json(snapshot_response(&request, &tracks)?))
}

fn invalid(field: &str, message: &str, input: Value) -> ApiError {
    ApiError::unprocessable(
        "value_error",
        vec!["body", "query", field],
        message,
        input,
        None,
    )
}

fn parse_request(root: &Path, payload: &Map<String, Value>) -> ApiResult<Request> {
    for (key, value) in payload {
        if !matches!(key.as_str(), "query" | "revision") {
            return Err(ApiError::unprocessable(
                "extra_forbidden",
                vec!["body", key],
                "不支持这个字段；筛选选择不接受分页或截断参数",
                value.clone(),
                None,
            ));
        }
    }
    let values = payload
        .get("query")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "dict_type",
                vec!["body", "query"],
                "请提供完整的筛选条件对象",
                payload.get("query").cloned().unwrap_or(Value::Null),
                None,
            )
        })?;
    let mut raw = HashMap::new();
    for (key, value) in values {
        if TEXT_FIELDS.contains(&key.as_str()) {
            let text = value
                .as_str()
                .filter(|text| !text.contains('\0') && text.chars().count() <= 4000)
                .ok_or_else(|| {
                    invalid(
                        key,
                        "筛选文字须为不含空字符且最多 4000 字的字符串",
                        value.clone(),
                    )
                })?;
            raw.insert(key.clone(), text.to_owned());
        } else if BOOL_FIELDS.contains(&key.as_str()) {
            let flag = value
                .as_bool()
                .ok_or_else(|| invalid(key, "筛选开关须为 JSON 布尔值", value.clone()))?;
            raw.insert(key.clone(), flag.to_string());
        } else {
            match key.as_str() {
                "sort" => {
                    let sort = value
                        .as_str()
                        .filter(|sort| SORTS.contains(sort))
                        .ok_or_else(|| invalid(key, "排序字段无效", value.clone()))?;
                    raw.insert(key.clone(), sort.to_owned());
                }
                "order" => {
                    let order = value
                        .as_str()
                        .map(|value| value.trim().to_ascii_lowercase())
                        .filter(|order| matches!(order.as_str(), "asc" | "desc"))
                        .ok_or_else(|| invalid(key, "排序方向须为 asc 或 desc", value.clone()))?;
                    raw.insert(key.clone(), order);
                }
                "album_group" => {
                    if !value.is_null() {
                        let valid = value
                            .as_array()
                            .filter(|parts| parts.len() == 2)
                            .is_some_and(|parts| {
                                parts.iter().all(|part| {
                                    part.as_str().is_some_and(|text| {
                                        !text.contains('\0') && text.chars().count() <= 4000
                                    })
                                })
                            });
                        if !valid {
                            return Err(invalid(key, "专辑分组须为 null 或两项字符串数组，每项最多 4000 字且不能含空字符", value.clone()));
                        }
                        raw.insert(key.clone(), value.to_string());
                    }
                }
                "folder" => {
                    let folder = value
                        .as_str()
                        .filter(|folder| !folder.contains('\0') && folder.chars().count() <= 32768)
                        .ok_or_else(|| {
                            invalid(
                                key,
                                "目录须为不含空字符且最多 32768 字的字符串",
                                value.clone(),
                            )
                        })?;
                    // Unlike tag queries, valid directory spaces are significant.
                    raw.insert(key.clone(), folder.to_owned());
                }
                _ => {
                    return Err(invalid(
                        key,
                        "不支持这个筛选字段；不能传入分页、数量限制或曲目 ID",
                        value.clone(),
                    ))
                }
            }
        }
    }
    let query = super::tracks::parse_track_query(root, &RawQuery(raw))?;
    let canonical = canonical_query(&query);
    let revision = match payload.get("revision") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|text| {
                    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    ApiError::unprocessable(
                        "value_error",
                        vec!["body", "revision"],
                        "请提供准备结果返回的 64 位版本标识",
                        value.clone(),
                        None,
                    )
                })?
                .to_ascii_lowercase(),
        ),
    };
    Ok(Request {
        query,
        canonical,
        revision,
    })
}

fn canonical_query(query: &TrackQuery) -> Value {
    json!({
        "q": query.q, "artist": query.artist, "album": query.album,
        "language": query.language, "albumtype": query.albumtype,
        "genre": query.genre, "year": query.year, "sort": query.sort,
        "order": if query.order_desc { "desc" } else { "asc" },
        "album_group": query.album_group,
        "folder": query.folder.as_ref().map(|folder| folder.directory()).unwrap_or(""),
        "folder_recursive": query.folder.as_ref().map(|folder| folder.recursive()).unwrap_or(true),
        "missing_cover": query.missing_cover, "missing_lyrics": query.missing_lyrics,
        "no_artist": query.no_artist, "no_album": query.no_album, "not_loaded": query.not_loaded,
    })
}

fn conflict(code: &str, message: &str) -> ApiError {
    ApiError::StatusDetail(StatusCode::CONFLICT, json!({"code":code,"message":message}))
}

fn snapshot_response(request: &Request, tracks: &[Track]) -> ApiResult<Value> {
    if tracks.len() > FILTERED_SELECTION_LIMIT {
        return Err(ApiError::StatusDetail(
            StatusCode::CONFLICT,
            json!({
                "code": "selection_limit_exceeded", "message": "当前筛选超过 20000 首，请缩小范围后重新准备；未加入任何曲目",
                "limit": FILTERED_SELECTION_LIMIT, "matched_at_least": FILTERED_SELECTION_LIMIT + 1,
            }),
        ));
    }
    let mut seen = HashSet::with_capacity(tracks.len());
    if tracks
        .iter()
        .any(|track| !(1..=MAX_SAFE_ID).contains(&track.id) || !seen.insert(track.id))
    {
        return Err(conflict(
            "invalid_selection_snapshot",
            "筛选结果含无效或重复曲目编号，请刷新曲库后重试；未加入任何曲目",
        ));
    }
    let items: Vec<Value> = tracks.iter().map(light_track_json).collect();
    let revision = snapshot_revision(&request.canonical, &items);
    if request
        .revision
        .as_ref()
        .is_some_and(|expected| *expected != revision)
    {
        return Err(conflict(
            "selection_changed",
            "筛选结果或曲目资料已变化，请重新准备并核对范围；未加入任何曲目",
        ));
    }
    Ok(
        json!({"query":request.canonical,"revision":revision,"total":items.len(),"limit":FILTERED_SELECTION_LIMIT,"items":items}),
    )
}

fn snapshot_revision(query: &Value, items: &[Value]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"metatidy-filtered-selection-v1\0");
    // Each canonical JSON value is length-prefixed: arbitrary text, quotes or
    // separators cannot alias a different query or a different ordered record.
    for value in std::iter::once(query).chain(items.iter()) {
        let encoded = serde_json::to_vec(value).expect("JSON values serialize");
        hash.update((encoded.len() as u64).to_be_bytes());
        hash.update(encoded);
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> &'static Path {
        if cfg!(windows) {
            Path::new(r"C:\Music")
        } else {
            Path::new("/music")
        }
    }
    fn request(value: Value) -> ApiResult<Request> {
        parse_request(root(), value.as_object().unwrap())
    }
    fn track(id: i64) -> Track {
        Track {
            id,
            title: format!("歌 {id}"),
            path: format!("/music/{id}.flac"),
            ..Track::default()
        }
    }

    #[test]
    fn canonical_scope_uses_the_shared_list_parser_and_semantic_defaults() {
        let default = request(json!({"query":{}})).unwrap();
        assert_eq!(default.canonical.as_object().unwrap().len(), 17);
        assert_eq!(default.canonical["sort"], "artist");
        assert_eq!(default.canonical["folder_recursive"], true);
        assert_eq!(default.canonical["album_group"], Value::Null);
        let value = request(json!({"query":{"q":" \u{3000}周%_杰\n", "artist":" 王菲 ", "order":" DESC ", "folder_recursive":false,"album_group":[" Mix "," "]}})).unwrap();
        let raw = RawQuery(HashMap::from([
            ("q".into(), " \u{3000}周%_杰\n".into()),
            ("artist".into(), " 王菲 ".into()),
            ("order".into(), " DESC ".into()),
            ("album_group".into(), "[\" Mix \",\" \"]".into()),
        ]));
        assert_eq!(
            value.canonical,
            canonical_query(&super::super::tracks::parse_track_query(root(), &raw).unwrap())
        );
        assert_eq!(value.canonical["q"], "周%_杰");
        assert_eq!(value.canonical["album_group"], json!(["Mix", ""]));
    }

    #[test]
    fn strict_query_types_and_unknown_fields_cannot_widen_or_truncate_selection() {
        for value in [
            json!({}),
            json!({"query":null}),
            json!({"query":[],"page":1}),
            json!({"query":{},"ids":[]}),
            json!({"query":{"page":2}}),
            json!({"query":{"limit":1}}),
            json!({"query":{"q":5}}),
            json!({"query":{"q":null}}),
            json!({"query":{"sort":"random"}}),
            json!({"query":{"order":"sideways"}}),
            json!({"query":{"album_group":"[\"a\",\"b\"]"}}),
            json!({"query":{"album_group":["",""]}}),
            json!({"query":{"missing_cover":"true"}}),
            json!({"query":{"folder_recursive":1}}),
            json!({"query":{"folder":null}}),
        ] {
            assert!(request(value.clone()).is_err(), "{value}");
        }
        for field in TEXT_FIELDS {
            for invalid in [json!("x\0y"), json!("歌".repeat(4001)), json!(true)] {
                assert!(request(json!({"query":{*field:invalid}})).is_err());
            }
            assert!(request(json!({"query":{*field:"歌".repeat(4000)}})).is_ok());
        }
    }

    #[test]
    fn folder_spaces_are_preserved_and_invalid_scopes_rejected() {
        let folder = root().join(" spaced ");
        let path = crate::models::path_key(&folder);
        let value = request(json!({"query":{"folder":path,"folder_recursive":false}})).unwrap();
        assert_eq!(value.canonical["folder"], path);
        assert_eq!(value.canonical["folder_recursive"], false);
        for folder in ["relative", "../elsewhere", "nul\0path"] {
            assert!(request(json!({"query":{"folder":folder}})).is_err());
        }
    }

    #[test]
    fn revision_requires_exact_hex_and_is_case_normalized() {
        assert!(request(json!({"query":{},"revision":null}))
            .unwrap()
            .revision
            .is_none());
        assert_eq!(
            request(json!({"query":{},"revision":"A".repeat(64)}))
                .unwrap()
                .revision,
            Some("a".repeat(64))
        );
        for revision in [
            json!(""),
            json!("a".repeat(63)),
            json!("g".repeat(64)),
            json!(true),
            json!(3),
            json!([]),
        ] {
            assert!(request(json!({"query":{},"revision":revision})).is_err());
        }
    }

    #[test]
    fn revision_covers_every_light_field_query_membership_and_order() {
        let scope = request(json!({"query":{}})).unwrap();
        let rows = vec![light_track_json(&track(1)), light_track_json(&track(2))];
        let first = snapshot_revision(&scope.canonical, &rows);
        for key in rows[0].as_object().unwrap().keys() {
            let mut changed = rows.clone();
            changed[0][key] = match &changed[0][key] {
                Value::String(value) => json!(format!("{value}x")),
                Value::Bool(value) => json!(!value),
                _ => json!(9999),
            };
            assert_ne!(
                first,
                snapshot_revision(&scope.canonical, &changed),
                "field {key}"
            );
        }
        let mut reversed = rows.clone();
        reversed.reverse();
        assert_ne!(first, snapshot_revision(&scope.canonical, &reversed));
        assert_ne!(first, snapshot_revision(&scope.canonical, &rows[..1]));
        let mut changed_query = scope.canonical.clone();
        changed_query["q"] = json!("different");
        assert_ne!(first, snapshot_revision(&changed_query, &rows));
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn entire_limit_and_safe_ids_are_enforced_before_any_partial_response() {
        let scope = request(json!({"query":{}})).unwrap();
        let mut rows: Vec<_> = (1..=FILTERED_SELECTION_LIMIT as i64).map(track).collect();
        assert_eq!(
            snapshot_response(&scope, &rows).unwrap()["total"],
            FILTERED_SELECTION_LIMIT
        );
        rows.push(track(FILTERED_SELECTION_LIMIT as i64 + 1));
        assert!(
            matches!(snapshot_response(&scope,&rows),Err(ApiError::StatusDetail(StatusCode::CONFLICT, detail)) if detail["code"]=="selection_limit_exceeded" && detail.get("items").is_none())
        );
        for rows in [
            vec![track(0)],
            vec![track(-1)],
            vec![track(MAX_SAFE_ID + 1)],
            vec![track(1), track(1)],
        ] {
            assert!(
                matches!(snapshot_response(&scope,&rows),Err(ApiError::StatusDetail(StatusCode::CONFLICT, detail)) if detail["code"]=="invalid_selection_snapshot")
            );
        }
        assert_eq!(snapshot_response(&scope, &[]).unwrap()["total"], 0);
        assert!(snapshot_response(&scope, &[track(MAX_SAFE_ID)]).is_ok());
    }

    #[test]
    fn final_confirmation_rejects_changed_same_count_or_changed_queries() {
        let scope = request(json!({"query":{"artist":" 王菲 "}})).unwrap();
        let response = snapshot_response(&scope, &[track(1), track(2)]).unwrap();
        let confirm =
            request(json!({"query":response["query"],"revision":response["revision"]})).unwrap();
        assert_eq!(
            snapshot_response(&confirm, &[track(1), track(2)]).unwrap(),
            response
        );
        let mut changed = track(2);
        changed.title = "新标题".into();
        for rows in [
            vec![track(1), track(3)],
            vec![track(2), track(1)],
            vec![track(1), changed],
        ] {
            assert!(
                matches!(snapshot_response(&confirm,&rows),Err(ApiError::StatusDetail(StatusCode::CONFLICT, detail)) if detail["code"]=="selection_changed")
            );
        }
        let confirm =
            request(json!({"query":{"artist":"其他"},"revision":response["revision"]})).unwrap();
        assert!(snapshot_response(&confirm, &[track(1), track(2)]).is_err());
    }
}
