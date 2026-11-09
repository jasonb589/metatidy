/** Explicit local playback. Sources are attached only by a user play action; never autoplay a queue. */
import { coverUrl } from "./api.js";
import * as ui from "./ui.js";

let nodes = null, current = null, queue = [], session = null, status = "stopped", opener = null;
let volume = .8, muted = false, accessBlocked = false;
const compactScreen = window.matchMedia("(max-width: 700px), (max-width: 1000px) and (max-height: 500px)");
let expanded = false;
const validRow = row => Number.isSafeInteger(Number(row?.id)) && Number(row.id) > 0;
const titleOf = row => String(row?.title || row?.filename || "未命名曲目");
const artistOf = row => String(row?.artist || "未知艺术家");
const seconds = value => Number.isFinite(value) && value >= 0 ? value : 0;
const time = value => { const total = Math.floor(seconds(value)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; };
const isCurrent = value => Boolean(value && session === value && !value.disposed);
function canPlay({ allowInert = false } = {}) {
  const shell = document.querySelector(".app-content"), auth = window.__MT_AUTH?.state;
  return !accessBlocked && Boolean(shell && (allowInert || !shell.inert)) && Boolean(auth && (!auth.required || auth.authenticated)) && !document.querySelector("#auth-veil:not([hidden])")?.getClientRects().length;
}
const ICONS = {
  play: "M5 2.8v10.4l8-5.2z", pause: "M5 3v10M11 3v10",
  previous: "M3 3v10M12.5 3.5L5.5 8l7 4.5z", next: "M13 3v10M3.5 3.5l7 4.5-7 4.5z",
  volume: "M2 6h3l3-3v10l-3-3H2zM10.5 5.5a4 4 0 0 1 0 5M12.5 3.5a7 7 0 0 1 0 9",
  mute: "M2 6h3l3-3v10l-3-3H2zM11 6l3 4M14 6l-3 4",
  queue: "M3 4h10M3 8h10M3 12h6", expand: "M4 10l4-4 4 4", close: "M4 4l8 8M12 4l-8 8", music: "M6 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM8 10V3l5 1M13 9a2 2 0 1 1-2 2M13 4v7",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 16 16", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", ICONS[name]); svg.append(path); return svg;
}
function announce(next, message) {
  const changed = status !== next || nodes?.host.dataset.trackId !== String(current?.id || "");
  status = next;
  if (!nodes) return;
  nodes.host.dataset.state = status;
  nodes.host.dataset.trackId = String(current?.id || "");
  if (message !== undefined) nodes.status.textContent = message;
  updateControls();
  if (changed) window.dispatchEvent(new CustomEvent("metatidy:audio-state", { detail: { id: current ? Number(current.id) : null, status } }));
}

