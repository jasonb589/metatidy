/**
 * 页签 4：设置。
 * 表单 → PUT /api/settings（后端回 {saved, warnings}，warnings 直接显示在表单下方）；
 * 别名库两张可编辑表格 → PUT /api/aliases/{kind}；
 * 顶部状态卡展示后端真实路径，音乐目录不存在时红色告警。
 */

import { api } from "./api.js";
import * as ui from "./ui.js";
import { state, emit } from "./store.js";

const SETTING_IDS = {
  dir_template: "set-dir-template",
  filename_template: "set-filename-template",
  conflict_policy: "set-conflict",
  unknown_artist: "set-unknown-artist",
  unknown_album: "set-unknown-album",
  unknown_other: "set-unknown-other",
};

const SWITCH_IDS = {
  write_cover: "set-write-cover",
  write_lyrics: "set-write-lyrics",
  overwrite_existing: "set-overwrite",
  normalize_artist_ampersand: "set-normalize",
};

let nodes = null;
let dirty = false;

export function init() {
  nodes = {
    statusKv: ui.byId("status-kv"),
    statusReload: ui.byId("btn-status-reload"),
    dir: ui.byId("set-dir-template"),
    filename: ui.byId("set-filename-template"),
    conflict: ui.byId("set-conflict"),
    unknownArtist: ui.byId("set-unknown-artist"),
    unknownAlbum: ui.byId("set-unknown-album"),
    unknownOther: ui.byId("set-unknown-other"),
    sources: ui.byId("set-sources"),
    writeCover: ui.byId("set-write-cover"),
    writeLyrics: ui.byId("set-write-lyrics"),
    overwrite: ui.byId("set-overwrite"),
    normalize: ui.byId("set-normalize"),
    save: ui.byId("btn-settings-save"),
    reload: ui.byId("btn-settings-reload"),
    dirtyHint: ui.byId("settings-dirty"),
    result: ui.byId("settings-result"),
    aliasArtistBody: ui.byId("alias-artist-body"),
    aliasAlbumBody: ui.byId("alias-album-body"),
    aliasArtistAdd: ui.byId("alias-artist-add"),
    aliasAlbumAdd: ui.byId("alias-album-add"),
    aliasArtistSave: ui.byId("alias-artist-save"),
    aliasAlbumSave: ui.byId("alias-album-save"),
    aliasArtistResult: ui.byId("alias-artist-result"),
    aliasAlbumResult: ui.byId("alias-album-result"),
  };

  Object.values(SETTING_IDS).forEach((id) => {
    const node = ui.byId(id);
    if (node) node.addEventListener("input", markDirty);
    if (node) node.addEventListener("change", markDirty);
  });
  Object.values(SWITCH_IDS).forEach((id) => {
    const node = ui.byId(id);
    if (node) node.addEventListener("change", markDirty);
  });

  nodes.save.addEventListener("click", saveSettings);
  nodes.reload.addEventListener("click", () => {
    fillForm();
    ui.toast("info", "已还原为后端当前设置", "");
  });
  nodes.statusReload.addEventListener("click", () => emit("status:refresh"));

  nodes.aliasArtistAdd.addEventListener("click", () => addAliasRow(nodes.aliasArtistBody));
  nodes.aliasAlbumAdd.addEventListener("click", () => addAliasRow(nodes.aliasAlbumBody));
  nodes.aliasArtistSave.addEventListener("click", () => saveAliases("artist", nodes.aliasArtistBody, nodes.aliasArtistResult));
  nodes.aliasAlbumSave.addEventListener("click", () => saveAliases("album", nodes.aliasAlbumBody, nodes.aliasAlbumResult));
}

function markDirty() {
  dirty = true;
  ui.setText(nodes.dirtyHint, "有未保存的修改");
  nodes.dirtyHint.className = "hint hint-warn";
}

