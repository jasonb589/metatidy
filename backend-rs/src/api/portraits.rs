//! Artist portrait review and single-use Navidrome uploads.
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sqlx::types::Json as SqlJson;
use std::collections::HashMap;
use uuid::Uuid;

use super::{ApiError, ApiResult, RawQuery};
use crate::lastfm_portraits::ProviderError;
use crate::navidrome_portraits::{self, Artist};
use crate::portraits::{self, Portrait};
use crate::AppState;

fn db(error: sqlx::Error) -> ApiError {
    anyhow::Error::from(error).into()
}
fn bad(error: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request(error.to_string())
}
fn required(payload: &serde_json::Map<String, Value>, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .ok_or_else(|| {
            ApiError::unprocessable(
                "value_error",
                vec!["body", key],
                "请提供非空文本",
                Value::Null,
                None,
            )
        })
}
fn uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::bad_request("头像或同步编号无效"))
}
fn nd_error(error: navidrome_portraits::Error) -> ApiError {
    let status = if error.is_bad_request() {
        StatusCode::BAD_REQUEST
    } else if error.is_not_found() {
        StatusCode::NOT_FOUND
    } else if error.is_rate_limited() {
        StatusCode::TOO_MANY_REQUESTS
    } else {
        StatusCode::BAD_GATEWAY
    };
    // Upstream 401 is not the MetaTidy user's expired session.
    ApiError::Status(status, error.to_string())
}
fn provider_error(error: ProviderError, cached: bool) -> Response {
    let status = match error.code.as_str() {
        "busy" | "cooldown" | "rate_limited" | "forbidden" | "challenge" => {
            StatusCode::TOO_MANY_REQUESTS
        }
        "invalid_artist" | "invalid_image_url" | "placeholder_image" => StatusCode::BAD_REQUEST,
        "artist_not_found" | "image_not_found" => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_GATEWAY,
    };
    let retry = error.retry_after_seconds;
    let mut response = (status, Json(json!({"detail":error.message,"code":error.code,"retry_after_seconds":retry,"cached":cached}))).into_response();
    if let Some(seconds) = retry {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, seconds.to_string().parse().unwrap());
    }
    response
}

pub async fn artists(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let q = query.str("q", "").trim().to_owned();
    if q.chars().count() > 200 {
        return Err(ApiError::bad_request("搜索最多 200 字"));
    }
    let size = query.i64("page_size", 50)?;
    if !(1..=100).contains(&size) {
        return Err(ApiError::bad_request("每页歌手数须为 1–100"));
    }
    let pattern = format!(
        "%{}%",
        q.replace('!', "!!").replace('%', "!%").replace('_', "!_")
    );
    // Artist tags are kept intact: splitting '&' or '/' can corrupt real names.
    let grouped = "SELECT BTRIM(artist) AS name,count(*)::bigint AS track_count, count(DISTINCT NULLIF(BTRIM(album),''))::bigint AS album_count FROM tracks WHERE BTRIM(artist)<>'' AND BTRIM(artist) ILIKE $1 ESCAPE '!' GROUP BY BTRIM(artist)";
    let mut tx = state.db.begin().await.map_err(db)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM ({grouped}) AS groups"))
        .bind(&pattern)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let pages = if total == 0 {
        0
    } else {
        (total - 1) / size + 1
    };
    let page = query.i64("page", 1)?.clamp(1, pages.max(1));
    let rows: Vec<(String, i64, i64)> =
        sqlx::query_as(&format!("{grouped} ORDER BY name LIMIT $2 OFFSET $3"))
            .bind(&pattern)
            .bind(size)
            .bind((page - 1) * size)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|(name,track_count,album_count)|json!({"name":name,"track_count":track_count,"album_count":album_count})).collect::<Vec<_>>(),"total":total,"page":page,"page_size":size,"pages":pages}),
    ))
}

pub async fn status(State(state): State<AppState>) -> ApiResult {
    let lastfm = match state.portraits.lastfm() {
        Ok(client) => serde_json::to_value(client.status()).unwrap(),
        Err(error) => {
            json!({"busy":false,"cooldown":true,"reason":error.message,"min_interval_seconds":5})
        }
    };
    Ok(Json(
        json!({"lastfm":lastfm,"navidrome":{"configured":state.portraits.configured(),"url":state.portraits.public_url(),"min_version":"0.61.0"},"cache_days":portraits::CACHE_DAYS}),
    ))
}

