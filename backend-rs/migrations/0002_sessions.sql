-- 登录会话（`METATIDY_PASSWORD` 密码登录）
--
-- 设计说明：
-- - token 是 32 字节随机数的十六进制串，**只存在服务端**；浏览器 Cookie 里放的就是它本身
--   （HttpOnly，JS 读不到）。这样不需要引入 HMAC/签名依赖，重启容器也不丢登录态。
-- - 存 Postgres 而不是 Redis：认证不该依赖缓存层；Redis 挂了顶多丢任务进度，不该把人锁在门外。
-- - 退出登录 = 删这一行，是真正的撤销（无状态签名 Cookie 做不到）。
-- - 过期行在每次成功登录时顺手清一次，不需要额外定时任务。

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT        PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    user_agent  TEXT        NOT NULL DEFAULT ''
);

-- 清理过期行用（`WHERE expires_at < now()`）
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
