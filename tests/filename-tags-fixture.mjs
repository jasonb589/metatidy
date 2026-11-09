/** In-memory filename-tag plans for browser acceptance. Never opens audio files. */
import { createHash, randomUUID } from 'node:crypto';

const prefix = '/api/tracks/filename-tags';
const fields = new Set(['track', 'disc', 'artist', 'title', 'album']);
const clone = value => structuredClone(value);
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code, message, status = 400) => { throw Object.assign(new Error(message), { status, detail: { code, message } }); };
const isUuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
function keys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) failure('invalid_request', '请求字段无效');
}
function ids(value) {
  if (!Array.isArray(value) || !value.length || value.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(value).size !== value.length) failure('invalid_request', '请选择不重复的有效曲目编号');
  if (value.length > 500) failure('selection_limit_exceeded', '一次最多处理 500 首曲目，请缩小选择范围');
  return value;
}
function templateOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || value.includes('\0')) failure('invalid_template', '请填写有效的文件名模板');
  const pieces = [], seen = new Set(); let cursor = 0;
  for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
    const literal = value.slice(cursor, match.index);
    if (/[{}]/.test(literal) || !fields.has(match[1]) || seen.has(match[1]) || (pieces.length && !literal)) failure('invalid_template', '字段不受支持、重复，或相邻字段之间缺少分隔符');
    pieces.push(literal, { field: match[1] }); seen.add(match[1]); cursor = match.index + match[0].length;
  }
  const end = value.slice(cursor); if (!seen.size || /[{}]/.test(end)) failure('invalid_template', '模板括号或字段无效');
  pieces.push(end); return pieces;
}
function parseFilename(filename, pieces) {
  const stem = filename.replace(/\.[^.]+$/, ''), matches = [];
  function visit(index, cursor, values) {
    if (matches.length > 1) return;
    if (index === pieces.length) { if (cursor === stem.length) matches.push(values); return; }
    const part = pieces[index];
    if (typeof part === 'string') { if (stem.startsWith(part, cursor)) visit(index + 1, cursor + part.length, values); return; }
    for (let end = cursor + 1; end <= stem.length; end++) {
      const text = stem.slice(cursor, end).trim();
      if (!text || (['track', 'disc'].includes(part.field) && !/^[0-9]{1,9}$/.test(text))) continue;
      visit(index + 1, end, { ...values, [part.field]: text });
    }
  }
  visit(0, 0, {});
  return matches.length === 1 ? { status: 'matched', parsed_fields: matches[0], reason: null }
    : matches.length > 1 ? { status: 'ambiguous', parsed_fields: {}, reason: '有多个合法拆分，请调整模板或排除此曲目' }
      : { status: 'unmatched', parsed_fields: {}, reason: '文件名与模板不匹配' };
}
const countsOf = items => items.reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {});

