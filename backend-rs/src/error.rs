//! 统一错误类型：把底层错误转成 HTTP 响应，前端拿到的永远是 `{"detail": "..."}`。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误：{0}")]
    Db(#[from] sqlx::Error),

    #[error("Redis 错误：{0}")]
    Redis(#[from] redis::RedisError),

    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(#[from] anyhow::Error),

    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    NotFound(String),
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // 先按引用取状态码，再取消息（self 会被消费）
        let status = match &self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let detail = self.to_string();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!("请求失败：{detail}");
        }
        (status, Json(json!({ "detail": detail }))).into_response()
    }
}
