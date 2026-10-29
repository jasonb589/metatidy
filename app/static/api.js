/**
 * 统一的后端调用封装。
 * - 每个请求带超时（AbortController），默认 30 秒；搜索/写入这类慢接口单独放宽
 * - 非 2xx 时把 FastAPI 的 detail（字符串或 422 校验数组）转成可读中文
 * - 网络层失败（后端没起来 / DNS / 连接被拒）给出明确提示，不抛原始 TypeError
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

export class ApiError extends Error {
  constructor(message, status = 0, detail = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** 把后端 detail 字段转成一行可读文本。 */
export function explainDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const loc = Array.isArray(entry.loc) ? entry.loc.filter((x) => x !== "body").join(".") : "";
          return (loc ? loc + "：" : "") + (entry.msg || JSON.stringify(entry));
        }
        return String(entry);
      })
      .join("；");
  }
  if (typeof detail === "object") return detail.message || JSON.stringify(detail);
  return String(detail);
}

export async function request(path, { method = "GET", body, timeout = 30000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const relay = () => controller.abort();
  if (signal) signal.addEventListener("abort", relay);

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relay);
    if (err && err.name === "AbortError") {
      if (signal && signal.aborted) throw new ApiError("请求已取消", 0, "");
      throw new ApiError(`请求超时（超过 ${Math.round(timeout / 1000)} 秒）`, 0, "");
    }
    throw new ApiError("无法连接后端服务，请确认服务仍在运行", 0, String((err && err.message) || err));
  }
  clearTimeout(timer);
  if (signal) signal.removeEventListener("abort", relay);

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const detail = explainDetail(data && data.detail) || `${res.status} ${res.statusText || "请求失败"}`;
    // 401 = 没登录 / 会话过期：广播出去让外壳弹回登录框（api.js 是叶子模块，用事件解耦）
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent("metatidy:unauthorized", { detail }));
    }
    throw new ApiError(detail, res.status, detail);
  }
  return data === null ? {} : data;
}

/** 只保留有值的查询参数：false / 空串 / null 一律不传（后端默认就是 false）。 */
export function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || value === false) return;
    search.set(key, value === true ? "1" : String(value));
  });
  return search.toString();
}

export const API = "/api";

export const api = {
  status: () => request(`${API}/status`),
  settings: () => request(`${API}/settings`),
  saveSettings: (values) => request(`${API}/settings`, { method: "PUT", body: { values } }),
  sources: () => request(`${API}/sources`),

  // 登录（后端没设 METATIDY_PASSWORD 时 session 直接回 required:false，前端就不弹框）
  session: () => request(`${API}/session`),
  login: (password) => request(`${API}/login`, { method: "POST", body: { password } }),
  logout: () => request(`${API}/logout`, { method: "POST", body: {} }),

  tracks: (params) => request(`${API}/tracks?${qs(params)}`),
  track: (id) => request(`${API}/tracks/${id}`),
  previewTracks: (payload) => request(`${API}/tracks/preview`, { method: "POST", body: payload, timeout: 90000 }),
  applyTracks: (payload) => request(`${API}/tracks/apply`, { method: "POST", body: payload, timeout: 300000 }),

  scan: (body) => request(`${API}/scan`, { method: "POST", body }),
  job: (jobId) => request(`${API}/jobs/${jobId}`),
  jobs: () => request(`${API}/jobs`),

  search: (payload) => request(`${API}/search`, { method: "POST", body: payload, timeout: 120000 }),
  scrapeApply: (payload) => request(`${API}/scrape/apply`, { method: "POST", body: payload, timeout: 180000 }),
  scrapeBatch: (payload) => request(`${API}/scrape/batch`, { method: "POST", body: payload }),

  movePreview: (payload) => request(`${API}/move/preview`, { method: "POST", body: payload, timeout: 120000 }),
  movePlan: (token) => request(`${API}/move/plan/${token}`),
  moveExecute: (payload) => request(`${API}/move/execute`, { method: "POST", body: payload, timeout: 120000 }),

  templateTest: (params) => request(`${API}/template/test?${qs(params)}`),
  aliases: (kind) => request(`${API}/aliases/${kind}`),
  saveAliases: (kind, items) => request(`${API}/aliases/${kind}`, { method: "PUT", body: { items } }),
};

export function coverUrl(trackId, size = 64) {
  return `${API}/tracks/${trackId}/cover?size=${size}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询任务直到 state 不再是 running。
 * onTick 每轮回调一次（用于刷新进度条与 message）。
 */
export async function pollJob(jobId, { onTick, interval = 600, timeoutMs = 3600000 } = {}) {
  const started = Date.now();
  for (;;) {
    const job = await api.job(jobId);
    if (onTick) onTick(job);
    if (job.state !== "running") return job;
    if (Date.now() - started > timeoutMs) throw new ApiError("等待任务完成超时，请到「任务」面板确认后端状态", 0, "");
    await sleep(interval);
  }
}
