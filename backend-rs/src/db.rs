//! Postgres 连接池与迁移。
//!
//! 与 Python 版最大的结构差异：这里是一等公民的 Postgres + 连接池，
//! 不再需要「每线程一个连接 + 全局写锁」那套 SQLite 妥协。

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tracing::info;

use crate::config::Config;

pub async fn connect_and_migrate(config: &Config) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .min_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect(&config.database_url)
        .await
        .with_context(|| {
            format!(
                "连接 Postgres 失败：{}（检查 DATABASE_URL 与服务是否已就绪）",
                redact(&config.database_url)
            )
        })?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("执行数据库迁移失败")?;

    // 上一次进程可能是被强杀的（容器重启/重新部署）：把还挂在 queued/running 的任务
    // 标成中断，否则界面上会永远挂着一个「正在跑」的僵尸任务（实测踩过）。
    if let Err(err) = sqlx::query(
        "UPDATE jobs SET state = 'error', message = '容器重启导致任务中断', \
         error = '容器重启导致任务中断', updated_at = now() \
         WHERE state IN ('queued', 'running')",
    )
    .execute(&pool)
    .await
    {
        tracing::warn!("清理中断任务失败（不影响启动）：{err}");
    }

    let version: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| "unknown".to_string());
    info!("Postgres 已连接并完成迁移：{}", version.lines().next().unwrap_or(""));

    Ok(pool)
}

/// 打日志时不要把密码打出来。
pub fn redact(url: &str) -> String {
    match (url.find("://"), url.rfind('@')) {
        (Some(scheme), Some(at)) if at > scheme => {
            let head = &url[..scheme + 3];
            let tail = &url[at..];
            format!("{head}***{tail}")
        }
        _ => url.to_string(),
    }
}
