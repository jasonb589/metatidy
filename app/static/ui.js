/**
 * 界面基础件：DOM 构造、格式化、提示、弹层、进度、差异视图。
 * 约定：任何来自后端的文本都只走 textContent（不拼 innerHTML），
 * 所以标签里带引号、尖括号、emoji 都不会破坏结构。
 */

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

export function truncatedPath(text) {
  // 只用于 title 属性：完整路径/文件名不截断，视觉截断交给 CSS
  return String(text === null || text === undefined ? "" : text);
}

/** 封面缩略图：只有 has_cover 为真时才请求接口，避免满屏 404。 */
export function coverThumb(row, { size = 48, big = false } = {}) {
  const cls = big ? "thumb thumb-lg" : "thumb";
  if (!row || !row.has_cover) {
    return el("span", { class: `${cls} ph`, "aria-hidden": "true", title: "无内嵌封面", text: "—" });
  }
  const img = el("img", {
    src: `/api/tracks/${row.id}/cover?size=${size}`,
    alt: "",
    loading: "lazy",
    decoding: "async",
    width: size,
    height: size,
  });
  const wrap = el("span", { class: cls, title: `${row.title || row.filename || "封面"}` }, [img]);
  img.addEventListener(
    "error",
    () => {
      img.remove();
      wrap.classList.add("ph");
      wrap.append(document.createTextNode("—"));
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

export function emptyState(icon, title, description, actions = []) {
  return el("div", { class: "empty" }, [
    el("div", { class: "ico", "aria-hidden": "true", text: icon }),
    el("h3", { text: title }),
    description ? el("p", { text: description }) : null,
    actions.length ? el("div", { class: "row", style: { justifyContent: "center" } }, actions) : null,
  ]);
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
      : el("div", { class: "hint", style: { padding: "6px 8px" } }, "这些字段与文件里的现值一致，不会产生写入。");
    nodes.push(el("section", { class: "diff-track" }, [header, table]));
  });

  return nodes;
}

/* ------------------------------------------------------------------ 进度 */

export function createProgress(host, { label = "任务" } = {}) {
  const bar = el("i");
  const barWrap = el("div", { class: "progress-bar" }, [bar]);
  const count = el("span", { class: "count", text: "0/0" });
  const msg = el("span", { class: "msg", text: "等待后端开始…" });
  const meta = el("div", { class: "progress-meta" }, [count, msg]);
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

  return {
    node,
    update(job) {
      lastJob = job;
      const total = Number(job.total) || 0;
      const done = Number(job.done) || 0;
      count.textContent = total ? `${done}/${total}` : `${done}`;
      status.textContent = job.state === "running" ? "进行中" : job.state === "done" ? "已完成" : "出错";
      status.className = `hint ${job.state === "error" ? "hint-err" : job.state === "done" ? "hint-ok" : ""}`;
      msg.textContent = job.message || job.error || "";
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
      const total = Number(job && job.total) || 0;
      const done = Number(job && job.done) || 0;
      if (job && job.state === "error") {
        bar.style.width = "100%";
        bar.style.background = "var(--err)";
        status.textContent = "失败";
        status.className = "hint hint-err";
        return;
      }
      // 完成后不再展示 done/total：后端进度写库有节流（400ms/20 项），
      // 结束时记录的 done 可能小于 total，显示成比例反而误导。
      count.textContent = "";
      bar.style.width = "100%";
      bar.style.background = "var(--ok)";
      void done;
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
