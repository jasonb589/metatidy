/**
 * 密码登录的「外壳」部分（后端在 `backend-rs/src/auth.rs`）。
 *
 * **登录框本身不在这里**，而在 `index.html` 的兜底脚本（`window.__MT_AUTH`）里。
 * 原因：反代/CDN 会按扩展名把 .js 缓存成旧版本（真踩过：openresty 把旧 app.js 缓存到第二天
 * 00:30，浏览器拿到「新 HTML + 旧 JS」——旧 JS 不知道要去问 /api/session，界面只弹一句
 * 「请先登录」，登录框永远不出现）。HTML 不被缓存，所以「能不能登录」必须由 HTML 里的脚本保证。
 *
 * 这里只负责：顶栏登录态胶囊、退出按钮、以及任何 401 之后的接管。
 */

import { api } from "./api.js";
import * as ui from "./ui.js";

let session = { required: false, authenticated: true, session_days: 0, warning: "" };
let authedHandler = null;

function gate() {
  return window.__MT_AUTH || null;
}

/** 当前会话状态。 */
export function current() {
  return session;
}

/** 注册「刚登录成功」的回调（app.js 用它决定是启动界面还是整页重载）。 */
export function onAuthenticated(handler) {
  authedHandler = handler;
}

/** 问后端要不要登录（复用 HTML 兜底脚本已经发出的那次请求），并更新顶栏。 */
export async function loadSession() {
  const hook = gate();
  let data = hook ? await hook.ready : null;
  if (!data) data = await api.session();
  session = data;
  applyChrome();
  return session;
}

/** 顶栏的登录态胶囊与「退出」按钮。 */
export function applyChrome() {
  const chip = ui.byId("auth-chip");
  const out = ui.byId("btn-logout");
  if (out) out.hidden = !session.required;
  if (!chip) return;
  if (session.required) {
    chip.textContent = session.authenticated ? "已登录" : "未登录";
    chip.title = `已启用密码登录；会话有效期 ${session.session_days} 天，到期后需重新登录`;
    chip.className = "chip";
  } else {
    chip.textContent = "未设密码";
    chip.title = session.warning || "未设置 METATIDY_PASSWORD：任何人都能访问";
    chip.className = "chip is-bad";
  }
}

/** 弹登录框（真正的 DOM 在 index.html 里，这里只是转发）。 */
export function showLoginOverlay(message = "") {
  const hook = gate();
  if (hook) {
    hook.show(message);
    return;
  }
  // 理论上到不了这里（index.html 一定带兜底脚本），但别静默失败
  ui.toast("warn", "需要登录", message || "请输入访问密码。");
}

/** 收起登录框。 */
export function hideLoginOverlay() {
  const hook = gate();
  if (hook) hook.hide();
}

export function init() {
  const btn = ui.byId("btn-logout");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.logout();
      } catch {
        // 会话可能早就失效了：照样回登录页
      }
      // 整页重载：列表里还留着刚才的数据，重载后才会变成干净的登录框
      location.reload();
    });
  }

  // 登录成功（index.html 的兜底脚本广播）
  window.addEventListener("metatidy:authenticated", (event) => {
    // preventDefault = 「界面由我接管，不用整页重载」（兜底脚本据此判断静态 JS 是不是旧版本：
    // 没人接管它就自己 reload 一次）
    event.preventDefault();
    session = { ...session, ...(event.detail || {}), authenticated: true };
    applyChrome();
    if (authedHandler) authedHandler();
  });

  // 任何请求撞到 401（会话过期 / 在别处退出登录）
  window.addEventListener("metatidy:unauthorized", () => {
    session = { ...session, required: true, authenticated: false };
    applyChrome();
    showLoginOverlay("登录已过期或在别处退出了，请重新登录。");
  });
}
