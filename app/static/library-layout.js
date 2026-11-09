/** Layout only: keep every existing library control and its event handlers intact. */
import * as ui from "./ui.js";

let initialized = false;

export function init() {
  if (initialized) return;
  const overview = ui.byId("library-overview"), tools = ui.byId("library-tools"), refine = ui.byId("library-refine-row");
  if (!overview || !tools || !refine) return;
  initialized = true;
  const mobile = matchMedia("(max-width: 700px)");
  const overviewToggle = ui.byId("library-overview-toggle"), overviewCopy = ui.byId("library-overview-summary");
  const views = ui.byId("library-view-controls"), help = ui.byId("btn-library-shortcuts");
  if (views) refine.prepend(views);
  if (help) {
    help.classList.add("btn", "btn-sm"); help.textContent = "键盘快捷键";
    tools.querySelector(".library-tools-panel").insertBefore(help, ui.byId("tracks-updated"));
  }
  const disclosures = [tools, ui.byId("library-filters"), ui.byId("library-saved-filters"), ui.byId("library-display-settings")].filter(Boolean);
  const contentOf = disclosure => disclosure.querySelector(".library-popover-panel, .library-display-panel");
  const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]");
  let animation = null;

  function close(disclosure, restore = false) {
    if (!disclosure.open) return;
    const summary = disclosure.querySelector(":scope > summary");
    if ((restore || disclosure.contains(document.activeElement)) && focusable(summary)) summary.focus({ preventScroll: true });
    disclosure.open = false;
    summary.setAttribute("aria-expanded", "false");
  }
  function place(disclosure) {
    if (!disclosure.open) return;
    const panel = contentOf(disclosure), summary = disclosure.querySelector(":scope > summary");
    if (!panel || !summary.getClientRects().length) return;
    const margin = 10, rect = summary.getBoundingClientRect();
    panel.style.maxHeight = `${Math.max(100, innerHeight - margin * 2)}px`;
    panel.style.left = `${Math.max(margin, Math.min(innerWidth - panel.offsetWidth - margin, rect.right - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(margin, Math.min(rect.bottom + 7, innerHeight - panel.offsetHeight - margin))}px`;
  }
  function reveal(content) {
    if (!content?.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animation?.cancel();
    animation = content.animate([{ opacity: .55, transform: "translateY(-3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
    animation.onfinish = () => { animation = null; };
  }
  for (const disclosure of disclosures) {
    const summary = disclosure.querySelector(":scope > summary"), panel = contentOf(disclosure);
    summary.setAttribute("aria-expanded", String(disclosure.open));
    if (!panel.id) panel.id = `${disclosure.id}-panel`;
    summary.setAttribute("aria-controls", panel.id);
    // Saved presets and updated status text can grow an already-open panel.
    // Re-anchor the same controls after content changes, including a modal return.
    new ResizeObserver(() => place(disclosure)).observe(panel);
    // Native details toggle events are queued and may arrive after a frame.
    // Position at the open-attribute microtask so reopening after a resize
    // never paints the previous viewport's coordinates, even for one frame.
    new MutationObserver(() => {
      summary.setAttribute("aria-expanded", String(disclosure.open));
      if (!disclosure.open) return;
      for (const other of disclosures) if (other !== disclosure) close(other);
      place(disclosure); reveal(panel);
    }).observe(disclosure, { attributes: true, attributeFilter: ["open"] });
  }
  function updateOverview() {
    const count = ui.byId("stats-strip")?.querySelector(".stat .v")?.textContent?.trim();
    const health = ui.byId("library-health")?.querySelector(".health-summary .hint")?.textContent?.trim();
    const next = [count ? `${count} 首` : "", health?.includes("%") ? health.replace("封面覆盖率 ", "封面 ") : ""].filter(Boolean).join(" · ");
    overviewCopy.textContent = next || "尚无曲目";
    overviewToggle.setAttribute("aria-expanded", String(overview.open));
  }
  function resize() {
    if (!mobile.matches && !overview.open) overview.open = true;
    for (const disclosure of disclosures) place(disclosure);
  }
  function changeOverviewMode() {
    if (mobile.matches) {
      if (overview.contains(document.activeElement) && document.activeElement !== overviewToggle) overviewToggle.focus({ preventScroll: true });
      overview.open = false;
    } else {
      overview.open = true;
      if (document.activeElement === overviewToggle) ui.byId("tracks-q")?.focus({ preventScroll: true });
    }
    updateOverview(); resize();
  }
  overview.addEventListener("toggle", () => { updateOverview(); if (overview.open && mobile.matches) reveal(overview.querySelector(".library-overview-content")); });
  new MutationObserver(updateOverview).observe(overview.querySelector(".library-overview-content"), { childList: true, subtree: true, characterData: true });
  mobile.addEventListener("change", changeOverviewMode);
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", () => { for (const disclosure of disclosures) place(disclosure); }, true);
  document.addEventListener("click", event => {
    if (document.querySelector("dialog[open]") || event.target.closest("dialog")) return;
    for (const disclosure of disclosures) if (!disclosure.contains(event.target)) close(disclosure);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    const opened = disclosures.find(disclosure => disclosure.open);
    if (opened) { event.preventDefault(); close(opened, true); }
  });
  const closeAll = () => { animation?.cancel(); for (const disclosure of disclosures) close(disclosure); };
  window.addEventListener("hashchange", closeAll);
  window.addEventListener("metatidy:unauthorized", closeAll);
  changeOverviewMode();
}