export function createFilenameTagsFixture(tracks, { jobs = [], autoComplete = true, now = () => Date.now() / 1000 } = {}) {
  const plans = new Map(), calls = [];
  const trackOf = id => tracks.find(row => row.id === id);
  function parse(body) {
    keys(body, ['ids', 'template']); const selected = ids(body.ids), pieces = templateOf(body.template);
    const items = selected.map(track_id => {
      const row = trackOf(track_id);
      return row ? { track_id, filename: row.filename, path: row.path, ...parseFilename(row.filename, pieces) }
        : { track_id, filename: '', path: '', status: 'index_missing', parsed_fields: {}, reason: '曲目索引不存在' };
    });
    return { analysis_revision: revision([body.template, items]), limit: 500, total: selected.length, template: body.template,
      counts: { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0, index_missing: 0, ...countsOf(items) }, items };
  }
  function preview(body) {
    keys(body, ['ids', 'template', 'analysis_revision', 'include_ids', 'overwrite', 'normalize_artist']);
    if (typeof body.overwrite !== 'boolean' || typeof body.normalize_artist !== 'boolean' || !Array.isArray(body.include_ids)
      || new Set(body.include_ids).size !== body.include_ids.length || body.include_ids.some(id => !body.ids?.includes(id))) failure('invalid_request', '预览选项或包含的曲目无效');
    const parsed = parse({ ids: body.ids, template: body.template });
    if (body.analysis_revision !== parsed.analysis_revision) failure('analysis_changed', '文件名分析已变化，请重新分析', 409);
    const items = parsed.items.map(item => {
      const included = body.include_ids.includes(item.track_id), row = trackOf(item.track_id);
      const result = { ...item, included, processed_fields: {}, current: {}, effective_fields: {}, changes: {}, skipped: [], stage: null, file_changed: false };
      if (item.status !== 'matched') { if (included) failure('invalid_request', '不能包含未成功解析的曲目'); return result; }
      if (!included) return { ...result, status: 'excluded', reason: '已从本次计划排除' };
      for (const [field, raw] of Object.entries(item.parsed_fields)) {
        const value = ['track', 'disc'].includes(field) ? String(Number(raw)) : field === 'artist' && body.normalize_artist ? raw.replace(/\s*&\s*/g, ' / ') : raw;
        result.processed_fields[field] = value;
      }
      if (row.fixture_read_error) return { ...result, status: 'unreadable', reason: row.fixture_read_error, stage: 'read' };
      for (const [field, value] of Object.entries(result.processed_fields)) {
        const current = String(row.fixture_current?.[field] ?? row[field] ?? '');
        result.current[field] = current;
        if (!body.overwrite && current.trim()) result.skipped.push({ field, reason: 'existing', detail: '保留已有值' });
        else if (current !== value) { result.effective_fields[field] = value; result.changes[field] = { old: current, new: value }; }
        else result.skipped.push({ field, reason: 'unchanged', detail: '值相同' });
      }
      result.status = Object.keys(result.changes).length ? 'ready' : 'unchanged'; return result;
    });
    const plan = { token: randomUUID(), revision: revision([body, items, now()]), state: 'ready', expires_at: now() + 1800,
      job_id: null, request_id: null, total: items.length, included_total: items.filter(item => item.included).length,
      ready_total: items.filter(item => item.status === 'ready').length, changed_fields: items.reduce((total, item) => total + Object.keys(item.changes).length, 0),
      template: body.template, overwrite: body.overwrite, normalize_artist: body.normalize_artist, counts: countsOf(items), items };
    plans.set(plan.token, plan); return clone(plan);
  }
  function settle(token, statuses = {}, state = 'done') {
    const plan = plans.get(token); if (!plan) failure('plan_missing', '标签提取计划不存在', 404);
    plan.state = state;
    for (const item of plan.items) {
      const supplied = statuses[item.track_id];
      if (supplied) Object.assign(item, typeof supplied === 'string' ? { status: supplied } : supplied);
      else if (['pending', 'writing', 'ready'].includes(item.status)) item.status = 'written';
      if (item.status === 'written') { item.file_changed = true; Object.assign(trackOf(item.track_id), item.effective_fields); }
    }
    plan.counts = countsOf(plan.items);
    const job = jobs.find(job => job.id === plan.job_id);
    if (job) Object.assign(job, { state, done: plan.items.length, updated_at: now(), message: '测试计划已完成，仅修改内存样本',
      result: JSON.stringify({ token: plan.token, revision: plan.revision, details: plan.items, details_total: plan.items.length, details_truncated: false }) });
    return clone(plan);
  }
  function apply(body) {
    keys(body, ['token', 'revision', 'request_id']);
    if (!isUuid(body.token) || typeof body.revision !== 'string' || !/^[a-f\d]{64}$/.test(body.revision) || !isUuid(body.request_id)) failure('invalid_request', '计划或请求编号无效');
    const plan = plans.get(body.token); if (!plan) failure('plan_missing', '标签提取计划不存在', 404);
    if (body.revision !== plan.revision) failure('plan_changed', '计划版本已变化', 409);
    if (plan.request_id && body.request_id !== plan.request_id) failure('already_submitted', '此计划已经提交，请查看原任务结果', 409);
    if (!plan.request_id) {
      if (plan.expires_at <= now()) failure('plan_expired', '计划已过期，请重新预览', 409);
      if (!plan.ready_total) failure('no_changes', '本次计划没有需要写入的变化', 409);
      plan.request_id = body.request_id; plan.job_id = randomUUID(); plan.state = 'running';
      for (const item of plan.items) if (item.status === 'ready') item.status = 'pending';
      plan.counts = countsOf(plan.items);
      jobs.unshift({ id: plan.job_id, kind: 'filename_tags', state: 'running', total: plan.items.length, done: 0,
        message: '测试计划已提交，仅修改内存样本', error: '', created_at: now(), updated_at: now(), result: '' });
      if (autoComplete) settle(plan.token);
    }
    return { token: plan.token, revision: plan.revision, job_id: plan.job_id, state: plan.state };
  }
  function handle(path, method, params = new URLSearchParams(), body = {}) {
    calls.push({ path, method, body: clone(body) });
    if (path === `${prefix}/parse` && method === 'POST') return parse(body);
    if (path === `${prefix}/preview` && method === 'POST') return preview(body);
    if (path === `${prefix}/apply` && method === 'POST') return apply(body);
    const match = path.match(/^\/api\/tracks\/filename-tags\/plans\/([^/]+)(\/items)?$/);
    if (match && method === 'GET') {
      const plan = plans.get(match[1]); if (!plan) failure('plan_missing', '标签提取计划不存在', 404);
      return clone(match[2] ? { token: plan.token, revision: plan.revision, state: plan.state, total: plan.total, items: plan.items } : plan);
    }
    failure('invalid_request', '不支持的文件名标签接口', 405);
  }
  return { handle, plans, calls, parse, preview, apply, settle, jobs };
}
