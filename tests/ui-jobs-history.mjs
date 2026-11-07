/** Task history, global polling and saved-result reports; fixture data only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const out = path.join(root, '.codex/ui-preview');
const port = Number(process.env.METATIDY_JOBS_UI_PORT || 18829);
const base = `http://127.0.0.1:${port}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred() });
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_JOBS_UI_CHECK && !name.includes(process.env.METATIDY_JOBS_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const idFor = number => number === 1 ? 'fixture-scan-001' : `history-${String(number).padStart(3, '0')}`;
function makeJobs() {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 64 }, (_, i) => {
    const n = i + 1, kind = n === 2 ? 'scrape' : ['scan', 'scrape', 'move'][i % 3];
    const result = n === 2 ? { applied: 31, failed: 1, details_total: 800, details_truncated: true,
      details: [...Array.from({ length: 31 }, (_, index) => ({ track_id: index + 1, status: 'applied', candidate: { title: `收藏 ${index + 1}`, artist: '验收歌手', source: 'fixture' } })), { track_id: 32, error: '受保护文件无法写入' }] }
      : { added: 4, updated: 2, moved: 3, applied: 5, skipped: 1, failed: 0, trigger: 'manual', root: '/music/验收收藏' };
    return { id: idFor(n), kind, state: n >= 53 ? 'running' : n === 40 ? 'error' : 'done', total: 100, done: n >= 53 ? 8 : 100,
      message: n >= 53 ? '等待或正在处理音乐' : n === 2 ? '部分文件写入失败' : `历史操作 ${n}`, error: n === 40 ? '任务数据库连接失败' : '',
      created_at: now - n * 60, updated_at: now - n * 30, result: n >= 53 ? '' : JSON.stringify(result) };
  });
}
function summary(job) {
  const { result, ...row } = job;
  let parsed; try { parsed = JSON.parse(result || '{}'); } catch { parsed = {}; }
  const scalars = Object.fromEntries(Object.entries(parsed).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
  return { ...row, percent: job.done / job.total * 100, has_result: Boolean(result), has_errors: Boolean(job.error || parsed.failed), summary: scalars };
}
const ordered = jobs => [...jobs].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
function overview(jobs, cursor = null) {
  const active = ordered(jobs).filter(job => job.state === 'running').reverse();
  return { jobs: ordered(jobs).slice(0, 20), counts: { total: jobs.length, ...Object.fromEntries(['running', 'done', 'error'].map(state => [state, jobs.filter(job => job.state === state).length])) },
    active: active.slice(0, 10).map(summary), active_total: active.length, active_limit: 10, latest_completed_watch: cursor };
}
function history(jobs, params) {
  const q = (params.get('q') || '').trim(), kind = params.get('kind') || '', state = params.get('state') || '';
  const items = ordered(jobs).filter(job => (!kind || job.kind === kind) && (!state || job.state === state)
    && (!q || ['id', 'kind', 'message', 'error'].some(key => String(job[key]).toLowerCase().includes(q.toLowerCase()))));
  const size = Number(params.get('page_size') || 20), pages = Math.ceil(items.length / size), page = Math.max(1, Math.min(pages || 1, Number(params.get('page') || 1)));
  return { items: items.slice((page - 1) * size, page * size).map(summary), q, kind, state, total: items.length, page, page_size: size, pages };
}
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const jobs = makeJobs(), calls = [], errors = [];
  const control = { cursor: null, delayHistory: null, delayDetail: null, delayStatus: null, historyError: null, detailError: null, detailResponse: null };
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === '/api/status' && control.delayStatus) {
      const delay = control.delayStatus; control.delayStatus = null; delay.entered.resolve(); await delay.release.promise;
    }
    if (url.pathname === '/api/jobs') return json(route, overview(jobs, control.cursor));
    if (url.pathname === '/api/jobs/history') {
      if (control.historyError) { const error = control.historyError; control.historyError = null; return json(route, { detail: error.text }, error.status); }
      const result = history(jobs, url.searchParams);
      if (control.delayHistory) { const delay = control.delayHistory; control.delayHistory = null; delay.entered.resolve(); await delay.release.promise; }
      return json(route, result);
    }
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (match) {
      if (control.detailError) { const error = control.detailError; control.detailError = null; return json(route, { detail: error.text }, error.status); }
      const result = structuredClone(control.detailResponse || jobs.find(job => job.id === decodeURIComponent(match[1]))); control.detailResponse = null;
      if (control.delayDetail) { const delay = control.delayDetail; control.delayDetail = null; delay.entered.resolve(); await delay.release.promise; }
      return json(route, result || { detail: '任务不存在' }, result ? 200 : 404);
    }
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  async function poll() {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs');
    await page.evaluate(async () => (await import('/store.js')).emit('jobs:refresh'));
    await (await response).finished(); await flush(page); await page.clock.runFor(180);
  }
  try {
    await page.goto(base); await page.waitForSelector('#jobs-list [data-job-id="fixture-scan-001"]', { state: 'attached' });
    await page.waitForSelector('#tracks-tbody tr'); await flush(page);
    await action({ page, context, jobs, calls, control, poll }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
const historyCalls = calls => calls.filter(call => call.path === '/api/jobs/history');
const detailCalls = (calls, id) => calls.filter(call => call.path === `/api/jobs/${id}`);
const cardFor = (page, id, host = 'jobs-history-list') => page.locator(`#${host} [data-job-id="${id}"]`);
async function openHistory(page) { await page.locator('#btn-jobs').click(); await page.locator('#jobs-history-tab').click(); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent.startsWith('匹配')); }
async function search(page, value) { await page.locator('#jobs-history-q').fill(value); await page.clock.runFor(280); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent.startsWith('匹配')); }

try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });

  await check('Global counts include old running tasks beyond the recent twenty', () => withPage(async ({ page, calls }) => {
    assert.equal(await page.locator('#jobs-running').textContent(), '12'); assert.equal(historyCalls(calls).length, 0);
    await page.locator('#btn-jobs').click(); assert.equal(await cardFor(page, idFor(64), 'jobs-list').count(), 1);
    assert.equal(await page.locator('[data-jobs-stat="running"] strong').textContent(), '12');
    await page.locator('#jobs-show-running').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs-history-list .job-card').length === 12);
    assert.equal(await page.locator('#jobs-history-state').inputValue(), 'running'); assert.equal(await page.locator('#jobs-running').textContent(), '12');
  }));
  await check('History search pagination and explicit query changes remove old open cards', () => withPage(async ({ page, calls }) => {
    await openHistory(page); assert.equal(await page.locator('#jobs-history-list .job-card').count(), 20); assert.match(await page.locator('#jobs-history-page').textContent(), /1 \/ 4/);
    await cardFor(page, idFor(1)).locator('summary').click(); await page.locator('#jobs-history-next').click();
    await page.waitForSelector(`#jobs-history-list [data-job-id="${idFor(21)}"]`); assert.equal(await cardFor(page, idFor(1)).count(), 0);
    await search(page, idFor(2)); assert.equal(await page.locator('#jobs-history-list .job-card').count(), 1); assert.equal(await page.locator('#jobs-history-page').textContent(), '1 / 1');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'jobs-history-q');
    await page.locator('#jobs-refresh').click(); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent === '匹配 1 项');
    assert.equal(historyCalls(calls).at(-1).query.q, idFor(2)); assert.equal(historyCalls(calls).at(-1).query.page, '1');
  }));
  await check('Completed partial failures remain distinct from failed tasks and type filters', () => withPage(async ({ page }) => {
    await openHistory(page); await page.locator('#jobs-history-state').selectOption('done'); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent === '匹配 51 项');
    assert.equal(await cardFor(page, idFor(2)).locator('.badge').textContent(), '已完成 · 部分失败');
    await page.locator('#jobs-history-kind').selectOption('scrape'); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent === '匹配 17 项');
    assert.equal(await page.locator('#jobs-running').textContent(), '12');
    await page.locator('#jobs-history-kind').selectOption(''); await page.locator('#jobs-history-state').selectOption('error'); await page.waitForFunction(() => document.querySelectorAll('#jobs-history-list .job-card').length === 1);
    assert.equal(await cardFor(page, idFor(40)).count(), 1); assert.equal(await cardFor(page, idFor(2)).count(), 0);
  }));
  await check('Polling never reruns or reorders a historical query and preserves focus and scroll', () => withPage(async ({ page, jobs, calls, poll }) => {
    await openHistory(page); const card = cardFor(page, idFor(5)); await card.locator('summary').click();
    await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"] .job-result-status`).textContent === '', idFor(5));
    await card.locator('summary').focus(); const before = await page.evaluate(() => {
      const list = document.querySelector('#jobs-history-list'); window.__savedJobCard = list.querySelector('[data-job-id="history-005"]'); list.scrollTop = 140;
      return { ids: [...list.querySelectorAll('.job-card')].map(card => card.dataset.jobId), scroll: list.scrollTop };
    });
    const count = historyCalls(calls).length; jobs.unshift({ ...jobs[0], id: 'brand-new', created_at: jobs[0].created_at + 200, updated_at: jobs[0].updated_at + 200 }); await poll();
    assert.equal(historyCalls(calls).length, count); assert.equal(await page.locator('#jobs-history-update').isVisible(), true);
    assert.deepEqual(await page.locator('#jobs-history-list .job-card').evaluateAll(cards => cards.map(card => card.dataset.jobId)), before.ids);
    assert.equal(await page.evaluate(() => document.querySelector('#jobs-history-list [data-job-id="history-005"]') === window.__savedJobCard), true);
    assert.equal(await card.getAttribute('open'), ''); assert.equal(await page.evaluate(() => document.activeElement.closest('.job-card').dataset.jobId), idFor(5));
    assert.equal(await page.locator('#jobs-history-list').evaluate(node => node.scrollTop), before.scroll);
  }));
  await check('Historical details load on demand and failed loads offer a working retry', () => withPage(async ({ page, calls, control }) => {
    await openHistory(page); assert.equal(detailCalls(calls, idFor(2)).length, 0); control.detailError = { status: 503, text: '暂时无法读取已存结果' };
    const card = cardFor(page, idFor(2)); await card.locator('summary').click(); await card.locator('.job-detail-retry').waitFor();
    assert.match(await card.locator('.job-result-status').textContent(), /结果读取失败/); assert.doesNotMatch(await card.locator('.job-result-status').textContent(), /没有保存/);
    await card.locator('.job-detail-retry').click(); await card.locator('.job-error-text').waitFor();
    assert.match(await card.locator('.job-detail-section .hint').textContent(), /前 30.*已保存 32 条明细（含错误）.*原明细总数 800/);
    assert.equal(await card.locator('.job-detail-row').count(), 30); assert.match(await card.locator('.job-error-text').textContent(), /受保护文件/);
  }));
  await check('Delayed detail responses cannot replace newer task completion', () => withPage(async ({ page, jobs, control, poll }) => {
    await openHistory(page); await search(page, idFor(64)); const old = gate(); control.delayDetail = old;
    const card = cardFor(page, idFor(64)); await card.locator('summary').click(); await old.entered.promise;
    const job = jobs.find(job => job.id === idFor(64)); Object.assign(job, { state: 'done', updated_at: job.updated_at + 5000, done: 100, result: JSON.stringify({ added: 99, failed: 0 }) });
    await poll(); await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"]`).dataset.jobState === 'done', job.id);
    old.release.resolve(); await flush(page); await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"] [data-metric="added"] strong`)?.textContent === '99', job.id);
    assert.equal(await card.getAttribute('data-job-state'), 'done'); assert.equal(await card.locator('.job-detail-retry').isHidden(), true);
  }));
  await check('Historical running records outside both overview windows get fresh progress', () => withPage(async ({ page, jobs, calls, poll }) => {
    await openHistory(page); await page.locator('#jobs-history-state').selectOption('running'); await page.waitForFunction(() => document.querySelectorAll('#jobs-history-list .job-card').length === 12);
    const job = jobs.find(job => job.id === idFor(53)); Object.assign(job, { done: 78, updated_at: job.updated_at + 200 }); await poll();
    await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"] .job-progress`).textContent.includes('78'), job.id);
    assert.ok(detailCalls(calls, job.id).length > 0);
    Object.assign(job, { state: 'done', done: 100, updated_at: job.updated_at + 200, result: JSON.stringify({ applied: 100 }) }); await poll();
    await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"]`).dataset.jobState === 'done', job.id);
    assert.equal(await page.locator('#jobs-history-list .job-card').count(), 12); assert.equal(await page.locator('#jobs-history-update').isVisible(), true);
  }));
  await check('Completed detail and same-second progress cannot regress to an older list snapshot', () => withPage(async ({ page, jobs, control, poll }) => {
    await openHistory(page); await search(page, idFor(64)); const original = jobs.find(job => job.id === idFor(64));
    control.detailResponse = { ...original, state: 'done', done: 100, updated_at: original.updated_at + 500, result: JSON.stringify({ added: 88 }) };
    const card = cardFor(page, original.id); await card.locator('summary').click();
    await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"]`).dataset.jobState === 'done', original.id);
    await poll(); assert.equal(await card.getAttribute('data-job-state'), 'done'); assert.equal(await card.locator('[data-metric="added"] strong').textContent(), '88');
    // Exercise the keyed renderer with complete recent rows as well as history summaries.
    await page.evaluate(async job => {
      const { renderJobs } = await import('/jobs-panel.js');
      const hostId = 'jobs-history-list'; renderJobs([{ ...job, state: 'running', done: 40, updated_at: job.updated_at + 1000 }], () => false, { hostId });
      renderJobs([{ ...job, state: 'running', done: 3, updated_at: job.updated_at + 1000 }], () => false, { hostId });
    }, { ...original, result: '' });
    assert.match(await card.locator('.job-progress-text, .job-progress').textContent(), /40 \/ 100/);
  }));
  await check('A stale query cannot overwrite a newer filter and errors clear totals and pager', () => withPage(async ({ page, control }) => {
    await openHistory(page); const old = gate(); control.delayHistory = old;
    await page.locator('#jobs-history-q').fill(idFor(30)); await page.clock.runFor(280); await old.entered.promise;
    await search(page, idFor(2)); old.release.resolve(); await flush(page); assert.equal(await cardFor(page, idFor(2)).count(), 1); assert.equal(await cardFor(page, idFor(30)).count(), 0);
    control.historyError = { status: 503, text: '历史库临时不可用' }; await page.locator('#jobs-history-q').fill('fail'); await page.clock.runFor(280); await page.locator('#jobs-history-retry').waitFor();
    assert.equal(await page.locator('#jobs-history-list .job-card').count(), 0); assert.equal(await page.locator('#jobs-history-total').textContent(), '历史未载入');
    assert.equal(await page.locator('#jobs-history-next').isDisabled(), true); assert.equal(await page.locator('#jobs-history-prev').isDisabled(), true);
    await page.locator('#jobs-history-retry').click(); await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent === '匹配 0 项');
    assert.match(await page.locator('#jobs-history-status').textContent(), /没有符合条件/);
  }));
  await check('Empty and unparseable saved results stay distinguishable from unloaded data', () => withPage(async ({ page, jobs }) => {
    jobs[1].result = ''; jobs[2].result = '{broken-json'; await openHistory(page);
    const empty = cardFor(page, idFor(2)); await empty.locator('summary').click(); await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"] .job-result-status`).textContent.includes('没有保存'), idFor(2));
    const broken = cardFor(page, idFor(3)); await broken.locator('summary').click(); await page.waitForFunction(id => document.querySelector(`#jobs-history-list [data-job-id="${id}"] .job-result-status`).textContent.includes('无法解析'), idFor(3));
    assert.equal(await broken.locator('.job-report-download').getAttribute('href'), `/api/jobs/${idFor(3)}/report?format=json`);
  }));
  await check('JSON reports use the authenticated saved-result endpoint and download valid scope', () => withPage(async ({ page }) => {
    await openHistory(page); const card = cardFor(page, idFor(1)); await card.locator('summary').click();
    const link = card.locator('.job-report-download'); assert.equal(await link.getAttribute('href'), '/api/jobs/fixture-scan-001/report?format=json');
    const downloaded = page.waitForEvent('download'); await link.click(); const file = await downloaded;
    const report = JSON.parse(await readFile(await file.path(), 'utf8'));
    assert.equal(file.suggestedFilename(), 'metatidy-job-fixture-scan-001.json'); assert.equal(report.report_scope, 'saved_result');
    assert.equal(report.completeness.scope, 'saved_result'); assert.equal(typeof report.job.result, 'string'); assert.equal(report.moved_paths, undefined);
  }));
  await check('Watcher cursor refreshes the library once while history is filtered', () => withPage(async ({ page, calls, control, poll }) => {
    await openHistory(page); await search(page, idFor(2)); const before = calls.filter(call => call.path === '/api/tracks').length, histories = historyCalls(calls).length;
    // The watcher refresh awaits a real status HTTP request before requesting
    // tracks; an idle table is also true before that request has even started.
    const refreshedTracks = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tracks');
    const status = gate(); control.delayStatus = status;
    control.cursor = { id: 'outside-recent-watch', updated_at: 999999, cursor: 'watch-completed-outside-window' }; await poll();
    await status.entered.promise;
    assert.equal(calls.filter(call => call.path === '/api/tracks').length, before, 'tracks must wait for the status response');
    status.release.resolve();
    await (await refreshedTracks).finished(); await flush(page);
    await page.waitForFunction(async () => !(await import('/store.js')).state.tracks.loading);
    assert.equal(calls.filter(call => call.path === '/api/tracks').length, before + 1); await poll();
    assert.equal(calls.filter(call => call.path === '/api/tracks').length, before + 1); assert.equal(historyCalls(calls).length, histories);
    assert.equal(await cardFor(page, idFor(2)).count(), 1);
  }));
  await check('Expired sessions invalidate delayed history and clear sensitive task data', () => withPage(async ({ page, control }) => {
    await openHistory(page); const old = gate(); control.delayHistory = old;
    await page.locator('#jobs-history-next').click(); await old.entered.promise;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized'))); old.release.resolve(); await flush(page);
    assert.equal(await page.locator('.job-card').count(), 0); assert.equal(await page.locator('.job-report-download').count(), 0); assert.equal(await page.locator('#jobs-global-stats').textContent(), '');
    assert.equal(await page.locator('#jobs-running').isHidden(), true); assert.equal(await page.locator('#jobs-pop').getAttribute('data-open'), 'false');
  }));
  await check('Expired sessions discard delayed detail responses and cached report links', () => withPage(async ({ page, control }) => {
    await openHistory(page); const old = gate(); control.delayDetail = old; await cardFor(page, idFor(2)).locator('summary').click(); await old.entered.promise;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized'))); old.release.resolve(); await flush(page);
    assert.equal(await page.locator('.job-card').count(), 0); assert.equal(await page.locator('.job-report-download').count(), 0);
  }));
  await check('Task tabs support roving keyboard focus and refresh keeps the current view', () => withPage(async ({ page }) => {
    await page.locator('#btn-jobs').click(); await page.locator('#jobs-overview-tab').focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#jobs-history-total').textContent.startsWith('匹配'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'jobs-history-tab'); assert.equal(await page.locator('#jobs-overview-tab').getAttribute('tabindex'), '-1');
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.id), 'jobs-overview-tab'); assert.equal(await page.locator('#jobs-overview').isVisible(), true);
  }));
  await check('Mobile history has fixed controls and one readable list scroller in both themes', async () => {
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'dark']]) await withPage(async ({ page }) => {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme); await openHistory(page);
      const card = cardFor(page, idFor(2)); await card.locator('summary').click(); await card.locator('.job-error-text').waitFor();
      const dimensions = await page.evaluate(() => {
        const pop = document.querySelector('#jobs-pop'), list = document.querySelector('#jobs-history-list'), controls = document.querySelector('.jobs-history-controls'), pager = document.querySelector('#jobs-history-pager');
        const before = [controls.getBoundingClientRect().top, pager.getBoundingClientRect().top]; list.scrollTop = 140;
        return { viewport: innerHeight, bottom: pop.getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth > innerWidth,
          listWidth: list.clientWidth, listContentWidth: list.scrollWidth, scrollable: list.scrollHeight > list.clientHeight, listHeight: list.clientHeight,
          stable: before.every((value, index) => value === [controls.getBoundingClientRect().top, pager.getBoundingClientRect().top][index]),
          reduced: getComputedStyle(document.querySelector('.job-progress-bar i')).transitionDuration };
      });
      await page.screenshot({ path: path.join(out, `jobs-history-${width}-${theme}.png`) });
      assert.equal(dimensions.overflow, false, `${width} ${theme}: ${JSON.stringify(dimensions)}`); assert.ok(dimensions.bottom <= dimensions.viewport); assert.equal(dimensions.scrollable, true);
      assert.ok(dimensions.listHeight >= 120); assert.equal(dimensions.listWidth, dimensions.listContentWidth); assert.equal(dimensions.stable, true); assert.match(dimensions.reduced, /^0s/);
      await page.screenshot({ path: path.join(out, `jobs-history-${width}-${theme}.png`) });
      await page.locator('#jobs-overview-tab').click(); await page.screenshot({ path: path.join(out, `jobs-overview-${width}-${theme}.png`) });
    }, { viewport: { width, height: width === 320 ? 740 : 950 }, colorScheme: theme });
  });
  console.log(`\n${passed} jobs history checks passed; ${failures.length} failed.`); if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
