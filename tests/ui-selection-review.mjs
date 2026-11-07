/** Selection review only reads fixture indexes; no audio files are touched. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const output = path.join(root, '.codex/ui-preview');
const port = Number(process.env.METATIDY_SELECTION_UI_PORT || 18839), base = `http://127.0.0.1:${port}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred() });
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_SELECTION_UI_CHECK && !name.includes(process.env.METATIDY_SELECTION_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const makeRows = (count = 1105) => Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `收藏曲目 ${index + 1}`, artist: index < 600 ? '匹配歌手' : '其他歌手', album: `专辑 ${Math.floor(index / 10) + 1}`,
  filename: `${index + 1}.flac`, path: `/music/选择快照/${index + 1}.flac`, has_cover: 0, has_lyrics: 0, language: '中文' }));
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
const checks = calls => calls.filter(call => call.path === '/api/tracks/selection');
const writes = calls => calls.filter(call => ['/api/tracks/apply', '/api/scrape/batch', '/api/move/execute'].includes(call.path));
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const rows = makeRows(), calls = [], errors = [];
  const control = { missing: new Set([2, 1002, 1105]), delay: null, delayPage: 1, errorPage: 0, malformedPage: 0, changingCounts: false, previewMissing: 0 };
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), body = route.request().postData() ? route.request().postDataJSON() : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/api/tracks/selection') {
      const ids = [...new Set(body.ids)], size = body.page_size, pages = Math.ceil(ids.length / size), pageNumber = Math.max(1, Math.min(pages || 1, body.page));
      const missing = ids.filter(id => control.missing.has(id)).length;
      const result = { total: ids.length, selected_total: ids.length, found_total: ids.length - missing, missing_total: missing, page: pageNumber, page_size: size, pages,
        items: ids.slice((pageNumber - 1) * size, pageNumber * size).map(id => ({ id, status: control.missing.has(id) ? 'missing' : 'found', track: control.missing.has(id) ? null : { ...rows[id - 1], id, title: '当前索引标题' } })) };
      if (control.changingCounts && pageNumber === 2) { result.missing_total += 1; result.found_total -= 1; }
      if (control.malformedPage === pageNumber) result.items[0].id = 999999;
      if (control.delay && control.delayPage === pageNumber) { const delayed = control.delay; control.delay = null; delayed.entered.resolve(); await delayed.release.promise; }
      if (control.errorPage === pageNumber) return json(route, { detail: '索引读取暂时失败' }, 503);
      return json(route, result);
    }
    if (url.pathname === '/api/tracks/preview') return json(route, { selected_total: body.ids.length, previewed_total: Math.min(500, body.ids.length), index_missing_total: control.previewMissing, index_missing_ids: control.previewMissing ? [1002] : [],
      items: body.ids.slice(0, 500).map(id => ({ track_id: id, filename: `${id}.flac`, file_exists: true, current: { title: '原始标题' }, proposed: body.fields, changes: { title: { old: '原始标题', new: body.fields.title } } })), changed_fields: body.ids.length, truncated: body.ids.length > 500 });
    if (url.pathname === '/api/move/preview') return json(route, { detail: '验收只核对提交范围，未创建移动计划' }, 503);
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base); await page.waitForSelector('#tracks-tbody tr'); await flush(page);
    await page.evaluate(async values => { const store = await import('/store.js'); store.selectRows(values); }, rows);
    await page.waitForSelector('#selection-review');
    await action({ page, context, rows, calls, control }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
async function open(page) { await page.locator('#selection-review').click(); await page.locator('#selection-review-dialog').waitFor(); }
async function search(page, q) { await page.locator('#selection-review-q').fill(q); await flush(page); }
async function selectedIds(page) { return page.evaluate(async () => (await import('/store.js')).selectionIds()); }
async function completeCheck(page) { await page.locator('#selection-review-check').click(); await page.waitForFunction(() => document.querySelector('#selection-review-check-status')?.textContent.startsWith('核对完成')); }

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });

  await check('All cross-page snapshots are searchable and paginated without index requests', () => withPage(async ({ page, calls }) => {
    await open(page); assert.match(await page.locator('#selection-review-total').textContent(), /1,105.*1,105/); assert.equal(await page.locator('.sr-track').count(), 50);
    await page.locator('#selection-review-next').click(); assert.equal(await page.locator('#selection-review-page').textContent(), '2 / 23'); assert.equal(await page.locator('.sr-track').first().getAttribute('data-selection-id'), '51');
    await search(page, '/1105.flac'); assert.equal(await page.locator('.sr-track').count(), 1); assert.equal(await page.locator('.sr-track').getAttribute('data-selection-id'), '1105');
    assert.match(await page.locator('#selection-review-edit').textContent(), /1,105/); assert.equal((await selectedIds(page)).length, 1105); assert.equal(checks(calls).length, 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'selection-review-q'); assert.match(await page.locator('.sr-snapshot-note').textContent(), /快照.*磁盘/);
  }));
  await check('Remove matching snapshots uses the entire filtered set across all pages', () => withPage(async ({ page, calls }) => {
    await open(page); await search(page, '匹配歌手'); assert.match(await page.locator('#selection-review-remove-matching').textContent(), /600/);
    await page.locator('#selection-review-remove-matching').click(); assert.match(await page.locator('#selection-review-removal').textContent(), /600.*其他审阅页/);
    assert.equal((await selectedIds(page)).length, 1105); await page.locator('#selection-review-confirm-remove').click();
    assert.deepEqual(await selectedIds(page), Array.from({ length: 505 }, (_, index) => index + 601)); assert.equal(writes(calls).length, 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'selection-review-q');
  }));
  await check('Membership changes invalidate removal confirmation even when the original IDs are restored', () => withPage(async ({ page }) => {
    await open(page); await search(page, '/1105.flac'); await page.locator('#selection-review-remove-matching').click();
    await page.evaluate(async () => { const store = await import('/store.js'); const row = store.state.selection.get(1); store.removeFromSelection([1]); store.selectRows([row]); });
    assert.equal(await page.locator('#selection-review-removal').isHidden(), true); assert.match(await page.locator('#selection-review-notice').textContent(), /选择范围已变化/);
    assert.ok((await selectedIds(page)).includes(1105));
  }));
  await check('Single removal preserves adjacent keyboard focus and empty search stays reversible', () => withPage(async ({ page }) => {
    await open(page); await page.locator('[data-remove-id="1"]').click(); assert.equal(await page.evaluate(() => document.activeElement.dataset.removeId), '2');
    await search(page, '/1105.flac'); await page.locator('[data-remove-id="1105"]').click(); assert.equal(await page.evaluate(() => document.activeElement.id), 'selection-review-q');
    assert.match(await page.locator('.sr-empty').textContent(), /没有匹配/); await search(page, ''); assert.equal(await page.locator('.sr-track').count(), 50);
  }));
  await check('Index verification reads every selected ID and publishes only a complete result', () => withPage(async ({ page, calls, control }) => {
    await open(page); await search(page, '/1105.flac'); const delay = gate(); control.delay = delay; control.delayPage = 2;
    await page.locator('#selection-review-check').click(); await delay.entered.promise;
    assert.match(await page.locator('#selection-review-check-status').textContent(), /200 \/ 1,105/); assert.equal(await page.locator('#selection-review-remove-missing').isHidden(), true);
    assert.equal(await page.locator('.sr-track').getAttribute('data-index-status'), 'unchecked'); assert.equal(await page.locator('#selection-review-edit').isDisabled(), true);
    delay.release.resolve(); await page.waitForFunction(() => document.querySelector('#selection-review-check-status').textContent.startsWith('核对完成'));
    assert.equal(checks(calls).length, 6); assert.ok(checks(calls).every(call => call.body.ids.length === 1105 && call.body.page_size === 200));
    assert.equal(await page.locator('.sr-track').getAttribute('data-index-status'), 'missing'); assert.match(await page.locator('#selection-review-check-status').textContent(), /缺失 3.*磁盘文件未检查/);
    assert.equal(await page.locator('.sr-track-title').textContent(), '收藏曲目 1105');
    await page.locator('#selection-review-remove-missing').click(); await page.locator('#selection-review-confirm-remove').click();
    const ids = await selectedIds(page); assert.equal(ids.length, 1102); assert.ok([2, 1002, 1105].every(id => !ids.includes(id))); assert.equal(writes(calls).length, 0);
  }));
  await check('Failed verification discards partial results and retry checks the whole selection', () => withPage(async ({ page, calls, control }) => {
    await open(page); control.errorPage = 2; await page.locator('#selection-review-check').click();
    await page.waitForFunction(() => document.querySelector('#selection-review-check-status').textContent.startsWith('索引核对失败'));
    assert.equal(await page.locator('#selection-review-remove-missing').isHidden(), true); assert.equal(await page.locator('[data-index-status="missing"]').count(), 0);
    control.errorPage = 0; await completeCheck(page); assert.equal(checks(calls).length, 8); assert.equal(checks(calls)[2].body.page, 1);
  }));
  await check('Malformed identities and changing index totals cannot become successful checks', () => withPage(async ({ page, control }) => {
    await open(page); control.malformedPage = 2; await page.locator('#selection-review-check').click();
    await page.waitForFunction(() => document.querySelector('#selection-review-check-status').textContent.includes('身份不完整'));
    control.malformedPage = 0; control.changingCounts = true; await page.locator('#selection-review-check').click();
    await page.waitForFunction(() => document.querySelector('#selection-review-check-status').textContent.includes('索引发生变化'));
    assert.equal(await page.locator('#selection-review-remove-missing').isHidden(), true);
  }));
  await check('Cancelling an in-flight verification rejects its late response and allows retry', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.delay = delay;
    await page.locator('#selection-review-check').click(); await delay.entered.promise; await page.locator('#selection-review-cancel-check').click(); delay.release.resolve(); await flush(page);
    assert.match(await page.locator('#selection-review-check-status').textContent(), /已取消/); assert.equal(await page.locator('[data-index-status="missing"]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'selection-review-check'); await completeCheck(page);
  }));
  await check('Selection membership changes cancel verification while metadata-only updates do not', () => withPage(async ({ page, control }) => {
    await open(page); const changed = gate(); control.delay = changed; await page.locator('#selection-review-check').click(); await changed.entered.promise;
    await page.evaluate(async () => (await import('/store.js')).removeFromSelection([3])); changed.release.resolve(); await flush(page);
    assert.match(await page.locator('#selection-review-check-status').textContent(), /范围已变化/); assert.equal(await page.locator('#selection-review-remove-missing').isHidden(), true);
    const labels = gate(); control.delay = labels; await page.locator('#selection-review-check').click(); await labels.entered.promise;
    await page.evaluate(async () => (await import('/store.js')).updateTrackSnapshot({ id: 1, title: '新的索引标签' }, { partial: true })); labels.release.resolve();
    await page.waitForFunction(() => document.querySelector('#selection-review-check-status').textContent.startsWith('核对完成'));
    assert.equal(await page.locator('[data-selection-id="1"] .sr-track-title').textContent(), '新的索引标签');
  }));
  await check('Closing and reopening review cannot revive an earlier verification', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.delay = delay; await page.locator('#selection-review-check').click(); await delay.entered.promise;
    await page.locator('#selection-review-close').click(); await open(page); delay.release.resolve(); await flush(page);
    assert.match(await page.locator('#selection-review-check-status').textContent(), /^未核对/); assert.equal(await page.locator('[data-index-status="missing"]').count(), 0);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#selection-review-dialog').count(), 0); assert.equal(await page.evaluate(() => document.activeElement.id), 'selection-review');
  }));
  await check('Session expiry clears snapshots and prevents late verification from restoring them', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.delay = delay; await page.locator('#selection-review-check').click(); await delay.entered.promise;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized'))); delay.release.resolve(); await flush(page);
    assert.equal(await page.locator('#selection-review-dialog').count(), 0); assert.deepEqual(await selectedIds(page), []);
  }));
  await check('Editor handoff uses every selected ID despite a one-item review search', () => withPage(async ({ page, calls }) => {
    await open(page); await search(page, '/1105.flac'); await page.locator('#selection-review-edit').click(); await page.locator('#edit-title').waitFor();
    assert.equal(await page.locator('#edit-scope').textContent(), '1105 首'); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    await page.locator('#edit-title').fill('统一标题'); await page.locator('#btn-edit-preview').click(); await page.locator('dialog[open]').waitFor();
    const payload = calls.find(call => call.path === '/api/tracks/preview').body; assert.equal(payload.ids.length, 1105); assert.equal(payload.ids.at(-1), 1105);
    assert.match(await page.locator('dialog[open]').textContent(), /仅展示前 500.*全部所选/); await page.locator('dialog[open]').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(writes(calls).length, 0);
  }));
  await check('Missing index IDs beyond preview limits block confirmation with precise feedback', () => withPage(async ({ page, calls, control }) => {
    control.previewMissing = 1; await open(page); await page.locator('#selection-review-edit').click(); await page.locator('#edit-title').fill('统一标题'); await page.locator('#btn-edit-preview').click();
    await page.locator('#edit-review-selection').waitFor(); assert.match(await page.locator('#edit-result').textContent(), /1 首不在曲库索引.*不表示磁盘文件已删除/);
    assert.equal(await page.locator('dialog[open]').count(), 0); assert.equal(writes(calls).length, 0); await page.locator('#edit-review-selection').click(); await page.locator('#selection-review-dialog').waitFor();
  }));
  await check('Missing index feedback cannot redirect a different editor scope into unrelated selections', () => withPage(async ({ page, control }) => {
    control.previewMissing = 1;
    await page.evaluate(async () => { const { editSelection } = await import('/tracks.js'); editSelection([{ id: 5000, title: '单独打开的旧曲目' }]); });
    await page.locator('#edit-title').fill('重新编辑'); await page.locator('#btn-edit-preview').click();
    await page.waitForFunction(() => document.querySelector('#edit-result').textContent.includes('刷新曲库'));
    assert.equal(await page.locator('#edit-review-selection').count(), 0); assert.equal((await selectedIds(page)).length, 1105);
  }));
  await check('Scrape handoff stays manual with all selected IDs and automatic writing rejects zero threshold', () => withPage(async ({ page, calls }) => {
    await open(page); await search(page, '/1105.flac'); await page.locator('#selection-review-scrape').click(); await page.waitForFunction(() => location.hash === '#scrape');
    assert.equal(await page.locator('#batch-count').textContent(), '已选 1105 首'); assert.equal(writes(calls).length, 0);
    await page.locator('#btn-batch-run').click(); await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('超过 200 首')); assert.equal(writes(calls).length, 0);
    await page.locator('input[name="batch-mode"][value="apply"]').check(); await page.locator('#batch-threshold').fill('0'); await page.locator('#btn-batch-run').click();
    await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('有效的自动写入最低分')); assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.locator('#batch-threshold').fill('125'); await page.locator('#btn-batch-run').click(); await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog[open]').textContent(), /1105 首/); assert.match(await page.locator('dialog[open]').textContent(), /125/); await page.locator('dialog[open]').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(writes(calls).length, 0);
  }));
  await check('Move handoff selects the full scope clears limits and never falls back to all when emptied', () => withPage(async ({ page, calls }) => {
    await page.evaluate(() => { document.querySelector('#move-limit').value = '2'; });
    await open(page); await search(page, '/1105.flac'); await page.locator('#selection-review-move').click(); await page.waitForFunction(() => location.hash === '#move');
    await page.waitForFunction(() => document.querySelector('input[name="move-scope"][value="selected"]').checked);
    assert.equal(await page.locator('#move-limit').inputValue(), '0'); assert.equal(calls.filter(call => call.path === '/api/move/preview').length, 0);
    await page.locator('#btn-move-preview').click(); await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('未创建移动计划'));
    const payload = calls.find(call => call.path === '/api/move/preview').body; assert.equal(payload.ids.length, 1105); assert.equal(payload.filters, undefined); assert.equal(payload.limit, undefined);
    await page.evaluate(async () => (await import('/store.js')).clearSelection()); assert.equal(await page.locator('input[name="move-scope"][value="selected"]').isChecked(), true);
    await page.locator('#btn-move-preview').click(); await flush(page); assert.equal(calls.filter(call => call.path === '/api/move/preview').length, 1); assert.equal(writes(calls).length, 0);
  }));
  await check('Command palette opens review without a selection and metadata remains plain text', () => withPage(async ({ page }) => {
    await page.evaluate(async () => (await import('/store.js')).clearSelection()); await page.locator('#btn-palette').click();
    await page.locator('#palette-input').fill('审阅跨页'); await page.keyboard.press('Enter'); await page.locator('#selection-review-dialog').waitFor();
    assert.match(await page.locator('.sr-empty').textContent(), /当前没有选择/); assert.equal(await page.locator('#selection-review-edit').isDisabled(), true);
    await page.evaluate(async () => (await import('/store.js')).selectRows([{ id: 3, title: '<img src=x onerror=alert(1)>', path: '/music/<svg onload=alert(1)>.flac' }]));
    assert.equal(await page.locator('.sr-track img').count(), 0); assert.match(await page.locator('.sr-track').textContent(), /<img src=x/);
  }));
  await check('Desktop and narrow mobile review retain fixed controls one list scroller and reduced motion', async () => {
    for (const [width, height, theme] of [[1440, 950, 'light'], [1440, 950, 'dark'], [390, 950, 'light'], [320, 740, 'dark'], [320, 568, 'light'], [844, 390, 'dark']]) await withPage(async ({ page }) => {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme); await open(page); await completeCheck(page);
      const dimensions = await page.evaluate(() => {
        const dialog = document.querySelector('#selection-review-dialog'), list = document.querySelector('#selection-review-list'), controls = document.querySelector('.sr-controls'), footer = document.querySelector('.sr-footer');
        const before = [controls.getBoundingClientRect().top, footer.getBoundingClientRect().top]; list.scrollTop = 100;
        return { overflow: document.documentElement.scrollWidth > innerWidth, bottom: dialog.getBoundingClientRect().bottom, viewport: innerHeight, listHeight: list.clientHeight,
          scrollable: list.scrollHeight > list.clientHeight, listWidth: list.clientWidth, contentWidth: list.scrollWidth,
          stable: before.every((value, index) => value === [controls.getBoundingClientRect().top, footer.getBoundingClientRect().top][index]), animation: getComputedStyle(dialog).animationName };
      });
      await page.screenshot({ path: path.join(output, `selection-review-${width}-${height}-${theme}.png`) });
      assert.equal(dimensions.overflow, false); assert.ok(dimensions.bottom <= dimensions.viewport); assert.ok(dimensions.listHeight >= 80, JSON.stringify(dimensions)); assert.equal(dimensions.scrollable, true);
      assert.equal(dimensions.listWidth, dimensions.contentWidth); assert.equal(dimensions.stable, true); assert.equal(dimensions.animation, 'none');
      await page.locator('#selection-review-remove-matching').click();
      const confirmBounds = await page.locator('#selection-review-confirm-remove').boundingBox();
      assert.ok(confirmBounds.y >= 0 && confirmBounds.y + confirmBounds.height <= height);
      await page.locator('#selection-review-cancel-remove').click();
    }, { viewport: { width, height }, colorScheme: theme });
  });
  console.log(`\n${passed} selection review checks passed; ${failures.length} failed.`); if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
