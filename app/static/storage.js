/** On-demand storage diagnostics. Never infer the Docker host's bind paths. */
import { request } from "./api.js";
import * as ui from "./ui.js";

let nodes = null;
let status = {};
let snapshot = null;
let attempted = false;
let pending = null;

export function init(statusKv, reload) {
  if (nodes) return;
  const card = statusKv.closest(".card");
  card.classList.add("storage-panel");
  const heading = card.querySelector(".card-head h2");
  if (heading) heading.textContent = "存储与运行状态";
  reload.textContent = "刷新用量";
  reload.title = "读取目录与缓存用量，不会写入文件";
  const cards = ui.el("div", { id: "storage-cards", class: "storage-grid" });
  const breakdown = ui.el("div", { class: "storage-breakdown" });
  const checked = ui.el("span", { id: "storage-checked-at", class: "hint" });
  const feedback = ui.el("div", { id: "storage-feedback", class: "storage-feedback", role: "status", "aria-live": "polite" });
  const check = ui.el("button", {
    id: "storage-check-write", type: "button", class: "btn btn-primary", text: "检查缓存写入",
    onClick: () => refresh({ checkWrite: true }),
  });
  const copy = ui.el("button", {
    id: "storage-copy-report", type: "button", class: "btn", text: "复制诊断信息", disabled: true,
    onClick: copyReport,
  });
  const locationNote = ui.el("p", { id: "storage-host-note", class: "hint storage-host-note" });
  const details = ui.el("details", { class: "storage-service-details" }, [
    ui.el("summary", { text: "服务详情" }), statusKv,
  ]);
  const body = card.querySelector(".card-body");
  body.replaceChildren(
    ui.el("p", { class: "storage-intro", text: "音乐留在曲库，图片按需缓存，设置保存在数据库。" }),
    cards, breakdown,
    ui.el("div", { class: "storage-actions" }, [
      ui.el("div", { class: "storage-action-buttons" }, [check, copy]), checked,
    ]),
    ui.el("p", { class: "hint storage-probe-note", text: "写入检查会创建缺少的缓存目录，并创建后立即删除一个临时文件；不会修改音乐或目录权限。" }),
    feedback, locationNote, details,
  );
  nodes = { cards, breakdown, feedback, check, copy, reload, checked, statusKv, locationNote };
  reload.addEventListener("click", () => refresh());
  render();
}

export function onStatus(value) {
  status = value || {};
  if (!nodes) return;
  const rows = [
    ["后端版本", status.version || "等待连接"],
    ["索引引擎", status.postgres ? "PostgreSQL" : "等待连接"],
    ["任务进度", status.redis ? "Redis 已连接" : "保存在 PostgreSQL"],
    ["支持音频", (status.supported_formats || []).join(" · ") || "—"],
    ["元数据源", status.scraper?.available ? `${status.scraper.count} 个可用` : "等待连接"],
    ["整理目录边界", status.library_root || status.music_dir || "—"],
  ];
  nodes.statusKv.replaceChildren(...rows.flatMap(([label, value]) => [ui.el("dt", { text: label }), ui.el("dd", { text: value })]));
  if (!snapshot) render();
}

export function ensureLoaded() {
  return attempted ? pending || Promise.resolve() : refresh();
}

export function refresh({ checkWrite = false } = {}) {
  if (!nodes) return Promise.resolve();
  if (pending) return pending;
  attempted = true;
  setBusy(true, checkWrite);
  nodes.feedback.replaceChildren(ui.loadingLine(checkWrite ? "正在以应用用户检查缓存写入…" : "正在读取缓存用量…"));
  pending = (async () => {
    try {
      snapshot = await request(checkWrite ? "/api/storage/check" : "/api/storage", {
        method: checkWrite ? "POST" : "GET", timeout: 45000,
      });
      render();
      renderWriteChecks();
    } catch (error) {
      nodes.feedback.replaceChildren(ui.notice("err", `暂时无法读取存储诊断：${error.message}。可点击「刷新用量」重试。`));
    } finally {
      pending = null;
      setBusy(false);
    }
  })();
  return pending;
}

function setBusy(busy, checking = false) {
  nodes.reload.disabled = busy;
  nodes.check.disabled = busy;
  nodes.copy.disabled = busy || !snapshot;
  nodes.check.textContent = busy && checking ? "正在检查…" : "检查缓存写入";
  nodes.cards.setAttribute("aria-busy", String(busy));
}

