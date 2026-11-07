/** Full plan review with in-memory fixture routes; never touches real audio. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const out = path.join(root, '.codex/ui-preview');
const port = Number(process.env.METATIDY_MOVE_UI_PORT || 18819);
const base = `http://127.0.0.1:${port}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_MOVE_UI_CHECK && !name.includes(process.env.METATIDY_MOVE_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
function plan(token, payload) {
  const items = Array.from({ length: 620 }, (_, i) => ({ ordinal: i + 1, track_id: i + 1, filename: `${i + 1} - 曲目.flac`, title: `曲目 ${i + 1}`, artist: '验收歌手',
    source: `/music/原始收藏/${i + 1} - 曲目.flac`, target: `/library/验收歌手/专辑/${i + 1}.flac`, action: i === 610 ? 'conflict_overwrite' : i === 611 ? 'invalid' : i === 612 ? 'conflict_skip' : 'move',
    reason: i === 610 ? '稀有冲突：目标存在' : i === 611 ? '目标越界，不执行' : '', warning: '' }));
  return { token, executed: false, total: 900, planned: items.length, truncated: true, counts: { move: 617, conflict_overwrite: 1, invalid: 1, conflict_skip: 1 },
    library_root: '/library', dir_template: payload.dir_template, filename_template: payload.filename_template, conflict_policy: payload.conflict_policy, items };
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], calls = [], plans = new Map();
  let seq = 0;
  const control = { delayPreview: null, delayItems: null, delayDry: null, delayJob: null, executeError: null, executeNetworkError: false, itemsError: null };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/move/**', async route => {
    const url = new URL(route.request().url()); const body = route.request().postData() ? route.request().postDataJSON() : null;
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === '/api/move/preview') {
      const result = plan(`plan-${++seq}`, body); plans.set(result.token, result);
      if (control.delayPreview) { const d = control.delayPreview; control.delayPreview = null; d.entered.resolve(result.token); await d.release.promise; }
      return json(route, { ...result, items: result.items.slice(0, 500), display_truncated: true });
    }
    if (url.pathname.endsWith('/items')) {
      const saved = plans.get(url.pathname.split('/').at(-2));
      if (control.itemsError) { const error = control.itemsError; control.itemsError = null; return json(route, { detail: error.text }, error.status); }
      let items = saved.items.filter(item => !url.searchParams.get('action') || item.action === url.searchParams.get('action'));
      const q = (url.searchParams.get('q') || '').toLowerCase(); if (q) items = items.filter(item => JSON.stringify(item).toLowerCase().includes(q));
      const pageSize = Number(url.searchParams.get('page_size') || 100), pages = Math.ceil(items.length / pageSize), pageNumber = Math.max(1, Math.min(pages || 1, Number(url.searchParams.get('page') || 1)));
      const response = { ...saved, q, action: url.searchParams.get('action') || '', filtered_total: items.length, page: pageNumber, page_size: pageSize, pages, items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize) };
      if (control.delayItems) { const d = control.delayItems; control.delayItems = null; d.entered.resolve(response); await d.release.promise; }
      return json(route, response);
    }
    if (url.pathname.endsWith('/export')) return route.fulfill({ contentType: 'application/json', headers: { 'Content-Disposition': 'attachment; filename="move-plan.json"' }, body: JSON.stringify({ report_type: 'move_plan', token: url.pathname.split('/').at(-2), filters: Object.fromEntries(url.searchParams) }) });
    if (url.pathname === '/api/move/execute') {
      if (body.dry_run) {
        if (control.delayDry) { const d = control.delayDry; control.delayDry = null; d.entered.resolve(); await d.release.promise; }
        return json(route, { moved: 618, skipped: 2, failed: 0, renamed: 0, failures: [] });
      }
      if (control.executeNetworkError) return route.abort('failed');
      if (control.executeError) return json(route, { detail: control.executeError }, 409);
      plans.get(body.token).executed = true; return json(route, { job_id: 'move-review-job' });
    }
    return route.continue();
  });
  await page.route('**/api/jobs/move-review-job', async route => {
    if (control.delayJob) { const d = control.delayJob; control.delayJob = null; d.entered.resolve(); await d.release.promise; }
    return json(route, { id: 'move-review-job', kind: 'move', state: 'done', done: 618, total: 618, result: JSON.stringify({ moved: 617, skipped: 2, failed: 1, renamed: 1, failures: [{ source: '/music/fail.flac', target: '/library/fail.flac', error: 'file busy' }] }) });
  });
  page.on('pageerror', error => errors.push(error.message));
  try { await page.goto(`${base}/#move`); await page.waitForFunction(() => document.querySelector('#move-dir').value !== ''); await action({ page, context, calls, control, plans }); assert.deepEqual(errors, []); }
  finally { await context.close(); }
}
async function preview(page) { await page.locator('#btn-move-preview').click(); await page.waitForFunction(() => document.querySelectorAll('#move-tbody tr').length === 100 && document.querySelector('#move-table-wrap').getAttribute('aria-busy') === 'false'); }
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
const gate = () => ({ entered: deferred(), release: deferred() });
const executions = calls => calls.filter(call => call.path === '/api/move/execute' && call.body.dry_run === false);

