/** Explicit, one-artist portrait review. Browsing never contacts Last.fm or Navidrome. */
import { api } from "./api.js";
import * as ui from "./ui.js";

const PAGE_SIZE = 50;
const SYNC_KEY = "metatidy-portrait-pending-sync";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requests = new Map();
let nodes;
let active = false;
let lifecycle = 0;
let sourceRevision = 0;
let targetRevision = 0;
let status = null;
let statusKnown = false;
let cooldownUntil = 0;
let statusTimer = 0;
let portrait = null;
let portraitLoaded = false;
let target = null;
let dialog = null;
let preflighting = false;
let sourceLoading = false;
let testLoading = false;
let connected = false;
let sync = null;
let syncChecking = false;
let uploadInFlight = false;
let syncTimer = 0;
let syncPolls = 0;
const library = { q: "", page: 1, pages: 1, total: 0, loading: false, loaded: false, items: [] };
const remote = { q: "", page: 1, pages: 1, total: 0, loading: false, items: [], searched: false };

const text = (value) => typeof value === "string" ? value : "";
const count = (value) => Math.max(0, Math.trunc(Number(value) || 0));
const pendingSync = () => Boolean(sync && !["uploaded", "failed"].includes(sync.state));
const button = (id, label, action, cls = "") => ui.el("button", { id, type: "button", class: `btn ${cls}`.trim(), text: label, onClick: action });
const message = (node, value, tone = "") => { node.textContent = value; node.dataset.tone = tone; };
const field = (title, input) => ui.el("label", { class: "field" }, [ui.el("span", { class: "lbl", text: title }), input]);

function cancel(kind) {
  requests.get(kind)?.controller.abort();
  requests.delete(kind);
}

function startRequest(kind) {
  cancel(kind);
  const request = { controller: new AbortController(), lifecycle };
  requests.set(kind, request);
  return { signal: request.controller.signal, current: () => active && lifecycle === request.lifecycle && requests.get(kind) === request && !request.controller.signal.aborted };
}

function closePreview() {
  dialog?.close();
  dialog = null;
  cancel("preflight");
  preflighting = false;
}

function clearFinishedSync() {
  if (sync && !pendingSync()) { sync = null; saveSync(); renderSync(); }
}

function invalidateSource() {
  sourceRevision++;
  cancel("fetch");
  sourceLoading = false;
  portrait = null;
  portraitLoaded = false;
  closePreview();
  clearFinishedSync();
  renderPortrait();
  updateSelection();
  message(nodes.fetchStatus, "填写或选择歌手后，手动获取头像。请确认 Last.fm 上的同名歌手。 ");
  updateControls();
}

function invalidateTarget({ clearResults = false } = {}) {
  targetRevision++;
  target = null;
  closePreview();
  clearFinishedSync();
  if (clearResults) {
    cancel("remote");
    remote.loading = false;
    remote.items = [];
    remote.searched = false;
    remote.page = 1;
    renderRemote();
  } else updateSelection();
  updateControls();
}

function card(title, step, content) {
  return ui.el("section", { class: "card portraits-card", "aria-label": title }, [
    ui.el("div", { class: "card-head" }, [ui.el("h2", {}, [step ? ui.el("span", { class: "portraits-step", text: step, "aria-hidden": "true" }) : ui.icon("artist"), title])]),
    ui.el("div", { class: "portraits-body" }, content),
  ]);
}

