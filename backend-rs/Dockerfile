# metatidy Rust 后端镜像
#
# 设计要点（每一条都是实测踩出来的）：
#
# 1) 全部用 rustls：不需要系统 OpenSSL，运行镜像可以保持极干净。
#    目标产物：单二进制 + debian-slim 底 → 镜像里**没有源码**，
#    所以「闭源」和「镜像可匿名拉取」这两件事第一次能同时成立。
#
# 2) **交叉编译，而不是让 arm64 跑 QEMU**：builder 固定跑在构建机的原生架构上
#    （`--platform=$BUILDPLATFORM`），arm64 用 aarch64 交叉工具链产出。
#    实测：让 arm64 在 QEMU 里直接编 300 个 crate，单次构建跑满一小时还没编完；
#    交叉编译后同一份产物只要几分钟。
#
# 3) 构建上下文是**仓库根**（CI 里 `context: .` + `file: backend-rs/Dockerfile`），
#    因为运行镜像还要带上无构建前端 app/static，它不在 backend-rs/ 下。
#
# 4) Cargo.lock 必须拷进来：没有它 cargo 会各自解析一遍依赖，镜像不可复现。
#
# 5) 用 `[profile.docker]`（关 LTO、放开 codegen-units、opt-level=2）：
#    镜像里的瓶颈是 IO 不是 CPU，但编译时长直接影响 CI 分钟数。

FROM --platform=$BUILDPLATFORM rust:1-slim AS builder
WORKDIR /build
ARG TARGETARCH

# arm64 才需要的交叉工具链（amd64 不装，省时间）
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
      && rm -rf /var/lib/apt/lists/* \
      && rustup target add aarch64-unknown-linux-gnu; \
    fi

# ring / cc 这类带 C 代码的 crate 要按目标架构挑交叉编译器
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar

# 先只拷清单，让依赖层能被 docker 缓存复用
COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
 && cargo build --profile docker $([ "$TARGETARCH" = "arm64" ] && echo --target aarch64-unknown-linux-gnu) \
 && rm -rf src

COPY backend-rs/src ./src
COPY backend-rs/migrations ./migrations

# 触碰一下保证重新编译业务代码（依赖层已缓存），并把二进制按架构摆到统一位置
RUN touch src/main.rs \
 && cargo build --profile docker $([ "$TARGETARCH" = "arm64" ] && echo --target aarch64-unknown-linux-gnu) \
 && mkdir -p /out \
 && if [ "$TARGETARCH" = "arm64" ]; then \
      cp target/aarch64-unknown-linux-gnu/docker/metatidy-server /out/metatidy-server; \
    else \
      cp target/docker/metatidy-server /out/metatidy-server; \
    fi \
 && /out/metatidy-server --version 2>/dev/null || true

FROM debian:bookworm-slim

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin metatidy \
 && mkdir -p /data /music \
 && chown -R metatidy:metatidy /data /music

COPY --from=builder /out/metatidy-server /usr/local/bin/metatidy-server

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
