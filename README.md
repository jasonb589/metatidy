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
- 浏览、搜索、过滤、排序**全部只查 SQLite**（WAL 模式），音频文件一个都不碰。
- 列表接口不返回封面二进制；封面走独立接口并在磁盘缓存缩略图。
- 扫描 / 批量刮削 / 整理移动都是后台任务，进度写库、前端轮询，HTTP 请求永不阻塞。
- 每个数据源独立线程 + 独立超时，慢源最多拖 20 秒，不影响其它源出结果。

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
> 但请注意：**Python 镜像里一定包含源码**（可反编译），公开镜像等于公开源码。

### docker compose（推荐）

```bash
git clone https://github.com/jasonb589/metatidy.git   # 或者自己写一份 compose
cd metatidy
# 编辑 docker-compose.yml，把 ./music 换成你的真实音乐目录
docker compose up -d
```

### docker run

```bash
docker run -d --name metatidy \
  -p 8080:8080 \
  -v /你的/音乐目录:/music \
  -v /你的/数据目录:/data \
  -e METATIDY_SCAN_WORKERS=4 \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/jasonb589/metatidy:latest
```

打开 `http://<主机IP>:8080/`。

- `/music`：要扫描和整理的库，**需要读写权限**（写标签、移动文件）。
- `/data`：索引库、缩略图缓存、任务记录。删掉它就等于清空索引（不会碰音乐文件）。
- 首次进入界面点「扫描库」。一万首以内通常几分钟；之后每次都是增量。

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
| `METATIDY_MUSIC_DIR` | `/music` | 音乐库根目录（扫描范围） |
| `METATIDY_DATA_DIR` | `/data` | 索引与缓存目录 |
| `METATIDY_LIBRARY_ROOT` | 同 `METATIDY_MUSIC_DIR` | 整理移动的库根（可在界面里改） |
| `METATIDY_HOST` / `METATIDY_PORT` | `0.0.0.0` / `8080` | 监听地址与端口 |
| `METATIDY_SCAN_WORKERS` | `4` | 扫描并发（机械硬盘用 2，NVMe 可 8） |
| `METATIDY_LOG_LEVEL` | `info` | 日志级别 |

用户可改的设置（目录模板、冲突策略、默认数据源、别名库等）存在 `/data/metatidy.db` 里，重启不丢。

---

## 本地开发

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows；Linux/macOS 用 source .venv/bin/activate
pip install -r requirements.txt pytest httpx

# 指向一个小目录试跑，别一上来就指整个库
export METATIDY_MUSIC_DIR=/path/to/test-library   # Windows: $env:METATIDY_MUSIC_DIR="..."
export METATIDY_DATA_DIR=./data
python -m app.cli --port 8080
```

跑测试：

```bash
pytest -q                        # 全部（含真实联网的数据源用例）
METATIDY_OFFLINE=1 pytest -q     # 只跑离线用例，CI 的阻断门禁用这个
```

测试不需要任何真实音乐文件：`tests/audiofix.py` 会现场合成最小的合法 FLAC 与 MP3
（仅 STREAMINFO 的 FLAC、静音 MPEG 帧的 MP3），标签读写、扫描、整理移动全部可离线验证。

---

## 项目结构

```
app/
  main.py          HTTP 接口（三个功能的路由都在这里）
  db.py            SQLite 索引层（WAL + 分页 + 任务 + 整理计划）
  index.py         增量扫描器（mtime+size 跳过未变动文件）
  tagio.py         标签读写（mp3/flac/m4a/ogg-opus，含 preview 差异计算）
  scrapebridge.py  多源搜索编排（并发、超时、打分、结果归一化）
  templates.py     目录/文件名模板引擎
  mover.py         整理移动执行器（预览 + 安全搬运）
  language.py      从路径推断语言
  normalize.py     多歌手归一化（& 规则）
  jobs.py          后台任务与进度
  static/          无构建前端（原生 HTML/CSS/JS，完全离线可用）
metatidy_core/     从既有产线项目迁移的 13 个数据源实现（已剥离 GUI 依赖）
tests/             79 个用例
```

前端是**零构建**的原生实现：没有 npm、没有 CDN、没有打包步骤，镜像断网也能正常用。

---

## 构建与发布

推到 `main` 或打 `v*` 标签，GitHub Actions 会：先跑离线测试（阻断门禁）→ 再构建
`linux/amd64` + `linux/arm64` 双架构镜像 → 推送到 `ghcr.io/jasonb589/metatidy`。

标签规则：`latest`（默认分支）、`sha-xxxxx`、以及打 tag 时的语义化版本号。

镜像可见性跟着仓库走（私有仓库 → 私有包），要公开需到 Package settings 手动改。

想同时发 Docker Hub，在 `.github/workflows/ci.yml` 里加一次 `docker/login-action` +
把 `images:` 换成多行即可，其余不变。

---

## 已知限制

- 支持写标签的格式：**mp3 / flac / m4a / ogg(oga/opus)**。wav/aiff/wma/ape 不写。
- 部分细节字段（碟号 `TPOS`、版权 `TCOP`）某些源拿不到，会留空而不是瞎填。
- 网易云 / QQ音乐有风控，高峰期可能返回空——不会影响其它源，界面上会显示每个源的状态。
- 语言兜底只认「已知语言目录名」，自造目录名不会被当成语言（宁可不猜）。
- 服务本身没有账号体系，**不要直接暴露到公网**；放在内网或前面套一层带认证的反代。

---

## 版权

闭源项目，保留所有权利。未经授权请勿复制、分发或用于商业用途。
