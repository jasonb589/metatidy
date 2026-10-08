# PORT_NOTES — metatidy_core 迁移说明

从桌面项目（PySide6/QML）的 `media_toolkit.py`（12072 行）与 `module_backends.py`（6703 行）
中抽取「音乐元数据刮削 + 标签读写」纯逻辑，剥离 GUI，形成本独立包。

源码行号均指 `D:\codex\脚本整合\media_toolkit.py`（该文件只读，未做任何修改）。

## 1. 文件与源码对照

| 新文件 | 行数 | 主要来源（源码行号） |
| --- | --- | --- |
| `metatidy_core/__init__.py` | 123 | 新写（对外出口 + 用法示例） |
| `metatidy_core/config.py` | 260 | 185-295（HEADERS / MUSIC_HEADERS / `_load_api_key` / `_load_setting` / `configure_music_providers`） |
| `metatidy_core/normalize.py` | 1213 | 324-522（语种/国籍库/流派表）、1066-1220（显示名/版本尾巴）、1695-1760（缓存/简繁）、1753-2302（署名归一/文件名/模糊匹配/时长）、4006-4098（标题词元/上下文）、1343-1372（粗归一） |
| `metatidy_core/scrapers.py` | 2795 | 594-763（重试/熔断/缓存）、2963-3836（13 个搜索函数）、3840-4003（增强元数据）、4047-4560（上下文/评分/歌词）、4866-5030（封面）、5783-5806（发行组标题）、4334-4393（年份补齐） |
| `metatidy_core/tagger.py` | 848 | 1841-1906（歌手标签归一）、1982-2011（发行类型写入）、4866-4873（Vorbis 打开）、4876-4905（读封面）、5257-5463（`update_audio_tags` 主体） |
| `docs/PORT_NOTES.md` | 本文件 | — |

未改动：源码项目任何文件；`module_backends.py` 只读参考（`MusicMetaScraper` 只是编排层，
把 `media_toolkit` 的搜索结果交给 UI 回调，本身没有可搬迁的搜索/标签逻辑）。

## 2. 数据源迁移状态

| # | 源（engine key） | 函数 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 网易云 `Netease` | `search_netease_api` | 完整迁移 | 新版 cloudsearch → 旧版 search 降级分支保留；`timeout=300`、Referer、UA 照抄 |
| 2 | QQ音乐 `QQMusic` | `search_qq_api` | 完整迁移 | 歌名匹配度排序取最佳 |
| 3 | 酷狗 `Kugou` | `search_kugou_metadata_api` | 完整迁移 | search → play/getdata 两跳；`trans_param.publish_time` 年份提取保留 |
| 4 | 酷我 `Kuwo` | `search_kuwo_api` | 完整迁移 | https→http 回退、`jsondata` 正则、ALBUMID 拼封面 |
| 5 | MusicBrainz `MusicBrainz` | `search_musicbrainz_api` | 完整迁移 | official 优先、最早发行排序、发行组类型/歌手国家/MBID/ISRC/format；**新增** 1 req/s 限速（见 §4.2） |
| 6 | iTunes `iTunes_US/CN/TW/HK` | `search_itunes_api` | 完整迁移 | 4 个地区各一个入口；**新增** UA 头（见 §4.1） |
| 7 | Deezer `Deezer` | `search_deezer_api` | 完整迁移 | 命中后补专辑详情的 `timeout=15` 请求保留 |
| 8 | Last.fm `Last.fm` | `search_lastfm_api` | 完整迁移 | 内置免费 Key `2bd6d4b4f7d439b7c41f0fd8b7e3b8e1` 照抄 |
| 9 | TheAudioDB `TheAudioDB` | `search_theaudiodb_api` | 完整迁移 | 内置测试 Key `2`；封面优先级 ThumbHD>Thumb>CDart |
| 10 | Spotify `Spotify` | `search_spotify_api` | 完整迁移（含 token） | Client Credentials + 线程安全自动刷新；缺 Key 直接返回 `None` |
| 11 | Genius `Genius` | `search_genius_api` | 完整迁移 | 需 `GENIUS_ACCESS_TOKEN` |
| 12 | YouTube Music `YouTubeMusic` | `search_ytmusic_api` | 完整迁移 | 依赖可选库 `ytmusicapi`；库缺失时返回 `None`（与源码 `HAS_YTMLIB=False` 一致） |
| 附加 | Discogs `Discogs` | `search_discogs_api` | 完整迁移 | 源码里是第 13 个源（在 `search_best_match_global` 的引擎表里），需 `DISCOGS_TOKEN` |
| 附加 | Cover Art Archive | `cover_art_archive_url` / `fetch_cover_art_archive` | 完整迁移 | 源码只在 MB 结果里拼 URL（3297 行），此处补了下载函数 |
| 附加 | 歌词 `fetch_lyrics` | `fetch_lyrics`（源码名 `global_fetch_lyrics`，另保留同名别名） | 完整迁移 | 网易云 → QQ → LRCLIB → 酷狗，四段评分逻辑照抄 |
| 附加 | AcoustID | — | **源码里没有可迁移的实现** | `ACOUSTID_API_KEY` 只在设置页与日志里出现，没有任何搜索/指纹函数；本包仅保留 Key 配置位与 `source_skip_reason` |