export function init() {
  if (nodes) return;
  const host = ui.byId("artist-portraits-root");
  if (!host) return;
  host.classList.add("portraits-workspace");
  const libraryQ = ui.el("input", { id: "portraits-library-q", type: "search", placeholder: "按歌手名筛选…", autocomplete: "off" });
  const librarySearch = button("portraits-library-search", "搜索", () => void loadLibrary(1), "btn-sm");
  const libraryStatus = ui.el("p", { id: "portraits-library-status", class: "portraits-status", role: "status" });
  const libraryList = ui.el("ul", { id: "portraits-library-list", class: "portraits-list", "aria-label": "音乐库中的歌手" });
  const libraryPager = ui.el("nav", { class: "portraits-pager", "aria-label": "歌手分页" });
  const libraryPrev = button("portraits-library-prev", "上一页", () => void loadLibrary(library.page - 1), "btn-sm");
  const libraryNext = button("portraits-library-next", "下一页", () => void loadLibrary(library.page + 1), "btn-sm");
  const libraryPage = ui.el("span", { id: "portraits-library-page", class: "portraits-page" });
  libraryPager.append(libraryPrev, libraryPage, libraryNext);
  const artist = ui.el("input", { id: "portraits-artist", type: "text", autocomplete: "off", maxlength: 200, placeholder: "例如：周杰伦" });
  const imageUrl = ui.el("input", { id: "portraits-image-url", type: "url", autocomplete: "off", placeholder: "粘贴 Last.fm 图片链接（https://…）", spellcheck: "false" });
  const fetchButton = button("portraits-fetch", "获取 Last.fm 头像", () => void fetchPortrait(), "btn-primary");
  const fetchStatus = ui.el("p", { id: "portraits-fetch-status", class: "portraits-status", role: "status", text: "填写或选择歌手后，手动获取头像。" });
  const limitStatus = ui.el("p", { id: "portraits-limit-status" });
  const statusRefresh = button("portraits-status-refresh", "更新服务状态", () => void refreshStatus(), "btn-sm btn-ghost");
  const preview = ui.el("div", { id: "portraits-preview", class: "portraits-preview", hidden: true });
  const connection = ui.el("p", { id: "portraits-connection", class: "portraits-status", role: "status", text: "正在读取 Navidrome 配置状态…" });
  const test = button("portraits-test", "测试连接", () => void testConnection(), "btn-sm");
  const targetQ = ui.el("input", { id: "portraits-target-q", type: "search", autocomplete: "off", placeholder: "输入 Navidrome 中的歌手名" });
  const targetSearch = button("portraits-target-search", "搜索目标歌手", () => void searchRemote(1), "btn-sm");
  const targetStatus = ui.el("p", { id: "portraits-target-status", class: "portraits-status", role: "status", text: "点击搜索，再选择准确的目标。相同名称也需要手动确认。" });
  const targetList = ui.el("ul", { id: "portraits-target-list", class: "portraits-list portraits-targets", "aria-label": "Navidrome 目标歌手" });
  const targetPager = ui.el("nav", { class: "portraits-pager", "aria-label": "Navidrome 歌手分页", hidden: true });
  const targetPrev = button("portraits-target-prev", "上一页", () => void searchRemote(remote.page - 1), "btn-sm");
  const targetNext = button("portraits-target-next", "下一页", () => void searchRemote(remote.page + 1), "btn-sm");
  const targetPage = ui.el("span", { id: "portraits-target-page", class: "portraits-page" });
  targetPager.append(targetPrev, targetPage, targetNext);
  const selection = ui.el("p", { id: "portraits-selection", class: "portraits-status", text: "先获取来源头像，并手动选择 Navidrome 目标歌手。" });
  const preflight = button("portraits-sync-preview", "预览同步…", () => void previewSync(), "btn-primary");
  const syncResult = ui.el("div", { id: "portraits-sync-result", class: "portraits-sync-result", tabindex: -1, hidden: true });
  const syncMessage = ui.el("p", { id: "portraits-sync-message", class: "portraits-status", role: "status" });
  const syncCheck = button("portraits-sync-check", "查询同步结果", () => { syncPolls = 0; void checkSync(); }, "btn-sm");
  const syncAcknowledge = button("portraits-sync-acknowledge", "已在 Navidrome 核对，结束本次", () => void acknowledgeSync(), "btn-sm btn-ghost");
  syncResult.append(syncMessage, syncCheck, syncAcknowledge);
  nodes = { host, libraryQ, librarySearch, libraryStatus, libraryList, libraryPager, libraryPrev, libraryPage, libraryNext, artist, imageUrl, fetchButton, fetchStatus, limitStatus, statusRefresh, preview, connection, test, targetQ, targetSearch, targetStatus, targetList, targetPager, targetPrev, targetPage, targetNext, selection, preflight, syncResult, syncMessage, syncCheck, syncAcknowledge };
  host.append(
    ui.el("div", { class: "portraits-intro" }, [ui.icon("artist", { size: 34 }), ui.el("div", {}, [ui.el("h2", { text: "从一张肖像，认识熟悉的声音。" }), ui.el("p", { text: "逐位获取 Last.fm 图片，核对来源与歌手，再同步到 Navidrome。浏览列表只读取本地索引。" })])]),
    ui.el("div", { class: "portraits-layout" }, [
      card("曲库歌手", "", [ui.el("form", { class: "portraits-form", onSubmit: (event) => { event.preventDefault(); void loadLibrary(1); } }, [field("筛选本地歌手", libraryQ), librarySearch]), libraryStatus, libraryList, libraryPager, ui.el("p", { class: "hint", text: "选择只会填入歌手名；也可以直接在右侧手动输入。" })]),
      ui.el("div", { class: "portraits-editor" }, [
        card("获取与核对来源", "1", [
          field("歌手名（Last.fm 查询）", artist),
          ui.el("details", { class: "portraits-manual" }, [ui.el("summary", { text: "手动使用 Last.fm 图片链接" }), field("Last.fm CDN 图片 URL（可选）", imageUrl), ui.el("p", { class: "hint", text: "自动查找没有合适结果时，可粘贴 Last.fm 的原图链接后点击获取。仍遵守服务冷却限制，不会绕过访问限制。" })]),
          ui.el("div", { class: "portraits-form" }, [fetchButton]), fetchStatus,
          ui.el("div", { class: "portraits-policy" }, [ui.el("p", { text: "仅在点击获取时请求。请求至少间隔 5 秒；成功缓存 7 天，未找到结果缓存 24 小时。遇到 403 / 429 时暂停访问。" }), limitStatus, statusRefresh]), preview,
        ]),
        card("选择 Navidrome 目标", "2", [
          connection, ui.el("div", { class: "portraits-form" }, [test]),
          ui.el("details", { id: "portraits-config", class: "portraits-config" }, [ui.el("summary", { text: "配置说明" }), ui.el("p", { text: "需要 Navidrome 0.61.0 或更新版本，以及有头像上传权限的账户；Navidrome 的 EnableArtworkUpload=false 时需管理员。在服务端设置以下环境变量并重启 metatidy：" }), ...["METATIDY_NAVIDROME_URL", "METATIDY_NAVIDROME_USERNAME", "METATIDY_NAVIDROME_PASSWORD"].map(value => ui.el("code", { text: value }))]),
          ui.el("form", { class: "portraits-form", onSubmit: (event) => { event.preventDefault(); void searchRemote(1); } }, [field("查找目标歌手", targetQ), targetSearch]),
          targetStatus, targetList, targetPager,
          ui.el("div", { class: "portraits-sync-action" }, [selection, preflight]), syncResult,
        ]),
      ]),
    ]),
  );
  artist.addEventListener("input", invalidateSource);
  imageUrl.addEventListener("input", invalidateSource);
  targetQ.addEventListener("input", () => { invalidateTarget({ clearResults: true }); message(targetStatus, "查询已修改，请点击搜索以载入新的候选。 "); });
  libraryQ.addEventListener("input", () => {
    cancel("library");
    library.loading = false;
    library.items = [];
    library.loaded = false;
    renderLibrary();
    message(libraryStatus, "筛选已修改，请点击搜索。 ");
    updateControls();
  });
  window.addEventListener("metatidy:unauthorized", leave);
  restoreSync();
  renderLibrary();
  renderRemote();
  renderSync();
  updateControls();
}