type PortraitRow = (Uuid, String, String, String, i32, i32, f64);
async fn portrait(state: &AppState, id: Uuid) -> Result<Portrait, ApiError> {
    let row: Option<PortraitRow> = sqlx::query_as("SELECT id,artist,source_page,source_image,width,height,extract(epoch from created_at)::double precision FROM artist_portraits WHERE id=$1")
        .bind(id).fetch_optional(&state.db).await.map_err(db)?;
    let (id, artist, source_page, source_image, width, height, created_at) =
        row.ok_or_else(|| ApiError::not_found("头像缓存记录不存在，请重新获取"))?;
    Ok(Portrait {
        id,
        artist,
        source_page,
        source_image,
        width,
        height,
        created_at,
        preview_url: format!("/api/artist-portraits/{id}/preview"),
        preview_format: "avif".into(),
        upload_format: "jpeg".into(),
    })
}

async fn read_bytes(state: &AppState, id: Uuid, preview: bool) -> Result<Vec<u8>, ApiError> {
    let field = if preview {
        "preview_digest"
    } else {
        "jpeg_digest"
    };
    let expected: Option<String> =
        sqlx::query_scalar(&format!("SELECT {field} FROM artist_portraits WHERE id=$1"))
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .map_err(db)?;
    let expected = expected.ok_or_else(|| ApiError::not_found("头像缓存不存在"))?;
    let directory = state.portraits.artifact_dir();
    tokio::task::spawn_blocking(move || {
        portraits::read_artifact(&directory, id, preview, &expected)
    })
    .await
    .map_err(|_| ApiError::bad_request("头像缓存读取未完成"))?
    .map_err(bad)
}

async fn cached_fetch(state: &AppState, key: &str) -> Result<Option<Response>, ApiError> {
    let cached: Option<(Option<Uuid>, Option<SqlJson<Value>>)> = sqlx::query_as("SELECT portrait_id,failure FROM artist_portrait_fetches WHERE cache_key=$1 AND expires_at>now()")
        .bind(key).fetch_optional(&state.db).await.map_err(db)?;
    if let Some((Some(id), _)) = cached {
        if read_bytes(state, id, false).await.is_ok() && read_bytes(state, id, true).await.is_ok() {
            return Ok(Some(
                Json(json!({"portrait":portrait(state,id).await?,"cached":true})).into_response(),
            ));
        }
        sqlx::query("DELETE FROM artist_portrait_fetches WHERE cache_key=$1")
            .bind(key)
            .execute(&state.db)
            .await
            .map_err(db)?;
    } else if let Some((_, Some(SqlJson(failure)))) = cached {
        return Ok(Some(provider_error(
            ProviderError {
                code: failure["code"].as_str().unwrap_or("parse_error").into(),
                message: failure["message"]
                    .as_str()
                    .unwrap_or("缓存中暂无可用头像，请稍后再试或提供 Last.fm 图片地址")
                    .into(),
                retry_after_seconds: None,
            },
            true,
        )));
    }
    Ok(None)
}