## 3. 标签字段映射

`update_audio_tags` 与源码 `media_toolkit.py:5257-5463` 逐字段一致：

| 字段 | .mp3 (ID3) | .m4a/.mp4 | .flac / .ogg / .oga / .opus |
| --- | --- | --- | --- |
| title | TIT2 | ©nam | title |
| artist | TPE1 | ©ART | artist |
| album | TALB | ©alb | album |
| album_artist | TPE2 | aART | albumartist |
| genre | TCON | ©gen | genre |
| date | TDRC | ©day | date |
| track_num | TRCK | trkn（含 total） | tracknumber |
| composer | TCOM | ©wrt | composer |
| lyricist | TEXT | `----:com.apple.iTunes:LYRICIST` | lyricist |
| language | TLAN | `…:LANGUAGE` | language |
| artist_mbid | TXXX:MusicBrainz Artist Id | `…:MusicBrainz Artist Id` | musicbrainz_artistid |
| release_group_id | TXXX:MusicBrainz Release Group Id | `…:MusicBrainz Release Group Id` | musicbrainz_releasegroupid |
| album_type | TXXX ×4（ALBUMTYPE / Album Type / RELEASETYPE / MusicBrainz Album Type） | `…:ALBUMTYPE / RELEASETYPE / MUSICBRAINZ_ALBUMTYPE` | RELEASETYPE / MUSICBRAINZ_ALBUMTYPE / ALBUMTYPE |
| lyrics | USLT(lang=zho) | ©lyr | lyrics |
| cover | APIC(type=3) | covr | metadata_block_picture |

**源码其实没有写的字段**（任务书里提到，但源码 write 路径不存在，本包照抄「不写」）：

* `TPOS`（碟号）— 只在源码 import 里出现，写入循环没有它；本包只在 `read_audio_tags` 里读 `disc_num`。
* `TCOP`（版权）— 同上，import 里有、从不写；只读。
* `total_tracks` — ID3/Vorbis 路径都不写（TRCK/Vorbis 没有 “/总数” 语义）；只有 m4a 的 `trkn` 带总数。
  实测：mp3 写完后 `read_audio_tags()['total_tracks']` 为 `0`。
* m4a 的 `©wrt` 只在 `composer` 非空时写；`trkn` 只在 `track_num > 0` 时写。
* 空值一律不写（源码用 `if not val: continue`）；`overwrite_existing=True` 且 `lyricist` 为空时，
  源码会顺手 `delall('TEXT')` / `pop('lyricist')`（本包保留该行为，并在预览里体现为 `lyricist: old→''`）。

## 4. 与源码的行为差异（有意为之，逐条说明）

1. **iTunes 增加 User-Agent**：源码 3065 行 `requests.get(...)` 不带任何头，实测 Apple 对匿名请求
   稳定返回 `resultCount=0`（`Jay Chou 稻香`、`稻香 周杰伦` 全部 0 命中），加上公共 UA（`MUSIC_HEADERS`）后
   才能拿到候选。这是让迁移后的函数「真的能用」的最小改动。
2. **MusicBrainz 1 req/s 限速**：源码没有限速（连发会被 MB 限流/封 UA）。本包加
   `RateLimiter(1.0)`（`MUSICBRAINZ_MIN_INTERVAL`），所有 MB 请求走 `_musicbrainz_get()`。
3. **`configure_music_providers` 不再落盘**：源码会写入 `~/.cyber_toolkit_settings.json`；
   库不该改用户家目录，改为仅内存注入。读取顺序不变（内存 → 环境变量 → 配置文件）。
4. **手工别名表只读内存**：源码 `_load_artist_aliases/save_artist_aliases` 会落盘
   `.artist_aliases.json`；本包提供 `normalize.merge_artist_name_aliases({...})` 注入，
   未注入时 `apply_artist_name_alias` 是恒等变换，写入结果与「没配别名」的源码一致。