function pill(text, tone = "neutral") {
  return ui.el("span", { class: `storage-pill storage-pill-${tone}`, text });
}

function pathLine(path, label) {
  return ui.el("div", { class: "storage-path" }, [
    ui.el("span", { class: "storage-path-label", text: label }),
    ui.el("code", { text: path || "等待连接", title: path || "" }),
  ]);
}

function tile({ icon, title, badge, children, tone = "" }) {
  return ui.el("section", { class: `storage-card ${tone}`.trim() }, [
    ui.el("div", { class: "storage-card-head" }, [
      ui.el("span", { class: "storage-icon", "aria-hidden": "true" }, [ui.icon(icon, { size: 20 })]), badge,
    ]),
    ui.el("h3", { text: title }), ...children,
  ]);
}

function number(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function render() {
  const music = snapshot?.music || { path: status.music_dir, exists: status.music_dir_exists };
  const cache = snapshot?.cache || { root: status.data_dir };
  const database = snapshot?.database || { connected: status.postgres, engine: "PostgreSQL" };
  const container = snapshot?.runtime?.container ?? status.docker;
  const pathLabel = container ? "容器内路径" : "服务所在机器路径";
  const thumbnails = cache.thumbnails;
  const originals = cache.originals;
  const cacheError = Boolean(thumbnails?.error || originals?.error);
  const partial = Boolean(thumbnails?.truncated || originals?.truncated || cacheError);
  const totalBytes = number(thumbnails?.bytes) + number(originals?.bytes);
  nodes.cards.replaceChildren(
    tile({ icon: "music", title: "音乐文件", badge: pill(music.exists === true ? "已找到目录" : music.exists === false ? "目录不可用" : "等待连接", music.exists === true ? "ok" : music.exists === false ? "warn" : "neutral"), children: [
      pathLine(music.path, pathLabel),
      ui.el("p", { class: "storage-card-copy", text: "音频与内嵌封面保存在音乐文件中，扫描后仍留在原目录。" }),
    ] }),
    tile({ icon: "cover", title: "图片缓存", tone: "storage-card-featured", badge: pill("AVIF · 按需生成", "accent"), children: [
      ui.el("div", { class: "storage-metric" }, [
        ui.el("strong", { text: snapshot ? cacheError && !totalBytes ? "读取受限" : `${partial ? "至少 " : ""}${ui.fmtBytes(totalBytes)}` : "—" }),
        ui.el("span", { text: snapshot ? thumbnails?.error ? "缩略图数量暂不可用" : `${partial ? "已统计 " : ""}${ui.fmtNum(number(thumbnails?.files))} 张缩略图` : "打开设置后读取用量" }),
      ]),
      pathLine(cache.root, pathLabel),
      ui.el("p", { class: "storage-card-copy", text: cacheError ? "部分缓存目录未能读取，请查看下方详情。" : "浏览有封面的曲目时才生成缓存。目录为空，也可能只是尚未请求过图片。" }),
    ] }),
    tile({ icon: "disk", title: "索引与设置", badge: pill(database.connected === true ? "已连接" : database.connected === false ? "连接异常" : "等待连接", database.connected === true ? "ok" : database.connected === false ? "warn" : "neutral"), children: [
      ui.el("div", { class: "storage-database-name", text: "PostgreSQL" }),
      ui.el("p", { class: "storage-card-copy", text: "曲库索引、应用设置、别名和任务记录保存在数据库，不会写成缓存目录下的配置文件。" }),
      ui.el("div", { class: "storage-store-tags" }, ["曲库索引", "应用设置", "别名", "任务"].map((text) => ui.el("span", { text }))),
    ] }),
  );
  nodes.breakdown.replaceChildren();
  if (snapshot) {
    for (const [label, item, note] of [
      ["AVIF 缩略图", thumbnails, "128 / 256 / 512px，保持比例"],
      ["封面原图", originals, "请求原图时保存，保留原始格式"],
    ]) {
      if (!item) continue;
      nodes.breakdown.append(ui.el("div", { class: "storage-cache-row" }, [
        ui.el("div", {}, [ui.el("strong", { text: label }), ui.el("span", { class: "hint", text: note })]),
        ui.el("code", { text: item.path || "—", title: item.path || "" }),
        ui.el("span", { class: "storage-cache-size", text: item.error ? "读取受限" : `${item.truncated ? "至少 " : ""}${ui.fmtNum(number(item.files))} 份 · ${ui.fmtBytes(number(item.bytes))}` }),
        item.error ? ui.el("p", { class: "storage-cache-error", text: item.error }) : item.exists === false ? ui.el("p", { class: "hint storage-cache-note", text: "目录尚未创建，首次成功缓存时会自动建立。" }) : null,
      ]));
    }
  }
  nodes.checked.textContent = snapshot?.checked_at ? `更新于 ${ui.fmtTime(snapshot.checked_at)}` : "尚未读取用量";
  nodes.locationNote.textContent = container
    ? "这里显示容器内路径。宿主机目录由 Compose 的卷映射决定，请在运行 Docker 的那台设备上核对。"
    : "这里显示运行服务的机器路径。环境变量保存在部署配置中，界面设置保存在 PostgreSQL。";
}

function renderWriteChecks() {
  const checks = snapshot?.write_checks;
  nodes.feedback.replaceChildren();
  if (!Array.isArray(checks)) {
    nodes.feedback.append(ui.el("p", { class: "hint", text: "用量统计不会测试写入权限。图片可在缓存写入失败时继续显示，可手动检查确认。" }));
    return;
  }
  const failures = checks.filter((check) => check.state !== "ok");
  nodes.feedback.append(ui.el("div", { class: `storage-check-summary ${failures.length ? "has-errors" : "is-ok"}` }, [
    ui.icon(failures.length ? "warn" : "check", { size: 18 }),
    ui.el("strong", { text: failures.length ? `${failures.length} 个目录未通过写入检查` : "缓存目录可正常写入" }),
  ]));
  for (const check of checks) {
    nodes.feedback.append(ui.el("div", { class: "storage-check-row" }, [
      pill(check.state === "ok" ? "可写" : "检查失败", check.state === "ok" ? "ok" : "warn"),
      ui.el("code", { text: check.path || "—" }),
      check.error ? ui.el("span", { class: "hint", text: check.error }) : null,
    ]));
  }
  if (failures.length) nodes.feedback.append(ui.el("p", { class: "hint storage-check-help", text: "请核对卷是否只读，以及容器运行用户对宿主目录的写入权限。检查过程没有更改目录权限。" }));
}

// Use an allowlist even if a future API version adds deployment fields. Paths
// and filesystem errors are useful here; credentials and connection URLs are not.
function diagnosticReport() {
  const bucket = (item = {}) => ({
    path: item.path, exists: item.exists, files: item.files, bytes: item.bytes,
    truncated: item.truncated, error: item.error,
  });
  return JSON.stringify({
    version: status.version || "unknown", checked_at: snapshot.checked_at,
    database: { engine: snapshot.database?.engine, connected: snapshot.database?.connected, stores: snapshot.database?.stores },
    music: { path: snapshot.music?.path, exists: snapshot.music?.exists },
    cache: {
      root: snapshot.cache?.root, format: snapshot.cache?.format, on_demand: snapshot.cache?.on_demand,
      originals: bucket(snapshot.cache?.originals), thumbnails: bucket(snapshot.cache?.thumbnails),
    },
    runtime: { container: snapshot.runtime?.container },
    write_checks: snapshot.write_checks?.map((entry) => ({ path: entry.path, state: entry.state, error: entry.error })) || null,
  }, null, 2);
}

async function copyReport() {
  if (!snapshot || pending) return;
  const report = diagnosticReport();
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(report);
    ui.toast("ok", "诊断信息已复制", "包含目录与检查结果，不含口令或数据库连接串");
  } catch {
    const text = ui.el("textarea", { class: "storage-report-text", readonly: true, rows: 12, value: report, "aria-label": "可复制的存储诊断信息", spellcheck: "false" });
    const closed = ui.openDialog({
      title: "存储诊断信息", subtitle: "浏览器未开放自动复制，可选中文字后手动复制。内容不含口令或连接串。",
      body: text, actions: [{ id: "close", label: "完成", variant: "btn-primary" }],
    });
    text.focus();
    text.select();
    await closed;
  }
}