/** Idempotent shell setup; creates no audio source and makes no media request. */
export function initAudioPlayer() {
  if (nodes) return;
  const button = (id, label, glyph, action, cls = "") => ui.el("button", { id, type: "button", class: `ap-button ${cls}`.trim(), "aria-label": label, title: label, onClick: action }, [icon(glyph)]);
  const host = ui.el("section", { id: "audio-player", class: "audio-player", hidden: true, "aria-label": "曲库试听播放器", dataset: { state: "stopped" } });
  const artwork = ui.el("div", { class: "ap-art", "aria-hidden": "true" });
  const title = ui.el("p", { id: "audio-player-title", class: "ap-title" });
  const artist = ui.el("p", { id: "audio-player-artist", class: "ap-artist" });
  const state = ui.el("p", { id: "audio-player-status", class: "ap-status", role: "status", "aria-live": "polite" });
  const toggle = button("audio-player-toggle", "播放", "play", () => togglePlayback(), "ap-toggle");
  const previous = button("audio-player-previous", "播放上一首", "previous", () => playNeighbour(-1));
  const next = button("audio-player-next", "播放下一首", "next", () => playNeighbour(1));
  const elapsed = ui.el("span", { id: "audio-player-elapsed", text: "0:00" });
  const duration = ui.el("span", { id: "audio-player-duration", text: "—" });
  const seek = ui.el("input", { id: "audio-player-seek", type: "range", min: 0, max: 0, step: .1, value: 0, disabled: true, "aria-label": "播放进度" });
  seek.addEventListener("input", () => seekTo(Number(seek.value)));
  const mute = button("audio-player-mute", "静音", "volume", () => {
    if (muted || volume === 0) { muted = false; if (volume === 0) volume = .8; }
    else muted = true;
    if (session) { session.audio.muted = muted; session.audio.volume = volume; }
    updateVolume();
  });
  const volumeInput = ui.el("input", { id: "audio-player-volume", type: "range", min: 0, max: 100, step: 1, value: volume * 100, "aria-label": "音量" });
  volumeInput.addEventListener("input", () => { volume = Math.min(1, Math.max(0, Number(volumeInput.value) / 100)); if (volume > 0) muted = false; if (session) { session.audio.volume = volume; session.audio.muted = muted; } updateVolume(); });
  const queueButton = button("audio-player-queue-toggle", "查看当前页播放列表", "queue", () => setQueueOpen(nodes.queuePanel.hidden));
  queueButton.setAttribute("aria-expanded", "false"); queueButton.setAttribute("aria-controls", "audio-player-queue");
  const expand = button("audio-player-expand", "展开进度与音量", "expand", () => setExpanded(!expanded), "ap-expand");
  expand.setAttribute("aria-controls", "audio-player-progress audio-player-volume-controls audio-player-previous audio-player-next");
  const close = button("audio-player-close", "关闭播放器并停止播放", "close", () => stopAudioPlayer({ restoreFocus: true }), "ap-close");
  const queueList = ui.el("ol", { id: "audio-player-queue-list", class: "ap-queue-list" });
  const queueCount = ui.el("span", { id: "audio-player-queue-count", class: "ap-queue-count" });
  const queuePanel = ui.el("div", { id: "audio-player-queue", class: "ap-queue", hidden: true, role: "region", "aria-labelledby": "audio-player-queue-heading" }, [
    ui.el("div", { class: "ap-queue-head" }, [ui.el("div", {}, [ui.el("h2", { id: "audio-player-queue-heading", text: "当前页播放列表" }), queueCount]), button("audio-player-queue-close", "收起播放列表", "close", () => setQueueOpen(false))]),
    queueList, ui.el("p", { class: "ap-queue-note", text: "点击曲目试听；播完当前曲目后停止。" }),
  ]);
  const progress = ui.el("div", { id: "audio-player-progress", class: "ap-progress" }, [elapsed, seek, duration]);
  const volumeControls = ui.el("div", { id: "audio-player-volume-controls", class: "ap-volume" }, [mute, volumeInput]);
  const bar = ui.el("div", { class: "ap-bar" }, [
    ui.el("div", { class: "ap-track" }, [artwork, ui.el("div", { class: "ap-track-copy" }, [title, artist, state])]),
    ui.el("div", { class: "ap-transport" }, [previous, toggle, next]),
    progress,
    ui.el("div", { class: "ap-utilities" }, [volumeControls, queueButton, expand, close]),
  ]);
  host.append(queuePanel, bar);
  nodes = { host, bar, artwork, title, artist, status: state, toggle, previous, next, elapsed, duration, seek, mute, volume: volumeInput, progress, volumeControls, expand, queueButton, queuePanel, queueList, queueCount, close };
  document.body.append(host);
  const measure = () => {
    if (!host.hidden) document.documentElement.style.setProperty("--audio-player-height", `${Math.ceil(bar.offsetHeight + parseFloat(getComputedStyle(host).bottom))}px`);
  };
  nodes.measure = measure;
  new ResizeObserver(measure).observe(bar);
  window.addEventListener("resize", measure);
  compactScreen.addEventListener("change", () => { expanded = false; applyCompactLayout(); measure(); });
  const lock = () => { accessBlocked = true; stopAudioPlayer(); };
  window.addEventListener("metatidy:unauthorized", lock);
  window.addEventListener("metatidy:logout", lock);
  window.addEventListener("metatidy:authenticated", () => { accessBlocked = false; });
  window.addEventListener("pagehide", () => stopAudioPlayer());
  host.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (!queuePanel.hidden) { event.preventDefault(); event.stopPropagation(); setQueueOpen(false); }
    else if (compactScreen.matches && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
  });
  document.addEventListener("pointerdown", event => { if (!queuePanel.hidden && !host.contains(event.target)) setQueueOpen(false, false); });
  document.addEventListener("focusin", event => { if (!queuePanel.hidden && !host.contains(event.target)) setQueueOpen(false, false); });
  applyCompactLayout(); updateVolume(); updateControls();
}

