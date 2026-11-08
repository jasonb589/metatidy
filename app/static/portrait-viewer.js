/** Local portrait inspection only. No source fetching, reuse, target selection or upload. */
import { api } from "./api.js";
import * as ui from "./ui.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = { jpeg: { label: "JPEG 上传用图", extension: "jpg", limit: 1024 }, avif: { label: "AVIF 缩略图", extension: "avif", limit: 512 } };
let activeViewer = null;

export function closePortraitViewer(options) { activeViewer?.close(options); }
export function invalidatePortraitViewer() { closePortraitViewer({ restoreFocus: false }); }

function sourcePage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.last.fm", "last.fm"].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443") && /^\/music\/[^/]+\/?$/.test(url.pathname) && !url.search && !url.hash ? url.href : "";
  } catch { return ""; }
}

function validPortrait(value, id) {
  return value?.id === id && typeof value.artist === "string" && value.artist.trim() &&
    Number.isInteger(value.width) && value.width > 0 && value.width <= 1024 &&
    Number.isInteger(value.height) && value.height > 0 && value.height <= 1024 &&
    Number.isFinite(value.created_at) && value.created_at > 0 && value.upload_format === "jpeg" && value.preview_format === "avif" &&
    value.preview_url === `/api/artist-portraits/${id}/preview`;
}

