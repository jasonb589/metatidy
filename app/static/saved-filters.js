/** Named library views, stored only in this browser. No server or file writes. */
import * as ui from "./ui.js";
import { normalizeAlbumGroup, albumGroupLabel } from "./album-group.js";

const STORAGE_KEY = "metatidy.saved-filters.v1";
const MAX_ITEMS = 12;
const MAX_NAME = 36;
const TEXT_FILTERS = ["language", "albumtype", "genre", "year", "artist", "album"];
const FLAG_FILTERS = ["missing_cover", "missing_lyrics", "no_artist", "no_album", "not_loaded"];
const SORTS = ["artist", "album", "title", "year", "track", "disc_track", "path", "indexed", "edited"];
const LABELS = {
  language: "语言", albumtype: "专辑类型", genre: "流派", year: "年份", artist: "艺术家", album: "专辑",
  missing_cover: "待补封面", missing_lyrics: "待补歌词", no_artist: "缺少艺术家", no_album: "缺少专辑", not_loaded: "待读标签",
};

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 1000) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const nameKey = (value) => value.normalize("NFKC").toLocaleLowerCase();
const trimName = (value) => String(value || "").trim();
const shortened = (value, max) => [...value].slice(0, max).join("");

/** Fixed keys and defaults make old or malformed saved data safe and comparable. */
function snapshotOf(value) {
  const source = object(value) ? value : {};
  const incoming = object(source.filters) ? source.filters : {};
  const filters = {};
  filters.folder = typeof incoming.folder === "string" && !incoming.folder.includes("\0") ? incoming.folder : "";
  filters.folder_recursive = incoming.folder_recursive !== false;
  for (const key of TEXT_FILTERS) filters[key] = text(incoming[key]);
  for (const key of FLAG_FILTERS) filters[key] = incoming[key] === true;
  filters.album_group = normalizeAlbumGroup(incoming.album_group);
  return {
    q: text(source.q, 4000),
    sort: SORTS.includes(source.sort) ? source.sort : "artist",
    order: source.order === "desc" ? "desc" : "asc",
    page_size: [50, 100, 200].includes(source.page_size) ? source.page_size : 100,
    view: source.view === "cards" ? "cards" : "list",
    density: source.density === "compact" ? "compact" : "comfortable",
    filters,
  };
}

function describe(snapshot) {
  const parts = [];
  if (snapshot.q) parts.push(`搜索：${snapshot.q}`);
  if (snapshot.filters.folder) parts.push(`目录：${snapshot.filters.folder}${snapshot.filters.folder_recursive ? "（含子目录）" : "（仅本层）"}`);
  if (snapshot.filters.album_group) parts.push(`专辑分组：${albumGroupLabel(snapshot.filters.album_group)}`);
  for (const key of TEXT_FILTERS) if (snapshot.filters[key]) parts.push(`${LABELS[key]}：${snapshot.filters[key]}`);
  for (const key of FLAG_FILTERS) if (snapshot.filters[key]) parts.push(LABELS[key]);
  if (!parts.length) parts.push("全部曲目");
  const sortLabel = { artist: "艺术家", album: "专辑", title: "标题", year: "年份", track: "轨号", disc_track: "碟号与曲序", path: "路径", indexed: "索引时间", edited: "编辑时间" }[snapshot.sort];
  parts.push(`${sortLabel}${snapshot.order === "desc" ? "降序" : "升序"}`);
  parts.push(snapshot.view === "cards" ? "封面视图" : `${snapshot.density === "compact" ? "紧凑" : "舒适"}列表`);
  return parts.join(" · ");
}

function readSaved() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { return { items: [], error: "浏览器禁止读取收藏。请允许此站点使用本地存储后重试。", warning: "" }; }
  if (!raw) return { items: [], error: "", warning: "" };
  let data;
  try {
    if (raw.length > 500000) throw new Error("oversized");
    data = JSON.parse(raw);
  } catch {
    return { items: [], error: "", warning: "收藏数据无法读取；保存新收藏会重新建立此浏览器的收藏列表。" };
  }
  if (object(data) && data.version !== 1) {
    return { items: [], error: "此浏览器的收藏格式暂不支持，原数据已保留。请使用创建这些收藏的应用版本。", warning: "" };
  }
  if (!object(data) || !Array.isArray(data.items)) {
    return { items: [], error: "", warning: "收藏数据不完整；保存新收藏会重新建立此浏览器的收藏列表。" };
  }
  const items = [];
  const ids = new Set();
  const names = new Set();
  for (const entry of data.items) {
    if (items.length === MAX_ITEMS) break;
    if (!object(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 80 || !object(entry.snapshot)) continue;
    const name = typeof entry.name === "string" ? trimName(entry.name) : "";
    if (!name || [...name].length > MAX_NAME || ids.has(entry.id) || names.has(nameKey(name))) continue;
    if (entry.snapshot.filters !== undefined && !object(entry.snapshot.filters)) continue;
    ids.add(entry.id);
    names.add(nameKey(name));
    items.push({ id: entry.id, name, snapshot: snapshotOf(entry.snapshot) });
  }
  return { items, error: "", warning: items.length === data.items.length ? "" : "已跳过无效或超出上限的收藏；其余收藏可以正常使用。" };
}

