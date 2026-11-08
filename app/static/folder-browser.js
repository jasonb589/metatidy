/** Index-only folder navigation. Browse and scan actions are explicit handoffs. */
import { api } from "./api.js";
import * as ui from "./ui.js";

let closeActive = null;
const pathValue = value => typeof value === "string" && value.length > 0 && !value.includes("\0");
const count = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

function validResult(value, requested, root) {
  if (!value || !pathValue(value.root) || !pathValue(value.current) || (root && value.root !== root) || (requested.folder && value.current !== requested.folder) || (!requested.folder && value.current !== value.root)) return false;
  if (!Array.isArray(value.breadcrumbs) || !value.breadcrumbs.length || !value.breadcrumbs.every(item => pathValue(item?.name) && pathValue(item?.path))) return false;
  const crumbs = value.breadcrumbs;
  if (crumbs[0].path !== value.root || crumbs.at(-1).path !== value.current || new Set(crumbs.map(item => item.path)).size !== crumbs.length) return false;
  if (value.parent !== (crumbs.length > 1 ? crumbs.at(-2).path : null)) return false;
  if (!count(value.total) || !count(value.total_tracks) || !count(value.direct_tracks) || value.direct_tracks > value.total_tracks || !bytes(value.bytes) || !count(value.page) || value.page < 1 || value.page_size !== 50 || !count(value.pages) || value.pages !== Math.ceil(value.total / value.page_size) || value.page !== Math.max(1, Math.min(Number(requested.page) || 1, value.pages || 1))) return false;
  if (typeof value.can_scan !== "boolean" || value.scan_root !== value.current || !Array.isArray(value.items) || value.items.length > 50 || value.items.length !== Math.min(50, Math.max(0, value.total - (value.page - 1) * 50))) return false;
  const seen = new Set(crumbs.map(item => item.path));
  return value.items.every(item => {
    if (!pathValue(item?.name) || !pathValue(item?.path) || seen.has(item.path) || !count(item.track_count) || !count(item.direct_tracks) || item.direct_tracks > item.track_count || !bytes(item.bytes)) return false;
    seen.add(item.path); return true;
  });
}

