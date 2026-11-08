/**
 * 界面基础件：DOM 构造、格式化、提示、弹层、进度、差异视图。
 * 约定：任何来自后端的文本都只走 textContent（不拼 innerHTML），
 * 所以标签里带引号、尖括号、emoji 都不会破坏结构。
 */

import { coverUrl } from "./api.js";

export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "html") throw new Error("禁止使用 innerHTML");
      else if (key === "value") node.value = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "style" && typeof value === "object") {
        // 自定义属性（--x）必须走 setProperty，Object.assign 会静默丢掉
        for (const [k, v] of Object.entries(value)) {
          if (k.startsWith("--")) node.style.setProperty(k, String(v));
          else node.style[k] = v;
        }
      }
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) {
    children.forEach((child) => append(node, child));
    return node;
  }
  node.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return node;
}

/**
 * 内联 SVG 图标（零外部依赖，跟 `currentColor` 走，所以日夜主题自动适配）。
 *
 * 只做 16px 的描边图标：`stroke-width=1.6`、`stroke-linecap=round`，
 * 视觉重量和 12.5px 的按钮文字相当，不会喧宾夺主。
 */
const ICON_PATHS = {
  play: "M5 2.8v10.4l8-5.2z",
  pause: "M5 3v10M11 3v10",
  folder: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11zM2.5 4.5V3h4l1.5 1.5h5.5V6",
  scan: "M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M9 3h2.5A1.5 1.5 0 0 1 13 4.5V7M13 9v2.5a1.5 1.5 0 0 1-1.5 1.5H9M7 13H4.5A1.5 1.5 0 0 1 3 11.5V9",
  refresh: "M13 3v3.5H9.5M3 13V9.5h3.5M13 6.5A5 5 0 0 0 4.2 5.4M3 9.5a5 5 0 0 0 8.8 1.1",
  filter: "M2.5 3.5h11l-4.2 4.7v4.6l-2.6 1.4V8.2z",
  edit: "M11.2 2.6a1.7 1.7 0 0 1 2.4 2.4l-7.4 7.4-3 .6.6-3zM9.6 4.2l2.4 2.4",
  close: "M3.5 3.5l9 9M12.5 3.5l-9 9",
  search: "M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4zM11.4 11.4l2.4 2.4",
  check: "M3 8.5l3.4 3.4L13 5",
  music: "M6 12.5a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM7.9 10.6V3.4l5.4 1.2M13.3 9.9a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 0 1 3.8 0z",
  album: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z",
  artist: "M8 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM2.9 13.4a5.1 5.1 0 0 1 10.2 0",
  lyrics: "M3 3.5h10M3 6.5h7M3 9.5h10M3 12.5h5",
  cover: "M2.6 3.5h10.8v9H2.6zM2.6 10l3-3 2.6 2.6 2-1.8 3 3",
  move: "M6 12.5V3.5M3 6.2l3-2.7 3 2.7M10 3.5v9M7 9.8l3 2.7 3-2.7",
  settings: "M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2zM8 1.9l1 1.6 1.9-.3.5 1.8 1.7.9-.8 1.7.8 1.7-1.7.9-.5 1.8-1.9-.3-1 1.6-1-1.6-1.9.3-.5-1.8-1.7-.9.8-1.7-.8-1.7 1.7-.9.5-1.8 1.9.3z",
  command: "M5.6 2.6a1.9 1.9 0 1 1 0 3.8h4.8a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 1.9 1.9v4.8a1.9 1.9 0 1 1-1.9 1.9 1.9 1.9 0 0 1-1.9-1.9H5.6a1.9 1.9 0 1 1-1.9-1.9 1.9 1.9 0 0 1 1.9-1.9",
  jobs: "M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6zM8 5.6V8l1.8 1.2",
  warn: "M8 2.6l5.6 9.8H2.4zM8 6.4v3M8 11h.01",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.4v3.4M8 5.4h.01",
  logout: "M6.4 13.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h2.4M9.6 11.2L12.8 8 9.6 4.8M12.8 8H6.4",
  theme: "M8 13.4a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8zM8 2.6v10.8",
  empty: "M2.6 9.4l2-4.4h6.8l2 4.4v3H2.6zM2.6 9.4h3l.8 1.4h3.2l.8-1.4h3",
  plus: "M8 3.5v9M3.5 8h9",
  disk: "M4 3.5h8A1.5 1.5 0 0 1 13.5 5v6A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V5A1.5 1.5 0 0 1 4 3.5zM2.5 9.2h11M11.3 10.8h.01",
  copy: "M5.5 5.5h7v8h-7zM10.5 5.5v-3h-8v8h3",
};

