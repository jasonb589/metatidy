import * as ui from "./ui.js";

let showing = false;

export async function showKeyboardHelp() {
  if (showing || document.querySelector("dialog[open]")) return;
  showing = true;
  const entries = [
    ["Ctrl / ⌘ + K", "打开命令面板，搜索曲目或跳转工作区"],
    ["/", "聚焦曲库搜索框"],
    ["↑ ↓", "在曲库中移动到上一行或下一行"],
    ["← →", "在封面视图中移动到相邻曲目"],
    ["Space", "勾选或取消当前高亮曲目"],
    ["Enter", "编辑当前高亮曲目的元数据"],
    ["I", "查看当前高亮曲目的详细资料"],
    ["Esc", "关闭当前面板，或取消曲库高亮"],
    ["?", "查看这份快捷键说明"],
  ];
  try {
    await ui.openDialog({
      title: "键盘快捷键", subtitle: "少一点点击，多一点从容。", size: "narrow",
      body: [ui.el("dl", { id: "keyboard-shortcuts", class: "keyboard-shortcuts" }, entries.flatMap(([key, label]) => [
        ui.el("dt", {}, [ui.el("kbd", { text: key })]), ui.el("dd", { text: label }),
      ])), ui.el("p", { class: "hint", text: "曲库快捷键在输入框外生效；聚焦按钮、链接和复选框时保留原生键盘操作。" })],
      actions: [{ id: "close", label: "知道了", variant: "btn-primary", autofocus: true }],
    });
  } finally { showing = false; }
}

export function initKeyboardHelp() {
  ui.byId("btn-shortcuts-footer")?.addEventListener("click", showKeyboardHelp);
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    if (document.querySelector("dialog[open], #edit-drawer[data-open='true'], .app-content[inert]")) return;
    if ([...document.querySelectorAll(".palette-veil, #auth-veil")].some((node) => node.getClientRects().length && !node.hidden)) return;
    event.preventDefault();
    void showKeyboardHelp();
  });
}