export function openFolderBrowser({ onBrowse = () => {}, onScan = () => {}, trigger } = {}) {
  closeActive?.({ restoreFocus: false });
  if (document.querySelector("dialog[open]")) return null;
  const opener = trigger instanceof HTMLElement ? trigger : document.activeElement;
  let closed = false, root = "", data = null, controller = null, generation = 0, loading = false, dirty = false;
  let requested = { folder: undefined, page: 1, q: "" };
  const makeButton = (id, label, action, cls = "") => ui.el("button", { id, type: "button", class: `btn btn-sm ${cls}`.trim(), text: label, onClick: action });
  const dialog = ui.el("dialog", { id: "folder-browser", class: "folder-browser", "aria-labelledby": "folder-browser-title", "aria-describedby": "folder-browser-note" });
  const closeButton = ui.el("button", { id: "folder-browser-close", type: "button", class: "btn btn-ghost fb-close", autofocus: true, "aria-label": "关闭文件夹浏览", title: "关闭（Esc）", onClick: () => close() }, [ui.icon("close", { size: 18 })]);
  const home = makeButton("folder-browser-home", "音乐库根目录", () => navigate(root || undefined), "btn-ghost");
  const up = makeButton("folder-browser-up", "上一级", () => { if (data?.parent) navigate(data.parent); }, "btn-ghost");
  const breadcrumbs = ui.el("nav", { id: "folder-browser-breadcrumbs", class: "fb-breadcrumbs", "aria-label": "文件夹位置" });
  const currentPath = ui.el("p", { id: "folder-browser-path", class: "fb-path", text: "正在读取音乐库位置…" });
  const facts = ui.el("p", { id: "folder-browser-facts", class: "fb-facts" });
  const query = ui.el("input", { id: "folder-browser-q", type: "search", maxlength: 200, autocomplete: "off", placeholder: "筛选当前目录的子文件夹…", "aria-label": "筛选当前目录的子文件夹" });
  const search = ui.el("button", { id: "folder-browser-search", type: "submit", class: "btn btn-sm", text: "筛选" });
  const status = ui.el("p", { id: "folder-browser-status", class: "fb-status", role: "status" });
  const retry = makeButton("folder-browser-retry", "重试", () => void load(requested), "btn-ghost");
  retry.hidden = true;
  const items = ui.el("div", { id: "folder-browser-items", class: "fb-items", "aria-label": "子文件夹", "aria-busy": "true" });
  const previous = makeButton("folder-browser-prev", "上一页", () => { if (data) void load({ ...requested, folder: data.current, page: data.page - 1 }); });
  const next = makeButton("folder-browser-next", "下一页", () => { if (data) void load({ ...requested, folder: data.current, page: data.page + 1 }); });
  const page = ui.el("span", { id: "folder-browser-page", class: "fb-page", text: "—" });
  const recursive = ui.el("input", { id: "folder-browser-recursive", type: "checkbox", checked: true });
  const selection = ui.el("p", { id: "folder-browser-selection", class: "fb-selection", text: "选择目录后，在曲库中查看歌曲。" });
  const browse = makeButton("folder-browser-browse", "在曲库查看", () => {
    if (!ready()) return;
    const scope = { folder: data.current, recursive: recursive.checked };
    close({ restoreFocus: false }); onBrowse(scope);
  }, "btn-primary");
  const scan = makeButton("folder-browser-scan", "扫描此目录…", () => {
    if (!ready() || !data.can_scan) return;
    const scanRoot = data.scan_root;
    close({ restoreFocus: false }); onScan(scanRoot);
  });
  const scanNote = ui.el("p", { id: "folder-browser-scan-note", class: "fb-scan-note", text: "扫描会先打开扫描设置。" });
  dialog.append(
    ui.el("header", { class: "fb-head" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "BROWSE YOUR LIBRARY" }), ui.el("h2", { id: "folder-browser-title", text: "按文件夹浏览" })]), closeButton]),
    ui.el("p", { id: "folder-browser-note", class: "fb-note", text: "沿着熟悉的目录找到音乐。这里显示已收录的文件夹；选择后，可在曲库继续筛选和整理。" }),
    ui.el("div", { class: "fb-location" }, [ui.el("div", { class: "fb-navigation" }, [home, up]), breadcrumbs, currentPath, facts]),
    ui.el("form", { class: "fb-search", onSubmit: event => { event.preventDefault(); void load({ ...requested, q: query.value.trim(), page: 1 }); } }, [query, search]),
    ui.el("div", { class: "fb-load" }, [status, retry]), items,
    ui.el("nav", { class: "fb-pagination", "aria-label": "子文件夹分页" }, [page, previous, next]),
    ui.el("footer", { class: "fb-footer" }, [
      ui.el("div", { class: "fb-scope" }, [ui.el("label", { class: "check" }, [recursive, ui.el("span", { text: "包含子文件夹" })]), selection]),
      ui.el("div", { class: "fb-actions" }, [ui.el("div", {}, [scan, browse]), scanNote]),
    ]),
  );

  function ready() { return !closed && dialog.open && Boolean(data) && !loading && !dirty; }
  function updateControls() {
    const valid = ready();
    browse.disabled = !valid;
    scan.disabled = !valid || !data.can_scan;
    recursive.disabled = !data;
    previous.disabled = !valid || data.page <= 1;
    next.disabled = !valid || data.page >= data.pages;
    up.disabled = !data?.parent;
    home.disabled = !root && loading;
    items.setAttribute("aria-busy", String(loading));
    if (data) selection.textContent = `${ui.fmtNum(recursive.checked ? data.total_tracks : data.direct_tracks)} 首歌曲${recursive.checked ? " · 当前目录及其子文件夹" : " · 仅当前目录"}`;
    scanNote.textContent = data && !data.can_scan ? "当前目录不可扫描；仍可查看已收录歌曲。" : "扫描会先打开扫描设置。";
  }
  function render() {
    currentPath.textContent = data.current;
    currentPath.title = data.current;
    facts.textContent = `${ui.fmtNum(data.total_tracks)} 首已收录 · 直属 ${ui.fmtNum(data.direct_tracks)} 首 · ${ui.fmtBytes(data.bytes)}`;
    breadcrumbs.replaceChildren(...data.breadcrumbs.map((item, index) => {
      const button = makeButton("", item.name, () => navigate(item.path), "btn-ghost");
      button.removeAttribute("id"); button.classList.add("fb-crumb"); button.dataset.path = item.path;
      button.title = item.path;
      if (index === data.breadcrumbs.length - 1) button.setAttribute("aria-current", "location");
      return ui.el("span", { class: "fb-crumb-part" }, [index ? ui.el("span", { class: "fb-divider", text: "/", "aria-hidden": "true" }) : null, button]);
    }));
    items.replaceChildren(...data.items.map(item => ui.el("button", { type: "button", class: "fb-folder", dataset: { path: item.path }, "aria-label": `打开文件夹 ${item.name}`, title: item.path, onClick: () => navigate(item.path) }, [
      ui.el("span", { class: "fb-folder-icon", "aria-hidden": "true" }, [ui.icon("folder", { size: 25 })]),
      ui.el("span", { class: "fb-folder-copy" }, [ui.el("strong", { text: item.name }), ui.el("span", { text: `${ui.fmtNum(item.track_count)} 首 · ${ui.fmtBytes(item.bytes)}` }), ui.el("small", { text: `直属 ${ui.fmtNum(item.direct_tracks)} 首` })]),
      ui.el("span", { class: "fb-folder-arrow", text: "›", "aria-hidden": "true" }),
    ])));
    if (!data.items.length) items.append(ui.el("div", { class: "fb-empty" }, [ui.icon("folder", { size: 44 }), ui.el("h3", { text: requested.q ? "没有匹配的子文件夹" : data.total_tracks ? "已到达这一层目录" : "这里还没有已收录的歌曲" }), ui.el("p", { text: requested.q ? "试试其他名称；当前目录的歌曲范围保持不变。" : data.total_tracks ? "可以查看当前目录的歌曲，或沿上方路径返回。" : "可以打开扫描设置，将这个目录中的音乐收录到曲库。" })]));
    page.textContent = `第 ${data.page} / ${Math.max(1, data.pages)} 页 · ${ui.fmtNum(data.total)} 个子文件夹`;
  }
  function navigate(folder) {
    query.value = "";
    void load({ folder, page: 1, q: "" });
  }
  async function load(params) {
    if (closed) return;
    const moveFocus = Boolean(document.activeElement?.closest(".fb-folder, .fb-breadcrumbs, .fb-navigation, .fb-pagination"));
    controller?.abort();
    controller = new AbortController();
    const operation = controller, sequence = ++generation;
    requested = { ...params };
    loading = true; dirty = false;
    retry.hidden = true;
    status.textContent = "正在读取已收录的文件夹…"; status.dataset.tone = "";
    items.replaceChildren();
    updateControls();
    const current = () => !closed && dialog.open && generation === sequence && controller === operation && !operation.signal.aborted;
    try {
      const result = await api.folders({ ...params, page_size: 50 }, { signal: operation.signal });
      if (!current()) return;
      if (!validResult(result, params, root)) throw new Error("返回的目录资料不完整或位置不一致");
      root = result.root; data = result;
      render();
      status.textContent = params.q ? `仅筛选当前目录的子文件夹名称：“${params.q}”` : "点击文件夹进入下一层。";
      if (moveFocus) breadcrumbs.querySelector('[aria-current="location"]')?.focus({ preventScroll: true });
    } catch (error) {
      if (!current()) return;
      dirty = true;
      status.textContent = error.status === 404 ? "这个目录已没有索引记录。可返回上一级或音乐库根目录。" : `无法读取目录：${error.message}`;
      status.dataset.tone = "error";
      retry.hidden = false;
      if (moveFocus) retry.focus({ preventScroll: true });
    } finally { if (current()) { loading = false; updateControls(); } }
  }
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; generation++; controller?.abort();
    window.removeEventListener("hashchange", invalidate);
    window.removeEventListener("metatidy:unauthorized", invalidate);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close(); dialog.remove();
    if (restoreFocus && opener instanceof HTMLElement && opener.isConnected && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
  }
  function invalidate() { close({ restoreFocus: false }); }
  query.addEventListener("input", () => {
    controller?.abort(); generation++; loading = false; dirty = true;
    items.replaceChildren(); status.textContent = "输入已修改，点击筛选查看结果。"; status.dataset.tone = ""; retry.hidden = true;
    updateControls();
  });
  recursive.addEventListener("change", updateControls);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")].filter(node => !node.hidden && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
  });
  closeActive = close;
  window.addEventListener("hashchange", invalidate);
  window.addEventListener("metatidy:unauthorized", invalidate);
  document.body.append(dialog); dialog.showModal(); closeButton.focus({ preventScroll: true });
  void load(requested);
  return { close };
}
