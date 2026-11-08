/** Collection CRUD and atomic selection adoption against an isolated in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCollectionsFixture } from './collections-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Existing local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_COLLECTIONS_UI_PORT || 18966), base = `http://127.0.0.1:${port}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred() });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const selectedIds = page => page.evaluate(async () => (await import('/store.js')).selectionIds());
const creationCalls = model => model.calls.filter(call => call.method === 'POST' && call.path === '/api/collections');
const collectionWrites = model => model.calls.filter(call => call.path.startsWith('/api/collections') && call.method !== 'GET' && !call.path.endsWith('/selection'));
let server, authServer, browser, passed = 0;
const failures = [];

function modelOf(count = 407) {
  const tracks = Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `清单曲目 ${index + 1}`, artist: `歌手 ${index % 7}`,
    album: `专辑 ${Math.floor(index / 10) + 1}`, albumartist: '清单歌手', path: `/fixture-music/清单/${index + 1}.flac`, dir: '/fixture-music/清单', filename: `${index + 1}.flac`,
    ext: 'flac', size: 123456, duration: 180, year: '2025', genre: 'Pop', track: String(index + 1), disc: '1', language: '中文', albumtype: '专辑',
    has_cover: 1, has_lyrics: 1, tags_loaded: true, path_derived: false, indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000 }));
  const fixture = createCollectionsFixture(tracks);
  const one = fixture.add('周末待整理', [3, 1, 2]);
  const two = fixture.add('跨页收藏', [...tracks.map(row => row.id), 9001]);
  const empty = fixture.add('空清单', []);
  return { tracks, fixture, one, two, empty, calls: [], plans: [], gates: [], errors: [], expectedWrites: 0, handler: null };
}
async function check(name, action) {
  if (process.env.METATIDY_COLLECTIONS_UI_CHECK && !name.includes(process.env.METATIDY_COLLECTIONS_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
async function withPage(action, { model = modelOf(), ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const pageErrors = [], forbidden = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : null;
    const call = { path: url.pathname, method: request.method(), query: Object.fromEntries(url.searchParams), body };
    model.calls.push(call);
    if (['/api/scan', '/api/tracks/apply', '/api/scrape/apply', '/api/scrape/batch', '/api/move/execute'].includes(call.path)) forbidden.push(call.path);
    if (url.port === String(port + 1)) return route.continue(); // Actual login gate from the authenticated fixture.
    if (call.path === '/api/tracks') return route.fulfill({ json: { items: model.tracks.slice(0, 18), total: model.tracks.length, page: 1, pages: Math.ceil(model.tracks.length / 18), page_size: 18 } });
    if (!call.path.startsWith('/api/collections') && call.path !== '/api/tracks/selection') return route.continue();
    const planIndex = model.plans.findIndex(plan => plan.path === call.path && (!plan.method || plan.method === call.method));
    const plan = planIndex < 0 ? null : model.plans.splice(planIndex, 1)[0];
    const fallback = () => {
      if (call.path.startsWith('/api/collections')) return model.fixture.handle(call.path, call.method, url.searchParams, body || {});
      const ids = [...new Set(body.ids)], size = body.page_size, pages = Math.ceil(ids.length / size), pageNumber = Math.max(1, Math.min(pages || 1, body.page));
      const found = ids.filter(id => model.tracks.some(row => row.id === id)).length;
      return { total: ids.length, selected_total: ids.length, found_total: found, missing_total: ids.length - found,
        page: pageNumber, page_size: size, pages, items: ids.slice((pageNumber - 1) * size, pageNumber * size).map(id => {
          const track = model.tracks.find(row => row.id === id); return { id, status: track ? 'found' : 'missing', track: track || null };
        }) };
    };
    try {
      let result;
      if (plan?.commit) result = fallback();
      if (plan?.gate) { plan.gate.entered.resolve(); await plan.gate.release.promise; }
      if (model.handler) {
        const response = await model.handler(call);
        if (response) return route.fulfill(response);
      }
      if (plan?.status) return route.fulfill({ status: plan.status, json: plan.data || { detail: '受控请求失败' } });
      result = plan?.data ?? result ?? fallback();
      return await route.fulfill({ json: plan?.transform ? plan.transform(result) : result });
    } catch (error) {
      if (page.isClosed()) return;
      if (error.status) await route.fulfill({ status: error.status, json: { detail: error.message } });
      else if (!plan?.gate) throw error;
    } finally { plan?.gate?.done.resolve(); }
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await action({ page, context, model });
    assert.deepEqual(pageErrors, [], 'Collections must not raise browser errors');
    assert.deepEqual(forbidden, [], 'Collection operations must never write audio tags, move or scan');
    assert.equal(collectionWrites(model).length, model.expectedWrites, 'Only explicitly confirmed collection writes are allowed');
  } finally { for (const delay of model.gates) delay.release.resolve(); await context.close(); }
}
function plan(model, value) { model.plans.push(value); if (value.gate) model.gates.push(value.gate); }
async function entered(delay) {
  let timer;
  try { await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request did not start')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, delay) { delay.release.resolve(); await delay.done.promise; await flush(page); }
async function ready(page) { await page.goto(`${base}/#collections`); await page.locator('#collections-create').waitFor(); await page.locator('[data-collection-id]').first().waitFor(); }
async function choose(page, id) { await page.locator(`#collections-list [data-collection-id="${id}"]`).click(); await page.waitForFunction(id => document.querySelector('#collections-detail')?.dataset.id === id && document.querySelector('#collections-detail')?.dataset.revision && document.querySelector('#collections-members')?.getAttribute('aria-busy') === 'false', id); await flush(page); }
async function dialog(page, action) { await page.locator(`#collections-dialog[data-action="${action}"][open]`).waitFor(); }
async function confirm(page) { await page.locator('#collections-confirm').click(); }
async function closed(page) { await page.locator('#collections-dialog').waitFor({ state: 'detached' }); await flush(page); }
async function setSelection(page, rows) { await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, rows); }
async function waitMembers(page, size) { await page.waitForFunction(size => document.querySelectorAll('#collections-members [data-member-id]').length === size, size); await flush(page); }

try {
  await mkdir(output, { recursive: true });
  const start = async (listenPort, args = []) => {
    const child = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${listenPort}`, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Collections fixture timeout')), 10000); child.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
    return child;
  };
  server = await start(port); authServer = await start(port + 1, ['--auth']);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Collections load only on their page and browsing never requests track files, covers, lyrics or audio', () => withPage(async ({ page, model }) => {
    await page.goto(base); await page.locator('#tracks-tbody tr').first().waitFor(); await page.waitForLoadState('networkidle');
    assert.equal(model.calls.some(call => call.path.startsWith('/api/collections')), false);
    const cursor = model.calls.length;
    await page.locator('#tab-collections').click(); await page.locator('[data-collection-id]').first().waitFor();
    await choose(page, model.one.id); await waitMembers(page, 3);
    assert.deepEqual(model.calls.slice(cursor).filter(call => /^\/api\/tracks\/\d+(?:\/(?:lyrics|cover|audio))?$/.test(call.path)), []);
    assert.deepEqual(await selectedIds(page), []);
  }));

  await check('Saving a filtered selection preserves every ID and its order across reload and another browser session', async () => {
    const model = modelOf(); let savedId;
    await withPage(async ({ page }) => {
      await page.goto(base); await page.locator('#tracks-tbody tr').first().waitFor();
      const rows = [model.tracks[400], model.tracks[2], model.tracks[1]];
      await setSelection(page, rows); await page.locator('#selection-review').click();
      await page.locator('#selection-review-q').fill('/3.flac');
      await page.locator('#selection-review-save-collection').click(); await dialog(page, 'create');
      assert.equal(creationCalls(model).length, 0);
      await page.locator('#collections-name').fill('本周待整理 <img onerror=alert(1)>'); model.expectedWrites++;
      await confirm(page); await closed(page);
      const call = creationCalls(model)[0]; savedId = call.body.id;
      assert.deepEqual(call.body.ids, [401, 3, 2]); assert.equal(model.fixture.records.get(savedId).name, '本周待整理 <img onerror=alert(1)>');
      await page.reload(); await page.locator(`#collections-list [data-collection-id="${savedId}"]`).waitFor();
      await choose(page, savedId); await waitMembers(page, 3);
      assert.deepEqual(await page.locator('#collections-members [data-member-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.memberId))), [401, 3, 2]);
      assert.equal(await page.locator('#collections-detail img').count(), 0);
    }, { model });
    await withPage(async ({ page }) => { await ready(page); await choose(page, savedId); await waitMembers(page, 3); assert.deepEqual(await selectedIds(page), []); }, { model });
  });

  await check('Empty creation validates Unicode names and uses UUID fallback without writing before confirmation', () => withPage(async ({ page, model }) => {
    await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { configurable: true, value: undefined }));
    await ready(page); await page.locator('#collections-create').click(); await dialog(page, 'create');
    await page.locator('#collections-name').fill('   '); assert.equal(await page.locator('#collections-confirm').isDisabled(), true);
    await page.locator('#collections-confirm').evaluate(node => node.click()); assert.equal(creationCalls(model).length, 0);
    await page.locator('#collections-name').fill('清单🎵'.repeat(40)); model.expectedWrites++;
    await confirm(page); await closed(page);
    const call = creationCalls(model)[0]; assert.match(call.body.id, /^[0-9a-f-]{36}$/i); assert.deepEqual(call.body.ids, []);
    assert.equal(model.fixture.records.get(call.body.id).name, '清单🎵'.repeat(40));
  }));

  await check('List search and pagination are literal while member pages retain order and show saved missing snapshots', () => withPage(async ({ page, model }) => {
    for (let index = 0; index < 24; index++) model.fixture.add(`普通清单 ${index}`, []);
    const literal = model.fixture.add('100%_中文清单', [2]);
    await ready(page); assert.equal(await page.locator('#collections-list [data-collection-id]').count(), 20);
    await page.locator('#collections-list-next').click(); await page.waitForFunction(() => document.querySelector('#collections-list-page')?.textContent.includes('2'));
    await page.locator('#collections-q').fill('%_中文'); await page.locator('#collections-search').click();
    await page.waitForFunction(() => document.querySelectorAll('#collections-list [data-collection-id]').length === 1);
    assert.equal(await page.locator('#collections-list [data-collection-id]').getAttribute('data-collection-id'), literal.id);
    await page.locator('#collections-q').fill('跨页'); await page.locator('#collections-search').click(); await choose(page, model.two.id); await waitMembers(page, 50);
    await page.locator('#collections-members-next').click(); await page.waitForFunction(() => document.querySelector('#collections-members [data-member-id]')?.dataset.memberId === '51');
    for (let expectedPage = 3; expectedPage <= 9; expectedPage++) {
      await page.locator('#collections-members-next').click();
      await page.waitForFunction(expectedPage => document.querySelector('#collections-members-page')?.textContent.startsWith(`${expectedPage} /`) && document.querySelector('#collections-members')?.getAttribute('aria-busy') === 'false', expectedPage);
    }
    await page.locator('#collections-members [data-member-id="9001"]').waitFor();
    assert.equal(await page.locator('[data-member-id="9001"]').getAttribute('data-status'), 'missing');
    assert.match(await page.locator('[data-member-id="9001"]').innerText(), /暂缺索引|旧收藏|缺失/);
  }));

  await check('Rename, append, remove and delete require explicit confirmation and never change music or current selection', () => withPage(async ({ page, model }) => {
    await ready(page); await choose(page, model.one.id); await waitMembers(page, 3);
    await page.locator('#collections-rename').click(); await dialog(page, 'rename'); await page.locator('#collections-name').fill('改名草稿');
    await page.locator('#collections-cancel').click(); await closed(page); assert.equal(model.one.name, '周末待整理');
    await page.locator('#collections-rename').click(); await page.locator('#collections-name').fill('已经改名'); model.expectedWrites++; await confirm(page); await closed(page);
    assert.equal(model.one.name, '已经改名');
    await setSelection(page, [model.tracks[1], model.tracks[6]]);
    await page.locator('#collections-append').click(); await dialog(page, 'append'); model.expectedWrites++; await confirm(page); await closed(page); await waitMembers(page, 4);
    assert.deepEqual(model.one.members.map(item => item.id), [3, 1, 2, 7]);
    await page.locator('#collections-members [data-remove-id="1"]').click(); await dialog(page, 'remove'); model.expectedWrites++; await confirm(page); await closed(page); await waitMembers(page, 3);
    assert.deepEqual(model.one.members.map(item => item.id), [3, 2, 7]); assert.deepEqual(await selectedIds(page), [2, 7]);
    await page.locator('#collections-delete').click(); await dialog(page, 'delete'); await page.locator('#collections-cancel').click(); await closed(page);
    assert.equal(model.fixture.records.has(model.one.id), true);
    await page.locator('#collections-delete').click(); model.expectedWrites++; await confirm(page); await closed(page);
    assert.equal(model.fixture.records.has(model.one.id), false); assert.deepEqual(await selectedIds(page), [2, 7]);
  }));

  await check('A selection changed while naming or appending invalidates the pending scope instead of silently changing it', () => withPage(async ({ page, model }) => {
    await page.goto(base); await page.locator('#tracks-tbody tr').first().waitFor(); await setSelection(page, model.tracks.slice(0, 2));
    await page.locator('#selection-review').click(); await page.locator('#selection-review-save-collection').click(); await dialog(page, 'create');
    await page.locator('#collections-name').fill('范围应固定'); await setSelection(page, [model.tracks[2]]);
    await page.locator('#collections-confirm').evaluate(node => node.click()); await flush(page); assert.equal(creationCalls(model).length, 0);
    await page.keyboard.press('Escape'); await choose(page, model.one.id); await waitMembers(page, 3);
    await page.locator('#collections-append').click(); await dialog(page, 'append'); await setSelection(page, [model.tracks[4]]);
    await page.locator('#collections-confirm').evaluate(node => node.click()); await flush(page);
    assert.deepEqual(model.one.members.map(item => item.id), [3, 1, 2]);
  }));

  await check('Stale revisions reject mutations and unknown create responses retry the original UUID without duplicates', () => withPage(async ({ page, model }) => {
    await ready(page); await choose(page, model.one.id); await waitMembers(page, 3);
    await page.locator('#collections-rename').click(); await page.locator('#collections-name').fill('不覆盖新版本');
    model.fixture.touch(model.one); model.expectedWrites++; await confirm(page);
    await page.waitForFunction(() => document.querySelector('#collections-dialog-status')?.textContent.includes('刷新'));
    assert.equal(model.one.name, '周末待整理'); await page.keyboard.press('Escape');
    await page.locator('#collections-create').click(); await page.locator('#collections-name').fill('响应丢失的创建');
    plan(model, { path: '/api/collections', method: 'POST', commit: true, status: 503 }); model.expectedWrites++;
    await confirm(page); await page.locator('#collections-retry-create').waitFor();
    const first = creationCalls(model).at(-1); assert.equal([...model.fixture.records.values()].filter(row => row.name === '响应丢失的创建').length, 1);
    const remoteSaved = model.fixture.records.get(first.body.id); remoteSaved.name = '另一设备已经改名'; model.fixture.touch(remoteSaved);
    model.expectedWrites++; await page.locator('#collections-retry-create').click();
    await page.waitForFunction(() => !document.querySelector('#collections-dialog[open]')); await flush(page);
    assert.deepEqual(creationCalls(model).at(-1).body, first.body);
    assert.equal(model.fixture.records.size, 4); assert.equal(model.fixture.records.get(first.body.id).name, '另一设备已经改名');
  }));

  await check('An uncertain create survives session expiry and login reload with the same original request', () => withPage(async ({ page, model }) => {
    await ready(page); await page.locator('#collections-create').click(); await page.locator('#collections-name').fill('重新登录后继续核对');
    plan(model, { path: '/api/collections', method: 'POST', commit: true, status: 503 }); model.expectedWrites++;
    await confirm(page); await page.locator('#collections-retry-create').waitFor();
    const original = creationCalls(model).at(-1).body;
    plan(model, { path: '/api/collections', method: 'POST', status: 401 }); model.expectedWrites++;
    await page.locator('#collections-retry-create').click(); await page.locator('#auth-veil').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#collections-recovery').isVisible(), false);
    await page.locator('#auth-password').fill('fixture');
    await Promise.all([page.waitForEvent('load'), page.locator('#auth-submit').click()]);
    await page.locator('#collections-recover-create').waitFor();
    assert.equal(creationCalls(model).length, 2, 'Login must not retry a write by itself');
    await page.locator('#collections-recover-create').click(); await dialog(page, 'create');
    model.expectedWrites++; await confirm(page); await closed(page);
    assert.deepEqual(creationCalls(model).map(call => call.body), [original, original, original]);
    assert.equal(model.fixture.records.size, 4);
    await page.reload(); await page.locator('#collections-create').waitFor();
    assert.equal(await page.locator('#collections-recovery').isVisible(), false);
  }));

  await check('Uncertain creation can be located or explicitly forgotten after an authenticated missing check', async () => {
    for (const saved of [true, false]) await withPage(async ({ page, model }) => {
      await ready(page); await page.locator('#collections-create').click(); await page.locator('#collections-name').fill('需要核对的请求');
      plan(model, { path: '/api/collections', method: 'POST', commit: saved, status: 503 }); model.expectedWrites++;
      await confirm(page); await page.locator('#collections-retry-create').waitFor();
      const original = creationCalls(model).at(-1).body;
      await page.keyboard.press('Escape'); await page.locator('#collections-recover-create').click(); await dialog(page, 'create');
      if (!saved) {
        plan(model, { path: `/api/collections/${original.id}`, method: 'GET', status: 503 });
        await page.locator('#collections-check-create').click();
        await page.waitForFunction(() => document.querySelector('#collections-dialog-status')?.textContent.includes('受控请求失败'));
        assert.equal(await page.locator('#collections-forget-create:visible').count(), 0);
      }
      await page.locator('#collections-check-create').click();
      if (saved) {
        await closed(page); await page.waitForFunction(id => document.querySelector('#collections-detail')?.dataset.id === id && document.querySelector('#collections-detail')?.dataset.revision, original.id);
      } else {
        await page.locator('#collections-forget-create').waitFor(); await page.locator('#collections-forget-create').click(); await dialog(page, 'forget-create');
        await page.locator('#collections-cancel').click(); await closed(page);
        assert.equal(await page.locator('#collections-recovery').isVisible(), true, 'Cancel must keep the recovery record');
        await page.locator('#collections-recover-create').click(); await page.locator('#collections-check-create').click();
        await page.locator('#collections-forget-create').click(); await dialog(page, 'forget-create'); await confirm(page); await closed(page);
      }
      assert.equal(await page.locator('#collections-recovery').isVisible(), false);
      assert.equal(creationCalls(model).length, 1, 'Read-only recovery and forgetting must not create or delete');
      assert.equal(model.fixture.records.size, saved ? 4 : 3);
    });
  });

  await check('A saved create followed by a failed detail reload never shows members from the previous collection', () => withPage(async ({ page, model }) => {
    await ready(page); await choose(page, model.one.id); await waitMembers(page, 3);
    model.handler = call => call.method === 'GET' && /^\/api\/collections\/[0-9a-f-]+$/.test(call.path) && call.path !== `/api/collections/${model.one.id}`
      ? { status: 503, json: { detail: '新清单详情暂不可用' } } : null;
    await page.locator('#collections-create').click(); await page.locator('#collections-name').fill('已保存但详情待刷新');
    model.expectedWrites++; await confirm(page); await closed(page);
    await page.waitForFunction(() => document.querySelector('#collections-detail-status')?.textContent.includes('新清单详情暂不可用'));
    assert.equal(await page.locator('#collections-members [data-member-id]').count(), 0);
    assert.notEqual(await page.locator('#collections-detail-title').innerText(), model.one.name);
    assert.equal(await page.locator('#collections-recovery').isVisible(), false);
    model.handler = null; await page.locator('#collections-detail-refresh').click();
    await page.waitForFunction(() => document.querySelector('#collections-detail-title')?.textContent === '已保存但详情待刷新');
  }));

  await check('Preparing a whole collection resolves all pages and confirms one additive selection while skipping missing IDs', () => withPage(async ({ page, model }) => {
    await ready(page); await choose(page, model.two.id); await waitMembers(page, 50);
    await setSelection(page, [model.tracks[0], { id: 8000, title: '已有其他选择', path: '/music/other.flac' }]);
    await page.locator('#collections-add-selection').click(); await dialog(page, 'add-selection');
    assert.deepEqual(await selectedIds(page), [1, 8000]);
    const resolves = model.calls.filter(call => call.path === '/api/tracks/selection');
    assert.equal(resolves.length, 3); assert.equal(resolves.every(call => call.body.ids.length === 408 && call.body.page_size === 200), true);
    await confirm(page); await page.locator('#selection-review-dialog').waitFor();
    assert.deepEqual(await selectedIds(page), [1, 8000, ...model.tracks.slice(1).map(row => row.id)]);
    assert.equal((await selectedIds(page)).includes(9001), false);
  }));

  await check('Selection changes, cancellation and membership changes during preparation never leave partial additions', async () => {
    for (const kind of ['selection', 'cancel', 'revision']) await withPage(async ({ page, model }) => {
      await ready(page); await choose(page, model.two.id); await waitMembers(page, 50); await setSelection(page, [model.tracks[1]]);
      const delay = gate(); plan(model, { path: '/api/tracks/selection', method: 'POST', gate: delay });
      await page.locator('#collections-add-selection').click(); await entered(delay);
      if (kind === 'selection') await setSelection(page, [model.tracks[2]]);
      if (kind === 'cancel') await page.locator('#collections-cancel-check').click();
      if (kind === 'revision') model.fixture.touch(model.two);
      await release(page, delay); await flush(page);
      assert.deepEqual(await selectedIds(page), kind === 'selection' ? [3] : [2]);
      assert.equal(await page.locator('#collections-dialog[data-action="add-selection"]').count(), 0);
    });
  });

  await check('A collection changed after preview or a canceled final check never adopts late results', async () => {
    for (const kind of ['remote', 'selection', 'cancel', 'leave']) await withPage(async ({ page, model }) => {
      await ready(page); await choose(page, model.one.id); await waitMembers(page, 3); await setSelection(page, [model.tracks[7]]);
      await page.locator('#collections-add-selection').click(); await dialog(page, 'add-selection');
      if (kind === 'remote') {
        model.fixture.touch(model.one); await confirm(page);
        await page.waitForFunction(() => document.querySelector('#collections-dialog-status')?.textContent.includes('刷新') || document.querySelector('#collections-check-status')?.textContent.includes('变化'));
      } else {
        const delay = gate(); plan(model, { path: `/api/collections/${model.one.id}`, method: 'GET', gate: delay });
        await confirm(page); await entered(delay);
        if (kind === 'selection') await setSelection(page, [model.tracks[6]]);
        if (kind === 'cancel') await page.locator('#collections-cancel').click();
        if (kind === 'leave') await page.evaluate(() => { location.hash = '#tracks'; });
        await release(page, delay);
      }
      assert.deepEqual(await selectedIds(page), kind === 'selection' ? [7] : [8]); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    });
  });

  await check('Mismatched identities or changing index counts fail preparation without selecting any partial page', async () => {
    for (const kind of ['identity', 'counts', 'duplicate', 'order', 'second-page-failure']) await withPage(async ({ page, model }) => {
      await ready(page); await choose(page, model.two.id); await waitMembers(page, 50); await setSelection(page, [model.tracks[8]]);
      if (kind === 'second-page-failure') {
        plan(model, { path: '/api/tracks/selection' }); plan(model, { path: '/api/tracks/selection', status: 503 });
      } else if (kind === 'order') plan(model, { path: `/api/collections/${model.two.id}/selection`, transform: data => ({ ...data, ids: [data.ids[1], data.ids[0], ...data.ids.slice(2)] }) });
      else if (kind === 'duplicate') plan(model, { path: `/api/collections/${model.two.id}/selection`, transform: data => ({ ...data, ids: data.ids.map((id, index) => index === 1 ? data.ids[0] : id) }) });
      else plan(model, { path: '/api/tracks/selection', transform: data => kind === 'identity' ? { ...data, items: data.items.map((item, index) => index ? item : { ...item, track: { ...item.track, id: 99999 } }) } : { ...data, found_total: data.found_total - 1 } });
      await page.locator('#collections-add-selection').click();
      await page.waitForFunction(() => !document.querySelector('#collections-cancel-check') || document.querySelector('#collections-cancel-check').hidden);
      await flush(page); assert.deepEqual(await selectedIds(page), [9]); assert.equal(await page.locator('#collections-dialog[data-action="add-selection"]').count(), 0);
      if (kind === 'second-page-failure') {
        assert.equal(model.calls.filter(call => call.path === '/api/tracks/selection').length, 2);
        await page.locator('#collections-add-selection').click(); await dialog(page, 'add-selection'); await confirm(page);
        await page.locator('#selection-review-dialog').waitFor(); assert.equal((await selectedIds(page)).length, model.tracks.length);
      }
    });
  });

  await check('Late detail responses and an in-flight create after leaving cannot replace the newly opened page', () => withPage(async ({ page, model }) => {
    await ready(page); const delay = gate(); plan(model, { path: `/api/collections/${model.one.id}`, method: 'GET', gate: delay });
    await page.locator(`[data-collection-id="${model.one.id}"]`).click(); await entered(delay);
    await choose(page, model.empty.id); await release(page, delay);
    assert.equal(await page.locator('#collections-detail-title').innerText(), model.empty.name);
    await page.locator('#collections-create').click(); await page.locator('#collections-name').fill('离开时仍可能保存');
    const write = gate(); plan(model, { path: '/api/collections', method: 'POST', gate: write }); model.expectedWrites++;
    await confirm(page); await entered(write); await page.evaluate(() => { location.hash = '#tracks'; });
    await release(page, write); await page.locator('#panel-tracks').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#collections-dialog').count(), 0); assert.equal(await page.locator('#panel-collections').isVisible(), false);
    assert.equal([...model.fixture.records.values()].filter(row => row.name === '离开时仍可能保存').length, 1);
  }));

  await check('401 cancels preparation and deep links cannot read collections before authentication', async () => {
    await withPage(async ({ page, model }) => {
      await ready(page); await choose(page, model.two.id); await waitMembers(page, 50); await setSelection(page, [model.tracks[4]]);
      plan(model, { path: '/api/tracks/selection', method: 'POST', status: 401 });
      await page.locator('#collections-add-selection').click(); await page.locator('#auth-veil').waitFor({ state: 'visible' });
      assert.deepEqual(await selectedIds(page), []); assert.equal(await page.locator('#collections-dialog').count(), 0);
    });
    await withPage(async ({ page, model }) => {
      await page.goto(`http://127.0.0.1:${port + 1}/#collections`); await page.locator('#auth-password').waitFor({ state: 'visible' });
      assert.equal(model.calls.some(call => call.path.startsWith('/api/collections')), false);
      await page.locator('#auth-password').fill('fixture'); await page.locator('#auth-submit').click();
      await page.locator('#collections-list [data-collection-id]').first().waitFor();
    });
  });

  await check('Collection pages, long member names and confirmations fit desktop and short mobile themes', async () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [320, 568, 'dark'], [844, 390, 'dark']]) {
      await withPage(async ({ page, model }) => {
        model.one.name = '待整理与精选曲目 '.repeat(12); model.tracks[2].title = '长曲名/'.repeat(80); model.tracks[2].path = '/music/' + '很长目录/'.repeat(70) + '3.flac';
        await ready(page); await flush(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: path.join(output, `collections-list-${width}x${height}-${colorScheme}.png`), fullPage: true });
        await choose(page, model.one.id); await waitMembers(page, 3);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.locator('#collections-delete').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `collections-detail-${width}x${height}-${colorScheme}.png`), fullPage: true });
        await page.locator('#collections-delete').click(); await dialog(page, 'delete');
        for (const id of ['collections-cancel', 'collections-confirm']) assert.equal(await page.locator(`#${id}`).evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === node; }), true);
        await page.screenshot({ path: path.join(output, `collections-confirm-${width}x${height}-${colorScheme}.png`) });
        await page.keyboard.press('Escape'); await closed(page);
        assert.equal(await page.locator('#collections-root').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
      }, { viewport: { width, height }, colorScheme });
    }
  });

  console.log(`\n${passed} collection checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); authServer?.kill(); }
