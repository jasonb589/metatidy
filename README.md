# metatidy

轻量音乐元数据工作台。只做三件事，并且把这三件事做快：

1. **元数据编辑** —— 浏览/检索全库，改字段前先看差异，确认后才落盘；支持批量。
2. **元数据搜索（刮削）** —— 一个入口并行查 13 个数据源，候选按分数排序、逐字段挑选写入。
3. **按目录层级整理移动** —— 用可配置模板（`{语言}/{歌手}/{专辑}/{曲序} - {标题}`）生成计划，预览确认后才动文件。

Web 界面，单容器部署，适合放在 NAS / 小主机上长期跑。

---

## 为什么它不卡

同类工具卡在「每次打开列表都去读音频文件」。metatidy 的做法是**索引优先**：

- 扫描只做一次，之后按 `mtime + size` **增量**跳过未变动文件；解析多线程、写入单线程。
- 浏览、搜索、过滤、排序**全部只查 PostgreSQL**（`pg_trgm` 索引），音频文件一个都不碰。
- 有个**快速扫描**模式：只从目录结构建索引、完全不打开文件。云盘上「首次读标签约 10 秒/文件」，
  一万首要 20 多小时；快速扫描下先出列表，等你真要编辑某几首时只读那几首。
  界面上就是「扫描曲库」旁边那个 **快速扫描** 勾选框（勾上后「全量重扫」自动失效）；
  也可以直接打接口：`curl -X POST http://<主机>:8080/api/scan -H 'Content-Type: application/json' -d '{"fast":true,"prune":true}'`。
- 列表接口不返回封面二进制；封面走独立接口并在磁盘缓存缩略图。
- 扫描 / 批量刮削 / 整理移动都是后台任务：任务行落 PostgreSQL，实时进度写 Redis，
  前端轮询，HTTP 请求永不阻塞。
- 每个数据源独立并发 + 独立超时（整源 20 秒上限），慢源不影响其它源出结果。

两万首规模下列表翻页与搜索基本无感。

---

## 快速开始（Docker）

> **注意：仓库是私有的，所以 GHCR 上的镜像默认也是私有的。** 拉取前需要登录一次：
>
> ```bash
> echo "<你的 GitHub PAT，需勾选 read:packages>" | docker login ghcr.io -u jasonb589 --password-stdin
> ```
>
> 想让别人匿名拉取，去 GitHub → Packages → metatidy → Package settings 把可见性改成 Public。
> 后端是 Rust 的编译产物，**镜像里只有二进制、没有源码**，所以「闭源」和「镜像可匿名拉取」
> 这两件事第一次可以同时成立（Python 版做不到这点）。

### docker compose（推荐）

```bash
git clone https://github.com/jasonb589/metatidy.git   # 或者自己写一份 compose
cd metatidy
# 编辑 docker-compose.yml：把 ./music 换成你的真实音乐目录；生产环境记得改掉 postgres 默认密码
docker compose up -d
```

compose 里已经带上两个依赖服务，不用你另外装：

- `postgres`：索引本体（曲目、任务、整理计划、设置、别名库），数据落在宿主的 `./pgdata`。
- `redis`：后台任务的实时进度（键 `metatidy:job:{id}`，TTL 7 天），数据落在 `./redisdata`。

### docker run（单容器，Postgres 与 Redis 自己准备）

```bash
docker run -d --name metatidy \
  -p 8080:8080 \
  -v /你的/音乐目录:/music \
  -v /你的/缓存目录:/data \
  -e DATABASE_URL="postgres://user:pass@你的PG:5432/metatidy" \
  -e REDIS_URL="redis://你的Redis:6379" \
  -e METATIDY_SCAN_WORKERS=4 \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/jasonb589/metatidy:latest
```

打开 `http://<主机IP>:8080/`。界面右上角有**浅色 / 深色**切换，默认跟随系统，手动切过一次后会记住。

### 在 Arcane / Portainer 里显示图标

镜像里带了图标（就是界面那个 favicon，`app/static/icon.svg`）。**直接指向你自己的服务即可**，不依赖任何外部地址：

```yaml
services:
  metatidy:
    labels:
      # 换成你的 NAS 局域网地址 + 你映射的端口（例如映射的是 8286:8080 就写 :8286）
      com.getarcaneapp.arcane.icon: "http://192.168.1.10:8286/icon.svg"
```

- Arcane 认的键是 `com.getarcaneapp.arcane.icon`（另有 `-light` / `-dark` 变体）；也可以在 compose 里用项目级块 `x-arcane: { icon: "…" }`。
- 图标 URL 是**浏览器**去加载的，所以用局域网地址就行；只有想让公网也能看到时才需要图床或公开仓库（本仓库是私有的，raw 链接匿名取不到）。