export function icon(name, { size = 16, cls = "" } = {}) {
  const path = ICON_PATHS[name];
  if (!path) return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `ico-svg ${cls}`.trim());
  for (const d of path.split("M").filter(Boolean)) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", `M${d}`);
    svg.append(p);
  }
  return svg;
}

/** 给按钮之类「只有文字」的元素补一个前置图标（已有就不重复加）。 */
export function withIcon(node, name, { size = 15 } = {}) {
  const ico = icon(name, { size });
  if (!node || !ico || node.querySelector(".ico-svg")) return node;
  node.prepend(ico);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function byId(id) {
  return document.getElementById(id);
}

export function setText(node, value) {
  if (node) node.textContent = value === null || value === undefined ? "" : String(value);
  return node;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** 数字千分位。 */
export function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

export function fmtBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** 秒数（float）→ 3:45。 */
export function fmtDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  const total = Math.round(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTime(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 字段名 → 中文标签（与 db.EDITABLE_FIELDS 对齐）。 */
export const FIELD_LABELS = {
  lyrics: "歌词",
  title: "标题",
  artist: "歌手",
  album: "专辑",
  albumartist: "专辑艺术家",
  genre: "流派",
  year: "年份",
  track: "音轨号",
  disc: "碟号",
  language: "语言",
  albumtype: "专辑类型",
  composer: "作曲",
  lyricist: "作词",
  copyright: "版权",
  comment: "注释",
  mb_artist_id: "MB 歌手 ID",
  release_group_id: "发行组 ID",
  cover: "封面",
  lyrics: "歌词",
};

export function fieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

export function skipReasonLabel(reason) {
  return {
    existing: "保留已有值",
    unchanged: "与现值相同",
    blank: "内容为空",
    invalid: "格式无效",
    unsupported: "不支持此字段",
    unavailable: "未能获取内容",
  }[reason] || "未写入";
}

/** Shared preview/result disclosure. All values remain text, including errors. */
export function skippedFieldsView(skipped = []) {
  const items = Array.isArray(skipped) ? skipped.filter((item) => item && typeof item.field === "string") : [];
  if (!items.length) return null;
  return el("details", { class: "diff-skipped" }, [
    el("summary", {}, [icon("info", { size: 13 }), `保留或跳过 ${items.length} 项`, el("span", { class: "hint", text: "查看原因" })]),
    el("ul", {}, items.map((item) => el("li", {}, [
      el("span", { text: fieldLabel(item.field) }),
      el("span", { text: skipReasonLabel(item.reason) }),
    ]))),
  ]);
}

export function truncatedPath(text) {
  // 只用于 title 属性：完整路径/文件名不截断，视觉截断交给 CSS
  return String(text === null || text === undefined ? "" : text);
}

/** Finite artwork reveal, shared by list, grid and candidate covers. */
export function enhanceArtwork(wrap, img) {
  if (!wrap || !img) return wrap;
  wrap.classList.add("artwork");
  wrap.dataset.imageState = "loading";
  const settle = () => { wrap.dataset.imageState = img.naturalWidth > 0 ? "loaded" : "failed"; };
  img.addEventListener("load", settle, { once: true });
  img.addEventListener("error", settle, { once: true });
  // Cached images can finish before their DOM is attached.
  if (img.complete) settle();
  return wrap;
}

/** 封面缩略图：只有 has_cover 为真时才请求接口，避免满屏 404。 */
export function coverThumb(row, { size = 48, big = false, reveal = true } = {}) {
  const cls = big ? "thumb thumb-lg" : "thumb";
  const seed = String(row?.album || row?.artist || row?.title || row?.id || "music");
  let tone = 0;
  for (const char of seed) tone = (tone * 31 + char.codePointAt(0)) % 6;
  const fallback = () => icon("music", { size: big ? 28 : 20 });
  if (!row || !row.has_cover) {
    return el("span", { class: `${cls} ph`, dataset: { tone }, "aria-hidden": "true", title: "暂无内嵌封面" }, [fallback()]);
  }
  const img = el("img", {
    src: coverUrl(row.id),
    alt: "",
    loading: "lazy",
    decoding: "async",
    width: size,
    height: size,
  });
  const wrap = el("span", { class: cls, dataset: { tone }, title: `${row.title || row.filename || "封面"}` }, [img]);
  if (reveal) enhanceArtwork(wrap, img);
  img.addEventListener(
    "error",
    () => {
      img.remove();
      wrap.classList.add("ph");
      wrap.append(fallback());
      wrap.title = "封面读取失败（文件可能已被移动或没有内嵌图）";
    },
    { once: true },
  );
  return wrap;
}

/** 候选封面（来自数据源的远程 URL，可能离线失败：失败后退回占位符，不再重试）。 */
export function remoteCover(url, { size = 64, label = "数据源封面" } = {}) {
  const wrap = el("span", { class: "thumb thumb-lg", title: label }, []);
  const img = el("img", { src: url, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener(
    "error",
    () => {
      img.remove();
      wrap.classList.add("ph");
      wrap.append(document.createTextNode("需外网"));
      wrap.title = "封面地址来自数据源，当前网络无法访问";
    },
    { once: true },
  );
  wrap.append(img);
  enhanceArtwork(wrap, img);
  void size;
  return wrap;
}

export function badge(text, variant = "") {
  return el("span", { class: `badge ${variant}`.trim(), text });
}

export function notice(kind, children) {
  const variant = kind ? `notice-${kind}` : "notice";
  return el("div", { class: variant }, [el("div", { class: "body" }, children)]);
}

export function loadingLine(text = "加载中…") {
  return el("div", { class: "loading-line" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text })]);
}

export function emptyState(glyph, title, description, actions = []) {
  // 第一个参数：图标名（渲染 SVG）或旧式两字文本（"00" / "··"）
  const svg = ICON_PATHS[glyph] ? icon(glyph, { size: 30 }) : null;
  return el("div", { class: "empty" }, [
    svg
      ? el("div", { class: "ico", "aria-hidden": "true" }, [svg])
      : el("div", { class: "ico", "aria-hidden": "true", text: glyph }),
    el("h3", { text: title }),
    description ? el("p", { text: description }) : null,
    actions.length ? el("div", { class: "row", style: { justifyContent: "center" } }, actions) : null,
  ]);
}

/**
 * 表格骨架屏占位行：首屏加载时铺几行，避免表格空白与高度跳动。
 * 行高与微光动画由 .skeleton-row 负责（含 prefers-reduced-motion 降级）；
 * 列数默认 11，与曲库表一致，空单元格让列宽保持原样。
 */
export function skeletonRows(count = 8, cols = 11) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const cells = [];
    for (let c = 0; c < cols; c += 1) cells.push(el("td", {}));
    rows.push(el("tr", { class: "skeleton-row", "aria-hidden": "true" }, cells));
  }
  return rows;
}

/* ------------------------------------------------------------------ 提示条 */

export function toast(kind, title, message = "", { timeout = 7000 } = {}) {
  const host = byId("toasts");
  if (!host) return () => {};
  const node = el("div", { class: `toast toast-${kind || "info"}` }, [
    el("div", { style: { minWidth: 0 } }, [
      el("div", { class: "t", text: title }),
      message ? el("div", { class: "m", text: message }) : null,
    ]),
    el("button", {
      class: "btn btn-sm btn-ghost x",
      type: "button",
      "aria-label": "关闭提示",
      text: "✕",
      onClick: () => remove(),
    }),
  ]);
  let removed = false;
  function remove() {
    if (removed) return;
    removed = true;
    node.dataset.leaving = "true";
    setTimeout(() => node.remove(), 200);
  }
  host.append(node);
  if (timeout > 0) setTimeout(remove, timeout);
  return remove;
}

/* ------------------------------------------------------------------ 弹层 */

let dialogSeq = 0;

/**
 * 通用弹层。actions: [{id, label, variant, autofocus}]
 * resolve 点击的动作 id；按 Esc / 取消 返回 ""。
 */
export function openDialog({ title, subtitle = "", body, actions = [], size = "" }) {
  return new Promise((resolve) => {
    dialogSeq += 1;
    const titleId = `dlg-title-${dialogSeq}`;
    const dialog = el("dialog", { class: `modal ${size}`.trim(), "aria-labelledby": titleId });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (dialog.open) dialog.close();
      // 延后一帧再摘除节点：让 <dialog> 的「焦点回到触发元素」在 DOM 移除前完成
      requestAnimationFrame(() => dialog.remove());
    };

    const buttons = actions.map((action) =>
      el("button", {
        type: "button",
        class: `btn ${action.variant || ""}`.trim(),
        text: action.label,
        autofocus: action.autofocus ? true : null,
        onClick: () => finish(action.id),
      }),
    );

    append(dialog, [
      el("div", { class: "modal-head" }, [
        el("div", { style: { minWidth: 0 } }, [
          el("h2", { id: titleId, text: title }),
          subtitle ? el("p", { class: "sub", text: subtitle }) : null,
        ]),
      ]),
      el("div", { class: "modal-body" }, body),
      el("div", { class: "modal-foot" }, [...buttons, el("div", { class: "spacer" }), el("span", { class: "hint", text: "Esc 可取消" })]),
    ]);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish("");
    });
    dialog.addEventListener("close", () => finish(""));
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * 二次确认。details: [{label, value, danger}]
 * 用于所有会改文件的操作，措辞必须写清后果。
 */
export async function confirmDialog({ title, message, details = [], confirmLabel = "确认", danger = false, note = "" }) {
  const body = [];
  if (message) body.push(el("p", { text: message }));
  if (details.length) {
    body.push(
      el(
        "dl",
        { class: "kv" },
        details.flatMap((item) => [
          el("dt", { text: item.label }),
          el("dd", { class: item.danger ? "bad" : "", text: item.value }),
        ]),
      ),
    );
  }
  if (note) body.push(notice(danger ? "warn" : "info", note));
  const answer = await openDialog({
    title,
    body,
    actions: [
      { id: "cancel", label: "取消" },
      { id: "ok", label: confirmLabel, variant: danger ? "btn-danger" : "btn-primary", autofocus: true },
    ],
  });
  return answer === "ok";
}

/* ------------------------------------------------------------ 差异预览视图 */

const DIFF_TRACK_LIMIT = 60;

/**
 * 差异对比视图（旧值红 / 新值绿）。
 * items 为 /api/tracks/preview 的 items 数组。
 */
export function diffView(items = []) {
  const total = items.length;
  const shown = items.slice(0, DIFF_TRACK_LIMIT);
  const nodes = [];

  if (total > DIFF_TRACK_LIMIT) {
    nodes.push(
      notice(
        "warn",
        `共 ${total} 首，这里只显示前 ${DIFF_TRACK_LIMIT} 首的逐字段差异；确认后后端会处理全部 ${total} 首。`,
      ),
    );
  }

  if (!shown.length) {
    nodes.push(notice("info", "选择的曲目都读不到（可能已被移动或删除）。"));
    return nodes;
  }

  shown.forEach((item) => {
    const changes = item.changes || {};
    const keys = Object.keys(changes);
    const header = el("header", {}, [
      el("span", { class: "nm mono", title: truncatedPath(item.path), text: item.filename || item.path || `#${item.track_id}` }),
      badge(`${keys.length} 处变更`, keys.length ? "badge-accent" : "badge-mute"),
      item.file_exists === false ? badge("文件不存在", "badge-err") : null,
    ]);
    const rows = keys.map((key) =>
      el("tr", {}, [
        el("td", { class: "fld", text: fieldLabel(key) }),
        el(
          "td",
          {},
          changes[key] && changes[key].old
            ? el("span", { class: "diff-old", text: changes[key].old })
            : el("span", { class: "diff-empty", text: "（空）" }),
        ),
        el(
          "td",
          {},
          changes[key] && changes[key].new
            ? el("span", { class: "diff-new", text: changes[key].new })
            : el("span", { class: "diff-empty", text: "（清空）" }),
        ),
      ]),
    );
    const table = keys.length
      ? el("table", { class: "diff-table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { scope: "col", text: "字段" }),
              el("th", { scope: "col", text: "当前值" }),
              el("th", { scope: "col", text: "写入后" }),
            ]),
          ]),
          el("tbody", {}, rows),
        ])
      : el("div", { class: "hint", style: { padding: "10px 14px" } }, "按当前选项，没有需要写入的字段变更。");
    nodes.push(el("section", { class: "diff-track" }, [header, table, skippedFieldsView(item.skipped)]));
  });

  return nodes;
}