try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });

  await check('Server filtering finds conflicts beyond the first 500 and preserves full execution count', () => withPage(async ({ page, calls }) => {
    await preview(page); assert.match(await page.locator('#move-plan-meta').innerText(), /900.*620/);
    await page.locator('#move-plan-action').selectOption('conflict_overwrite');
    await page.waitForSelector('#move-tbody tr[data-move-ordinal="611"]');
    assert.equal(await page.locator('#move-tbody tr').count(), 1); assert.match(await page.locator('#btn-move-exec').innerText(), /618/);
    await page.locator('#btn-move-exec').click(); const dialog = page.locator('dialog[open]'); assert.match(await dialog.innerText(), /当前搜索或动作筛选不会缩小/); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(executions(calls).length, 0);
  }));
  await check('Search and pagination operate on the full plan without stealing search focus', () => withPage(async ({ page }) => {
    await preview(page); await page.locator('#move-plan-next').click(); await page.waitForSelector('#move-tbody tr[data-move-ordinal="101"]');
    await page.locator('#move-plan-q').fill('稀有冲突'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="611"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'move-plan-q'); assert.match(await page.locator('#move-plan-range').innerText(), /当前条件 1 条/);
  }));
  await check('Configuration changes invalidate open confirmations and restoring text does not revive them', () => withPage(async ({ page, calls }) => {
    await preview(page); await page.locator('#btn-move-exec').click();
    await page.evaluate(() => { const input = document.querySelector('#move-dir'); const old = input.value; input.value = 'changed'; input.dispatchEvent(new Event('input', { bubbles: true })); input.value = old; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('dialog[open]').getByRole('button', { name: /确认移动/ }).click(); await flush(page);
    assert.equal(executions(calls).length, 0); assert.equal(await page.locator('#btn-move-exec').isDisabled(), true); assert.match(await page.locator('#move-plan-state').innerText(), /重新预览/);
  }));
  await check('A late preview cannot replace a newer plan after configuration changes', () => withPage(async ({ page, control }) => {
    const old = gate(); control.delayPreview = old; await page.locator('#btn-move-preview').click(); await old.entered.promise;
    await page.locator('#move-dir').fill('new-template'); await preview(page); old.release.resolve(); await flush(page);
    assert.match(await page.locator('#move-plan-meta').innerText(), /new-template/); assert.match(await page.locator('#move-export-json').getAttribute('href'), /plan-2/);
  }));
  await check('Late dry-run results cannot populate a replacement plan', () => withPage(async ({ page, control }) => {
    await preview(page); const old = gate(); control.delayDry = old; await page.locator('#btn-move-dry').click(); await old.entered.promise;
    await page.locator('#move-filename').fill('new-name'); await preview(page); old.release.resolve(); await flush(page); assert.equal(await page.locator('#move-summary').textContent(), '');
  }));
  await check('Stale page responses cannot overwrite a new plan and failed filters clear old rows', () => withPage(async ({ page, control }) => {
    await preview(page); const old = gate(); control.delayItems = old;
    await page.locator('#move-plan-action').selectOption('invalid'); await old.entered.promise;
    await page.locator('#move-filename').fill('replacement-name'); await preview(page); old.release.resolve(); await flush(page);
    assert.equal(await page.locator('#move-tbody tr').count(), 100); assert.match(await page.locator('#move-plan-meta').innerText(), /replacement-name/);
    control.itemsError = { status: 503, text: '临时不可用' }; await page.locator('#move-plan-action').selectOption('conflict_overwrite'); await page.waitForSelector('#move-list-retry');
    assert.equal(await page.locator('#move-tbody tr').count(), 0); assert.match(await page.locator('#move-plan-range').innerText(), /未载入/);
    await page.locator('#move-list-retry').click(); await page.waitForSelector('#move-tbody tr[data-move-ordinal="611"]');
  }));
  await check('Filter redraw during dry-run stays busy and never unlocks execution', () => withPage(async ({ page, control }) => {
    await preview(page); const dry = gate(); control.delayDry = dry; await page.locator('#btn-move-dry').click(); await dry.entered.promise;
    await page.locator('#move-plan-action').selectOption('invalid'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="612"]'); assert.equal(await page.locator('#btn-move-exec').isDisabled(), true); assert.equal(await page.locator('#btn-move-preview').isDisabled(), true);
    dry.release.resolve(); await page.waitForSelector('#move-export-result'); assert.equal(await page.locator('#btn-move-exec').isDisabled(), false);
  }));
  await check('Accepted execution is consumed while polling and stays consumed after filtering', () => withPage(async ({ page, control, calls }) => {
    await preview(page); const job = gate(); control.delayJob = job; await page.locator('#btn-move-exec').click(); await page.locator('dialog[open]').getByRole('button', { name: /确认移动/ }).click(); await job.entered.promise;
    await page.locator('#move-plan-action').selectOption('conflict_skip'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="613"]'); assert.equal(await page.locator('#btn-move-exec').isDisabled(), true);
    job.release.resolve(); await page.waitForSelector('#move-export-result'); assert.equal(await page.locator('#btn-move-exec').isDisabled(), true); assert.equal(executions(calls).length, 1);
  }));
  await check('Plan downloads capture full versus filtered scope and execution report contains no invented paths', () => withPage(async ({ page }) => {
    await preview(page); await page.locator('#move-plan-q').fill('稀有冲突'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="611"]');
    await page.locator('.move-export > summary').click(); assert.ok(!(await page.locator('#move-export-json').getAttribute('href')).includes('q='));
    await page.locator('#move-export-scope').selectOption('filtered'); assert.match(await page.locator('#move-export-json').getAttribute('href'), /q=/);
    // Chromium downloads may bypass page route interception. Assert the exact
    // authenticated same-origin URL here; real export bytes have HTTP coverage.
    const expected = new URL(await page.locator('#move-export-json').getAttribute('href'), base);
    const planDownload = page.waitForEvent('download'); await page.locator('#move-export-json').click(); const downloaded = await planDownload;
    assert.equal(downloaded.url(), expected.href); assert.equal(expected.searchParams.get('q'), '稀有冲突'); assert.equal(expected.searchParams.get('format'), 'json');
    await page.locator('.move-export > summary').click(); await page.locator('#btn-move-exec').click(); await page.locator('dialog[open]').getByRole('button', { name: /确认移动/ }).click(); await page.waitForSelector('#move-export-result');
    const resultDownload = page.waitForEvent('download'); await page.locator('#move-export-result').click(); const file = await resultDownload; const report = JSON.parse(await readFile(await file.path(), 'utf8'));
    assert.equal(report.report_type, 'move_execution_summary'); assert.equal(report.failures.length, 1); assert.equal(report.items, undefined); assert.equal(report.moved_paths, undefined);
  }));
  await check('Session expiry invalidates pending confirmation and old plan data', () => withPage(async ({ page, calls }) => {
    await preview(page); await page.locator('#btn-move-exec').click(); await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized'))); await flush(page);
    assert.equal(executions(calls).length, 0); assert.equal(await page.locator('#btn-move-preview').isDisabled(), true); assert.equal(await page.locator('#move-export-json').getAttribute('href'), null);
  }));
  await check('Missing plan errors and conflicts lock execution rather than allowing retries', () => withPage(async ({ page, control }) => {
    await preview(page); control.executeError = '这个计划已经提交执行'; await page.locator('#btn-move-exec').click(); await page.locator('dialog[open]').getByRole('button', { name: /确认移动/ }).click(); await page.waitForFunction(() => document.querySelector('#move-plan-badge').textContent.includes('消费'));
    assert.equal(await page.locator('#btn-move-exec').isDisabled(), true); assert.match(await page.locator('#move-summary').innerText(), /勿重复提交/);
  }));
  await check('An uncertain execute response remains locked through view changes', () => withPage(async ({ page, control, calls }) => {
    await preview(page); control.executeNetworkError = true;
    await page.locator('#btn-move-exec').click(); await page.locator('dialog[open]').getByRole('button', { name: /确认移动/ }).click();
    await page.waitForFunction(() => document.querySelector('#move-plan-state').textContent.includes('提交响应未确认'));
    await page.locator('#move-plan-action').selectOption('invalid'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="612"]');
    assert.equal(await page.locator('#btn-move-exec').isDisabled(), true); assert.equal(executions(calls).length, 1);
  }));
  await check('Path details render untrusted names as text and copy controls do not write files', () => withPage(async ({ page, plans, calls }) => {
    await preview(page); const saved = [...plans.values()][0]; saved.items[0].source = '/music/<img src=x onerror=alert(1)>/曲目.flac'; saved.items[0].target = '/library/新目录/曲目.flac';
    await page.locator('#move-plan-q').fill('<img'); await page.waitForFunction(() => document.querySelectorAll('#move-tbody tr').length === 1);
    await page.locator('#move-tbody [data-move-detail]').click(); const dialog = page.locator('dialog[open]'); assert.equal(await dialog.locator('img').count(), 0); assert.match(await dialog.innerText(), /<img src=x/);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedMovePath = value; } } }); });
    await dialog.getByRole('button', { name: '复制路径' }).first().click(); await page.waitForFunction(() => Boolean(window.__copiedMovePath));
    assert.equal(await page.evaluate(() => window.__copiedMovePath), saved.items[0].source); assert.match(await dialog.innerText(), /已复制/); assert.equal(executions(calls).length, 0);
  }));
  await check('Mobile cards and desktop path details remain readable in both themes', async () => {
    for (const [width, theme] of [[1440, 'light'], [390, 'light'], [320, 'dark']]) await withPage(async ({ page }) => {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator('#move-conflict').selectOption('overwrite');
      await preview(page); await page.locator('#move-plan-action').selectOption('conflict_overwrite'); await page.waitForSelector('#move-tbody tr[data-move-ordinal="611"]', { state: 'attached' });
      const selector = width < 700 ? '#move-plan-cards [data-move-detail]' : '#move-tbody [data-move-detail]';
      await page.locator(selector).click(); assert.match(await page.locator('dialog[open]').innerText(), /原始收藏/); assert.match(await page.locator('dialog[open]').innerText(), /计划目标/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(out, `move-review-detail-${width}-${theme}.png`) });
      await page.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).click(); await page.locator('#move-review-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `move-review-${width}-${theme}.png`) });
    }, { viewport: { width, height: 950 }, colorScheme: theme });
  });
  console.log(`\n${passed} move review checks passed; ${failures.length} failed.`); if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