- `/music`：要扫描和整理的库，**需要读写权限**（写标签、移动文件）。
- `/data`：封面与缩略图缓存（索引在 Postgres 里，不在这）。
- 首次进界面点「扫描库」。云盘用户建议先用界面上的**快速扫描**：只从目录结构建索引，
  一万首约 24 秒，之后再按需读某几首的真实标签。

---

## 三个功能怎么用

### 1. 元数据编辑

搜索/过滤定位曲目 → 勾选（可多选）→ 在编辑面板里**只填想改的字段**（留空表示不改）→
点「预览变更」看逐字段的 `旧值 → 新值` → 确认后「写入」。

- 多歌手会自动归一：`周杰伦/费玉清`、`A feat. B`、`周杰伦 五月天` 全部变成 `A & B`（可关）。
- 别名库会在写入前套用（比如把 `周杰伦` 统一成 `Jay Chou`）。
- 「覆盖已有值」关掉时，已有非空字段不会被改写。

### 2. 元数据搜索（刮削）

选中曲目 → 勾选数据源 → 「搜索候选」。每个源给出它认为最匹配的一条，按分数合并排序。

- 置信度：**高** ≥120 分 / **中** ≥70 分 / **待确认** 其余（含标题、歌手、时长、专辑类型、翻唱/伴奏惩罚）。
- 勾选要写入的字段（也可以只写标题、或只下封面）→ 写入前仍然展示差异。
- 批量刮削：勾选多首 + 设「自动写入最低分」（填 0 则只搜索不写，人工复核）。

### 3. 按目录层级整理移动

在「整理移动」页配置两个模板：

| 模板 | 例子 |
| --- | --- |
| 目录层级 | `{language?}/{artist}/{album}` |
| 文件名 | `{track:02} - {title}` |

可用占位符（界面里点一下就插入）：

| 占位符 | 含义 | 占位符 | 含义 |
| --- | --- | --- | --- |
| `{artist}` | 歌手（已用 ` & ` 连接） | `{track}` | 音轨号，`{track:02}` 补零 |
| `{albumartist}` | 专辑艺术家 | `{disc}` | 碟号 |
| `{album}` | 专辑名 | `{year}` | 年份，`{year:4}` 截取 |
| `{title}` | 歌曲名 | `{genre}` | 流派 |
| `{language}` | 语言 | `{albumtype}` | 专辑类型 |
| `{mb_artist_id}` | MusicBrainz 歌手 ID | `{original}` | 原名（不含扩展名） |
| `{release_group_id}` | 发行组 ID | `{ext}` | 扩展名（不含点） |

**空值规则**：

- `{artist}` `{albumartist}` `{album}` `{title}` `{genre}` 为空时回退成设置里的文案（默认「未知艺术家 / 未知专辑 / 未知」），保证文件不会散落在库根目录。
- `{language}` `{albumtype}` `{year}` `{track}` `{disc}` 为空时**整段丢弃**，不会产生 `未知/` 空目录。
- 任意占位符都能写成 `{字段?}`，表示「为空就整段丢弃」，例如 `{language?}`。

**语言兜底**：如果标签里没有 `language`，会自动用「库根下第一层目录名」推断
（`.../【Music】/俄文/ADÉLA/PRIMA/x.flac` → `俄文`），只认已知语言名，拿不准就留空。
这样按 `{language}` 整理时不会把已有的语言目录压平。

**冲突策略**（目标已存在时）：

- `rename`（默认）自动改名 `歌名 (2).ext`，绝不覆盖。
- `skip` 跳过该文件。
- `overwrite` 覆盖目标。

**安全保证**：

- 先「仅演练」确认计划，再「确认执行」；执行用一次性 token，同一计划不能重复执行。
- 目标路径必须落在库根目录内，越界项直接标为 `invalid` 且不执行。
- 同计划内两首歌撞同一目标会自动错开，不会互相覆盖。
- 跨磁盘/云盘搬运时先复制、校验字节数一致，才删除源文件；任何异常都**保留源文件**并把失败明细列出来。
- 索引里的路径会随文件移动同步更新。

---

## 数据源

13 个源，只有 4 个需要密钥，**不配也不影响其余源**。

| 源 | 需要密钥 | 环境变量 |
| --- | --- | --- |
| MusicBrainz + Cover Art Archive | 否 | — |
| iTunes（US/CN/TW/HK 四个地区入口） | 否 | — |
| Deezer | 否 | — |
| 网易云音乐 | 否 | — |
| QQ音乐 | 否 | — |
| 酷狗音乐 | 否 | — |
| 酷我音乐 | 否 | — |
| TheAudioDB | 否 | — |
| YouTube Music | 否 | — |
| Last.fm | 是 | `LASTFM_API_KEY` |
| Spotify | 是 | `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` |
| Genius | 是 | `GENIUS_TOKEN` |
| Discogs | 是 | `DISCOGS_TOKEN` |