pub async fn fetch(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let payload = super::parse_body(&body)?;
    let artist = portraits::normalize_artist(&required(&payload, "artist")?).map_err(bad)?;
    let manual = match payload.get("image_url") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.trim().is_empty() => None,
        Some(Value::String(value)) if value.len() <= 2048 => Some(value.trim().to_string()),
        _ => return Err(ApiError::bad_request("Last.fm 图片地址无效或过长")),
    };
    let key = portraits::cache_key(&artist, manual.as_deref());
    if let Some(response) = cached_fetch(&state, &key).await? {
        return Ok(response);
    }
    // Cache is checked before and after the lock. Uncached concurrent clicks do
    // not accumulate a hidden queue of Last.fm requests.
    let _lock = match state.portraits.fetch_lock.try_lock() {
        Ok(lock) => lock,
        Err(_) => {
            return Ok(provider_error(
                ProviderError {
                    code: "busy".into(),
                    message: "正在处理另一张歌手头像，请等待完成".into(),
                    retry_after_seconds: Some(5),
                },
                false,
            ))
        }
    };
    if let Some(response) = cached_fetch(&state, &key).await? {
        return Ok(response);
    }
    let provider = match state.portraits.lastfm() {
        Ok(client) => client,
        Err(error) => return Ok(provider_error(error, false)),
    };
    let result = match manual {
        Some(url) => provider.fetch_image(&artist, &url).await,
        None => provider.fetch_artist(&artist).await,
    };
    let found = match result {
        Ok(found) => found,
        Err(error) => {
            if matches!(
                error.code.as_str(),
                "artist_not_found" | "image_not_found" | "placeholder_image" | "parse_error"
            ) {
                sqlx::query("INSERT INTO artist_portrait_fetches(cache_key,failure,expires_at) VALUES($1,$2,now()+interval '1 day') ON CONFLICT(cache_key) DO UPDATE SET portrait_id=NULL,failure=excluded.failure,expires_at=excluded.expires_at")
                    .bind(&key).bind(SqlJson(json!({"code":error.code,"message":error.message}))).execute(&state.db).await.map_err(db)?;
            }
            return Ok(provider_error(error, false));
        }
    };
    let bytes = found.bytes;
    let (jpeg, avif, width, height) =
        tokio::task::spawn_blocking(move || crate::cover_images::encode_portrait(&bytes))
            .await
            .map_err(|_| ApiError::bad_request("头像转换未完成"))?
            .map_err(bad)?;
    let jpeg_digest = portraits::digest(&jpeg);
    let preview_digest = portraits::digest(&avif);
    let id = Uuid::new_v4();
    let directory = state.portraits.artifact_dir();
    tokio::task::spawn_blocking(move || portraits::save_artifacts(&directory, id, &jpeg, &avif))
        .await
        .map_err(|_| ApiError::bad_request("头像缓存保存未完成"))?
        .map_err(bad)?;
    let mut tx = state.db.begin().await.map_err(db)?;
    sqlx::query("INSERT INTO artist_portraits(id,artist,source_page,source_image,jpeg_digest,preview_digest,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(&artist).bind(&found.source_page).bind(&found.source_image).bind(jpeg_digest).bind(preview_digest).bind(width as i32).bind(height as i32).execute(&mut *tx).await.map_err(db)?;
    sqlx::query("INSERT INTO artist_portrait_fetches(cache_key,portrait_id,expires_at) VALUES($1,$2,now()+interval '7 days') ON CONFLICT(cache_key) DO UPDATE SET portrait_id=excluded.portrait_id,failure=NULL,expires_at=excluded.expires_at")
        .bind(key).bind(id).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"portrait":portrait(&state,id).await?,"cached":false})).into_response())
}

fn image_response(bytes: Vec<u8>, mime: &str) -> Response {
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}
pub async fn preview(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    Ok(image_response(
        read_bytes(&state, uuid(&id)?, true).await?,
        "image/avif",
    ))
}

pub async fn connection(State(state): State<AppState>) -> ApiResult {
    let data = state
        .portraits
        .navidrome()
        .map_err(bad)?
        .status()
        .await
        .map_err(nd_error)?;
    Ok(Json(
        json!({"connected":data.connected,"user":{"name":state.config.navidrome_username,"is_admin":data.is_admin},"server_version":data.server_version,
        "supports_upload":data.supports_upload,"min_version":"0.61.0","message":"已验证连接；头像上传要求 Navidrome 0.61.0 或以上及相应权限"}),
    ))
}
pub async fn targets(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult {
    let query = RawQuery(params);
    let page = query.i64("page", 1)?.clamp(1, 100000) as u32;
    let size = query.i64("page_size", 50)?;
    if !(1..=100).contains(&size) {
        return Err(ApiError::bad_request("每页歌手数须为1–100"));
    }
    let data = state
        .portraits
        .navidrome()
        .map_err(bad)?
        .list_artists(&query.str("q", ""), page, size as u32)
        .await
        .map_err(nd_error)?;
    let pages = if data.total == 0 {
        0
    } else {
        (data.total - 1) / u64::from(data.page_size) + 1
    };
    Ok(Json(
        json!({"items":data.items,"total":data.total,"page":data.page,"page_size":data.page_size,"pages":pages}),
    ))
}

pub async fn sync_preview(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let portrait_id = uuid(&required(&payload, "portrait_id")?)?;
    let artist_id = required(&payload, "artist_id")?;
    let portrait = portrait(&state, portrait_id).await?;
    read_bytes(&state, portrait_id, false).await?;
    read_bytes(&state, portrait_id, true).await?;
    let client = state.portraits.navidrome().map_err(bad)?;
    let destination = state.portraits.destination();
    let mut tx = state.db.begin().await.map_err(db)?;
    // Read the target and issue its token under the same lock as upload claims.
    // Otherwise an in-flight upload could leave a new token with an old image.
    lock_target(&mut tx, &destination, &artist_id).await?;
    let target = client.get_artist(&artist_id).await.map_err(nd_error)?;
    let token = Uuid::new_v4();
    let expires_at: f64 = sqlx::query_scalar("INSERT INTO artist_portrait_syncs(token,portrait_id,target,destination,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING extract(epoch from expires_at)::double precision")
        .bind(token).bind(portrait_id).bind(SqlJson(&target)).bind(destination).fetch_one(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"token":token,"portrait":portrait,"target":target,"sync_state":"ready","expires_at":expires_at,"target_image_url":format!("/api/artist-portraits/sync/{token}/target-image")}),
    ))
}