5. **`langid` 与 `thefuzz` 变成可选依赖**：源码把 `langid` 当硬依赖（缺失直接 `sys.exit(1)`）。
   本包缺失时：`detect_language()` 返回 `None`，`detect_language_smart()` 退回脚本规则后兜底 `'英文'`；
   `is_fuzzy_match()` 走源码本来就有的「首字符+长度」降级分支。
6. **修复 `get_search_info` 的潜在 `NameError`**：源码 2245-2256 行在「非 mp3/flac 文件」或读取异常时
   `tag_artist/tag_title` 未赋值就被引用，会直接抛异常。本包先初始化为 `''`，其余顺序不变。
   第 3 步读标签改用 `mutagen.File(easy=True)`（等价取 artist/title，且覆盖 m4a/ogg）。
7. **缓存/熔断可注入**：源码是模块级全局字典；本包默认仍是进程内内存实现，
   但提供 `set_search_cache()` / `set_circuit_breaker_registry()` 注入点（TTL、容量、淘汰策略与源码一致）。
8. **候选对象**：源码全程传 dict；本包包成 `Candidate`（`@dataclass` + `dict` 子类），
   字段名一个没改，`c.get('title')` / `c['context']=...` 照旧可用，且 `json.dumps(c)` 直接可用。
   新增了 `score` 与 `confidence` 两个派生字段（源码里 `sort_score` 由 `process_single_music_file`
   之后的 module_backends.py:5611 换算置信度）。

## 5. 预览（变更摘要）接口

```python
plan_tag_update(filepath, info, image_data=None, lyrics_text=None,
                overwrite_existing=True, plain_album=None) -> TagUpdatePlan
#   TagUpdatePlan 是 dict 子类，内容就是 {字段: {'old': 旧值, 'new': 新值}}
#   额外属性： .filepath .fmt .info(归一后的写入值) .image_data .lyrics_text
#             .overwrite_existing .skipped{字段:原因} .changed[字段名] .changes

apply_tag_update(plan, filepath=None) -> (success: bool, error_msg: str|None)

update_audio_tags(filepath, info, image_data=None, lyrics_text=None,
                  overwrite_existing=True, plain_album=None, dry_run=False)
#   dry_run=True  → 返回 TagUpdatePlan（不落盘）
#   dry_run=False → 返回 (success, error_msg)，与源码签名/返回值一致

read_audio_tags(filepath) -> dict   # 字段：title/artist/album/album_artist/genre/date/year/
                                    # track_num/total_tracks/disc_num/composer/lyricist/
                                    # language/artist_mbid/release_group_id/album_type/
                                    # copyright/lyrics/has_cover/cover_mime/cover_size/format
```

预览只列出「本次会被写入的字段」（新值为空的不写、不列）；因 `overwrite_existing=False`
而跳过的字段进 `.skipped`。封面与歌词用可 JSON 序列化的一行字表示（如 `<image/jpeg 81234 bytes>`）。
注意：ID3 的 `album_type` 会写 4 个 TXXX 键、m4a 写 3 个 atom，预览按「字段级」给一条摘要（粒度比写入略粗）。

## 6. 未迁移（明确排除）

| 类别 | 具体内容（源码位置） | 原因 |
| --- | --- | --- |
| GUI | `LoggedFrame` / 各 `*Frame` / `MediaToolkitApp`（6517 行起）、`CyberConfirmDialog`、`CyberMessageDialog`、`MetadataReviewWindow`、`ActorFixerEngine` 的 UI 部分 | 任务要求零 GUI 依赖 |
| 编排层 | `process_single_music_file`（6145）、`normalize_library_names`、`unify_album_identity`、`upgrade_album_covers` | 含进度回调/文件移动/停批事件，属上层流程；本次只搬纯逻辑 |
| 封面协调 | `MusicAlbumCoverCoordinator`（5033）、`cover_similarity`（5201）、`_read_cover_entry`/`_refresh_cover_file`/`_write_cover_only` | 依赖批次内状态与文件系统副作用 |
| 增量刮削 | `_scrape_registry` / `is_already_scraped` / `mark_as_scraped` / `flush_scrape_registry`、`_file_fingerprint`（706-763） | 磁盘状态文件，属上层 |
| AI 增强（除下述 4 个必需项外全部未迁移） | `ai_refine_genre`、`ai_reconcile_metadata`、`ai_infer_metadata`、`ai_pick_best_album`→**已迁移**、`ai_infer_year`→**已迁移**、`ai_predict_language`→**已迁移**、`neuro_parse_filename`→**已迁移**、`ai_extract_credits_from_lyrics`、`ai_check_lyrics_validity`、`ai_verify_lyrics_match`、`ai_translate_lyrics`、`needs_translation_check`、`get_style_prompt` | 迁移的 4 个是主链路（语种判定、文件名解析、候选排序、年份补齐）必需；其余是可选增强，涉及提示词管理与翻译，留给上层 |
| Navidrome | `navidrome_*`、`audit_navidrome_*`、`artist_folder_key` 之外的审计逻辑（1264-1693） | 属音乐库审计，非刮削核心 |
| 其它模块 | 文件整理/漫画/视频/图集/电子书/字幕/ed2k/Wonder3 等（module_backends.py 全部类、`move_into_place`、云盘重试） | 与音乐元数据无关 |
| 依赖 | `cloudscraper` / `googlesearch` / `plyer` / `customtkinter` | 不在允许的第三方库清单内；音乐路径本来也不用 `scraper_get` |

