/**
 * 密码登录（后端在 `backend-rs/src/auth.rs`）。
 *
 * 后端没设 `METATIDY_PASSWORD` 时这里几乎全是空操作：`/api/session` 回 `required: false`，
 * 页面照旧直接进，只在顶栏挂一个红色的「未设密码」提醒。
 *
 * 设了密码之后的流程：
 *   1. 启动先问 `/api/session`；
 *   2. 需要登录且没有会话 → 铺一层全屏遮罩要口令，**通过之前一个数据请求都不发**
 *      （否则一屏 401 会把 toast 刷满，还会让人以为「这软件坏了」）；
 *   3. 任何请求撞到 401（会话过期 / 在别处退出登录）→ 遮罩自己弹回来。
 *      遮罩**不允许 Esc 关掉**：关掉之后界面是一片空数据，比遮罩更误导。
 */

import { api } from "./api.js";
import * as ui from "./ui.js";

let session = { required: false, authenticated: true, session_days: 0, warning: "" };
let veil = null;
let authedHandler = null;

/** 当前会话状态。 */
export function current() {
  return session;
}

/** 注册「刚登录成功」的回调（app.js 用它决定是启动界面还是整页重载）。 */
export function onAuthenticated(handler) {
  authedHandler = handler;
}

/** 问后端要不要登录，并顺手更新顶栏。 */
export async function loadSession() {
  session = await api.session();
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

function buildVeil() {
  const reason = ui.el("p", { class: "hint", id: "auth-reason", text: "请输入访问密码。" });
  const input = ui.el("input", {
    type: "password",
    id: "auth-password",
    autocomplete: "current-password",
    placeholder: "访问密码",
    "aria-label": "访问密码",
  });
  const submit = ui.el("button", {
    type: "submit",
    class: "btn btn-primary",
    id: "auth-submit",
    text: "登录",
  });
  const form = ui.el("form", { class: "auth-card", id: "auth-form", novalidate: true }, [
    ui.el("h2", { text: "需要登录" }),
    ui.el("p", { class: "hint", text: "这个服务启用了密码保护（METATIDY_PASSWORD）。" }),
    ui.el("label", { class: "auth-field" }, [
      ui.el("span", { class: "hint", text: "访问密码" }),
      input,
    ]),
    reason,
    ui.el("div", { class: "auth-actions" }, [submit]),
    ui.el("p", {
      class: "hint",
      text: "连续输错 5 次会锁 5 分钟。忘了密码就改容器的 METATIDY_PASSWORD 再重新部署。",
    }),
  ]);
  const wrap = ui.el(
    "div",
    { class: "auth-veil", id: "auth-veil", role: "dialog", "aria-modal": "true", "aria-label": "登录" },
    [form],
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitLogin(input, submit, reason);
  });
  return { wrap, input, submit, reason };
}

/** 弹登录遮罩（已经开着就只更新提示，不擦掉用户已经敲进去的口令）。 */
export function showLoginOverlay(message = "") {
  if (!veil) veil = buildVeil();
  const wasOpen = veil.wrap.dataset.open === "true";
  if (message) {
    veil.reason.textContent = message;
    veil.reason.classList.remove("hint-err");
  }
  if (!veil.wrap.isConnected) document.body.append(veil.wrap);
  veil.wrap.dataset.open = "true";
  if (!wasOpen) {
    veil.input.value = "";
    window.setTimeout(() => veil.input.focus(), 0);
  }
}

/** 收起登录遮罩。 */
export function hideLoginOverlay() {
  if (!veil) return;
  veil.wrap.dataset.open = "false";
  if (veil.wrap.isConnected) veil.wrap.remove();
}

async function submitLogin(input, submit, reason) {
  const password = input.value;
  if (!password) {
    reason.textContent = "请输入密码。";
    reason.classList.add("hint-err");
    input.focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = "登录中…";
  reason.classList.remove("hint-err");
  reason.textContent = "正在验证…";
  try {
    const info = await api.login(password);
    // 用后端回的答案更新本地状态：否则顶栏会一直挂着「未登录」
    session = {
      required: info.required !== false,
      authenticated: true,
      session_days: info.session_days || session.session_days,
      warning: "",
    };
    applyChrome();
    hideLoginOverlay();
    input.value = "";
    if (authedHandler) await authedHandler();
  } catch (err) {
    // 401 会先触发 metatidy:unauthorized（遮罩重新显示），这里再用真实原因覆盖提示
    reason.textContent = (err && err.message) || "登录失败";
    reason.classList.add("hint-err");
    input.select();
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
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
      // 整页重载：列表里还留着刚才的数据，重载后才会变成干净的登录遮罩
      location.reload();
    });
  }

  window.addEventListener("metatidy:unauthorized", () => {
    session = { ...session, required: true, authenticated: false };
    applyChrome();
    showLoginOverlay("登录已过期或在别处退出了，请重新登录。");
  });
}