另外 `SILICONFLOW_KEY` 可选，配了才启用 AI 辅助（语言判定、文件名解析等）。

> 网易云 / QQ音乐是逆向接口，有风控风险：请求已做限速、缓存与降级。
> MusicBrainz 严格要求 ≤1 请求/秒，代码里已内置限速器。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 无（**必须给**） | PostgreSQL 连接串，如 `postgres://metatidy:metatidy@postgres:5432/metatidy` |
| `REDIS_URL` | 无（可选） | Redis 连接串；不配也能跑，只是任务进度只落数据库、不进 Redis |
| `METATIDY_MUSIC_DIR` | `/music` | 音乐库根目录（扫描范围） |
| `METATIDY_LIBRARY_ROOT` | 同 `METATIDY_MUSIC_DIR` | 整理移动的库根（可在界面里改） |
| `METATIDY_DATA_DIR` | `/data` | 封面/缩略图缓存目录（索引在 Postgres，不在这） |
| `METATIDY_STATIC_DIR` | 自动探测 | 前端静态文件目录（镜像里已设为 `/app/static`） |
| `METATIDY_HOST` / `METATIDY_PORT` | `0.0.0.0` / `8080` | 监听地址与端口 |
| `METATIDY_SCAN_WORKERS` | `4` | 扫描并发（机械硬盘用 2，NVMe 可 8） |
| `RUST_LOG` | `info` | 日志级别（`METATIDY_LOG_LEVEL` 也兼容） |
| `METATIDY_PASSWORD` | 无（**强烈建议设**） | 访问口令。设了就启用密码登录；不设则整个界面完全开放（同网段谁都能改你的标签、移动你的文件） |
| `METATIDY_SESSION_DAYS` | `30` | 登录会话有效期（天），到期后需重新登录 |
| `METATIDY_COOKIE_SECURE` | 关 | 给会话 Cookie 加 `Secure`；只在走 HTTPS/反代时打开（http 访问打开会登不进去） |
| `METATIDY_TRUST_PROXY` | 关 | 信任 `X-Forwarded-For`：反代后面限速才按真实客户端 IP 算（**默认不信**，否则谁都能伪造这个头绕过限速） |

用户可改的设置（目录模板、冲突策略、默认数据源）与别名库存在 PostgreSQL 里，重启不丢。


## 登录保护（`METATIDY_PASSWORD`）

**不设这个变量，界面就是完全开放的**：任何能连到你 NAS 端口的人都能改标签、按模板移动文件
（后者不可撤销）。设了它就启用密码登录：

- 打开界面先弹登录框，**通过之前前端一个数据请求都不发**（不会先闪一屏空表格）；
- 口令对了下发 HttpOnly 会话 Cookie（`metatidy_session`），默认有效期 30 天；
- 会话存在 PostgreSQL 的 `sessions` 表里 —— 所以**退出登录是真的撤销**（删行），重启容器也不丢登录态；
- 连错 5 次锁 5 分钟（按来源 IP 计数，成功登录即清零）；
- 顶栏显示登录状态；没设口令时显示红色的「未设密码」提醒。

几个刻意的取舍：

| 行为 | 原因 |
| --- | --- |
| `/api/health` 保持匿名可用 | 否则容器探针与 `--healthcheck` 会把一个健康实例判死 |
| 静态 HTML/JS 不拦，数据全在 `/api/*` 后面 | 未登录拿到的是空壳界面 + 登录框，页面本身不含任何数据 |
| Cookie 默认不带 `Secure` | 家用场景基本是局域网 http，带上反而登不进去；走 HTTPS 时设 `METATIDY_COOKIE_SECURE=1` |
| 口令在内存里定长比较，不存哈希 | 口令只存在于容器环境变量，没有落盘的哈希可存；比较用定长实现，避开时序侧信道 |
| 认证不依赖 Redis | Redis 挂了顶多丢任务进度，不该把人锁在门外 |

> Python 版（`app/`）保留为契约参考实现，**没有**这层登录保护；线上跑的是 Rust 版。
---

## 本地开发

Rust 后端（需要 Rust 1.80+；依赖服务用容器起最省事）：

```bash
docker compose up -d postgres redis      # 只起依赖，不跑应用
export DATABASE_URL="postgres://metatidy:metatidy@127.0.0.1:5432/metatidy"
export REDIS_URL="redis://127.0.0.1:6379"
export METATIDY_MUSIC_DIR=/path/to/test-library   # 指向小目录试跑，别一上来就指整库
cargo run --manifest-path backend-rs/Cargo.toml --release
```

自检与测试（都不需要真实音乐文件，真实音频样本由 ffmpeg 现场生成）：