export function onStatus(status) {
  const rows = [
    ["版本", status.version || "—", ""],
    ["音乐目录", status.music_dir || "—", status.music_dir_exists ? "good" : "bad"],
    ["音乐目录存在", status.music_dir_exists ? "是" : "否 —— 扫描会直接失败", status.music_dir_exists ? "good" : "bad"],
    ["库根目录（整理移动的边界）", status.library_root || "—", ""],
    ["数据目录", status.data_dir || "—", ""],
    ["数据库", status.db_path || "—", ""],
    ["支持格式", (status.supported_formats || []).join("  "), ""],
    [
      "迁移层",
      status.scraper && status.scraper.available
        ? `可用（${status.scraper.count} 个源：${(status.scraper.sources || []).join("、") || "无"}）`
        : "不可用（仅内置实现的数据源可用）",
      status.scraper && status.scraper.available ? "good" : "bad",
    ],
    ["运行环境", status.docker ? "容器内（/.dockerenv 存在）" : "非容器进程", ""],
  ];
  ui.clear(nodes.statusKv);
  const fragment = document.createDocumentFragment();
  rows.forEach(([label, value, variant]) => {
    fragment.append(ui.el("dt", { text: label }), ui.el("dd", { class: variant, title: value, text: value }));
  });
  nodes.statusKv.append(fragment);
  if (!status.music_dir_exists) {
    nodes.statusKv.append(
      ui.el("dd", { style: { gridColumn: "1 / -1" } }, [
        ui.notice("err", `音乐目录不存在：${status.music_dir} —— 扫描会失败，请检查 METATIDY_MUSIC_DIR 环境变量或挂载。`),
      ]),
    );
  }
  renderSourceDefaults();
}

function renderSourceDefaults() {
  if (!nodes.sources) return;
  const values = (state.settings && state.settings.values) || {};
  const enabled = new Set(values.enabled_sources || []);
  ui.clear(nodes.sources);
  if (!state.sources.length) {
    nodes.sources.append(ui.el("span", { class: "hint", text: "没有读取到数据源列表。" }));
    return;
  }
  state.sources.forEach((source) => {
    const input = ui.el("input", { type: "checkbox", checked: enabled.has(source.name), "aria-label": `默认启用数据源 ${source.label}` });
    input.dataset.source = source.name;
    input.addEventListener("change", markDirty);
    nodes.sources.append(
      ui.el("label", { class: "check", title: `${source.label} · ${source.status}${source.needs_key ? ` · 需要 ${source.needs_key}` : ""}` }, [
        input,
        ui.el("span", { text: source.label }),
        ui.el("span", { class: `badge ${source.status === "不可用" ? "badge-warn" : "badge-mute"}`, text: source.status }),
      ]),
    );
  });
  nodes.sources.append(
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "全选",
      onClick: () => {
        nodes.sources.querySelectorAll("input[type=checkbox]").forEach((input) => {
          input.checked = true;
        });
        markDirty();
      },
    }),
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "只留可用",
      onClick: () => {
        nodes.sources.querySelectorAll("input[type=checkbox]").forEach((input) => {
          const source = state.sources.find((item) => item.name === input.dataset.source);
          input.checked = Boolean(source && source.status !== "不可用");
        });
        markDirty();
      },
    }),
  );
}

export function onSettings() {
  fillForm();
  renderSourceDefaults();
}

function fillForm() {
  const values = (state.settings && state.settings.values) || {};
  nodes.dir.value = values.dir_template || "";
  nodes.filename.value = values.filename_template || "";
  ui.clear(nodes.conflict);
  [
    ["rename", "rename · 目标存在时自动改名"],
    ["skip", "skip · 目标存在时跳过"],
    ["overwrite", "overwrite · 目标存在时覆盖（谨慎）"],
  ].forEach(([value, label]) => nodes.conflict.append(ui.el("option", { value, text: label })));
  nodes.conflict.value = values.conflict_policy || "rename";
  nodes.unknownArtist.value = values.unknown_artist || "";
  nodes.unknownAlbum.value = values.unknown_album || "";
  nodes.unknownOther.value = values.unknown_other || "";
  nodes.writeCover.checked = Boolean(values.write_cover);
  nodes.writeLyrics.checked = Boolean(values.write_lyrics);
  nodes.overwrite.checked = Boolean(values.overwrite_existing);
  nodes.normalize.checked = Boolean(values.normalize_artist_ampersand);
  dirty = false;
  ui.setText(nodes.dirtyHint, "与后端当前设置一致");
  nodes.dirtyHint.className = "hint";
}

function collectValues() {
  const values = {
    conflict_policy: nodes.conflict.value,
    unknown_artist: nodes.unknownArtist.value,
    unknown_album: nodes.unknownAlbum.value,
    unknown_other: nodes.unknownOther.value,
    write_cover: nodes.writeCover.checked,
    write_lyrics: nodes.writeLyrics.checked,
    overwrite_existing: nodes.overwrite.checked,
    normalize_artist_ampersand: nodes.normalize.checked,
    enabled_sources: [...nodes.sources.querySelectorAll("input[type=checkbox]")]
      .filter((input) => input.checked)
      .map((input) => input.dataset.source),
  };
  values.dir_template = nodes.dir.value;
  values.filename_template = nodes.filename.value;
  return values;
}

