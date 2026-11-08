/** Presentation only: the editor owns queue state, navigation decisions and every write. */
import * as ui from "./ui.js";

const LABELS = { pending: "待处理", saved: "已写入", unchanged: "未改动", skipped: "已跳过", error: "待核对" };
const stateOf = (states, row) => {
  const value = states instanceof Map ? states.get(row.id)?.status : "pending";
  return Object.hasOwn(LABELS, value) ? value : "pending";
};
const titleOf = row => String(row?.title || row?.filename || "未命名曲目");
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

export function createEditSequence({ host, onNavigate = () => {}, onSkip = () => {} } = {}) {
  if (!(host instanceof HTMLElement)) return { render() {}, hide() {}, animate() {} };
  let model = null, animation = null;
  const heading = ui.el("h4", { id: "edit-sequence-heading", class: "sr-only", text: "逐首编辑已选曲目" });
  const position = ui.el("strong", { id: "edit-sequence-position", class: "es-position" });
  const status = ui.el("span", { id: "edit-sequence-status", class: "es-status", role: "status", "aria-live": "polite" });
  const progress = ui.el("progress", { id: "edit-sequence-progress", class: "es-progress", max: 1, value: 0, "aria-label": "本轮处理进度" });
  const counts = ui.el("p", { id: "edit-sequence-counts", class: "es-counts" });
  const previous = ui.el("button", { id: "edit-sequence-prev", type: "button", class: "btn btn-sm es-nav", text: "上一首", onClick: () => navigate(-1) });
  const next = ui.el("button", { id: "edit-sequence-next", type: "button", class: "btn btn-sm es-nav", text: "下一首", onClick: () => navigate(1) });
  const skip = ui.el("button", { id: "edit-sequence-skip", type: "button", class: "btn btn-sm btn-ghost es-skip", text: "先跳过", title: "标记当前曲目为跳过，仍停留在这一首", onClick: () => {
    if (!model || host.hidden || model.busy) return;
    onSkip();
  } });
  host.classList.add("edit-sequence");
  host.setAttribute("role", "region");
  host.setAttribute("aria-labelledby", "edit-sequence-heading");
  host.replaceChildren(heading,
    ui.el("div", { class: "es-heading" }, [position, status]), progress,
    ui.el("div", { class: "es-bottom" }, [counts, ui.el("nav", { class: "es-actions", "aria-label": "逐首编辑导航" }, [previous, next, skip])]),
  );
  host.hidden = true;

  function navigate(offset) {
    if (!model || host.hidden || model.busy) return;
    const index = model.index + offset;
    if (index >= 0 && index < model.rows.length) onNavigate(index);
  }
  function render({ rows = [], index = 0, states = new Map(), busy = false, dirty = false, unavailable = false } = {}) {
    if (!Array.isArray(rows) || !rows.length || !Number.isInteger(index) || index < 0 || index >= rows.length || !rows[index]) { hide(); return; }
    const focused = document.activeElement;
    model = { rows, index, busy: Boolean(busy) };
    host.hidden = false;
    Object.assign(host.dataset, { index: String(index), trackId: String(rows[index].id), busy: String(Boolean(busy)), dirty: String(Boolean(dirty)), unavailable: String(Boolean(unavailable)) });
    host.setAttribute("aria-busy", String(Boolean(busy)));
    setText(position, `第 ${ui.fmtNum(index + 1)} / ${ui.fmtNum(rows.length)} 首`);
    position.title = titleOf(rows[index]);
    position.setAttribute("aria-label", `第 ${index + 1} 首，共 ${rows.length} 首：${titleOf(rows[index])}`);
    const currentState = stateOf(states, rows[index]);
    status.dataset.state = currentState;
    status.dataset.tone = busy ? "busy" : unavailable ? "error" : dirty ? "dirty" : currentState;
    setText(status, busy ? "处理中…" : unavailable ? "暂不可编辑" : dirty ? "有未提交修改" : LABELS[currentState]);
    const total = { pending: 0, saved: 0, unchanged: 0, skipped: 0, error: 0 };
    for (const row of rows) total[stateOf(states, row)]++;
    const processed = total.saved + total.unchanged + total.skipped;
    progress.max = rows.length; progress.value = processed;
    const detail = `已写入 ${total.saved} 首，未改动 ${total.unchanged} 首，跳过 ${total.skipped} 首，待核对 ${total.error} 首，待处理 ${total.pending} 首`;
    progress.setAttribute("aria-valuetext", `已处理 ${processed} / ${rows.length} 首。${detail}`);
    progress.title = detail;
    setText(counts, `已写入 ${ui.fmtNum(total.saved)} · 未改 ${ui.fmtNum(total.unchanged)} · 跳过 ${ui.fmtNum(total.skipped)}`);
    counts.title = detail;
    counts.setAttribute("aria-label", detail);
    previous.disabled = Boolean(busy) || index === 0;
    next.disabled = Boolean(busy) || index === rows.length - 1;
    skip.disabled = Boolean(busy);
    previous.title = index > 0 ? `上一首：${titleOf(rows[index - 1])}` : "已是第一首";
    next.title = index < rows.length - 1 ? `下一首：${titleOf(rows[index + 1])}` : "已是最后一首";
    // Keep keyboard navigation reachable when the active edge button becomes disabled.
    if (!busy && (focused === previous || focused === next) && focused.disabled) {
      (previous.disabled ? next.disabled ? skip : next : previous).focus({ preventScroll: true });
    }
  }
  function hide() {
    animation?.cancel(); animation = null; model = null;
    host.hidden = true;
    host.removeAttribute("aria-busy");
    for (const key of ["index", "trackId", "busy", "dirty", "unavailable"]) delete host.dataset[key];
    previous.disabled = next.disabled = skip.disabled = true;
  }
  function animate() {
    animation?.cancel(); animation = null;
    if (host.hidden || !model || model.busy || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const body = host.closest(".drawer")?.querySelector(".drawer-body");
    if (!body?.animate) return;
    const nextAnimation = body.animate([{ opacity: .72, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
    animation = nextAnimation;
    nextAnimation.onfinish = () => { if (animation === nextAnimation) animation = null; };
  }
  return { render, hide, animate };
}
