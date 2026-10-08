# metatidy Rust 后端镜像
#
# 全部用 rustls：不需要系统 OpenSSL，运行镜像可以保持极干净。
# 目标产物：单二进制 + debian-slim 底 → 镜像约 90MB，常驻内存约 20MB。
# 相比 Python 版的关键差别：**源码不进镜像**（只有编译后的二进制），
# 所以「闭源」和「镜像可匿名拉取」这两件事第一次能同时成立。

FROM rust:1-slim AS builder

WORKDIR /build

# 先只拷清单，让依赖层能被 docker 缓存复用。
# 构建上下文是**仓库根**（CI 里 `context: .` + `file: backend-rs/Dockerfile`），
# 因为镜像还要带上无构建前端 app/static（见下面运行阶段）。
# Cargo.lock 必须拷进来：没有它 cargo 会各自解析一遍依赖，镜像不可复现。
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src

COPY backend-rs/src ./src
COPY backend-rs/migrations ./migrations

# 触碰一下保证重新编译业务代码（依赖层已在上一步缓存好）
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin metatidy \
 && mkdir -p /data /music \
 && chown -R metatidy:metatidy /data /music

COPY --from=builder /build/target/release/metatidy-server /usr/local/bin/metatidy-server

# 无构建前端：与 Python 版同一套 app/static，内容一个字节都不改
COPY app/static /app/static

USER metatidy

ENV METATIDY_HOST=0.0.0.0 \
    METATIDY_PORT=8080 \
    METATIDY_MUSIC_DIR=/music \
    METATIDY_LIBRARY_ROOT=/music \
    METATIDY_STATIC_DIR=/app/static \
    METATIDY_DATA_DIR=/data \
    RUST_LOG=info

VOLUME ["/music"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/metatidy-server", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/metatidy-server"]