function applyCompactLayout() {
  if (!nodes) return;
  const compact = compactScreen.matches, hide = compact && !expanded;
  const extras = [nodes.progress, nodes.volumeControls, nodes.previous, nodes.next];
  if (compact) nodes.expand.hidden = false;
  if (hide && extras.some(node => node.contains(document.activeElement))) nodes.expand.focus({ preventScroll: true });
  if (!compact && document.activeElement === nodes.expand) nodes.toggle.focus({ preventScroll: true });
  nodes.host.dataset.compact = String(compact); nodes.host.dataset.expanded = String(compact && expanded);
  nodes.expand.hidden = !compact;
  nodes.expand.setAttribute("aria-expanded", String(compact && expanded));
  const label = expanded ? "收起进度与音量" : "展开进度与音量";
  nodes.expand.setAttribute("aria-label", label); nodes.expand.title = label;
  for (const node of extras) node.hidden = hide;
  nodes.measure?.();
}
function setExpanded(open) {
  expanded = Boolean(open); applyCompactLayout();
  if (open) setQueueOpen(false, false);
}

/** A repeated click toggles the same song without losing its position. */
export function playTrack(row, { rows = [] } = {}) {
  if (!validRow(row)) return;
  initAudioPlayer();
  if (!canPlay()) return;
  if (!nodes.host.contains(document.activeElement)) opener = document.activeElement;
  const seen = new Set();
  queue = (Array.isArray(rows) ? rows : []).filter(item => validRow(item) && !seen.has(Number(item.id)) && seen.add(Number(item.id))).slice(0, 1000).map(item => ({ ...item, id: Number(item.id) }));
  const index = queue.findIndex(item => item.id === Number(row.id));
  if (index < 0) queue = [{ ...row, id: Number(row.id) }];
  else queue[index] = { ...queue[index], ...row, id: Number(row.id) };
  if (current?.id === Number(row.id) && session) {
    current = { ...current, ...row, id: Number(row.id) };
    renderTrack(false); renderQueue(); togglePlayback(); return;
  }
  clearSession();
  current = { ...row, id: Number(row.id) };
  nodes.host.hidden = false; document.body.classList.add("audio-player-open");
  renderTrack(true); renderQueue();
  nodes.measure();
  startSource();
}

/** Clears the queue/source immediately; logging in again never restores playback. */
export function stopAudioPlayer({ restoreFocus = false } = {}) {
  const shouldRestore = restoreFocus && nodes?.host.contains(document.activeElement);
  const trackId = current?.id;
  clearSession(); current = null; queue = [];
  if (!nodes) return;
  setQueueOpen(false, false); expanded = false; applyCompactLayout(); nodes.host.hidden = true;
  nodes.artwork.replaceChildren(); nodes.title.textContent = nodes.artist.textContent = "";
  nodes.queueList.replaceChildren();
  document.body.classList.remove("audio-player-open"); document.documentElement.style.removeProperty("--audio-player-height");
  announce("stopped", ""); updateProgress();
  if (shouldRestore) {
    const candidates = [opener, ...document.querySelectorAll(`button[data-play-id="${trackId}"]`), document.querySelector('#app-sidebar [aria-selected="true"]'), document.querySelector('#main')];
    const restore = candidates.find(node => node instanceof HTMLElement && node.isConnected && node.getClientRects().length && !node.closest("[hidden], [inert]"));
    restore?.focus({ preventScroll: true });
  }
}

