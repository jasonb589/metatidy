/** Folder browsing acceptance. Local fixtures only; scans remain an explicit handoff. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), outputDir = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Available runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
let browser, server, base, passed = 0;
const failures = [], ROOT = '/fixture-music';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const item = (name, parent = ROOT, extra = {}) => ({ name, path: `${parent}/${name}`, track_count: 8, direct_tracks: 2, bytes: 8000000, ...extra });
const listing = (items = [], extra = {}) => ({ root: ROOT, current: ROOT, parent: null, breadcrumbs: [{ name: 'fixture-music', path: ROOT }], total: items.length, page: 1, page_size: 50, pages: Math.ceil(items.length / 50), total_tracks: 500, direct_tracks: 3, bytes: 500000000, items, scan_root: extra.current || ROOT, can_scan: true, ...extra });
const childListing = (child, items = [], extra = {}) => listing(items, { current: child.path, parent: ROOT, breadcrumbs: [{ name: 'fixture-music', path: ROOT }, { name: child.name, path: child.path }], ...extra });
async function check(name, action) {
  if (process.env.METATIDY_FOLDERS_TEST_FILTER && !name.includes(process.env.METATIDY_FOLDERS_TEST_FILTER)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], model = { calls: [], handler: null, trackCalls: [], posts: [] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/tracks') model.trackCalls.push(url); if (request.method() !== 'GET' && url.pathname.startsWith('/api/')) model.posts.push(url.pathname); });
  await page.route('**/api/folders?*', async route => {
    const url = new URL(route.request().url()); model.calls.push(url);
    if (model.handler) return model.handler({ route, url });
    return route.continue();
  });
  try { await action({ page, context, model }); assert.deepEqual(errors, [], 'Folder browsing must not throw browser exceptions'); }
  finally { await context.close(); }
}
async function ready(page) { await page.goto(base); await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18); }
async function loaded(page) { await page.waitForFunction(() => document.querySelector('#folder-browser-items')?.getAttribute('aria-busy') === 'false' && !document.querySelector('#folder-browser-browse')?.disabled); }
async function open(page) { await page.locator('#btn-library-folders').click(); await loaded(page); }
async function enter(page, name) { await page.locator('.fb-folder').filter({ has: page.locator('strong', { hasText: name }) }).click(); await loaded(page); }
async function snapshot(page) { return page.evaluate(async () => { const { state } = await import('/store.js'); return { q: state.tracks.q, filters: { ...state.tracks.filters }, page: state.tracks.page, selected: [...state.selection.keys()] }; }); }
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function waitDeferred(value) { let timer; try { await Promise.race([value.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pending request did not start')), 5000); })]); } finally { clearTimeout(timer); } }

try {
  await mkdir(outputDir, { recursive: true });
  const port = Number(process.env.METATIDY_UI_FOLDERS_PORT) || 18875;
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Folder fixture did not start')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Folders load only on demand, navigate server breadcrumbs and preserve library state until explicit browse', () => withPage(async ({ page, model }) => {
    await ready(page); const before = await snapshot(page);
    assert.equal(model.calls.length, 0); await open(page);
    assert.equal(model.calls.length, 1); assert.equal(model.calls[0].searchParams.has('folder'), false);
    assert.equal(await page.locator('#folder-browser-recursive').isChecked(), true);
    assert.equal(await page.locator('#folder-browser-up').isDisabled(), true);
    await enter(page, '中文'); await enter(page, '周杰伦');
    assert.equal(await page.locator('#folder-browser-path').innerText(), `${ROOT}/中文/周杰伦`);
    assert.equal(await page.locator('.fb-crumb[aria-current]').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await snapshot(page), before);
    await page.locator('#folder-browser-up').click(); await loaded(page);
    assert.equal(await page.locator('#folder-browser-path').innerText(), `${ROOT}/中文`);
    await page.locator('.fb-crumb').first().click(); await loaded(page);
    assert.equal(await page.locator('#folder-browser-path').innerText(), ROOT);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btn-library-folders').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(model.posts, []);
  }));

  await check('Folder browse scopes preserve searches, tag filters and selection while direct mode is sent explicitly', () => withPage(async ({ page, model }) => {
    await ready(page);
    await page.evaluate(async () => { const { state, selectRows } = await import('/store.js'); selectRows([state.tracks.items[0]], true); state.tracks.q = '晴天'; state.tracks.filters.artist = '周杰伦'; state.tracks.page = 3; });
    const before = await snapshot(page);
    await open(page); await enter(page, '中文'); await enter(page, '周杰伦');
    await page.locator('#folder-browser-recursive').uncheck(); await page.locator('#folder-browser-browse').click();
    await page.waitForFunction(() => !document.querySelector('#folder-browser') && document.querySelector('[data-filter-key="folder"]'));
    await page.waitForFunction(async () => !(await import('/store.js')).state.tracks.loading);
    let after = await snapshot(page);
    assert.equal(after.q, '晴天'); assert.equal(after.filters.artist, '周杰伦'); assert.deepEqual(after.selected, before.selected);
    assert.equal(after.page, 1); assert.equal(after.filters.folder, `${ROOT}/中文/周杰伦`); assert.equal(after.filters.folder_recursive, false);
    assert.equal(model.trackCalls.at(-1).searchParams.get('folder_recursive'), 'false');
    assert.equal(await page.locator('#tracks-tbody tr[data-id]').count(), 0, 'Direct mode excludes songs in album subfolders');
    await open(page); await enter(page, '中文'); await enter(page, '周杰伦'); await page.locator('#folder-browser-browse').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 1);
    assert.equal(model.trackCalls.at(-1).searchParams.get('folder_recursive'), 'true');
    await page.locator('[data-filter-key="folder"] button').click();
    after = await snapshot(page); assert.equal(after.filters.folder, ''); assert.equal(after.filters.artist, '周杰伦'); assert.equal(after.q, '晴天');
    assert.deepEqual(after.selected, before.selected); assert.deepEqual(model.posts, []);
  }));

  await check('Folder scan only prefills and reveals the existing scan form without POST or changing scope', () => withPage(async ({ page, model }) => {
    await ready(page); const before = await snapshot(page);
    await open(page); await enter(page, '日文'); await page.locator('#folder-browser-scan').click();
    await page.waitForFunction(() => document.querySelector('#scan-root')?.value === '/fixture-music/日文');
    assert.equal(await page.locator('#scan-root').evaluate(node => node.closest('details').open && node === document.activeElement), true);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(model.posts, []);
  }));

  await check('Folder search submits once, filters immediate child names and paginates without shrinking scope totals', () => withPage(async ({ page, model }) => {
    const all = Array.from({ length: 63 }, (_, index) => item(`唱片 ${String(index + 1).padStart(2, '0')}`));
    model.handler = ({ route, url }) => {
      const q = url.searchParams.get('q') || '', rows = all.filter(value => value.name.includes(q)), pages = Math.ceil(rows.length / 50), pageNumber = Math.max(1, Math.min(Number(url.searchParams.get('page')), pages || 1));
      return route.fulfill({ json: listing(rows.slice((pageNumber - 1) * 50, pageNumber * 50), { total: rows.length, pages, page: pageNumber }) });
    };
    await ready(page); await open(page); assert.equal(await page.locator('.fb-folder').count(), 50);
    await page.locator('#folder-browser-next').click(); await loaded(page);
    assert.equal(await page.locator('.fb-folder').count(), 13); assert.match(await page.locator('#folder-browser-page').innerText(), /2 \/ 2/);
    const before = model.calls.length;
    await page.locator('#folder-browser-q').fill('唱片 63'); await page.locator('#folder-browser-search').click(); await loaded(page);
    assert.equal(model.calls.length, before + 1); assert.equal(await page.locator('.fb-folder').count(), 1);
    assert.match(await page.locator('#folder-browser-facts').innerText(), /500 首/);
    assert.equal(await page.locator('#folder-browser-next').isDisabled(), true);
    await page.locator('#folder-browser-q').fill('没有匹配'); await page.locator('#folder-browser-q').press('Enter'); await loaded(page);
    assert.equal(model.calls.length, before + 2); assert.match(await page.locator('.fb-empty').innerText(), /没有匹配/);
    assert.equal(await page.locator('#folder-browser-browse').isDisabled(), false);
  }));

  await check('Folder callbacks preserve exact returned path spaces, Unicode, percent and backslashes', () => withPage(async ({ page, model }) => {
    const child = item('  收藏 %_! \\ 名称  ');
    model.handler = ({ route, url }) => route.fulfill({ json: url.searchParams.get('folder') ? childListing(child, [], { can_scan: false }) : listing([child]) });
    await ready(page); await page.evaluate(async () => {
      window.folderCalls = [];
      (await import('/folder-browser.js')).openFolderBrowser({ onBrowse: value => window.folderCalls.push(value), onScan: value => window.folderCalls.push(value) });
    }); await loaded(page); await page.locator('.fb-folder').click(); await loaded(page);
    assert.equal(model.calls.at(-1).searchParams.get('folder'), child.path);
    assert.equal(await page.locator('#folder-browser-path').textContent(), child.path);
    assert.equal(await page.locator('#folder-browser-scan').isDisabled(), true);
    await page.locator('#folder-browser-recursive').uncheck(); await page.locator('#folder-browser-browse').click();
    assert.deepEqual(await page.evaluate(() => window.folderCalls), [{ folder: child.path, recursive: false }]);
  }));

  await check('Empty root and missing directories remain recoverable with explicit retry and safe actions', () => withPage(async ({ page, model }) => {
    const child = item('失去索引'); let rootEmpty = true, failed = false;
    model.handler = ({ route, url }) => {
      if (url.searchParams.get('folder') === child.path) return route.fulfill({ status: 404, json: { detail: '目录没有索引记录' } });
      if (failed) return route.fulfill({ status: 503, json: { detail: '索引暂不可用' } });
      return route.fulfill({ json: rootEmpty ? listing([], { total_tracks: 0, direct_tracks: 0, bytes: 0 }) : listing([child]) });
    };
    await ready(page); await open(page);
    assert.match(await page.locator('.fb-empty').innerText(), /还没有已收录/); assert.equal(await page.locator('#folder-browser-scan').isDisabled(), false);
    rootEmpty = false; await page.locator('#folder-browser-home').click(); await loaded(page);
    await page.locator('.fb-folder').click();
    await page.waitForFunction(() => document.querySelector('#folder-browser-status')?.textContent.includes('已没有索引'));
    assert.equal(await page.locator('#folder-browser-browse').isDisabled(), true); assert.equal(await page.locator('#folder-browser-scan').isDisabled(), true);
    assert.equal(await page.locator('#folder-browser-retry').evaluate(node => node === document.activeElement), true);
    failed = true; await page.locator('#folder-browser-home').click();
    await page.waitForFunction(() => document.querySelector('#folder-browser-status')?.textContent.includes('索引暂不可用'));
    failed = false; await page.locator('#folder-browser-retry').click(); await loaded(page); assert.equal(await page.locator('.fb-folder').count(), 1);
  }));

  await check('Folder late navigation, search, close and hash responses cannot replace the current directory', () => withPage(async ({ page, model }) => {
    const first = item('旧目录'), entered = deferred(), release = deferred(), searchEntered = deferred(), searchRelease = deferred();
    model.handler = async ({ route, url }) => {
      if (url.searchParams.get('folder') === first.path) { entered.resolve(); await release.promise; return route.fulfill({ json: childListing(first) }).catch(() => {}); }
      if (url.searchParams.get('q') === 'old') { searchEntered.resolve(); await searchRelease.promise; return route.fulfill({ json: listing([item('old')]) }).catch(() => {}); }
      return route.fulfill({ json: listing([first]) });
    };
    try {
      await ready(page); await open(page); await page.locator('.fb-folder').click(); await waitDeferred(entered);
      assert.equal(await page.locator('#folder-browser-browse').isDisabled(), true);
      await page.locator('#folder-browser-home').click(); await loaded(page); release.resolve(); await settle(page);
      assert.equal(await page.locator('#folder-browser-path').innerText(), ROOT);
      await page.locator('#folder-browser-q').fill('old'); await page.locator('#folder-browser-search').click(); await waitDeferred(searchEntered);
      await page.locator('#folder-browser-q').fill('new'); await page.locator('#folder-browser-search').click(); await loaded(page); searchRelease.resolve(); await settle(page);
      assert.equal(await page.locator('.fb-folder strong').innerText(), '旧目录'); assert.match(await page.locator('#folder-browser-status').innerText(), /new/);
      await page.evaluate(() => { location.hash = '#settings'; }); await page.locator('#folder-browser').waitFor({ state: 'detached' });
      assert.deepEqual(model.posts, []);
    } finally { release.resolve(); searchRelease.resolve(); }
  }));

  await check('Folder metadata mismatches and wrong page responses never enable browse or scan', () => withPage(async ({ page, model }) => {
    const badResponses = [listing([], { current: '/outside', scan_root: '/outside' }), listing([], { parent: '/unexpected' }), listing([], { page: 2 }), listing([], { scan_root: '/elsewhere' }), listing([item('same'), item('same')])];
    await ready(page);
    for (const response of badResponses) {
      model.handler = ({ route }) => route.fulfill({ json: response });
      await page.locator('#btn-library-folders').click();
      await page.waitForFunction(() => document.querySelector('#folder-browser-status')?.textContent.includes('不完整或位置不一致'));
      assert.equal(await page.locator('#folder-browser-browse').isDisabled(), true); assert.equal(await page.locator('#folder-browser-scan').isDisabled(), true);
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(model.posts, []);
  }));

  await check('Folder 401 closes the dialog and prevents a pending browse or scan handoff', () => withPage(async ({ page, model }) => {
    await ready(page); model.handler = ({ route }) => route.fulfill({ status: 401, json: { detail: '登录已过期' } });
    await page.locator('#btn-library-folders').click(); await page.locator('#auth-password').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#folder-browser').count(), 0); assert.equal(await page.locator('.app-content').evaluate(node => node.inert), true); assert.deepEqual(model.posts, []);
  }));

  await check('Folder keyboard navigation retains focus after loading and traps focus until Escape', () => withPage(async ({ page }) => {
    await ready(page); await page.locator('#btn-library-folders').focus(); await page.keyboard.press('Enter'); await loaded(page);
    assert.equal(await page.locator('#folder-browser-close').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('#folder-browser-browse').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await page.locator('#folder-browser-close').evaluate(node => node === document.activeElement), true);
    await page.locator('.fb-folder').first().focus(); await page.keyboard.press('Enter'); await loaded(page);
    assert.equal(await page.locator('.fb-crumb[aria-current]').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#btn-library-folders').evaluate(node => node === document.activeElement), true);
  }));

  await check('Folder layouts keep cards and actions reachable on four sizes, both themes and long paths', async () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [320, 568, 'dark']]) {
      await withPage(async ({ page, model }) => {
        const long = item('很长的音乐收藏路径_'.repeat(24)), child = item('现场录音与未分类收藏', long.path);
        model.handler = ({ route, url }) => route.fulfill({ json: url.searchParams.get('folder') ? childListing(long, [child]) : listing([item('中文唱片'), item('原声音乐'), item('最近归档'), long]) });
        await ready(page); await open(page);
        const checkLayout = async () => {
          assert.equal(await page.locator('#folder-browser').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && node.scrollWidth <= node.clientWidth + 1; }), true);
          assert.equal(await page.locator('#folder-browser-items').evaluate(node => node.clientHeight >= 104), true, 'At least one complete folder card must fit');
          assert.equal(await page.locator('#folder-browser-browse').evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), true);
          assert.equal(await page.locator('#folder-browser').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        };
        await checkLayout(); await page.screenshot({ path: path.join(outputDir, `folder-browser-${width}-${colorScheme}.png`) });
        await page.locator('.fb-folder').last().click(); await loaded(page); await checkLayout();
        await page.screenshot({ path: path.join(outputDir, `folder-browser-long-${width}-${colorScheme}.png`) });
        await page.locator('.fb-folder').first().focus(); assert.equal(await page.locator('.fb-folder').first().evaluate(node => node === document.activeElement), true);
      }, { viewport: { width, height }, colorScheme });
    }
  });

  console.log(`\n${passed} folder checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