type SyncRow = (
    Uuid,
    SqlJson<Artist>,
    String,
    String,
    String,
    Option<SqlJson<Value>>,
    f64,
);
async fn sync_row(state: &AppState, token: Uuid) -> Result<SyncRow, ApiError> {
    sqlx::query_as("SELECT portrait_id,target,destination,state,message,result,extract(epoch from expires_at)::double precision FROM artist_portrait_syncs WHERE token=$1")
        .bind(token).fetch_optional(&state.db).await.map_err(db)?.ok_or_else(||ApiError::not_found("同步记录不存在，请重新预览"))
}
pub async fn sync_status(State(state): State<AppState>, Path(token): Path<String>) -> ApiResult {
    let token = uuid(&token)?;
    let (id, SqlJson(target), _, status, message, result, expires_at) =
        sync_row(&state, token).await?;
    Ok(Json(
        json!({"token":token,"portrait_id":id,"target":target,"state":status,"message":message,"result":result.map(|value|value.0),"expires_at":expires_at}),
    ))
}
pub async fn target_image(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    let (_, SqlJson(target), destination, _, _, _, expires_at) =
        sync_row(&state, uuid(&token)?).await?;
    if destination != state.portraits.destination()
        || expires_at < chrono::Utc::now().timestamp() as f64
    {
        return Err(ApiError::conflict("目标预览已失效，请重新预览"));
    }
    let image = state
        .portraits
        .navidrome()
        .map_err(bad)?
        .get_current_image(&target.id)
        .await
        .map_err(nd_error)?;
    Ok(image_response(image.bytes, &image.content_type))
}

async fn lock_target(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    destination: &str,
    artist_id: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{destination}:{artist_id}"))
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM artist_portrait_syncs WHERE destination=$1 AND target->>'id'=$2 AND state='uploading')")
        .bind(destination).bind(artist_id).fetch_one(&mut **tx).await.map_err(db)?;
    if active {
        return Err(ApiError::conflict(
            "该 Navidrome 歌手已有同步进行中，请等待结果",
        ));
    }
    Ok(())
}