export async function activate() {
  init();
  if (!nodes) return;
  active = true;
  if (!statusTimer) statusTimer = window.setInterval(() => { renderLimit(); updateControls(); }, 1000);
  const work = [refreshStatus()];
  if (!library.loaded) work.push(loadLibrary(library.page));
  if (pendingSync()) work.push(checkSync());
  await Promise.allSettled(work);
}

export function leave() {
  active = false;
  lifecycle++;
  for (const kind of requests.keys()) cancel(kind);
  closePreview();
  if (library.loading) library.loaded = false;
  library.loading = remote.loading = sourceLoading = testLoading = syncChecking = false;
  clearInterval(statusTimer);
  statusTimer = 0;
  clearTimeout(syncTimer);
  syncTimer = 0;
  if (nodes) nodes.statusRefresh.disabled = false;
  updateControls();
}

function updateControls() {
  if (!nodes) return;
  const locked = pendingSync();
  const configured = Boolean(statusKnown && status?.navidrome?.configured);
  nodes.artist.disabled = nodes.imageUrl.disabled = locked;
  nodes.fetchButton.disabled = locked || sourceLoading || !active || !nodes.artist.value.trim() || !statusKnown || Boolean(status?.lastfm?.busy) || cooldownUntil > Date.now() || Boolean(status?.lastfm?.cooldown && !cooldownUntil);
  nodes.fetchButton.textContent = sourceLoading ? "正在获取与缓存…" : "获取 Last.fm 头像";
  nodes.fetchButton.setAttribute("aria-busy", String(sourceLoading));
  nodes.test.disabled = !active || !configured || testLoading || locked;
  nodes.test.textContent = testLoading ? "正在测试…" : "测试连接";
  nodes.targetQ.disabled = !configured || locked;
  nodes.targetSearch.disabled = !active || !configured || remote.loading || locked || !nodes.targetQ.value.trim();
  nodes.preflight.disabled = !active || locked || !configured || !portrait || !portraitLoaded || !target || sourceLoading || remote.loading || preflighting;
  nodes.preflight.textContent = preflighting ? "正在核对同步目标…" : "预览同步…";
  nodes.preflight.setAttribute("aria-busy", String(preflighting));
  nodes.librarySearch.disabled = !active || library.loading;
  nodes.libraryPrev.disabled = library.loading || library.page <= 1 || !library.loaded;
  nodes.libraryNext.disabled = library.loading || library.page >= library.pages || !library.loaded;
  nodes.targetPrev.disabled = remote.loading || remote.page <= 1 || locked;
  nodes.targetNext.disabled = remote.loading || remote.page >= remote.pages || locked;
  nodes.libraryList.setAttribute("aria-busy", String(library.loading));
  nodes.targetList.setAttribute("aria-busy", String(remote.loading));
  nodes.syncCheck.disabled = !active || syncChecking || uploadInFlight;
  nodes.syncCheck.textContent = syncChecking ? "正在查询…" : "查询同步结果";
  nodes.syncAcknowledge.disabled = !active || syncChecking || uploadInFlight;
  nodes.libraryList.querySelectorAll("button").forEach(item => { item.disabled = locked; });
  nodes.targetList.querySelectorAll("button").forEach(item => { item.disabled = locked; });
}

