/* 日夜主题。
 *
 * 设计取舍：
 * - 主题只体现为 <html data-theme="light|dark">，配色全部由 styles.css 的变量决定，
 *   所以这里不需要认识任何具体颜色。
 * - 默认跟随系统（prefers-color-scheme）；用户手动切过一次后记住选择（localStorage）。
 * - 首屏防闪：index.html 的 <head> 里有一段同样逻辑的内联脚本，在样式生效前就定好主题；
 *   这里只负责按钮、以及跟随系统变化。
 */
import { icon } from "./ui.js";

const KEY = "metatidy-theme";
const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: light)");
// 禁用 localStorage 时也保留本页的手动选择，连续点击仍可正常往返切换。
let manualTheme = null;

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // 隐私模式/禁用存储：当作没选过
  }
}

export function current() {
  return manualTheme || stored() || (media.matches ? "light" : "dark");
}

function apply(theme) {
  root.dataset.theme = theme;
  const btn = document.getElementById("btn-theme");
  if (btn) {
    // 按钮显示的是「点下去会切到哪个主题」，避免歧义
    let label = btn.querySelector(".theme-label");
    if (!label) {
      // 保留已有图标，只移除旧文本节点。
      [...btn.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).forEach((node) => node.remove());
      label = document.createElement("span");
      label.className = "theme-label";
      btn.append(label);
    }
    if (!btn.querySelector("svg")) {
      const glyph = icon("theme", { size: 16 });
      if (glyph) btn.prepend(glyph);
    }
    label.textContent = theme === "light" ? "深色模式" : "浅色模式";
    btn.title = theme === "light" ? "切到深色主题" : "切到浅色主题";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(theme === "dark"));
  }
}

export function init() {
  apply(current());

  const btn = document.getElementById("btn-theme");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = current() === "light" ? "dark" : "light";
      manualTheme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* 存不下就只影响这次会话 */
      }
      apply(next);
    });
  }

  // 没手动选过时跟随系统切换
  const onChange = () => {
    if (!manualTheme && !stored()) apply(current());
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
  } else if (typeof media.addListener === "function") {
    media.addListener(onChange); // 老浏览器
  }
}
