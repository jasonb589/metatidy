# metatidy Rust 后端镜像
#
# 全部用 rustls：不需要系统 OpenSSL，运行镜像可以保持极干净。
# 目标产物：单二进制 + debian-slim 底 → 镜像约 90MB，常驻内存约 20MB。
# 相比 Python 版的关键差别：**源码不进镜像**（只有编译后的二进制），
# 所以「闭源」和「镜像可匿名拉取」这两件事第一次能同时成立。

FROM rust:1-slim AS builder

WORKDIR /build

# 先只拷清单，让依赖层能被 docker 缓存复用
COPY Cargo.toml ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src

COPY src ./src
COPY migrations ./migrations
# 触碰一下保证重新编译业务代码
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin metatidy \
 && mkdir -p /data /music \
 && chown -R metatidy:metatidy /data /music

COPY --from=builder /build/target/release/metatidy-server /usr/local/bin/metatidy-server

USER metatidy

ENV METATIDY_HOST=0.0.0.0 \
    METATIDY_PORT=8080 \
    METATIDY_MUSIC_DIR=/music \
    METATIDY_LIBRARY_ROOT=/music \
    RUST_LOG=info

VOLUME ["/music"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/metatidy-server", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/metatidy-server"]