function nameError(value, items, exceptId = "") {
  if (!value) return "请给这个筛选起一个名字。";
  if ([...value].length > MAX_NAME) return `名称最多 ${MAX_NAME} 个字。`;
  if (items.some((item) => item.id !== exceptId && nameKey(item.name) === nameKey(value))) return "已经有同名收藏，请换一个名字。";
  return "";
}

/**
 * host is an empty element inside .library-toolbar. The caller owns live track
 * state and resets page to 1 when applySnapshot is invoked. sync() is cheap and
 * can run after a filter, sort, view or density change without stealing focus.
 */
export function initSavedFilters({ host, getSnapshot, applySnapshot }) {
  if (!host) return { sync() {} };
  host.classList.add("saved-filters");
  host.setAttribute("aria-label", "常用筛选收藏");
  let stored = readSaved();
  let activeDialog = null;
  let managerRefresh = null;
  let managerStale = null;
  let dialogSequence = 0;

  const chips = ui.el("div", { class: "saved-filter-list", role: "group", "aria-label": "已保存的筛选" });
  const hint = ui.el("span", { class: "saved-filter-local", text: "仅此浏览器" });
  const save = ui.el("button", {
    id: "saved-filter-save", type: "button", class: "btn btn-sm btn-ghost saved-filter-save",
    title: "保存当前搜索、筛选、排序和显示方式", onClick: openSave,
  }, [ui.icon("plus", { size: 13 }), "保存当前筛选"]);
  const manage = ui.el("button", {
    id: "saved-filter-manage", type: "button", class: "btn btn-sm btn-ghost", text: "管理", onClick: openManager,
  });
  const warning = ui.el("p", { class: "saved-filter-warning", role: "status", hidden: true });
  host.replaceChildren(
    ui.el("span", { class: "saved-filter-label", text: "常用筛选" }),
    chips,
    ui.el("div", { class: "saved-filter-tools" }, [save, manage, hint]),
    warning,
  );

  function sync() {
    const current = JSON.stringify(snapshotOf(getSnapshot()));
    for (const button of chips.children) {
      const item = stored.items.find((entry) => entry.id === button.dataset.savedFilterId);
      button.setAttribute("aria-pressed", String(Boolean(item && JSON.stringify(item.snapshot) === current)));
    }
  }

  function render() {
    const focusedId = chips.contains(document.activeElement) ? document.activeElement.dataset.savedFilterId : "";
    chips.replaceChildren(...stored.items.map((item) => ui.el("button", {
      type: "button", class: "saved-filter-chip", dataset: { savedFilterId: item.id },
      text: item.name, title: `${item.name}\n${describe(item.snapshot)}`, "aria-pressed": "false",
      onClick: async () => {
        try {
          await applySnapshot(snapshotOf(item.snapshot));
          sync();
        } catch (error) {
          ui.toast("err", "未能应用收藏", error?.message || "请稍后重试。");
          sync();
        }
      },
    })));
    chips.hidden = stored.items.length === 0;
    manage.hidden = stored.items.length === 0;
    hint.hidden = stored.items.length > 0;
    warning.textContent = stored.error || stored.warning;
    warning.hidden = !warning.textContent;
    sync();
    if (focusedId) {
      const replacement = [...chips.children].find((node) => node.dataset.savedFilterId === focusedId);
      (replacement || save).focus({ preventScroll: true });
    }
  }

  /** Re-read before each write so another tab's new entries are not discarded. */
  function commit(mutator) {
    const latest = readSaved();
    if (latest.error) return latest.error;
    const result = mutator(latest.items);
    if (typeof result === "string") return result;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: result })); }
    catch { return "保存失败：浏览器存储不可用或空间不足。当前操作尚未保存，请检查浏览器设置后重试。"; }
    stored = { items: result, error: "", warning: "" };
    render();
    return "";
  }

  function dialog(title, subtitle) {
    if (activeDialog?.open) return null;
    dialogSequence += 1;
    const titleId = `saved-filter-title-${dialogSequence}`;
    const trigger = document.activeElement;
    const node = ui.el("dialog", { id: "saved-filters-dialog", class: "modal saved-filters-dialog", "aria-labelledby": titleId });
    const body = ui.el("div", { class: "modal-body" });
    const footer = ui.el("div", { class: "modal-foot" });
    const close = () => { if (node.open) node.close(); };
    node.append(
      ui.el("div", { class: "modal-head" }, [
        ui.el("div", { class: "saved-filter-heading" }, [
          ui.el("p", { class: "eyebrow", text: "YOUR LIBRARY SHORTCUTS" }),
          ui.el("h2", { id: titleId, text: title }),
          ui.el("p", { class: "sub", text: subtitle }),
        ]),
        ui.el("button", { type: "button", class: "btn btn-sm btn-ghost saved-filter-close", "aria-label": "关闭收藏面板", onClick: close }, [ui.icon("close")]),
      ]), body, footer,
    );
    node.addEventListener("close", () => {
      activeDialog = null;
      managerRefresh = null;
      managerStale = null;
      node.remove();
      const destination = trigger?.isConnected && trigger.getClientRects().length ? trigger : save;
      destination.focus({ preventScroll: true });
    }, { once: true });
    activeDialog = node;
    document.body.append(node);
    return { node, body, footer, close };
  }

  function openSave() {
    const captured = snapshotOf(getSnapshot());
    const sheet = dialog("保存常用筛选", "保存搜索条件、排序和显示方式。收藏仅保存在当前浏览器，不会同步到其他设备。");
    if (!sheet) return;
    const summary = describe(captured);
    const defaultName = captured.q || albumGroupLabel(captured.filters.album_group) || [...TEXT_FILTERS.map((key) => captured.filters[key]), ...FLAG_FILTERS.filter((key) => captured.filters[key]).map((key) => LABELS[key])].filter(Boolean).join(" · ") || "我的曲库";
    const input = ui.el("input", { id: "saved-filter-name", type: "text", value: shortened(defaultName, MAX_NAME), autocomplete: "off", "aria-describedby": "saved-filter-name-hint saved-filter-form-error" });
    const error = ui.el("p", { id: "saved-filter-form-error", class: "saved-filter-form-error", role: "alert", hidden: true });
    const form = ui.el("form", { class: "saved-filter-form" }, [
      ui.el("label", { class: "field", for: "saved-filter-name" }, [ui.el("span", { class: "lbl", text: "收藏名称" }), input]),
      ui.el("p", { id: "saved-filter-name-hint", class: "hint", text: `最多 ${MAX_NAME} 个字，可保存 ${MAX_ITEMS} 个收藏。` }),
      ui.el("div", { class: "saved-filter-preview" }, [ui.icon("filter"), ui.el("p", { text: summary })]),
      error,
    ]);
    if (stored.warning || stored.error) form.append(ui.el("p", { class: "saved-filter-warning", text: stored.error || stored.warning }));
    const submit = () => {
      const name = trimName(input.value);
      const message = commit((items) => {
        const invalid = nameError(name, items);
        if (invalid) return invalid;
        if (items.length >= MAX_ITEMS) return `最多保存 ${MAX_ITEMS} 个收藏，请先在“管理”中删除不再需要的收藏。`;
        const id = globalThis.crypto?.randomUUID?.() || `filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        return [...items, { id, name, snapshot: captured }];
      });
      if (message) {
        error.textContent = message;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      sheet.close();
      ui.toast("ok", "筛选已收藏", `“${name}”已保存在当前浏览器。`);
    };
    form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
    input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); error.hidden = true; });
    sheet.body.append(form);
    sheet.footer.append(
      ui.el("button", { id: "saved-filter-submit", type: "button", class: "btn btn-primary", text: "保存收藏", onClick: submit }),
      ui.el("button", { type: "button", class: "btn", text: "取消", onClick: sheet.close }),
    );
    sheet.node.showModal();
    input.focus();
    input.select();
  }

  function openManager() {
    stored = readSaved();
    render();
    const sheet = dialog("管理常用筛选", "重命名或删除当前浏览器中的收藏。删除收藏不会删除音乐，也不会改变当前筛选。");
    if (!sheet) return;
    const list = ui.el("div", { class: "saved-filter-manager" });
    const status = ui.el("p", { id: "saved-filter-manager-status", class: "hint", role: "status" });
    managerStale = ui.el("div", { class: "saved-filter-stale", hidden: true }, [
      ui.el("span", { text: "其他标签页更新了收藏。此处的输入已保留。" }),
      ui.el("button", { type: "button", class: "btn btn-sm", text: "刷新列表", onClick: () => renderManager() }),
    ]);
    sheet.body.append(managerStale, list, status);
    sheet.footer.append(ui.el("button", { type: "button", class: "btn", text: "完成", onClick: sheet.close }), ui.el("span", { class: "hint", text: "仅保存在当前浏览器" }));

    function renderManager(focusId = "") {
      stored = readSaved();
      render();
      if (managerStale) managerStale.hidden = true;
      list.replaceChildren();
      status.textContent = stored.error || stored.warning || `已保存 ${stored.items.length} / ${MAX_ITEMS} 个收藏`;
      if (!stored.items.length) list.append(ui.el("p", { class: "saved-filter-empty", text: "还没有收藏。关闭面板后，使用“保存当前筛选”添加。" }));
      for (const item of stored.items) {
        const row = ui.el("section", { class: "saved-filter-manager-row", dataset: { savedFilterRow: item.id } });
        const info = ui.el("div", { class: "saved-filter-manager-info" }, [ui.el("h3", { text: item.name }), ui.el("p", { text: describe(item.snapshot) })]);
        const actions = ui.el("div", { class: "saved-filter-manager-actions" });
        const editor = ui.el("div", { class: "saved-filter-editor", hidden: true });
        const rename = ui.el("button", { type: "button", class: "btn btn-sm", text: "重命名", "aria-label": `重命名收藏 ${item.name}`, onClick: () => renameItem(item, actions, editor, rename) });
        const remove = ui.el("button", { type: "button", class: "btn btn-sm btn-ghost", text: "删除", "aria-label": `删除收藏 ${item.name}`, onClick: () => deleteItem(item, actions, editor, remove) });
        actions.append(rename, remove);
        row.append(info, actions, editor);
        list.append(row);
      }
      if (focusId) {
        const row = [...list.children].find((node) => node.dataset.savedFilterRow === focusId);
        (row?.querySelector("button") || list.querySelector("button") || sheet.footer.querySelector("button")).focus({ preventScroll: true });
      }
    }

    function setupEditor(actions, editor, trigger) {
      actions.hidden = true;
      editor.hidden = false;
      editor.replaceChildren();
      const cancel = () => {
        editor.hidden = true;
        editor.replaceChildren();
        actions.hidden = false;
        trigger.focus();
      };
      const error = ui.el("p", { class: "saved-filter-form-error", role: "alert", hidden: true });
      const showError = (message) => { error.textContent = message; error.hidden = false; };
      return { cancel, error, showError };
    }

    function renameItem(item, actions, editor, trigger) {
      const { cancel, error, showError } = setupEditor(actions, editor, trigger);
      const input = ui.el("input", { type: "text", value: item.name, "aria-label": `收藏 ${item.name} 的新名称`, autocomplete: "off" });
      const form = ui.el("form", { class: "saved-filter-rename" });
      form.append(input, ui.el("button", { type: "submit", class: "btn btn-sm btn-primary", text: "保存名称" }), ui.el("button", { type: "button", class: "btn btn-sm", text: "取消", onClick: cancel }));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = trimName(input.value);
        const message = commit((items) => {
          if (!items.some((entry) => entry.id === item.id)) return "这个收藏已在其他标签页被删除，请刷新列表。";
          const invalid = nameError(name, items, item.id);
          if (invalid) return invalid;
          return items.map((entry) => entry.id === item.id ? { ...entry, name } : entry);
        });
        if (message) { showError(message); input.setAttribute("aria-invalid", "true"); input.focus(); return; }
        renderManager(item.id);
        status.textContent = `已重命名为“${name}”。`;
      });
      input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); error.hidden = true; });
      editor.append(form, error);
      input.focus();
      input.select();
    }

    function deleteItem(item, actions, editor, trigger) {
      const { cancel, error, showError } = setupEditor(actions, editor, trigger);
      const confirm = ui.el("button", {
        type: "button", class: "btn btn-sm btn-danger", text: "确认删除收藏",
        onClick: () => {
          const index = stored.items.findIndex((entry) => entry.id === item.id);
          const nextId = stored.items[index + 1]?.id || stored.items[index - 1]?.id || item.id;
          const message = commit((items) => items.filter((entry) => entry.id !== item.id));
          if (message) { showError(message); return; }
          renderManager(nextId);
          status.textContent = `已删除收藏“${item.name}”。音乐和当前筛选保持原样。`;
        },
      });
      const cancelButton = ui.el("button", { type: "button", class: "btn btn-sm", text: "取消", onClick: cancel });
      editor.append(ui.el("p", { class: "saved-filter-delete-question", text: `删除收藏“${item.name}”？` }), ui.el("div", { class: "saved-filter-editor-actions" }, [confirm, cancelButton]), error);
      cancelButton.focus();
    }

    managerRefresh = renderManager;
    renderManager();
    sheet.node.showModal();
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    stored = readSaved();
    render();
    // Other tabs may update the collection while a name is being edited. Keep
    // that form intact, rebase writes on fresh records, and offer an explicit refresh.
    if (managerRefresh && managerStale) managerStale.hidden = false;
  });
  render();
  return { sync };
}