pub async fn sync(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let payload = super::parse_body(&body)?;
    let token = uuid(&required(&payload, "token")?)?;
    let (_, SqlJson(target), destination, status, _, _, expires_at) =
        sync_row(&state, token).await?;
    if status != "ready" || expires_at < chrono::Utc::now().timestamp() as f64 {
        return Err(ApiError::conflict(
            "此同步确认已提交或过期，请查看结果后重新预览",
        ));
    }
    if destination != state.portraits.destination() {
        return Err(ApiError::conflict("Navidrome 连接已变化，请重新预览"));
    }
    state.portraits.navidrome().map_err(bad)?;
    let mut tx = state.db.begin().await.map_err(db)?;
    // Serialize claims for the same destination+artist, even with two distinct
    // preview tokens. Never blindly retry an uncertain remote write.
    lock_target(&mut tx, &destination, &target.id).await?;
    let claimed:Option<Uuid>=sqlx::query_scalar("UPDATE artist_portrait_syncs SET state='uploading',message='正在核对目标并上传',updated_at=now() WHERE token=$1 AND state='ready' AND expires_at>now() RETURNING portrait_id")
        .bind(token).fetch_optional(&mut *tx).await.map_err(db)?;
    let portrait_id = claimed.ok_or_else(|| ApiError::conflict("同步已提交或过期，请查看结果"))?;
    // An old second token must not become an implicit retry of an uncertain
    // remote write. Only a newly reviewed target may be submitted afterwards.
    sqlx::query("UPDATE artist_portrait_syncs SET state='failed',message='该目标已有新的同步提交，本次旧预览已失效，请核对结果后重新预览',updated_at=now() WHERE token<>$1 AND destination=$2 AND target->>'id'=$3 AND state='ready'")
        .bind(token).bind(&destination).bind(&target.id).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    tokio::spawn(async move {
        run_sync(state, token, portrait_id, target).await;
    });
    Ok(Json(
        json!({"token":token,"state":"uploading","message":"已提交，请等待上传结果"}),
    ))
}

fn target_matches(before: &Artist, after: &Artist) -> bool {
    before.id == after.id
        && before.name == after.name
        && before.mbid == after.mbid
        && before.uploaded_image == after.uploaded_image
        && before.updated_at == after.updated_at
        && before.image_hash == after.image_hash
}

async fn run_sync(state: AppState, token: Uuid, id: Uuid, target: Artist) {
    let result:Result<(String,String,Value),ApiError> = async {
        let client=state.portraits.navidrome().map_err(bad)?;
        let current=client.get_artist(&target.id).await.map_err(nd_error)?;
        if !target_matches(&target,&current) {return Err(ApiError::conflict("目标歌手或头像在预览后已变化，未上传，请重新预览"));}
        let bytes=read_bytes(&state,id,false).await?;
        match client.upload_image(&target.id,bytes).await {
            Ok(upload) => {
                let readback=client.get_artist(&target.id).await;
                let observed=readback.as_ref().ok().is_some_and(|artist| {
                    artist.uploaded_image.as_ref().is_some_and(|image|!image.is_empty())
                    && (artist.uploaded_image!=target.uploaded_image || artist.updated_at!=target.updated_at || artist.image_hash!=target.image_hash)
                });
                Ok(("uploaded".into(), if observed {"Navidrome 已确认上传，回读头像记录有变化；客户端图片缓存可能稍后刷新".into()} else {"Navidrome 已确认上传；回读头像记录尚未变化，请在 Navidrome 刷新查看".into()},json!({"uploaded":upload.uploaded,"target_id":target.id,"target_record_changed":observed})))
            }
            Err(error) => Ok((if error.outcome_uncertain(){"uncertain"}else{"failed"}.into(),error.to_string(),json!({"target_id":target.id,"uploaded":if error.outcome_uncertain(){Value::Null}else{json!(false)}}))),
        }
    }.await;
    let (status, message, result) = match result {
        Ok(result) => result,
        Err(error) => (
            "failed".into(),
            error.detail_text(),
            json!({"uploaded":false}),
        ),
    };
    // Only retry the idempotent database finalization, never the remote upload.
    for delay_ms in [0, 200, 500] {
        if delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        if sqlx::query("UPDATE artist_portrait_syncs SET state=$2,message=$3,result=$4,updated_at=now() WHERE token=$1 AND state='uploading'")
            .bind(token).bind(&status).bind(&message).bind(SqlJson(&result)).execute(&state.db).await.is_ok() {
            return;
        }
    }
    tracing::error!("歌手头像同步结果未能持久化，请在 Navidrome 核对，不要重复提交");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_identity_and_artwork_changes_invalidate_preview() {
        let artist: Artist =
            serde_json::from_value(json!({"id":"a","name":"歌手","updatedAt":"old"})).unwrap();
        let mut other = artist.clone();
        other.album_count = 200;
        assert!(target_matches(&artist, &other));
        other.uploaded_image = Some("new".into());
        assert!(!target_matches(&artist, &other));
        other = artist.clone();
        other.name = "同名另一位".into();
        assert!(!target_matches(&artist, &other));
        other = artist.clone();
        other.updated_at = Some("new".into());
        assert!(!target_matches(&artist, &other));
    }
}
