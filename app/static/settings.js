/** Settings and aliases keep independent drafts across internal navigation. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import * as storage from "./storage.js";
import { state, emit } from "./store.js";

const SETTING_IDS = {
  dir_template: "set-dir-template", filename_template: "set-filename-template",
  conflict_policy: "set-conflict", unknown_artist: "set-unknown-artist",
  unknown_album: "set-unknown-album", unknown_other: "set-unknown-other",
};
const SWITCH_IDS = {
  write_cover: "set-write-cover", write_lyrics: "set-write-lyrics",
  overwrite_existing: "set-overwrite", normalize_artist_ampersand: "set-normalize",
};
const aliasDrafts = Object.fromEntries(["artist", "album"].map((kind) => [kind, {
  loaded: false, attempted: false, dirty: false, revision: 0, saving: false, loading: null, saved: [],
}]));
let nodes = null;
let dirty = false;
let revision = 0;
let loaded = false;
let saving = false;
let sourceChoice = new Set();
let sourceSignature = "";

export function init() {
  if (nodes) return;
  nodes = {
    statusKv: ui.byId("status-kv"), statusReload: ui.byId("btn-status-reload"),
    dir: ui.byId("set-dir-template"), filename: ui.byId("set-filename-template"),
    conflict: ui.byId("set-conflict"), unknownArtist: ui.byId("set-unknown-artist"),
    unknownAlbum: ui.byId("set-unknown-album"), unknownOther: ui.byId("set-unknown-other"),
    sources: ui.byId("set-sources"), writeCover: ui.byId("set-write-cover"),
    writeLyrics: ui.byId("set-write-lyrics"), overwrite: ui.byId("set-overwrite"),
    normalize: ui.byId("set-normalize"), save: ui.byId("btn-settings-save"),
    reload: ui.byId("btn-settings-reload"), dirtyHint: ui.byId("settings-dirty"),
    result: ui.byId("settings-result"),
  };
  ui.byId("panel-settings")?.classList.add("settings-workspace");
  nodes.save.closest(".card")?.classList.add("settings-editor-card");
  nodes.save.parentElement.classList.add("settings-save-bar");
  nodes.dirtyHint.setAttribute("role", "status");
  const editorHint = nodes.save.closest(".card")?.querySelector(".card-head .hint");
  if (editorHint) editorHint.textContent = "保存后长期保留；未保存的草稿可在页面间继续编辑";

  for (const id of Object.values(SETTING_IDS)) {
    ui.byId(id).disabled = true;
    ui.byId(id)?.addEventListener("input", markDirty);
    ui.byId(id)?.addEventListener("change", markDirty);
  }
  for (const id of Object.values(SWITCH_IDS)) {
    ui.byId(id).disabled = true;
    ui.byId(id)?.addEventListener("change", markDirty);
  }
  nodes.save.addEventListener("click", saveSettings);
  nodes.reload.addEventListener("click", discardSettings);
  storage.init(nodes.statusKv, nodes.statusReload);
  nodes.statusReload.addEventListener("click", () => emit("status:refresh"));

  for (const kind of ["artist", "album"]) initAliasEditor(kind);
  updateSettingsDraft();
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function markDirty() {
  dirty = true;
  revision += 1;
  updateSettingsDraft();
}

function updateSettingsDraft(message = "") {
  nodes.dirtyHint.textContent = message || (dirty ? "有未保存的修改 · 切换页面会保留" : "已与保存的设置同步");
  nodes.dirtyHint.className = `hint settings-draft ${dirty ? "hint-warn is-dirty" : ""}`;
  nodes.save.disabled = saving || !loaded;
  nodes.reload.disabled = saving || !loaded;
  nodes.save.textContent = saving ? "保存中…" : "保存设置";
}

export function onStatus(status) {
  storage.onStatus(status);
}

function renderSourceDefaults() {
  sourceSignature = JSON.stringify(state.sources);
  ui.clear(nodes.sources);
  if (!state.sources.length) {
    nodes.sources.append(ui.el("span", { class: "hint", text: "没有读取到数据源列表。" }));
    return;
  }
  for (const source of state.sources) {
    const input = ui.el("input", { type: "checkbox", checked: sourceChoice.has(source.name), "aria-label": `默认启用数据源 ${source.label}` });
    input.dataset.source = source.name;
    input.addEventListener("change", () => {
      if (input.checked) sourceChoice.add(source.name);
      else sourceChoice.delete(source.name);
      markDirty();
    });
    nodes.sources.append(ui.el("label", { class: "check", title: `${source.label} · ${source.status}${source.needs_key ? ` · 需要 ${source.needs_key}` : ""}` }, [
      input, ui.el("span", { text: source.label }),
      ui.el("span", { class: `badge ${source.status === "不可用" ? "badge-warn" : "badge-mute"}`, text: source.status }),
    ]));
  }
  for (const [label, availableOnly] of [["全选", false], ["只留可用", true]]) {
    nodes.sources.append(ui.el("button", {
      type: "button", class: "btn btn-sm", text: label,
      onClick: () => {
        for (const input of nodes.sources.querySelectorAll("input[type=checkbox]")) {
          const source = state.sources.find((entry) => entry.name === input.dataset.source);
          input.checked = !availableOnly || Boolean(source && source.status !== "不可用");
          if (input.checked) sourceChoice.add(input.dataset.source);
          else sourceChoice.delete(input.dataset.source);
        }
        markDirty();
      },
    }));
  }
}

export function onSettings() {
  // Startup requests and tab navigation both call this hook. Neither may
  // overwrite a draft, including edits made while a save is in flight.
  if (!nodes || !state.settings?.values) return;
  if (dirty || saving) {
    // The source catalogue can arrive after settings. Keep existing choices
    // when rendering that late response; it must not reset other draft fields.
    if (sourceSignature !== JSON.stringify(state.sources)) renderSourceDefaults();
    return;
  }
  fillForm();
}

function fillForm() {
  const values = state.settings?.values || {};
  for (const [key, id] of Object.entries(SETTING_IDS)) {
    ui.byId(id).disabled = false;
    if (key !== "conflict_policy") ui.byId(id).value = values[key] || "";
  }
  nodes.conflict.replaceChildren(...[
    ["rename", "目标存在时自动改名"], ["skip", "目标存在时跳过"], ["overwrite", "覆盖目标文件（谨慎）"],
  ].map(([value, text]) => ui.el("option", { value, text })));
  nodes.conflict.value = values.conflict_policy || "rename";
  for (const [key, id] of Object.entries(SWITCH_IDS)) {
    ui.byId(id).disabled = false;
    ui.byId(id).checked = Boolean(values[key]);
  }
  sourceChoice = new Set(values.enabled_sources || []);
  renderSourceDefaults();
  loaded = true;
  dirty = false;
  updateSettingsDraft();
}

function collectValues() {
  const values = Object.fromEntries(Object.entries(SETTING_IDS).map(([key, id]) => [key, ui.byId(id).value]));
  for (const [key, id] of Object.entries(SWITCH_IDS)) values[key] = ui.byId(id).checked;
  values.enabled_sources = [...sourceChoice];
  return values;
}

async function discardSettings() {
  if (saving || !loaded) return;
  if (dirty && !await ui.confirmDialog({
    title: "放弃这份设置草稿？", message: "整理模板、默认数据源和写入开关将恢复为最近保存的设置。别名草稿会继续保留。",
    confirmLabel: "放弃修改",
  })) return;
  revision += 1;
  fillForm();
  nodes.result.replaceChildren();
  ui.toast("info", "已还原为最近保存的设置", "");
}

async function saveSettings() {
  if (saving || !loaded) return;
  const payload = collectValues();
  const submittedRevision = revision;
  saving = true;
  updateSettingsDraft();
  nodes.result.replaceChildren();
  try {
    const response = await api.saveSettings(payload);
    state.settings = { ...(state.settings || {}), values: { ...payload, ...(response.saved || {}) } };
    const warnings = Array.isArray(response.warnings) ? response.warnings : [];
    const newerEdits = submittedRevision !== revision;
    if (!newerEdits) dirty = false;
    const message = newerEdits ? "提交时的设置已保存，之后的修改仍是草稿。" : `已保存 ${Object.keys(response.saved || {}).length} 项设置。`;
    nodes.result.append(ui.el("div", { class: "result-block" }, [
      ui.notice(warnings.length || newerEdits ? "warn" : "ok", message),
      ...warnings.map((text) => ui.el("p", { class: "hint", text })),
    ]));
    ui.toast(warnings.length ? "warn" : "ok", newerEdits ? "已保存提交时的设置" : "设置已保存", newerEdits ? "新的修改还没有保存" : warnings.length ? `${warnings.length} 条模板提示` : "");
    emit("settings:saved");
  } catch (error) {
    nodes.result.replaceChildren(ui.notice("err", `保存失败：${error.message}`));
    ui.toast("err", "保存设置失败", error.message);
  } finally {
    saving = false;
    updateSettingsDraft();
  }
}

function initAliasEditor(kind) {
  const draft = aliasDrafts[kind];
  draft.body = ui.byId(`alias-${kind}-body`);
  draft.add = ui.byId(`alias-${kind}-add`);
  draft.save = ui.byId(`alias-${kind}-save`);
  draft.result = ui.byId(`alias-${kind}-result`);
  const card = draft.body.closest(".card");
  card.classList.add("settings-alias-card");
  draft.hint = ui.el("span", { id: `alias-${kind}-dirty`, class: "hint settings-draft", role: "status" });
  draft.reload = ui.el("button", {
    type: "button", id: `alias-${kind}-reload`, class: "btn btn-sm btn-ghost", text: "放弃修改",
    onClick: () => discardAliases(kind),
  });
  draft.result.before(ui.el("div", { class: "alias-draft-bar" }, [draft.hint, draft.reload]));
  draft.add.textContent = "添加别名";
  draft.add.addEventListener("click", () => {
    if (!draft.loaded) return;
    const row = addAliasRow(kind);
    markAliasDirty(kind);
    row.querySelector("input")?.focus();
  });
  draft.save.addEventListener("click", () => saveAliases(kind));
  updateAliasDraft(kind);
}

function markAliasDirty(kind) {
  const draft = aliasDrafts[kind];
  draft.dirty = true;
  draft.revision += 1;
  updateAliasDraft(kind);
}

function updateAliasDraft(kind) {
  const draft = aliasDrafts[kind];
  draft.hint.textContent = draft.loading ? "正在读取别名…" : draft.dirty ? "有未保存的别名 · 切换页面会保留" : draft.loaded ? "别名已保存" : "尚未读取别名";
  draft.hint.className = `hint settings-draft ${draft.dirty ? "hint-warn is-dirty" : ""}`;
  draft.save.disabled = draft.saving || !draft.loaded;
  draft.save.textContent = draft.saving ? "保存中…" : "保存";
  draft.add.disabled = !draft.loaded;
  draft.reload.disabled = draft.saving || Boolean(draft.loading);
  draft.reload.textContent = draft.loaded ? "放弃修改" : "重新读取";
}

function addAliasRow(kind, item = { from: "", to: "" }) {
  const draft = aliasDrafts[kind];
  const tr = ui.el("tr");
  for (const [key, label] of [["from", "原名"], ["to", "替换为"]]) {
    const input = ui.el("input", { type: "text", value: item[key] || "", "aria-label": `别名${label}`, placeholder: label });
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      markAliasDirty(kind);
    });
    tr.append(ui.el("td", {}, [input]));
  }
  tr.append(ui.el("td", { class: "act" }, [ui.el("button", {
    type: "button", class: "btn btn-sm btn-ghost", "aria-label": "删除这一行别名", title: "删除这一行别名",
    onClick: () => { tr.remove(); markAliasDirty(kind); },
  }, [ui.icon("close", { size: 14 })])]));
  draft.body.append(tr);
  return tr;
}

function renderAliases(kind, items) {
  aliasDrafts[kind].body.replaceChildren();
  for (const item of items.length ? items : [{ from: "", to: "" }]) addAliasRow(kind, item);
}

function loadAliases(kind, { force = false } = {}) {
  const draft = aliasDrafts[kind];
  if (draft.loading) return draft.loading;
  if ((draft.attempted && !force) || draft.dirty || draft.saving) return Promise.resolve();
  draft.attempted = true;
  const requestedRevision = draft.revision;
  draft.loading = (async () => {
    try {
      const data = await api.aliases(kind);
      draft.saved = (data.items || []).map((item) => ({ from: item.from, to: item.to }));
      draft.loaded = true;
      if (!draft.dirty && requestedRevision === draft.revision) renderAliases(kind, draft.saved);
      draft.result.replaceChildren();
    } catch (error) {
      draft.result.replaceChildren(ui.notice("err", `读取别名失败：${error.message}。可点击「重新读取」重试。`));
    } finally {
      draft.loading = null;
      updateAliasDraft(kind);
    }
  })();
  updateAliasDraft(kind);
  return draft.loading;
}

async function discardAliases(kind) {
  const draft = aliasDrafts[kind];
  if (draft.saving || draft.loading) return;
  if (!draft.loaded) { await loadAliases(kind, { force: true }); return; }
  if (draft.dirty && !await ui.confirmDialog({
    title: `放弃${kind === "artist" ? "歌手" : "专辑"}别名草稿？`,
    message: "这一组别名将恢复为最近保存的内容，其他设置与别名草稿会继续保留。", confirmLabel: "放弃修改",
  })) return;
  draft.revision += 1;
  draft.dirty = false;
  renderAliases(kind, draft.saved);
  draft.result.replaceChildren();
  updateAliasDraft(kind);
}

function collectAliases(kind) {
  const draft = aliasDrafts[kind];
  const items = [];
  const seen = new Set();
  for (const [index, row] of [...draft.body.querySelectorAll("tr")].entries()) {
    const inputs = [...row.querySelectorAll("input")];
    if (inputs.length < 2) continue;
    const [from, to] = inputs.map((input) => input.value.trim());
    if (!from && !to) continue;
    if (!from || !to || seen.has(from)) {
      const message = seen.has(from) ? `第 ${index + 1} 行的原名重复，请合并为一条。` : `第 ${index + 1} 行请填写原名和替换名，或删除这一行。`;
      const target = !from || seen.has(from) ? inputs[0] : inputs[1];
      target.setAttribute("aria-invalid", "true");
      target.focus();
      draft.result.replaceChildren(ui.notice("warn", message));
      return null;
    }
    seen.add(from);
    items.push({ from, to });
  }
  return items;
}

async function saveAliases(kind) {
  const draft = aliasDrafts[kind];
  if (draft.saving || !draft.loaded) return;
  const items = collectAliases(kind);
  if (!items) return;
  const submittedRevision = draft.revision;
  draft.saving = true;
  draft.result.replaceChildren();
  updateAliasDraft(kind);
  try {
    const response = await api.saveAliases(kind, items);
    draft.saved = items.map((item) => ({ ...item }));
    const newerEdits = draft.revision !== submittedRevision;
    if (!newerEdits) draft.dirty = false;
    draft.result.append(ui.notice(newerEdits ? "warn" : "ok", newerEdits
      ? "提交时的别名已保存，之后的修改仍是草稿。"
      : `已保存 ${response.saved ?? items.length} 条${kind === "artist" ? "歌手" : "专辑"}别名。`));
    ui.toast("ok", "别名库已保存", newerEdits ? "新的修改还没有保存" : `${response.saved ?? items.length} 条`);
  } catch (error) {
    draft.result.replaceChildren(ui.notice("err", `保存失败：${error.message}`));
    ui.toast("err", "别名库保存失败", error.message);
  } finally {
    draft.saving = false;
    updateAliasDraft(kind);
  }
}

export function refreshAll() {
  return Promise.allSettled([storage.ensureLoaded(), loadAliases("artist"), loadAliases("album")]);
}

export function isDirty() {
  return dirty || Object.values(aliasDrafts).some((draft) => draft.dirty);
}