async function refreshStatus() {
  if (!active) return;
  const operation = startRequest("status");
  nodes.statusRefresh.disabled = true;
  try {
    const result = await api.artistPortraitStatus({ signal: operation.signal });
    if (!operation.current()) return;
    status = result;
    statusKnown = true;
    const seconds = Number(result.lastfm?.retry_after_seconds || 0);
    cooldownUntil = Math.max(seconds > 0 ? Date.now() + seconds * 1000 : 0, Number(result.lastfm?.retry_at || 0) * 1000);
    if (!result.navidrome?.configured) {
      connected = false;
      message(nodes.connection, "Navidrome 尚未配置。展开配置说明，在服务端设置连接信息。 ");
    } else if (!connected) message(nodes.connection, `已配置 ${text(result.navidrome.url)}；可点击测试连接。要求 Navidrome ≥ ${text(result.navidrome.min_version) || "0.61.0"}。`);
    renderLimit();
  } catch (error) {
    if (!operation.current()) return;
    statusKnown = false;
    message(nodes.limitStatus, `无法确认服务状态：${error.message}。更新状态后再获取。`, "error");
    message(nodes.connection, "服务状态尚未确认。请点击更新服务状态。", "error");
  } finally {
    if (operation.current()) { nodes.statusRefresh.disabled = false; updateControls(); }
  }
}

function renderLimit() {
  if (!nodes || !statusKnown) return;
  const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  if (seconds) message(nodes.limitStatus, `Last.fm 冷却中：${seconds} 秒后可再次获取。${text(status?.lastfm?.reason)}`, "error");
  else if (status?.lastfm?.cooldown && !cooldownUntil) message(nodes.limitStatus, `Last.fm 已暂停访问，待服务恢复后请更新状态。${text(status?.lastfm?.reason) === "persistence_error" ? "无法保存请求状态，请检查服务缓存目录权限。" : text(status?.lastfm?.reason)}`, "error");
  else if (status?.lastfm?.busy) message(nodes.limitStatus, "服务正在获取其他头像。完成后请更新服务状态。 ");
  else message(nodes.limitStatus, "Last.fm 当前可请求；缓存命中时直接使用本地图片。 ");
}

async function loadLibrary(page = 1) {
  if (!active || library.loading) return;
  const operation = startRequest("library");
  const q = nodes.libraryQ.value.trim();
  library.loading = true;
  message(nodes.libraryStatus, "正在读取本地歌手索引…");
  updateControls();
  try {
    const result = await api.artists({ q, page, page_size: PAGE_SIZE }, { signal: operation.signal });
    if (!operation.current()) return;
    if (!Array.isArray(result.items)) throw new Error("歌手数据不完整");
    Object.assign(library, { q, page: count(result.page) || 1, pages: Math.max(1, count(result.pages)), total: count(result.total), items: result.items.filter(item => text(item?.name)), loaded: true });
    renderLibrary();
    message(nodes.libraryStatus, library.items.length ? `共 ${ui.fmtNum(library.total)} 位歌手 · 从本地索引读取` : q ? "没有匹配的歌手，可直接手动输入歌手名。" : "本地索引中还没有歌手，可先扫描曲库或直接手动输入。 ");
  } catch (error) {
    if (operation.current()) message(nodes.libraryStatus, `无法读取歌手索引：${error.message}。可重新搜索或手动输入。`, "error");
  } finally { if (operation.current()) { library.loading = false; updateControls(); } }
}

