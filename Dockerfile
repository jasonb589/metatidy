# metatidy —— 轻量音乐元数据工作台（单镜像部署）
#
# 设计说明：
# - 基础镜像用 python:3.12-slim，和本地验证过的解释器版本一致
# - 依赖单独一层：改业务代码时不会重装依赖，构建更快
# - 非 root 运行；/music 与 /data 是仅有的两个需要挂载的位置
# - 镜像不含 any 缓存/测试文件，体积尽量小

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    METATIDY_MUSIC_DIR=/music \
    METATIDY_DATA_DIR=/data \
    METATIDY_HOST=0.0.0.0 \
    METATIDY_PORT=8080 \
    METATIDY_SCAN_WORKERS=4

WORKDIR /app

# 1) 依赖层（只在 requirements.txt 变化时重建）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 2) 代码层
COPY app ./app
COPY metatidy_core ./metatidy_core

# 3) 运行用户与目录权限
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin metatidy \
 && mkdir -p /data /music \
 && chown -R metatidy:metatidy /data /music /app
USER metatidy

VOLUME ["/music", "/data"]
EXPOSE 8080

# 健康检查：打自己的状态接口，容器编排能自动重启坏实例
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/status', timeout=5).status == 200 else 1)"

CMD ["python", "-m", "app.cli", "--host", "0.0.0.0", "--port", "8080"]