## 7. 可选 API Key

| 配置项 | 环境变量 | 影响的源 | 缺失时行为 |
| --- | --- | --- | --- |
| `siliconflow_api_key` | `SILICONFLOW_API_KEY` | AI 语种/文件名/候选排序/年份 | AI 相关分支跳过，规则逻辑照常 |
| `acoustid_api_key` | `ACOUSTID_API_KEY` | AcoustID | 源码无实现，本包只占位并报告「已跳过」 |
| `spotify_client_id` + `spotify_client_secret` | `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify | 该源跳过并给出可读原因 |
| `genius_access_token` | `GENIUS_ACCESS_TOKEN` | Genius | 同上 |
| `discogs_token` | `DISCOGS_TOKEN` | Discogs | 同上 |

无需 Key：Netease / QQMusic / Kugou / Kuwo / MusicBrainz / Cover Art Archive / iTunes ×4 /
Deezer / Last.fm（内置 key）/ TheAudioDB（内置 key）/ YouTubeMusic / LRCLIB。
跳过原因由 `config.source_skip_reason()` 给出，`search_all(..., report={})` 会把它们回填到
`report['skipped']`，不影响其它源出结果。

## 8. 已知缺陷 / 不确定项

1. `classify_album_context` 判定「1~3 首且无 secondary types → single」是源码行为；实测 MB 稻香那条
   `total_tracks=3` 被判成 `single`（真实是《魔杰座》那一版 3 首发行）。照抄未改。
2. 各源的 `timeout=300`（源码值）对多数接口偏长，失败时单源会拖慢整体；`safe_api_call` 只重试 1 次。
3. 搜索缓存键是 `(keyword, artist_hint)`，与源码一致 —— `title_hint`/`duration_hint`/`sources` 不同也命中同一缓存。
4. `search_all` 的 `limit` 作用于排序后的候选；若首选分 `< 25` 直接返回空列表（源码行为）。
5. `_relaxed_search`（放宽兜底）会调用 Spotify，缺 Key 时该分支自然拿不到结果（与源码一致）。
6. `read_audio_tags` 的 `year` 取自 `date` 前 4 位；源码没有独立的 year 标签。
7. `plan_tag_update` 对 `overwrite_existing=False` 的「已有标签」判断是字段级（读取的旧值非空即跳过），
   而实际写入是按标签键逐个判断（如 album_type 的 4 个键可能只写其中几个）；想完全一致需要按 key 逐条比对。
8. 未做真实的 m4a / flac / ogg 写盘实测（构建环境没有编码器可生成这些容器）；只对 mp3 做了
   写入→读回→二次预览的端到端验证，其余三种格式靠与源码逐行对照保证。
9. `MusicBrainz` 的 `release_group_id` 会写进标签，但 `Cover Art Archive` 取封面走的仍是 URL 拼接
   （`coverartarchive.org/release-group/{id}/front`），没有 404 兜底到具体 release。
10. `module_backends.py` 的 `MusicLibraryOrganizer`（5819 行起）里含命名/路径规则（`library_relpath` 等），
    属整理而非刮削，未纳入；若上层需要，需另开一次迁移。

## 9. 自检命令（本机 .build-env）

```powershell
$env:PYTHONIOENCODING="utf-8"; cd "D:\codex\音乐刮削"
& "D:\codex\脚本整合\.build-env\Scripts\python.exe" -m py_compile metatidy_core/*.py
& "D:\codex\脚本整合\.build-env\Scripts\python.exe" -c "import metatidy_core.scrapers, metatidy_core.tagger, metatidy_core.normalize"
```