function clearSession() {
  if (!session) return;
  const old = session; session = null; old.disposed = true; old.attempt++;
  old.events.abort(); old.diagnostic?.abort();
  old.audio.pause(); old.audio.removeAttribute("src"); old.audio.load(); old.audio.remove();
}
function renderTrack(art) {
  nodes.title.textContent = titleOf(current); nodes.title.title = titleOf(current);
  nodes.artist.textContent = artistOf(current); nodes.artist.title = artistOf(current);
  if (!art) return;
  nodes.artwork.replaceChildren(icon("music"));
  if (current.has_cover) {
    const image = ui.el("img", { src: coverUrl(current.id, 128), alt: "", decoding: "async" });
    image.addEventListener("error", () => { if (image.parentNode === nodes.artwork) nodes.artwork.replaceChildren(icon("music")); }, { once: true });
    nodes.artwork.replaceChildren(image);
  }
}
function renderQueue() {
  const focusedId = document.activeElement?.closest(".ap-queue-track")?.dataset.id;
  nodes.queueCount.textContent = `${queue.length} 首 · 本次打开的曲目顺序`;
  nodes.queueList.replaceChildren(...queue.map((row, index) => ui.el("li", {}, [ui.el("button", { type: "button", class: "ap-queue-track", dataset: { id: row.id }, "aria-label": `播放 ${titleOf(row)}`, onClick: () => { const rows = [...queue]; playTrack(row, { rows }); } }, [
    ui.el("span", { class: "ap-queue-number", text: String(index + 1).padStart(2, "0"), "aria-hidden": "true" }),
    ui.el("span", { class: "ap-queue-copy" }, [ui.el("strong", { text: titleOf(row), title: titleOf(row) }), ui.el("span", { text: artistOf(row), title: artistOf(row) })]),
    ui.el("span", { class: "ap-queue-time", text: Number(row.duration) > 0 ? time(Number(row.duration)) : "" }),
  ])])));
  if (focusedId) nodes.queueList.querySelector(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  updateControls();
}
function setQueueOpen(open, focus = true) {
  if (!nodes) return;
  nodes.queuePanel.hidden = !open; nodes.queueButton.setAttribute("aria-expanded", String(open)); nodes.host.dataset.queueOpen = String(open);
  if (!focus) return;
  if (open) {
    const selected = nodes.queueList.querySelector(`[data-id="${current?.id}"]`) || nodes.queueList.querySelector("button");
    selected?.focus({ preventScroll: true }); selected?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  } else nodes.queueButton.focus({ preventScroll: true });
}
function updateControls() {
  if (!nodes) return;
  const active = status === "playing" || status === "loading", index = queue.findIndex(row => row.id === current?.id);
  nodes.toggle.replaceChildren(icon(active ? "pause" : "play"));
  const action = active ? "暂停" : status === "ended" ? "重新播放" : status === "error" ? "重试播放" : "播放";
  nodes.toggle.setAttribute("aria-label", action); nodes.toggle.title = action;
  nodes.toggle.disabled = !current;
  nodes.previous.disabled = index <= 0; nodes.next.disabled = index < 0 || index >= queue.length - 1;
  for (const button of nodes.queueList.querySelectorAll("button")) {
    const selected = Number(button.dataset.id) === current?.id;
    button.setAttribute("aria-current", selected ? "true" : "false");
    button.setAttribute("aria-pressed", String(selected && active));
    const row = queue.find(item => item.id === Number(button.dataset.id));
    button.setAttribute("aria-label", `${selected && active ? "暂停" : "播放"} ${titleOf(row)}`);
  }
}
function updateVolume() {
  if (!nodes) return;
  const silent = muted || volume === 0;
  nodes.mute.replaceChildren(icon(silent ? "mute" : "volume")); nodes.mute.setAttribute("aria-label", silent ? "取消静音" : "静音");
  nodes.mute.title = silent ? "取消静音" : "静音"; nodes.mute.setAttribute("aria-pressed", String(silent));
  nodes.volume.value = String(Math.round(volume * 100)); nodes.volume.setAttribute("aria-valuetext", `${Math.round(volume * 100)}%${muted ? "，已静音" : ""}`);
}
function updateProgress() {
  if (!nodes) return;
  const audio = session?.audio, duration = seconds(audio?.duration), position = seconds(audio?.currentTime);
  nodes.seek.disabled = !audio || !duration || status === "error";
  nodes.seek.max = String(duration); nodes.seek.value = String(Math.min(position, duration));
  nodes.seek.style.setProperty("--progress", `${duration ? Math.min(100, position / duration * 100) : 0}%`);
  nodes.seek.setAttribute("aria-valuetext", `${time(position)} / ${duration ? time(duration) : "时长未知"}`);
  nodes.elapsed.textContent = time(position); nodes.duration.textContent = duration ? time(duration) : "—";
}
function seekTo(value) {
  if (!session || !Number.isFinite(value) || !Number.isFinite(session.audio.duration) || session.audio.duration <= 0) return;
  try { session.audio.currentTime = Math.max(0, Math.min(value, session.audio.duration)); updateProgress(); }
  catch { nodes.status.textContent = "当前音频尚不能跳转，请稍候重试。"; }
}
function playNeighbour(offset) {
  const index = queue.findIndex(row => row.id === current?.id), row = queue[index + offset];
  if (row) playTrack(row, { rows: [...queue] });
}
function togglePlayback() {
  if (!current) return;
  if (!canPlay()) { stopAudioPlayer(); return; }
  if (!session || status === "error") { clearSession(); startSource(); return; }
  if (session.wantsPlay) {
    session.wantsPlay = false; session.attempt++; session.audio.pause(); announce("paused", "已暂停");
  } else {
    if (session.audio.ended || status === "ended") session.audio.currentTime = 0;
    void startPlaying(session);
  }
}
function startSource() {
  if (!current || !canPlay()) { stopAudioPlayer(); return; }
  const audio = document.createElement("audio");
  audio.id = "audio-player-media"; audio.preload = "none"; audio.controls = false; audio.hidden = true;
  audio.volume = volume; audio.muted = muted; audio.setAttribute("playsinline", "");
  const value = { audio, events: new AbortController(), diagnostic: null, errorHandled: false, disposed: false, wantsPlay: false, attempt: 0, id: current.id };
  session = value;
  const listen = (name, handler) => audio.addEventListener(name, () => { if (isCurrent(value)) handler(); }, { signal: value.events.signal });
  for (const name of ["timeupdate", "durationchange", "loadedmetadata", "seeked"]) listen(name, updateProgress);
  listen("playing", () => { if (!value.wantsPlay || !canPlay({ allowInert: true })) { audio.pause(); return; } announce("playing", "正在试听"); });
  listen("pause", () => { if (audio.paused && !audio.ended && status !== "error") { value.wantsPlay = false; value.attempt++; announce("paused", "已暂停"); } });
  listen("waiting", () => { if (value.wantsPlay) announce("loading", "正在缓冲…"); });
  listen("stalled", () => { if (value.wantsPlay) announce("loading", "正在等待音频数据…"); });
  listen("ended", () => { value.wantsPlay = false; value.attempt++; announce("ended", "播放结束 · 可手动选择下一首"); updateProgress(); });
  listen("error", () => void failed(value, audio.error));
  nodes.host.append(audio);
  // No speculative source/preload: this function runs only after a play click.
  audio.src = `/api/tracks/${current.id}/audio`;
  updateProgress(); void startPlaying(value);
}
async function startPlaying(value) {
  if (!isCurrent(value)) return;
  if (!canPlay()) { stopAudioPlayer(); return; }
  value.diagnostic?.abort(); value.diagnostic = null;
  value.wantsPlay = true; const attempt = ++value.attempt;
  announce("loading", "正在读取音频…");
  try {
    await value.audio.play();
    if (!isCurrent(value)) { value.audio.pause(); return; }
    if (attempt !== value.attempt) { if (!value.wantsPlay) value.audio.pause(); return; }
    if (!value.wantsPlay) value.audio.pause();
  } catch (error) {
    if (!isCurrent(value) || attempt !== value.attempt || !value.wantsPlay) return;
    if (error?.name === "NotAllowedError") { value.wantsPlay = false; announce("paused", "浏览器暂停了播放，请再次点击播放。"); return; }
    if (error?.name === "AbortError") { value.wantsPlay = false; announce("paused", "已暂停，可点击继续播放。"); return; }
    await failed(value, value.audio.error || { code: error?.name === "NotSupportedError" ? 4 : 2 });
  }
}
async function failed(value, error) {
  if (!isCurrent(value) || value.errorHandled) return;
  value.errorHandled = true;
  value.wantsPlay = false; value.attempt++; value.audio.pause();
  const fallback = error?.code === 4 ? "当前浏览器无法播放这个音频格式。" : error?.code === 3 ? "音频无法解码，文件可能损坏或格式不受支持。" : "音频读取失败，请重试。";
  announce("error", fallback); updateProgress();
  const controller = new AbortController(); value.diagnostic = controller;
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // Native media errors conceal HTTP status. Diagnose only this explicit failed play.
    const response = await fetch(`/api/tracks/${value.id}/audio`, { method: "HEAD", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    if (!isCurrent(value) || controller.signal.aborted || value.diagnostic !== controller) return;
    if (response.status === 401) { window.dispatchEvent(new CustomEvent("metatidy:unauthorized", { detail: "登录已过期，请重新登录。" })); return; }
    const messages = { 404: "音频文件或索引记录不存在，请检查文件后重新扫描。", 403: "该音频路径无法访问。", 400: "音频路径无效或不是可播放的文件。", 415: "这个文件格式暂不支持试听。", 422: "曲目资料无效，请刷新曲库后重试。" };
    if (!response.ok) nodes.status.textContent = messages[response.status] || `音频服务暂不可用（${response.status}），请稍后重试。`;
  } catch { /* Keep the native decode/network error; a failed HEAD never retries playback. */ }
  finally { clearTimeout(timer); if (value.diagnostic === controller) value.diagnostic = null; }
}