/* ------------------------------------------------------------------ 进度 */

export function createProgress(host, { label = "任务" } = {}) {
  const bar = el("i");
  const barWrap = el("div", { class: "progress-bar" }, [bar]);
  const count = el("span", { class: "count", text: "" });
  const msg = el("span", { class: "msg", text: "等待后端开始…" });
  const eta = el("span", { class: "eta", text: "" });
  const meta = el("div", { class: "progress-meta" }, [count, msg, eta]);
  const status = el("div", { class: "hint" });
  const node = el("div", { class: "progress" }, [
    el("div", { class: "row tight" }, [el("span", { class: "lbl", text: label, style: { marginBottom: "0" } }), status]),
    barWrap,
    meta,
  ]);

  clear(host);
  host.hidden = false;
  host.append(node);

  let lastJob = null;
  let startedAt = 0; // 任务第一次回调的时间
  let phaseStart = 0; // 当前阶段开始的时间
  let phaseDone = 0; // 当前阶段开始时的 done
  let phaseKey = ""; // 阶段标识（由 done/total 推出来，不去解析后端文案）

  /** 由 done/total 推出阶段：枚举目录 → 读取文件 → 收尾。 */
  function phaseOf(total, done) {
    if (!total) return "枚举目录";
    return done >= total ? "收尾" : "读取文件";
  }

  /** 秒数说成人话。 */
  function humanDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }

  /**
   * 预估剩余时间。
   *
   * 用**当前阶段**的速率算（阶段切换时重置基准）：枚举阶段没有总数，只能给速率；
   * 读取阶段前几秒样本太少，会给出很离谱的数字，所以样本不足时只报「已用时」。
   */
  function estimateText(now, total, done) {
    const elapsed = (now - startedAt) / 1000;
    if (elapsed < 3) return "";
    const span = (now - phaseStart) / 1000;
    const progressed = done - phaseDone;
    if (!total) {
      if (span < 3 || progressed <= 0) return `已用时 ${humanDuration(elapsed)}`;
      return `已用时 ${humanDuration(elapsed)} · 约 ${Math.round(progressed / span)} 项/秒`;
    }
    if (span < 3 || progressed < 5) return `已用时 ${humanDuration(elapsed)}`;
    const rate = progressed / span;
    if (!(rate > 0)) return `已用时 ${humanDuration(elapsed)}`;
    const remain = (total - done) / rate;
    if (!Number.isFinite(remain) || remain < 1) return `已用时 ${humanDuration(elapsed)}`;
    return `已用时 ${humanDuration(elapsed)} · 剩余约 ${humanDuration(remain)}`;
  }

  return {
    node,
    update(job) {
      lastJob = job;
      const now = Date.now();
      if (!startedAt) startedAt = now;
      const total = Number(job.total) || 0;
      const done = Number(job.done) || 0;
      const phase = phaseOf(total, done);
      if (phase !== phaseKey) {
        phaseKey = phase;
        phaseStart = now;
        phaseDone = done;
      }
      // 计数槽：读取阶段是「已完成/总数」，枚举阶段是目录项数（阶段文字会说明是哪个）
      count.textContent = total ? `${done}/${total}` : done ? `${done} 项` : "";
      status.textContent = job.state === "running" ? phase : job.state === "done" ? "已完成" : "出错";
      status.className = `hint ${job.state === "error" ? "hint-err" : job.state === "done" ? "hint-ok" : ""}`;
      msg.textContent = job.message || job.error || "";
      eta.textContent = job.state === "running" ? estimateText(now, total, done) : "";
      if (total > 0) {
        barWrap.classList.remove("indet");
        const percent = Math.max(0, Math.min(100, (done / total) * 100));
        bar.style.width = `${percent.toFixed(1)}%`;
      } else {
        barWrap.classList.add("indet");
      }
    },
    /** 直接写一行状态文字（例如用户主动停止）。 */
    setStatus(text, variant = "") {
      status.textContent = text;
      status.className = `hint ${variant}`.trim();
    },
    finish(job) {
      if (job) this.update(job);
      barWrap.classList.remove("indet");
      if (job && job.state === "error") {
        bar.style.width = "100%";
        bar.style.background = "var(--err)";
        status.textContent = "失败";
        status.className = "hint hint-err";
        eta.textContent = "";
        return;
      }
      // 完成后不再展示 done/total：后端进度写库有节流（400ms/20 项），
      // 结束时记录的 done 可能小于 total，显示成比例反而误导。
      count.textContent = "";
      eta.textContent = "";
      bar.style.width = "100%";
      bar.style.background = "var(--ok)";
    },
    context: () => lastJob,
  };
}