```bash
cd backend-rs
cargo test --release                       # 单元测试：打分表/模板/移动安全底线/标签读写…
cargo run --release -- --selftest          # 真 Postgres + 真 Redis + 真实 HTTP + lofty
cargo run --release -- --selftest-index    # 扫描/增量/语言推断/标签落盘/整理移动/快速扫描
cargo run --release -- --selftest-scrape   # 真实联网：4 个源 + 歌词 + 封面
```

端到端验收（与 Python 版用的是**同一套检查**；脚本会自己起服务）：

```bash
# 验收 Rust 二进制
E2E_SERVER_CMD="./backend-rs/target/release/metatidy-server" METATIDY_PORT=8097 \
  python tests/e2e_acceptance.py "$PWD" /tmp/metatidy-e2e

# 不设 E2E_SERVER_CMD 则用 Python 版（python -m uvicorn app.main:app）
python tests/e2e_acceptance.py "$PWD" /tmp/metatidy-e2e
```

---

## 项目结构

```
backend-rs/           Rust 后端（现役，镜像就是它编译出来的）
  src/main.rs         启动、环境变量、三个自检入口
  src/api/            HTTP 路由（21 条）与请求/响应形状
  src/jobs.rs         后台任务：任务落 Postgres，实时进度写 Redis
  src/repo.rs         PostgreSQL 访问层（运行时 query，不用编译期宏）
  src/scanner.rs      增量扫描 + 快速（仅路径）扫描
  src/tagio.rs        标签读写（lofty：mp3/flac/m4a/ogg/opus + 预览差异）
  src/scrapers.rs     13 个数据源 + 打分 + 歌词 + 封面
  src/mover.rs        整理移动（预览 + 安全底线，失败绝不删源）
  src/templates.rs    目录/文件名模板引擎
  src/language.rs     从路径推断语言
  src/normalize.rs    多歌手归一化（& 规则）
  migrations/         Postgres 建表与索引
  Dockerfile          镜像定义（构建上下文是仓库根，因为要带 app/static）
app/                  Python 版本：**参考实现**，接口契约以它为准（镜像已不再用它）
  static/             无构建前端（原生 HTML/CSS/JS，完全离线可用；两个版本共用）
metatidy_core/        Python 版的数据源实现（从既有产线项目迁移，已剥离 GUI 依赖）
tests/                Python 单元测试 + e2e_acceptance.py（端到端验收脚本）
```

前端是**零构建**的原生实现：没有 npm、没有 CDN、没有打包步骤，镜像断网也能正常用。

---

## 构建与发布

推到 `main` 或打 `v*` 标签，GitHub Actions 会依次：单元测试 + 三个自检 + **端到端验收**
（打真实二进制，带真 Postgres / Redis / 真实数据源）→ 构建 `linux/amd64` + `linux/arm64`
双架构镜像 → 推送到 `ghcr.io/jasonb589/metatidy`。

镜像用 `backend-rs/Dockerfile` 构建：里面**只有编译后的二进制**与无构建前端，没有源码；
依赖版本由 `backend-rs/Cargo.lock` 固定，构建可复现。

标签规则：`latest`（默认分支）、`sha-xxxxx`、以及打 tag 时的语义化版本号。
镜像可见性跟着仓库走（私有仓库 → 私有包），要公开需到 Package settings 手动改。

想同时发 Docker Hub，在 `.github/workflows/ci.yml` 里加一次 `docker/login-action` +
把 `images:` 换成多行即可，其余不变。

---

## 已知限制

- 支持写标签的格式：**mp3 / flac / m4a / ogg(oga/opus)**。wav/aiff/wma/ape 不写。
  mp3 与 flac 的写入路径有真实样本的自动化测试；m4a/ogg 目前没有样本，属**未验证**。
- 部分细节字段（碟号 `TPOS`、版权 `TCOP`）某些源拿不到，会留空而不是瞎填。
- 数据源现状（都是**实测**结论，不是推测）：
  - 直接可用：MusicBrainz、iTunes（4 区）、网易云、QQ音乐、酷狗、酷我、Deezer、TheAudioDB。
  - Last.fm：内置 key 已被上游吊销（HTTP 403），要用请自备 `LASTFM_API_KEY`。
  - TheAudioDB：上游没有中文曲库数据，中文歌只能靠其它源。
  - 需自备 key：Spotify / Genius / Discogs；YouTube Music 未实现（Python 版依赖的可选库本来也拿不到结果）。
  - 酷我的封面 URL 在上游普遍 404，它的候选可能没有封面。
- 语言兜底只认「已知语言目录名」，自造目录名不会被当成语言（宁可不猜）。
- 服务本身没有账号体系，**不要直接暴露到公网**；放在内网或前面套一层带认证的反代。

---

## 版权

闭源项目，保留所有权利。未经授权请勿复制、分发或用于商业用途。