function renderLibrary() {
  nodes.libraryList.replaceChildren(...library.items.map(item => {
    const select = button("", "", () => {
      if (pendingSync()) return;
      nodes.artist.value = item.name;
      nodes.imageUrl.value = "";
      invalidateSource();
      nodes.artist.focus({ preventScroll: true });
    }, "portraits-artist");
    select.className = "portraits-artist";
    select.removeAttribute("id");
    select.dataset.artist = item.name;
    select.setAttribute("aria-pressed", String(nodes.artist.value.trim() === item.name));
    select.append(ui.el("span", { class: "portraits-initial", text: Array.from(item.name)[0] || "♪", "aria-hidden": "true" }), ui.el("span", { class: "portraits-item-copy" }, [ui.el("strong", { text: item.name }), ui.el("small", { text: `${ui.fmtNum(count(item.track_count))} 首 · ${ui.fmtNum(count(item.album_count))} 张专辑` })]));
    return ui.el("li", {}, [select]);
  }));
  nodes.libraryPage.textContent = `${library.page} / ${library.pages}`;
}

async function fetchPortrait() {
  if (!active || nodes.fetchButton.disabled) return;
  invalidateSource();
  const operation = startRequest("fetch");
  const revision = sourceRevision;
  const artist = nodes.artist.value.trim();
  const imageUrl = nodes.imageUrl.value.trim();
  sourceLoading = true;
  message(nodes.fetchStatus, imageUrl ? `正在缓存「${artist}」的手动图片链接…` : `正在查询「${artist}」的 Last.fm 公开页面…`);
  updateControls();
  try {
    const result = await api.artistPortraitFetch({ artist, ...(imageUrl ? { image_url: imageUrl } : {}) }, { signal: operation.signal });
    if (!operation.current() || revision !== sourceRevision) return;
    if (!result.portrait?.id || !portraitUrl(result.portrait)) throw new Error("头像预览数据不完整，请更新状态后重试");
    if (text(result.portrait.artist).trim() !== artist) throw new Error("返回的来源歌手与本次查询不一致，请重新获取后核对");
    portrait = result.portrait;
    renderPortrait();
    message(nodes.fetchStatus, `${result.cached ? "使用本地缓存" : "已缓存头像"}。请对照来源确认人物，同名匹配不保证准确。`, "success");
    updateSelection();
  } catch (error) {
    if (!operation.current() || revision !== sourceRevision) return;
    message(nodes.fetchStatus, error.message, "error");
  } finally {
    if (operation.current()) { sourceLoading = false; statusKnown = false; updateControls(); await refreshStatus(); }
  }
}

/** Never embed a remote URL or a credentialed URL as a preview image. */
function localImageUrl(value) {
  try {
    const url = new URL(value, location.origin);
    const parts = url.pathname.split("/");
    const isSource = parts.length === 5 && parts[1] === "api" && parts[2] === "artist-portraits" && UUID.test(parts[3]) && parts[4] === "preview";
    const isTarget = parts.length === 6 && parts[1] === "api" && parts[2] === "artist-portraits" && parts[3] === "sync" && UUID.test(parts[4]) && parts[5] === "target-image";
    return url.origin === location.origin && (isSource || isTarget) && !url.username && !url.password && !url.search && !url.hash ? url.pathname : "";
  } catch { return ""; }
}

function portraitUrl(value) {
  const path = localImageUrl(value?.preview_url);
  return path === `/api/artist-portraits/${value?.id}/preview` ? path : "";
}

function sourceLink(label, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["www.last.fm", "last.fm", "lastfm.freetls.fastly.net", "lastfm-img.freetls.fastly.net"].includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) return null;
    return ui.el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer", text: label });
  } catch { return null; }
}

function imageFrame(url, alt, empty = "暂无头像", onState = () => {}) {
  const frame = ui.el("div", { class: "portraits-image" });
  const safe = localImageUrl(url);
  if (safe) {
    const image = ui.el("img", { src: safe, alt, width: 512, height: 512, decoding: "async" });
    image.addEventListener("load", () => onState(image.naturalWidth > 0), { once: true });
    image.addEventListener("error", () => { frame.replaceChildren(ui.el("p", { text: "头像预览暂不可用" })); onState(false); }, { once: true });
    frame.append(image);
  } else frame.append(ui.el("p", { text: empty }));
  return frame;
}