/** 结果汇总块：counts 为 [{label, value, variant}]，failures 为 [{who, why}]。 */
export function resultBlock({ summary = [], failures = [], failuresTitle = "失败明细" } = {}) {
  const nodes = [];
  if (summary.length) {
    nodes.push(
      el(
        "div",
        { class: "row" },
        summary.map((item) => el("span", { class: `chip ${item.variant || ""}`.trim(), title: item.title || "" }, [item.label, el("strong", { text: String(item.value) })])),
      ),
    );
  }
  if (failures.length) {
    nodes.push(
      el("div", {}, [
        el("div", { class: "lbl", text: `${failuresTitle}（${failures.length}）` }),
        el(
          "div",
          { class: "result-list" },
          failures.map((item) =>
            el("div", { class: "item" }, [
              el("span", { class: "who", title: truncatedPath(item.who), text: item.who || "—" }),
              el("span", { class: "why", title: truncatedPath(item.why), text: item.why || "" }),
            ]),
          ),
        ),
      ]),
    );
  }
  return el("div", { class: "result-block" }, nodes);
}

export function jobStateBadge(state) {
  const map = {
    running: ["运行中", "badge-info"],
    done: ["已完成", "badge-ok"],
    error: ["失败", "badge-err"],
  };
  const [text, variant] = map[state] || [state || "未知", ""];
  return badge(text, variant);
}

export function jobKindLabel(kind) {
  return { scan: "扫描库", scrape: "批量刮削", move: "整理移动" }[kind] || kind || "任务";
}