export function openPortraitViewer(id, { trigger } = {}) {
  if (!UUID.test(String(id || ""))) return null;
  closePortraitViewer({ restoreFocus: false });
  // Sync confirmation and other native dialogs retain their own exclusive flow.
  if (document.querySelector("dialog[open]")) return null;
  const opener = trigger instanceof HTMLElement ? trigger : document.activeElement;
  let closed = false, portrait = null, format = "jpeg", zoom = "fit", imageUrl = "", imageSequence = 0;
  let detailController = null, imageController = null, downloadController = null;
  let imageReady = false;
  const temporaryUrls = new Set();
  const downloadTimers = new Set();
  const makeButton = (id, label, action, cls = "") => ui.el("button", { id, type: "button", class: `btn btn-sm ${cls}`.trim(), text: label, onClick: action });
  const dialog = ui.el("dialog", { id: "portrait-viewer", class: "portrait-viewer", "aria-labelledby": "portrait-viewer-title", "aria-describedby": "portrait-viewer-policy", dataset: { zoom, format } });
  const heading = ui.el("h2", { id: "portrait-viewer-title", text: "本地头像" });
  const closeButton = ui.el("button", { id: "portrait-viewer-close", type: "button", class: "btn btn-ghost pv-close", autofocus: true, "aria-label": "关闭头像大图", title: "关闭（Esc）", onClick: () => close() }, [ui.icon("close", { size: 18 })]);
  const formatButtons = Object.fromEntries(Object.entries(FORMATS).map(([key, value]) => [key, makeButton(`portrait-viewer-${key}`, value.label, () => void loadImage(key))]));
  const fitButton = makeButton("portrait-viewer-fit", "适应窗口", () => setZoom("fit"));
  const actualButton = makeButton("portrait-viewer-actual", "100%", () => setZoom("actual"));
  actualButton.title = "按真实像素查看，可滚动图片";
  const status = ui.el("p", { id: "portrait-viewer-status", class: "pv-status", role: "status", text: "正在校验本地头像资料…" });
  const retry = makeButton("portrait-viewer-retry", "重试", () => portrait ? void loadImage(format) : void loadDetails(), "btn-ghost");
  retry.hidden = true;
  const stage = ui.el("div", { id: "portrait-viewer-stage", class: "pv-stage", tabindex: "0", "aria-label": "头像大图；100% 模式下可用方向键滚动", "aria-busy": "true" });
  const canvas = ui.el("div", { class: "pv-canvas" });
  stage.append(canvas);
  const dimensions = ui.el("span", { id: "portrait-viewer-dimensions", text: "图片尚未载入" });
  const date = ui.el("time", { id: "portrait-viewer-date" });
  const source = ui.el("div", { class: "pv-source" });
  const policy = ui.el("p", { id: "portrait-viewer-policy", class: "pv-policy", text: "JPEG 为上传用重编码图片（最长边 1024px，质量 90）；AVIF 为最长边 512px 的缩略图。均为本地缓存文件。" });
  const downloadStatus = ui.el("p", { id: "portrait-viewer-download-status", class: "pv-status", role: "status" });
  const downloads = Object.fromEntries(Object.keys(FORMATS).map(key => [key, makeButton(`portrait-viewer-download-${key}`, `下载 ${key.toUpperCase()}`, () => void download(key), key === "jpeg" ? "btn-primary" : "")]));
  const cancelDownload = makeButton("portrait-viewer-download-cancel", "取消下载", () => abortDownload(true), "btn-ghost");
  cancelDownload.hidden = true;
  dialog.append(
    ui.el("header", { class: "pv-head" }, [ui.el("div", { class: "pv-heading" }, [ui.el("p", { class: "eyebrow", text: "LOCAL PORTRAIT" }), heading]), closeButton]),
    ui.el("div", { class: "pv-toolbar" }, [
      ui.el("div", { class: "pv-switch", role: "group", "aria-label": "查看图片格式" }, Object.values(formatButtons)),
      ui.el("div", { class: "pv-switch pv-zoom", role: "group", "aria-label": "图片缩放" }, [fitButton, actualButton]),
    ]),
    ui.el("div", { class: "pv-load" }, [status, retry]), stage,
    ui.el("footer", { class: "pv-footer" }, [
      ui.el("div", { class: "pv-information" }, [ui.el("div", { class: "pv-facts" }, [dimensions, date, source]), policy]),
      ui.el("div", { class: "pv-downloads" }, [ui.el("div", { class: "pv-download-actions" }, [...Object.values(downloads), cancelDownload]), downloadStatus]),
    ]),
  );

  function current() { return !closed && dialog.open; }
  function createUrl(blob) { const url = URL.createObjectURL(blob); temporaryUrls.add(url); return url; }
  function revoke(url) { if (temporaryUrls.delete(url)) URL.revokeObjectURL(url); }
  function clearImage() {
    imageReady = false;
    const image = canvas.querySelector("img");
    if (image) image.removeAttribute("src");
    canvas.replaceChildren();
    if (imageUrl) revoke(imageUrl);
    imageUrl = "";
    dimensions.textContent = `${format.toUpperCase()} · 图片尚未载入`;
  }
  function updateControls() {
    for (const [key, button] of Object.entries(formatButtons)) { button.disabled = !portrait; button.setAttribute("aria-pressed", String(key === format)); }
    fitButton.disabled = actualButton.disabled = !imageReady;
    fitButton.setAttribute("aria-pressed", String(zoom === "fit"));
    actualButton.setAttribute("aria-pressed", String(zoom === "actual"));
    for (const button of Object.values(downloads)) button.disabled = !portrait || Boolean(downloadController);
    cancelDownload.hidden = !downloadController;
    dialog.dataset.format = format;
  }
  function setZoom(value) {
    if (!imageReady || !["fit", "actual"].includes(value)) return;
    zoom = value;
    dialog.dataset.zoom = zoom;
    stage.scrollTo({ top: 0, left: 0, behavior: "instant" });
    updateControls();
  }
  function abortDownload(announce = false) {
    downloadController?.abort();
    downloadController = null;
    if (announce) { downloadStatus.textContent = "下载已取消。"; downloadStatus.dataset.tone = ""; }
    updateControls();
  }
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    imageSequence++;
    detailController?.abort(); imageController?.abort(); abortDownload();
    clearImage();
    for (const timer of downloadTimers) clearTimeout(timer);
    for (const url of [...temporaryUrls]) revoke(url);
    window.removeEventListener("hashchange", invalidatePortraitViewer);
    window.removeEventListener("metatidy:unauthorized", invalidatePortraitViewer);
    if (activeViewer?.close === close) activeViewer = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (restoreFocus && opener instanceof HTMLElement && opener.isConnected && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
  }
  async function loadDetails() {
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    retry.hidden = true;
    status.textContent = "正在校验本地头像资料…";
    status.dataset.tone = "";
    try {
      const result = await api.artistPortraitDetail(id, { signal: controller.signal });
      if (!current() || detailController !== controller || controller.signal.aborted) return;
      if (!validPortrait(result?.portrait, id)) throw new Error("返回的头像资料不完整或与当前项目不一致");
      portrait = result.portrait;
      heading.textContent = portrait.artist;
      date.textContent = `获取于 ${new Date(portrait.created_at * 1000).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
      const page = sourcePage(portrait.source_page);
      source.replaceChildren(page ? ui.el("a", { href: page, target: "_blank", rel: "noopener noreferrer", text: "Last.fm 来源页面 ↗" }) : ui.el("span", { text: "来源页面不可用" }));
      updateControls();
      await loadImage(format);
    } catch (error) {
      if (!current() || detailController !== controller || controller.signal.aborted) return;
      status.textContent = `无法查看这张头像：${error.message}`;
      status.dataset.tone = "error";
      stage.setAttribute("aria-busy", "false");
      retry.hidden = false;
    }
  }
  async function loadImage(nextFormat) {
    if (!current() || !portrait || !FORMATS[nextFormat]) return;
    imageController?.abort();
    const controller = new AbortController(), sequence = ++imageSequence;
    imageController = controller;
    format = nextFormat;
    clearImage();
    retry.hidden = true;
    status.textContent = `正在读取本地 ${FORMATS[format].label}…`;
    status.dataset.tone = "";
    stage.setAttribute("aria-busy", "true");
    updateControls();
    const valid = () => current() && imageController === controller && sequence === imageSequence && !controller.signal.aborted;
    try {
      const blob = await api.artistPortraitImage(id, nextFormat, { signal: controller.signal });
      if (!valid()) return;
      const url = createUrl(blob);
      imageUrl = url;
      const image = ui.el("img", { src: url, alt: `${portrait.artist} · ${FORMATS[nextFormat].label}`, decoding: "async", draggable: "false" });
      await image.decode();
      if (!valid()) { revoke(url); return; }
      if (!image.naturalWidth || !image.naturalHeight || Math.max(image.naturalWidth, image.naturalHeight) > FORMATS[nextFormat].limit || (nextFormat === "jpeg" && (image.naturalWidth !== portrait.width || image.naturalHeight !== portrait.height))) throw new Error("图片实际尺寸与本地资料不一致");
      canvas.append(image);
      imageReady = true;
      dimensions.textContent = `${nextFormat.toUpperCase()} · ${image.naturalWidth} × ${image.naturalHeight} px`;
      status.textContent = nextFormat === "jpeg" ? "上传用 JPEG · 完整画面" : "AVIF 缩略图 · 完整画面";
      stage.scrollTo({ top: 0, left: 0, behavior: "instant" });
    } catch (error) {
      if (!valid()) return;
      clearImage();
      status.textContent = `图片未能载入：${error.message || "无法解码本地图片"}。可重试或切换格式。`;
      status.dataset.tone = "error";
      retry.hidden = false;
    } finally {
      if (valid()) { stage.setAttribute("aria-busy", "false"); updateControls(); }
    }
  }
  async function download(downloadFormat) {
    if (!current() || !portrait || downloadController) return;
    const controller = new AbortController();
    downloadController = controller;
    downloadStatus.textContent = `正在准备 ${downloadFormat.toUpperCase()} 文件…`;
    downloadStatus.dataset.tone = "";
    updateControls();
    const valid = () => current() && downloadController === controller && !controller.signal.aborted;
    try {
      const blob = await api.artistPortraitDownload(id, downloadFormat, { signal: controller.signal });
      if (!valid()) return;
      const url = createUrl(blob);
      const anchor = ui.el("a", { href: url, download: `portrait-${id.toLowerCase()}.${FORMATS[downloadFormat].extension}`, hidden: true });
      dialog.append(anchor);
      anchor.click(); anchor.remove();
      // Leave one task for the browser to take ownership; close/leave also releases it.
      const timer = setTimeout(() => { revoke(url); downloadTimers.delete(timer); }, 1000);
      downloadTimers.add(timer);
      downloadStatus.textContent = `${downloadFormat.toUpperCase()} 已交给浏览器保存。`;
    } catch (error) {
      if (!valid()) return;
      downloadStatus.textContent = `下载失败：${error.message}`;
      downloadStatus.dataset.tone = "error";
    } finally {
      if (downloadController === controller) { downloadController = null; if (current()) updateControls(); }
    }
  }

  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", event => {
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), a[href], [tabindex='0']")].filter(node => !node.hidden && node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener("hashchange", invalidatePortraitViewer);
  window.addEventListener("metatidy:unauthorized", invalidatePortraitViewer);
  activeViewer = { close };
  document.body.append(dialog);
  dialog.showModal();
  updateControls();
  closeButton.focus({ preventScroll: true });
  void loadDetails();
  return activeViewer;
}
