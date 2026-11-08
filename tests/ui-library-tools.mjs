/**
 * Browser acceptance for track details, saved filters and library shortcuts.
 * Uses isolated fixtures and controlled responses; never touches real music.
 * Run: node tests/ui-library-tools.mjs
 * Optional: PLAYWRIGHT_MODULE and PLAYWRIGHT_CHANNEL, as in ui-smoke.mjs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Try available test installs. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to an existing installation.');

const savedKey = 'metatidy.saved-filters.v1';
const failures = [];
let passed = 0;
let browser;
let server;
let base;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function check(name, action) {
  try { await action(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}

async function withPage(action, { viewport = { width: 1440, height: 1000 }, colorScheme = 'light', reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await action({ page, context });
    assert.deepEqual(errors, [], 'New library tools must not raise browser exceptions');
  } finally { await context.close(); }
}

async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
}

async function openTrack(page, id = 1) {
  await page.locator(`#tracks-tbody button[data-detail-id="${id}"]`).click();
  await page.locator('#track-inspector[open]').waitFor();
}

async function loaded(page) {
  await page.waitForFunction(() => document.querySelector('#track-inspector .ti-content')?.getAttribute('aria-busy') === 'false');
}

async function noOverflow(page, selector) {
  const sizes = await page.evaluate(selector => {
    const node = document.querySelector(selector) || document.documentElement;
    return { width: node.scrollWidth, client: node.clientWidth, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
  }, selector);
  assert.ok(sizes.pageWidth <= sizes.viewport + 1, `Page overflows: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.width <= sizes.client + 1, `${selector} overflows: ${JSON.stringify(sizes)}`);
}

async function saveFilter(page, name) {
  await page.locator('#saved-filter-save').click();
  await page.locator('#saved-filter-name').fill(name);
  await page.locator('#saved-filter-submit').click();
  await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
}

async function storedItems(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"items":[]}').items, savedKey);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const { tracks } = (await import('/store.js')).state;
    return { q: tracks.q, sort: tracks.sort, order: tracks.order, page_size: tracks.page_size, view: tracks.view, density: tracks.density, filters: tracks.filters };
  });
}

try {
  await mkdir(outputDir, { recursive: true });
  const port = Number(process.env.METATIDY_UI_TOOLS_PORT) || 18775;
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Library tools fixture did not start')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  base = `http://127.0.0.1:${port}`;
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Details load index data and 512px artwork, while lyrics stay on demand', () => withPage(async ({ page }) => {
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await ready(page);
    await openTrack(page);
    await loaded(page);
    assert.equal(await page.locator('#track-inspector-title').innerText(), '晴天');
    assert.match(await page.locator('#track-inspector-tags').innerText(), /周杰伦/);
    assert.match(await page.locator('#track-inspector-file-info').innerText(), /标签已读取/);
    assert.equal(await page.locator('#track-inspector-path').inputValue(), '/fixture-music/中文/周杰伦/叶惠美/01 - 晴天.flac');
    assert.equal(new URL(await page.locator('.ti-art img').getAttribute('src'), base).searchParams.get('size'), '512');
    assert.equal(requests.filter(url => url.endsWith('/lyrics')).length, 0, 'Opening details must not automatically read lyrics from the original file');
    assert.equal(await page.locator('#track-inspector').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.evaluate(() => document.querySelector('#tracks-q').focus());
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'tracks-q', 'Native modal must prevent focusing background controls');
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab');
      // Chromium may route a Tab through browser chrome, leaving BODY as the
      // active element. Background application controls must remain inert.
      assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector('#track-inspector').contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    await page.locator('#track-inspector').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.detailId), '1');
  }));

  await check('Late detail responses cannot replace a newly selected track', () => withPage(async ({ page, context }) => {
    const first = await (await context.request.get(`${base}/api/tracks/1`)).json();
    const entered = deferred();
    const release = deferred();
    const fulfilled = deferred();
    await page.route('**/api/tracks/1', async route => {
      entered.resolve();
      await release.promise;
      await route.fulfill({ json: { ...first, title: 'STALE DETAIL RESPONSE' } });
      fulfilled.resolve();
    });
    try {
      await ready(page);
      await openTrack(page);
      await entered.promise;
      await page.locator('#track-inspector-next').click();
      await loaded(page);
      const nextId = await page.locator('#track-inspector').getAttribute('data-track-id');
      assert.notEqual(nextId, '1');
      const title = await page.locator('#track-inspector-title').innerText();
      release.resolve();
      await fulfilled.promise;
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#track-inspector-title').innerText(), title);
      assert.equal(await page.locator('#track-inspector').getAttribute('data-track-id'), nextId);
    } finally { release.resolve(); }
  }));

  await check('Closing and reopening details ignores the previous modal request', () => withPage(async ({ page, context }) => {
    const row = await (await context.request.get(`${base}/api/tracks/1`)).json();
    const entered = deferred();
    const release = deferred();
    const fulfilled = deferred();
    let calls = 0;
    await page.route('**/api/tracks/1', async route => {
      if (++calls === 1) { entered.resolve(); await release.promise; await route.fulfill({ json: { ...row, title: 'OLD MODAL' } }); fulfilled.resolve(); }
      else await route.fulfill({ json: { ...row, title: 'CURRENT MODAL' } });
    });
    try {
      await ready(page);
      await openTrack(page);
      await entered.promise;
      await page.keyboard.press('Escape');
      await openTrack(page);
      await loaded(page);
      release.resolve();
      await fulfilled.promise;
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#track-inspector-title').innerText(), 'CURRENT MODAL');
      assert.equal(await page.locator('#track-inspector[open]').count(), 1);
    } finally { release.resolve(); }
  }));

  await check('Detail errors expose retry and do not erase the indexed snapshot', () => withPage(async ({ page, context }) => {
    const row = await (await context.request.get(`${base}/api/tracks/1`)).json();
    let calls = 0;
    await page.route('**/api/tracks/1', route => ++calls === 1
      ? route.fulfill({ status: 404, json: { detail: '测试曲目暂时不可用' } })
      : route.fulfill({ json: { ...row, file_exists: false, tags_loaded: false, path_derived: true } }));
    await ready(page);
    await openTrack(page);
    await loaded(page);
    assert.match(await page.locator('#track-inspector-status').innerText(), /测试曲目暂时不可用/);
    assert.equal(await page.locator('#track-inspector-title').innerText(), '晴天');
    await page.locator('#track-inspector-retry').click();
    await loaded(page);
    assert.equal(calls, 2);
    assert.equal(await page.locator('#track-inspector-retry').isVisible(), false);
    assert.match(await page.locator('#track-inspector-file-info').innerText(), /原文件暂不可访问/);
    assert.match(await page.locator('#track-inspector-file-info').innerText(), /标签尚未读取/);
    assert.match(await page.locator('#track-inspector-file-info').innerText(), /含路径推断字段/);
  }));

  await check('Lyrics are read explicitly, can retry, and late lyrics cannot leak across tracks', () => withPage(async ({ page }) => {
    const entered = deferred();
    const release = deferred();
    const fulfilled = deferred();
    let calls = 0;
    await page.route('**/api/tracks/1/lyrics', async route => {
      calls += 1;
      if (calls === 1) return route.fulfill({ status: 503, json: { detail: '测试云盘暂未就绪' } });
      entered.resolve();
      await release.promise;
      await route.fulfill({ json: { lyrics: 'STALE LYRICS', has_lyrics: true, lines: 1, chars: 12 } });
      fulfilled.resolve();
    });
    try {
      await ready(page);
      await openTrack(page);
      await loaded(page);
      assert.equal(calls, 0);
      await page.locator('#track-inspector-lyrics-load').click();
      await page.waitForFunction(() => document.querySelector('#track-inspector-lyrics-status')?.textContent.includes('测试云盘暂未就绪'));
      assert.equal(await page.locator('#track-inspector-lyrics-load').isEnabled(), true);
      await page.locator('#track-inspector-lyrics-load').click();
      await entered.promise;
      await page.locator('#track-inspector-next').click();
      await loaded(page);
      release.resolve();
      await fulfilled.promise;
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#track-inspector-lyrics').isVisible(), false);
      assert.equal(await page.locator('#track-inspector-lyrics-load').isEnabled(), true);
      assert.doesNotMatch(await page.locator('#track-inspector').innerText(), /STALE LYRICS/);
    } finally { release.resolve(); }
  }));

  await check('Labels and lyrics remain text and artwork errors fall back safely', () => withPage(async ({ page, context }) => {
    const row = await (await context.request.get(`${base}/api/tracks/2`)).json();
    const payload = '<img src=x onerror="window.uiInjected=1">';
    await page.route('**/api/tracks/2', route => route.fulfill({ json: { ...row, title: payload, composer: payload, comment: payload, path: `/music/${payload}.flac` } }));
    await page.route('**/api/tracks/2/lyrics', route => route.fulfill({ json: { lyrics: payload, has_lyrics: true } }));
    await page.route('**/api/tracks/2/cover?size=512', route => route.fulfill({ status: 404, body: 'Unavailable' }));
    await ready(page);
    await openTrack(page, 2);
    await loaded(page);
    assert.equal(await page.locator('#track-inspector-title').innerText(), payload);
    await page.locator('.ti-extra > summary').click();
    assert.match(await page.locator('.ti-extra-fields').innerText(), /<img/);
    await page.locator('#track-inspector-lyrics-load').click();
    await page.locator('#track-inspector-lyrics').waitFor();
    assert.equal(await page.locator('#track-inspector-lyrics').innerText(), payload);
    assert.equal(await page.locator('#track-inspector img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => window.uiInjected), undefined);
    await page.waitForFunction(() => document.querySelector('.ti-art')?.dataset.state === 'failed');
    assert.match(await page.locator('.ti-art').innerText(), /暂时无法读取/);
  }));

  await check('Copying a path works without Clipboard API and leaves it selected', () => withPage(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await ready(page);
    await openTrack(page);
    await loaded(page);
    await page.locator('#track-inspector-copy-path').click();
    assert.match(await page.locator('#track-inspector-copy-feedback').innerText(), /Ctrl\+C/);
    const selection = await page.locator('#track-inspector-path').evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, length: node.value.length, focused: document.activeElement === node }));
    assert.deepEqual(selection, { start: 0, end: selection.length, length: selection.length, focused: true });
    const id = await page.locator('#track-inspector').getAttribute('data-track-id');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#track-inspector').getAttribute('data-track-id'), id, 'Arrow keys in the path field must not navigate to another track');
  }));

  await check('Details open from cards and hand off to editing or scraping without writes', () => withPage(async ({ page }) => {
    const writes = [];
    page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
    await ready(page);
    await page.locator('#view-cards').click();
    await page.locator('#tracks-grid [data-id="2"] button[data-detail-id]').first().click();
    await loaded(page);
    await page.locator('#track-inspector-edit').click();
    assert.equal(await page.locator('#track-inspector').count(), 0);
    await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'true');
    assert.match(await page.locator('#edit-scope').innerText(), /七里香/);
    await page.locator('#edit-close').click();
    await page.locator('#tracks-grid [data-id="2"] button[data-detail-id]').first().click();
    await loaded(page);
    await page.locator('#track-inspector-scrape').click();
    await page.waitForFunction(() => document.querySelector('#tab-scrape')?.getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('#track-inspector').count(), 0);
    assert.equal(await page.evaluate(async () => (await import('/store.js')).state.currentTrackId), 2);
    assert.deepEqual(writes, [], 'Inspecting or navigating into editing/scraping must not mutate music');
  }));

  await check('Saved filters restore search, exact filters, ordering, page size and presentation', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#tracks-q').fill('周杰伦');
    await page.locator('#tracks-q').press('Enter');
    await page.locator('.advanced-filters > summary').click();
    await page.locator('#filter-artist').fill('周杰伦');
    await page.locator('#filter-artist').blur();
    await page.locator('#filter-album').fill('叶惠美');
    await page.locator('#filter-album').blur();
    await page.locator('#filter-language').selectOption('中文');
    await page.locator('#filter-missing-lyrics').check();
    await page.locator('#library-display-toggle').click();
    await page.locator('#tracks-sort').selectOption('title');
    await page.locator('#tracks-order').selectOption('desc');
    await page.locator('#tracks-pagesize').selectOption('50');
    await page.locator('#density-compact').click();
    await page.keyboard.press('Escape');
    await page.locator('#view-cards').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-grid .track-card').length === 1);
    const before = await snapshot(page);
    await saveFilter(page, '周杰伦待补歌词');
    assert.equal((await storedItems(page)).length, 1);
    await page.locator('[data-quick-filter="all"]').click();
    await page.locator('#view-list').click();
    await page.locator('#library-display-toggle').click();
    await page.locator('#density-comfortable').click();
    await page.locator('#tracks-sort').selectOption('artist');
    await page.locator('#tracks-order').selectOption('asc');
    await page.locator('#tracks-pagesize').selectOption('100');
    await page.keyboard.press('Escape');
    await page.locator('.saved-filter-chip').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-grid .track-card').length === 1 && !document.querySelector('#tracks-grid').hidden);
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await page.locator('.saved-filter-chip').getAttribute('aria-pressed'), 'true');
    await page.reload();
    await page.locator('#tracks-grid .track-card[data-id]').first().waitFor();
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await page.locator('.saved-filter-chip').innerText(), '周杰伦待补歌词');
    assert.equal(await page.locator('.saved-filter-chip').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(outputDir, 'saved-filter-library.png'), fullPage: true, animations: 'disabled' });
  }));

  await check('Display settings keep search visible, persist choices, and close with Escape or outside interaction', () => withPage(async ({ page }) => {
    await ready(page);
    assert.equal(await page.locator('#tracks-sort').isVisible(), false);
    assert.equal(await page.locator('#btn-edit-selected').isVisible(), false);
    await page.locator('#library-display-toggle').click();
    await page.locator('#tracks-sort').selectOption('title');
    await page.locator('#tracks-order').selectOption('desc');
    await page.locator('#tracks-pagesize').selectOption('50');
    await page.locator('#density-compact').click();
    await page.waitForFunction(() => document.querySelector('#library-display-summary')?.textContent === '标题 · 降序 · 50 首');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#library-display-settings').getAttribute('open'), null);
    assert.equal(await page.locator('#library-display-toggle').evaluate(node => node === document.activeElement), true);
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#library-display-summary').innerText(), '标题 · 降序 · 50 首');
    assert.equal(await page.locator('.library-card').getAttribute('data-library-density'), 'compact');
    await page.locator('#library-display-toggle').click();
    await page.locator('#tracks-q').click();
    assert.equal(await page.locator('#tracks-sort').isVisible(), false);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#library-display-toggle').click();
      await noOverflow(page, '.library-display-panel');
      const bounds = await page.locator('.library-display-panel').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(await page.locator('#tracks-pagesize').isVisible(), true);
      await page.screenshot({ path: path.join(outputDir, `library-display-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
    }
  }));

  await check('Saved folder scopes preserve exact path spaces and direct-only mode across restore', () => withPage(async ({ page }) => {
    await ready(page);
    const folder = '/fixture-music/  收藏 %_! \\ 名称  ';
    await page.evaluate(async folder => {
      (await import('/tracks.js')).setFolderScope({ folder, recursive: false });
    }, folder);
    await saveFilter(page, '目录收藏');
    await page.locator('[data-quick-filter="all"]').click();
    await page.locator('.saved-filter-chip').click();
    await page.waitForFunction(folder => document.querySelector('[data-filter-key="folder"]')?.textContent.includes(folder), folder);
    const restored = await snapshot(page);
    assert.equal(restored.filters.folder, folder);
    assert.equal(restored.filters.folder_recursive, false);
    assert.match(await page.locator('[data-filter-key="folder"]').innerText(), /仅本层/);
    await page.reload();
    await page.waitForFunction(async () => {
      const { tracks } = (await import('/store.js')).state;
      return !tracks.loading && tracks.loadedAt > 0;
    });
    assert.equal((await snapshot(page)).filters.folder, folder);
    assert.equal((await snapshot(page)).filters.folder_recursive, false);
    await page.locator('[data-filter-key="folder"] button').click();
    assert.equal((await snapshot(page)).filters.folder, '');
    assert.equal((await snapshot(page)).filters.folder_recursive, true);
  }));

  await check('Folder scan preparation preserves exact paths and rejects browser-normalized names without starting jobs', () => withPage(async ({ page }) => {
    await ready(page);
    const writes = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    const validPath = '/fixture-music/  名称 %_! \\ 保留  ';
    const prepared = await page.evaluate(async folder => (await import('/tracks.js')).prepareFolderScan(folder), validPath);
    assert.equal(prepared, true);
    assert.equal(await page.locator('#scan-root').inputValue(), validPath);
    assert.equal(await page.locator('#scan-root').evaluate(node => node.closest('details').open), true);
    await page.locator('#scan-root').evaluate(node => { node.closest('details').open = false; });
    for (const separator of ['\n', '\r', '\r\n']) {
      const accepted = await page.evaluate(async folder => (await import('/tracks.js')).prepareFolderScan(folder), `/fixture-music/A${separator}B`);
      assert.equal(accepted, false);
      assert.equal(await page.locator('#scan-root').inputValue(), validPath);
      assert.equal(await page.locator('#scan-root').evaluate(node => node.closest('details').open), false);
    }
    assert.deepEqual(writes, []);
  }));

  await check('Saved filter names validate and management renames or confirms deletion', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#saved-filter-save').click();
    for (const [name, message] of [['   ', /名字/], ['长'.repeat(37), /最多 36/]]) {
      await page.locator('#saved-filter-name').fill(name);
      await page.locator('#saved-filter-submit').click();
      assert.match(await page.locator('#saved-filter-form-error').innerText(), message);
      assert.equal((await storedItems(page)).length, 0);
    }
    await page.locator('#saved-filter-name').fill('Rock');
    await page.locator('#saved-filter-submit').click();
    await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
    await page.locator('#saved-filter-save').click();
    await page.locator('#saved-filter-name').fill('ＲＯＣＫ');
    await page.locator('#saved-filter-submit').click();
    assert.match(await page.locator('#saved-filter-form-error').innerText(), /同名/);
    await page.keyboard.press('Escape');
    await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'saved-filter-save');
    await page.locator('#saved-filter-manage').click();
    await page.getByRole('button', { name: '重命名收藏 Rock', exact: true }).click();
    await page.getByRole('textbox', { name: '收藏 Rock 的新名称', exact: true }).fill('摇滚收藏');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    assert.equal((await storedItems(page))[0].name, '摇滚收藏');
    await page.getByRole('button', { name: '删除收藏 摇滚收藏', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await storedItems(page)).length, 1);
    const before = await snapshot(page);
    await page.getByRole('button', { name: '删除收藏 摇滚收藏', exact: true }).click();
    await page.getByRole('button', { name: '确认删除收藏', exact: true }).click();
    assert.equal((await storedItems(page)).length, 0);
    assert.deepEqual(await snapshot(page), before, 'Deleting a saved filter must not change the current collection');
    await page.keyboard.press('Escape');
    await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'saved-filter-save');
  }));

  await check('Cross-tab saved filter updates preserve a pending rename and merge new entries', () => withPage(async ({ page, context }) => {
    await ready(page);
    await saveFilter(page, '原始收藏');
    await page.locator('#saved-filter-manage').click();
    await page.getByRole('button', { name: '重命名收藏 原始收藏', exact: true }).click();
    const rename = page.getByRole('textbox', { name: '收藏 原始收藏 的新名称', exact: true });
    await rename.fill('还在输入的名称');
    const other = await context.newPage();
    await ready(other);
    await saveFilter(other, '另一标签页新增');
    await page.locator('.saved-filter-stale:not([hidden])').waitFor();
    assert.equal(await rename.inputValue(), '还在输入的名称');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    assert.deepEqual((await storedItems(page)).map(item => item.name).sort(), ['另一标签页新增', '还在输入的名称'].sort());
    await other.close();
  }));

  await check('Invalid saved data is bounded, sanitized and rendered only as text', () => withPage(async ({ page }) => {
    const unsafeName = '<img src=x onerror=alert(1)>';
    const data = { version: 1, items: [null, { id: 'bad', name: 'bad', snapshot: { filters: null } }, { id: 'safe', name: unsafeName, snapshot: { q: '', sort: '<script>', order: 'drop', page_size: -1, view: 'invalid', density: {}, filters: { artist: '周杰伦', not_loaded: 'true', missing_cover: 1, injected: 'anything' } } }] };
    for (let index = 0; index < 20; index += 1) data.items.push({ id: `filter-${index}`, name: `收藏${index}`, snapshot: {} });
    await page.addInitScript(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), { key: savedKey, data });
    await ready(page);
    assert.equal(await page.locator('.saved-filter-chip').count(), 12);
    assert.equal(await page.locator('.saved-filter-chip').first().innerText(), unsafeName);
    assert.equal(await page.locator('.saved-filters img').count(), 0);
    await page.locator('.saved-filter-chip').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    const current = await snapshot(page);
    assert.equal(current.sort, 'artist');
    assert.equal(current.order, 'asc');
    assert.equal(current.page_size, 100);
    assert.equal(current.view, 'list');
    assert.equal(current.density, 'comfortable');
    assert.equal(current.filters.not_loaded, false);
    assert.equal(current.filters.missing_cover, false);
    assert.equal('injected' in current.filters, false);
    await page.locator('#saved-filter-save').click();
    await page.locator('#saved-filter-name').fill('第十三条');
    await page.locator('#saved-filter-submit').click();
    assert.match(await page.locator('#saved-filter-form-error').innerText(), /最多保存 12/);
  }));

  await check('Storage failures keep save dialogs open and never claim success', () => withPage(async ({ page }) => {
    await page.addInitScript(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Test quota exceeded', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, savedKey);
    await ready(page);
    await page.locator('#saved-filter-save').click();
    await page.locator('#saved-filter-name').fill('不能保存');
    await page.locator('#saved-filter-submit').click();
    assert.match(await page.locator('#saved-filter-form-error').innerText(), /保存失败/);
    assert.equal(await page.locator('#saved-filters-dialog[open]').count(), 1);
    assert.equal(await page.locator('.saved-filter-chip').count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), savedKey), null);
  }));

  await check('Broken saved JSON can recover while future versions remain intact', async () => {
    await withPage(async ({ page }) => {
      await page.addInitScript(key => localStorage.setItem(key, '{broken'), savedKey);
      await ready(page);
      assert.match(await page.locator('.saved-filter-warning').innerText(), /无法读取/);
      await saveFilter(page, '恢复后的收藏');
      assert.equal((await storedItems(page))[0].name, '恢复后的收藏');
    });
    await withPage(async ({ page }) => {
      const future = JSON.stringify({ version: 99, items: [{ id: 'future', name: '未来版本', snapshot: {} }] });
      await page.addInitScript(({ key, data }) => localStorage.setItem(key, data), { key: savedKey, data: future });
      await ready(page);
      assert.match(await page.locator('.saved-filter-warning').innerText(), /暂不支持/);
      await page.locator('#saved-filter-save').click();
      await page.locator('#saved-filter-name').fill('不应覆盖');
      await page.locator('#saved-filter-submit').click();
      assert.match(await page.locator('#saved-filter-form-error').innerText(), /暂不支持/);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), savedKey), future);
    });
  });

  await check('Tracks without indexed artwork never request a detail cover', () => withPage(async ({ page }) => {
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await ready(page);
    await openTrack(page, 4);
    await loaded(page);
    assert.match(await page.locator('.ti-art').innerText(), /尚未收录封面/);
    assert.equal(requests.filter(url => url === '/api/tracks/4/cover').length, 0);
  }));

  await check('Exact artist/album and unread-tag filters query the expected library subset', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('.advanced-filters > summary').click();
    await page.locator('#filter-artist').fill('周杰伦');
    await page.locator('#filter-artist').blur();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    await page.locator('#filter-album').fill('叶惠美');
    await page.locator('#filter-album').blur();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 1);
    assert.equal(await page.locator('#tracks-tbody tr').getAttribute('data-id'), '1');
    await page.locator('#filter-not-loaded').check();
    await page.waitForFunction(() => document.querySelector('#tracks-total')?.textContent.includes('0'));
    assert.match(await page.locator('#filter-chips').innerText(), /待读标签/);
    await page.locator('#btn-filters-reset').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
  }));

  await check('Batch selection handoff preserves selected tracks without starting work', () => withPage(async ({ page }) => {
    const writes = [];
    page.on('request', request => { if (['POST', 'PUT'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
    await ready(page);
    await page.locator('#tracks-tbody tr[data-id="1"] input[type=checkbox]').check();
    await page.locator('#tracks-tbody tr[data-id="2"] input[type=checkbox]').check();
    await page.locator('#tracks-q').fill('Radiohead');
    await page.locator('#tracks-q').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 1);
    assert.match(await page.locator('#selection-bar').innerText(), /当前页 0 首/);
    assert.match(await page.locator('#selection-bar').innerText(), /其他页 2 首/);
    await page.locator('#selection-scrape').click();
    await page.waitForFunction(() => document.querySelector('#tab-scrape')?.getAttribute('aria-selected') === 'true');
    await page.waitForFunction(() => document.activeElement?.matches('input[name="batch-mode"]:checked'));
    assert.deepEqual(await page.evaluate(async () => [...(await import('/store.js')).state.selection.keys()]), [1, 2]);
    assert.deepEqual(writes, []);
    await page.locator('#tab-tracks').click();
    await page.locator('#selection-clear').click();
    assert.equal(await page.locator('#selection-bar').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'check-page');
  }));

  await check('Clearing a selection from an empty result restores focus to library search', () => withPage(async ({ page }) => {
    await ready(page);
    for (const view of ['list', 'cards']) {
      await page.locator('[data-quick-filter="all"]').click();
      await page.locator(`#view-${view}`).click();
      const host = view === 'list' ? '#tracks-tbody' : '#tracks-grid';
      await page.locator(`${host} [data-id="1"] input[type=checkbox]`).check();
      await page.locator('#tracks-q').fill('no-fixture-can-match-this-title');
      await page.locator('#tracks-q').press('Enter');
      await page.waitForFunction(() => document.querySelector('#tracks-total')?.textContent.includes('0'));
      await page.locator('#selection-clear').click();
      assert.equal(await page.locator('#selection-bar').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tracks-q');
    }
  }));

  await check('Command shortcuts cannot open the palette behind native dialogs', () => withPage(async ({ page }) => {
    await ready(page);
    const scenarios = [
      { open: () => page.locator('#btn-library-shortcuts').click(), selector: 'dialog[open]:has(#keyboard-shortcuts)' },
      { open: () => openTrack(page), selector: '#track-inspector[open]' },
      { open: () => page.locator('#saved-filter-save').click(), selector: '#saved-filters-dialog[open]' },
    ];
    for (const { open, selector } of scenarios) {
      await open();
      await page.locator(selector).waitFor();
      await page.keyboard.press('Control+k');
      await page.keyboard.press('Meta+k');
      assert.equal(await page.locator('.palette-veil').isVisible(), false, 'The palette must remain closed behind a native dialog');
      assert.equal(await page.locator(selector).isVisible(), true);
      await page.keyboard.press('Escape');
      await page.locator(selector).waitFor({ state: 'detached' });
      assert.equal(await page.locator('.palette-veil').isVisible(), false, 'One Escape must close the active modal without revealing a hidden palette');
    }
  }));

  await check('Help opened from a palette command restores focus to its visible launcher', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#btn-palette').click();
    await page.locator('#palette-input').fill('查看键盘快捷键');
    await page.locator('.palette-item').filter({ hasText: '查看键盘快捷键' }).click();
    await page.locator('#keyboard-shortcuts').waitFor();
    assert.equal(await page.locator('.palette-veil').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.locator('#keyboard-shortcuts').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-palette');
    assert.equal(await page.evaluate(() => document.activeElement.getClientRects().length > 0), true);
  }));

  await check('Keyboard help and detail shortcuts respect focused controls and modal boundaries', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#main').focus();
    await page.keyboard.press('?');
    await page.locator('#keyboard-shortcuts').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#keyboard-shortcuts').waitFor({ state: 'detached' });
    await page.locator('#tracks-q').focus();
    await page.keyboard.press('?');
    assert.equal(await page.locator('#keyboard-shortcuts').count(), 0);
    await page.locator('#tracks-q').fill('');
    await page.locator('#tracks-q').press('Enter');
    await page.locator('#main').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('i');
    await page.locator('#track-inspector[open]').waitFor();
    const active = await page.locator('#track-inspector').getAttribute('data-track-id');
    await page.keyboard.press('?');
    assert.equal(await page.locator('#keyboard-shortcuts').count(), 0);
    assert.equal(await page.locator('#track-inspector').getAttribute('data-track-id'), active);
  }));

  await check('New dialogs fit mobile and desktop themes with bounded motion', async () => {
    for (const [width, height, colorScheme, reducedMotion] of [[1440, 1000, 'light', 'no-preference'], [1440, 1000, 'dark', 'reduce'], [390, 500, 'light', 'reduce'], [320, 568, 'dark', 'reduce']]) {
      await withPage(async ({ page }) => {
        await ready(page);
        await openTrack(page, 2);
        await loaded(page);
        await noOverflow(page, '#track-inspector');
        await noOverflow(page, '.ti-body');
        if (reducedMotion === 'reduce') assert.equal(await page.locator('#track-inspector').evaluate(node => getComputedStyle(node).animationName), 'none');
        assert.equal(await page.locator('#track-inspector').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity)), false);
        await page.waitForFunction(() => document.querySelector('.ti-art')?.dataset.state !== 'loading');
        await page.locator('#track-inspector').evaluate(async node => {
          await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
        });
        assert.equal(await page.locator('#track-inspector').evaluate(node => getComputedStyle(node).opacity), '1');
        await page.screenshot({ path: path.join(outputDir, `track-details-${width}-${colorScheme}.png`) });
        await page.keyboard.press('Escape');
        await saveFilter(page, '日常整理与待补资料');
        await page.locator('#saved-filter-manage').click();
        await noOverflow(page, '#saved-filters-dialog');
        await noOverflow(page, '#saved-filters-dialog .modal-body');
        const foot = await page.locator('#saved-filters-dialog .modal-foot').boundingBox();
        assert.ok(foot && foot.y >= 0 && foot.y + foot.height <= height, 'Management actions must stay within a short mobile viewport');
        await page.screenshot({ path: path.join(outputDir, `saved-filter-manager-${width}-${colorScheme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.locator('#btn-library-shortcuts').click();
        await page.locator('#keyboard-shortcuts').waitFor();
        await noOverflow(page, 'dialog[open]');
      }, { viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} library tools checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server?.kill();
}