async function saveSettings() {
  nodes.save.disabled = true;
  nodes.save.textContent = "保存中…";
  ui.clear(nodes.result);
  try {
    const payload = collectValues();
    const response = await api.saveSettings(payload);
    state.settings = { ...(state.settings || {}), values: { ...payload } };
    const savedKeys = Object.keys(response.saved || {});
    const warnings = response.warnings || [];
    dirty = false;
    ui.setText(nodes.dirtyHint, "已保存");
    nodes.dirtyHint.className = "hint hint-ok";
    nodes.result.append(
      ui.el("div", { class: "result-block" }, [
        ui.notice(warnings.length ? "warn" : "ok", `已保存 ${savedKeys.length} 项设置。${warnings.length ? "后端返回了模板警告：" : ""}`),
        warnings.length ? ui.el("div", { class: "result-list" }, warnings.map((text) => ui.el("div", { class: "item" }, [ui.el("span", { class: "who", text })]))) : null,
        ui.el("div", { class: "hint", text: "模板与开关对「整理移动」和「刮削写入」立即生效；默认数据源会自动同步到刮削页的初始勾选。" }),
      ]),
    );
    ui.toast(warnings.length ? "warn" : "ok", "设置已保存", warnings.length ? `${warnings.length} 条警告` : "后端无警告");
    emit("settings:saved");
  } catch (err) {
    ui.clear(nodes.result);
    nodes.result.append(ui.notice("err", `保存失败：${err.message}`));
    ui.toast("err", "保存设置失败", err.message);
  } finally {
    nodes.save.disabled = false;
    nodes.save.textContent = "保存设置";
  }
}

/* ------------------------------------------------------------- 别名库 */

function addAliasRow(tbody, item = { from: "", to: "" }) {
  const tr = ui.el("tr", {});
  const from = ui.el("input", { type: "text", value: item.from, "aria-label": "别名原名", placeholder: "原名" });
  const to = ui.el("input", { type: "text", value: item.to, "aria-label": "别名替换为", placeholder: "替换为" });
  tr.append(
    ui.el("td", {}, [from]),
    ui.el("td", {}, [to]),
    ui.el("td", { class: "act" }, [
      ui.el("button", {
        type: "button",
        class: "btn btn-sm btn-ghost",
        text: "✕",
        "aria-label": "删除这一行别名",
        onClick: () => tr.remove(),
      }),
    ]),
  );
  tbody.append(tr);
  return tr;
}

async function loadAliases() {
  for (const kind of ["artist", "album"]) {
    const body = kind === "artist" ? nodes.aliasArtistBody : nodes.aliasAlbumBody;
    try {
      const data = await api.aliases(kind);
      ui.clear(body);
      const items = data.items || [];
      if (!items.length) {
        addAliasRow(body);
      } else {
        items.forEach((item) => addAliasRow(body, item));
      }
    } catch (err) {
      ui.clear(body);
      body.append(ui.el("tr", {}, [ui.el("td", { colspan: "3" }, [ui.notice("err", `读取失败：${err.message}`)])]));
    }
  }
}

async function saveAliases(kind, tbody, resultHost) {
  const items = [];
  tbody.querySelectorAll("tr").forEach((tr) => {
    const inputs = tr.querySelectorAll("input");
    if (inputs.length < 2) return;
    const from = inputs[0].value.trim();
    const to = inputs[1].value.trim();
    if (from && to) items.push({ from, to });
  });
  const button = kind === "artist" ? nodes.aliasArtistSave : nodes.aliasAlbumSave;
  button.disabled = true;
  ui.clear(resultHost);
  try {
    const result = await api.saveAliases(kind, items);
    resultHost.append(ui.notice("ok", `已保存 ${result.saved ?? items.length} 条${kind === "artist" ? "歌手" : "专辑"}别名。`));
    ui.toast("ok", "别名库已保存", `${result.saved ?? items.length} 条`);
  } catch (err) {
    resultHost.append(ui.notice("err", `保存失败：${err.message}`));
    ui.toast("err", "别名库保存失败", err.message);
  } finally {
    button.disabled = false;
  }
}

export function refreshAll() {
  loadAliases();
}

export function isDirty() {
  return dirty;
}