function renderPortrait() {
  nodes.preview.hidden = !portrait;
  nodes.preview.replaceChildren();
  if (!portrait) return;
  const id = portrait.id;
  const revision = sourceRevision;
  nodes.preview.append(imageFrame(portraitUrl(portrait), `${portrait.artist} 的来源头像`, "来源预览地址无效", loaded => {
    if (revision !== sourceRevision || portrait?.id !== id) return;
    portraitLoaded = loaded;
    if (!loaded) message(nodes.fetchStatus, "来源头像预览加载失败，暂不能同步。请重新获取，确认看见头像后继续。", "error");
    updateControls();
  }), ui.el("div", { class: "portraits-preview-copy" }, [
    ui.el("h3", { text: portrait.artist }),
    ui.el("p", { text: `本地 AVIF 预览 · 上传图片 ${count(portrait.width)} × ${count(portrait.height)}` }),
    ui.el("p", { text: "请确认是这位歌手，并核对图片是否适合用作头像。" }),
    ui.el("div", { class: "portraits-links" }, [sourceLink("Last.fm 来源页面 ↗", portrait.source_page), sourceLink("来源图片 ↗", portrait.source_image)]),
  ]));
}

async function testConnection() {
  if (!active || nodes.test.disabled) return;
  const operation = startRequest("test");
  testLoading = true;
  message(nodes.connection, "正在验证 Navidrome 连接与账户信息…");
  updateControls();
  try {
    const result = await api.navidromeTest({ signal: operation.signal });
    if (!operation.current()) return;
    connected = result.connected === true;
    message(nodes.connection, connected ? `已连接 · ${text(result.user?.name)} · ${result.user?.is_admin ? "管理员" : "普通账户（需要启用 EnableArtworkUpload）"}。${text(result.message)}` : text(result.message) || "连接未通过，请检查服务器地址、版本与账户权限。", connected ? "success" : "error");
  } catch (error) {
    if (operation.current()) { connected = false; message(nodes.connection, error.message, "error"); }
  } finally { if (operation.current()) { testLoading = false; updateControls(); } }
}

async function searchRemote(page = 1) {
  if (!active || !statusKnown || !status?.navidrome?.configured || remote.loading || pendingSync() || !nodes.targetQ.value.trim()) return;
  invalidateTarget();
  const operation = startRequest("remote");
  const q = nodes.targetQ.value.trim();
  remote.loading = true;
  remote.items = [];
  remote.searched = false;
  renderRemote();
  message(nodes.targetStatus, "正在搜索 Navidrome 歌手…");
  updateControls();
  try {
    const result = await api.navidromeArtists({ q, page, page_size: PAGE_SIZE }, { signal: operation.signal });
    if (!operation.current()) return;
    if (!Array.isArray(result.items)) throw new Error("目标歌手数据不完整");
    Object.assign(remote, { q, page: count(result.page) || 1, pages: Math.max(1, count(result.pages)), total: count(result.total), items: result.items.filter(item => text(item?.id) && text(item?.name)), searched: true });
    renderRemote();
    message(nodes.targetStatus, remote.items.length ? `找到 ${ui.fmtNum(remote.total)} 个目标，请核对 ID、专辑数量与 MusicBrainz ID 后选择。` : "没有找到目标歌手。请检查名称或先更新 Navidrome 曲库。 ");
  } catch (error) { if (operation.current()) message(nodes.targetStatus, error.message, "error"); }
  finally { if (operation.current()) { remote.loading = false; updateControls(); } }
}

function renderRemote() {
  nodes.targetList.replaceChildren(...remote.items.map(item => {
    const choose = ui.el("button", { type: "button", class: "portraits-target", dataset: { artistId: item.id }, "aria-pressed": "false", onClick: () => {
      if (pendingSync()) return;
      invalidateTarget();
      target = item;
      updateSelection();
      updateControls();
    } }, [ui.icon("artist", { size: 18 }), ui.el("span", { class: "portraits-item-copy" }, [
      ui.el("strong", { text: item.name }),
      ui.el("small", { text: `${count(item.album_count)} 张专辑 · ${count(item.song_count)} 首 · ID: ${item.id}` }),
      ui.el("small", { text: `MusicBrainz ID: ${text(item.mbid) || "未提供"}` }),
    ])]);
    return ui.el("li", {}, [choose]);
  }));
  nodes.targetPager.hidden = !remote.searched;
  nodes.targetPage.textContent = `${remote.page} / ${remote.pages}`;
  updateSelection();
}

function updateSelection() {
  nodes.libraryList.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.artist === nodes.artist.value.trim())));
  nodes.targetList.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.artistId === target?.id)));
  message(nodes.selection, target ? `目标：${target.name} · ID: ${target.id}${portrait ? `；来源：${portrait.artist}` : "；请先获取来源头像"}` : "先获取来源头像，并手动选择 Navidrome 目标歌手。 ");
}

