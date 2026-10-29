/* 日夜主题。
 *
 * 设计取舍：
 * - 主题只体现为 <html data-theme="light|dark">，配色全部由 styles.css 的变量决定，
 *   所以这里不需要认识任何具体颜色。
 * - 默认跟随系统（prefers-color-scheme）；用户手动切过一次后记住选择（localStorage）。
 * - 首屏防闪：index.html 的 <head> 里有一段同样逻辑的内联脚本，在样式生效前就定好主题；
 *   这里只负责按钮、以及跟随系统变化。
 */
const KEY = "metatidy-theme";
const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: light)");

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // 隐私模式/禁用存储：当作没选过
  }
}

export function current() {
  return stored() || (media.matches ? "light" : "dark");
}

function apply(theme) {
  root.dataset.theme = theme;
  const btn = document.getElementById("btn-theme");
  if (btn) {
    // 按钮显示的是「点下去会切到哪个主题」，避免歧义
    btn.textContent = theme === "light" ? "深色" : "浅色";
    btn.title = theme === "light" ? "切到深色主题" : "切到浅色主题";
    btn.setAttribute("aria-label", btn.title);
  }
}

export function init() {
  apply(current());

  const btn = document.getElementById("btn-theme");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = current() === "light" ? "dark" : "light";
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
    if (!stored()) apply(current());
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
  } else if (typeof media.addListener === "function") {
    media.addListener(onChange); // 老浏览器
  }
}