async function previewSync() {
  if (!active || nodes.preflight.disabled) return;
  const sourceAt = sourceRevision;
  const targetAt = targetRevision;
  const portraitId = portrait.id;
  const targetId = target.id;
  const operation = startRequest("preflight");
  let confirmed = false;
  const valid = () => operation.current() && sourceAt === sourceRevision && targetAt === targetRevision && portrait?.id === portraitId && target?.id === targetId && !pendingSync();
  preflighting = true;
  message(nodes.selection, "正在读取目标当前头像并生成一次性同步预览…");
  updateControls();
  try {
    const result = await api.artistPortraitSyncPreview({ portrait_id: portraitId, artist_id: targetId }, { signal: operation.signal });
    if (!valid()) return;
    if (!UUID.test(text(result.token)) || result.target?.id !== targetId || result.portrait?.id !== portraitId || result.portrait?.artist !== portrait.artist || !portraitUrl(result.portrait)) throw new Error("预览目标与当前选择不一致，请重新选择并预览");
    const previewPortrait = result.portrait;
    const previewTarget = result.target;
    let confirmButton = null;
    let confirmationImageLoaded = false;
    const imageStatus = ui.el("p", { class: "portraits-dialog-note", role: "status", text: "来源头像加载完成后才能确认同步。" });
    const sourceFrame = imageFrame(portraitUrl(previewPortrait), `${previewPortrait.artist} 的新头像`, "来源预览地址无效", loaded => {
      if (!valid() || !confirmButton?.closest("dialog")?.open) return;
      confirmationImageLoaded = loaded;
      confirmButton.disabled = !loaded;
      imageStatus.textContent = loaded ? "来源头像已载入。请核对人物和目标，再确认替换。" : "来源头像加载失败。请取消本次，重新获取可见的来源头像后再同步。";
    });
    const targetImageUrl = localImageUrl(result.target_image_url) === `/api/artist-portraits/sync/${result.token}/target-image` ? result.target_image_url : "";
    const body = ui.el("div", { id: "portraits-confirmation" }, [
      ui.el("div", { class: "portraits-comparison" }, [
        ui.el("figure", {}, [ui.el("figcaption", { text: "准备同步的来源头像" }), sourceFrame, ui.el("h3", { text: previewPortrait.artist }), ui.el("div", { class: "portraits-links" }, [sourceLink("Last.fm 来源 ↗", previewPortrait.source_page)])]),
        ui.el("figure", {}, [ui.el("figcaption", { text: "Navidrome 当前头像" }), imageFrame(targetImageUrl, `${previewTarget.name} 的当前头像`, "目标当前没有可预览的头像"), ui.el("h3", { text: previewTarget.name }), ui.el("p", { text: `ID: ${previewTarget.id}` }), ui.el("p", { text: `MusicBrainz ID: ${text(previewTarget.mbid) || "未提供"}` })]),
      ]),
      ui.el("p", { class: "portraits-overwrite", text: `确认后将替换 Navidrome 歌手「${previewTarget.name}」（ID: ${previewTarget.id}）当前使用的头像。请核对人物与目标；同名不代表同一位歌手。` }),
      ui.el("p", { class: "portraits-dialog-note", text: "预览使用本地 AVIF，上传使用 Navidrome 支持的 JPEG。仅同步这一位歌手，确认仅提交一次。" }),
      imageStatus,
    ]);
    const answerPromise = ui.openDialog({ title: "确认同步歌手头像", subtitle: "核对两侧头像与准确的目标歌手后再确认。", body, size: "portraits-sync-dialog", actions: [
      { id: "cancel", label: "取消", autofocus: true }, { id: "confirm", label: "确认替换此歌手头像", variant: "btn-primary" },
    ] });
    dialog = body.closest("dialog");
    confirmButton = dialog.querySelector(".modal-foot .btn-primary");
    confirmButton.disabled = true;
    const answer = await answerPromise;
    dialog = null;
    if (answer !== "confirm" || !valid() || !confirmationImageLoaded) return;
    if (Number(result.expires_at) * 1000 <= Date.now()) throw new Error("同步预览已过期，请重新预览后确认");
    sync = { token: result.token, artist: previewPortrait.artist, target: previewTarget.name, targetId: previewTarget.id, state: "uploading", message: "正在同步头像，请等待服务器结果…" };
    syncPolls = 0;
    confirmed = true;
    saveSync();
    renderSync();
    updateControls();
    nodes.syncResult.focus({ preventScroll: true });
    await executeSync(sync);
  } catch (error) {
    if (operation.current()) message(nodes.selection, error.message, "error");
  } finally {
    if (operation.current()) {
      preflighting = false;
      updateControls();
      if (!confirmed) nodes.preflight.focus({ preventScroll: true });
    }
  }
}

async function executeSync(record) {
  // A dispatched upload is never aborted/reissued on navigation or a network error.
  uploadInFlight = true;
  updateControls();
  try {
    const result = await api.artistPortraitSync(record.token);
    if (sync !== record) return;
    uploadInFlight = false;
    acceptSyncState(result);
    if (pendingSync() && active) await checkSync();
  } catch (error) {
    if (sync !== record) return;
    uploadInFlight = false;
    sync.state = "uncertain";
    sync.message = `尚不能确认上传结果：${error.message}。已锁定重复提交，正在查询服务器记录。`;
    saveSync();
    renderSync();
    updateControls();
    if (active && error.status !== 401) await checkSync();
  } finally { uploadInFlight = false; updateControls(); }
}

function acceptSyncState(result) {
  const state = ["uploaded", "failed", "uncertain", "uploading", "ready"].includes(result?.state) ? result.state : "uncertain";
  sync.state = state;
  const fallback = state === "uploaded" ? "头像已同步。" : state === "failed" ? "同步失败，未完成上传。请重新预览并确认。" : "上传结果尚未确认。请查询状态，不要重复提交。";
  sync.message = text(result?.message) || fallback;
  saveSync();
  renderSync();
  updateControls();
}

async function checkSync() {
  if (!active || !sync || !pendingSync() || syncChecking) return;
  clearTimeout(syncTimer);
  syncTimer = 0;
  const operation = startRequest("sync-status");
  const record = sync;
  syncChecking = true;
  updateControls();
  try {
    const result = await api.artistPortraitSyncStatus(record.token, { signal: operation.signal });
    if (!operation.current() || sync !== record) return;
    acceptSyncState(result);
    // Poll only an acknowledged upload, with a bounded five-second cadence.
    // Uncertain/ready results require user review, never another upload POST.
    if (sync.state === "uploading" && ++syncPolls < 30) {
      syncTimer = window.setTimeout(() => { syncTimer = 0; void checkSync(); }, 5000);
    }
  } catch (error) {
    if (!operation.current() || sync !== record) return;
    sync.state = "uncertain";
    sync.message = `查询结果失败：${error.message}。同步仍未确认，已阻止重复上传。`;
    saveSync();
    renderSync();
  } finally { if (operation.current()) { syncChecking = false; updateControls(); } }
}

function renderSync() {
  if (!nodes) return;
  nodes.syncResult.hidden = !sync;
  if (!sync) return;
  nodes.syncResult.dataset.state = sync.state;
  const label = sync.state === "uploaded" ? "已同步" : sync.state === "failed" ? "同步失败" : sync.state === "uploading" ? "同步中" : "结果待确认";
  message(nodes.syncMessage, `${label} · ${sync.target}（ID: ${sync.targetId}）。${sync.message}${pendingSync() ? " 本次不会再次发送上传请求；可查询服务器状态。" : ""}`, sync.state === "uploaded" ? "success" : "");
  nodes.syncCheck.hidden = !pendingSync();
  nodes.syncAcknowledge.hidden = !["uncertain", "ready"].includes(sync.state);
}

async function acknowledgeSync() {
  if (!active || nodes.syncAcknowledge.disabled || !sync || !["uncertain", "ready"].includes(sync.state)) return;
  const record = sync;
  const revision = lifecycle;
  const body = ui.el("p", { class: "portraits-overwrite", text: `请先在 Navidrome 中核对「${record.target}」（ID: ${record.targetId}）的实际头像。结束本次只会解除界面锁定，不会撤销或重发上传；如果仍需同步，必须重新预览并确认。` });
  const answerPromise = ui.openDialog({ title: "结束尚未确认的同步？", body, actions: [{ id: "cancel", label: "返回核对", autofocus: true }, { id: "acknowledge", label: "我已核对，结束本次" }] });
  dialog = body.closest("dialog");
  const answer = await answerPromise;
  dialog = null;
  if (answer !== "acknowledge" || !active || revision !== lifecycle || sync !== record || !["uncertain", "ready"].includes(sync.state)) return;
  cancel("sync-status");
  clearTimeout(syncTimer);
  syncTimer = 0;
  sync = null;
  saveSync();
  renderSync();
  updateSelection();
  updateControls();
}

function saveSync() {
  try {
    if (pendingSync()) sessionStorage.setItem(SYNC_KEY, JSON.stringify(sync));
    else sessionStorage.removeItem(SYNC_KEY);
  } catch { /* The in-memory token still prevents duplicate submissions in this page. */ }
}

function restoreSync() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SYNC_KEY) || "null");
    if (saved && UUID.test(text(saved.token)) && text(saved.targetId)) sync = { ...saved, state: "uncertain", message: "检测到上次尚未确认的同步，正在读取服务器结果。" };
  } catch { /* Ignore malformed session data. */ }
}
