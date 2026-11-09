/** Album browser acceptance with isolated fixture data, never real music. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { revealSavedFilters } from './ui-library-controls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Existing installation or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const failures = [];
const servers = [];
let passed = 0;
let browser;
let base;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function check(name, action) {
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
async function startFixture(port, extra = []) {
  const server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`, ...extra], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Album fixture ${port} did not start`)), 10000);
    server.stdout.on('data', data => { if (String(data).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', data => { clearTimeout(timer); reject(new Error(String(data))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  return `http://127.0.0.1:${port}`;
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try { await action({ page, context }); assert.deepEqual(errors, [], 'Album interactions must not raise browser exceptions'); }
  finally { await context.close(); }
}
async function settled(page, expected) {
  await page.waitForFunction(expected => {
    const grid = document.querySelector('#albums-grid');
    return grid?.getAttribute('aria-busy') === 'false' && (expected === undefined || grid.querySelectorAll('.album-card[data-album-key]').length === expected);
  }, expected);
}
async function ready(page, expected = 17) {
  await page.goto(`${base}/#albums`);
  await settled(page, expected);
}
function card(page, album, artist) {
  return page.locator('.album-card').filter({ has: page.locator('.album-title', { hasText: album }) }).filter({ has: page.locator('.album-artist', { hasText: artist }) });
}
const sampleAlbum = (album, album_artist, extra = {}) => ({ album, album_artist, track_count: 2, duration: 510, bytes: 50000000, missing_cover: 0, missing_lyrics: 0, not_loaded: 0, cover_track_id: null, year: '2024', indexed_at: 1700000000, disc_count: 1, ...extra });
const albumResponse = (items, extra = {}) => ({ items, total: items.length, page: 1, page_size: 24, pages: items.length ? 1 : 0, ...extra });
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal page overflow');
  assert.equal(await page.locator('#albums-root').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'No album workspace overflow');
}

try {
  await mkdir(outputDir, { recursive: true });
  const port = Number(process.env.METATIDY_UI_ALBUMS_PORT) || 18785;
  base = await startFixture(port);
  const emptyBase = await startFixture(port + 1, ['--empty']);
  const authBase = await startFixture(port + 2, ['--auth']);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Albums load lazily from index summaries without library-wide track reads or writes', () => withPage(async ({ page }) => {
    const requests = [];
    page.on('request', request => requests.push({ url: new URL(request.url()), method: request.method() }));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
    assert.equal(requests.filter(r => r.url.pathname === '/api/albums').length, 0);
    const trackReads = requests.filter(r => r.url.pathname === '/api/tracks').length;
    await page.locator('#tab-albums').click();
    await settled(page, 17);
    assert.match(await page.locator('#albums-total').innerText(), /17/);
    assert.equal(requests.filter(r => r.url.pathname === '/api/tracks').length, trackReads);
    assert.equal(requests.some(r => ['POST', 'PUT', 'DELETE'].includes(r.method)), false);
    for (const source of await page.locator('#albums-grid img').evaluateAll(images => images.map(img => img.src))) assert.equal(new URL(source).searchParams.get('size'), '256');
    assert.match(await page.locator('.albums-guide').innerText(), /专辑艺术家/);
    await noOverflow(page);
  }));

  await check('Album search, sort and incomplete filter stay synchronized', () => withPage(async ({ page, context }) => {
    await ready(page);
    await page.locator('#albums-q').fill('周杰伦');
    await page.locator('#albums-q').press('Enter');
    await settled(page, 3);
    assert.ok((await page.locator('.album-artist').allTextContents()).every(value => value === '周杰伦'));
    await page.locator('#albums-sort').selectOption('recent');
    await settled(page, 3);
    await page.locator('#albums-incomplete').check();
    await settled(page, 1);
    assert.equal(await page.locator('.album-title').innerText(), '叶惠美');
    await page.locator('#albums-clear-filters').click();
    await settled(page, 17);
    const expected = await (await context.request.get(`${base}/api/albums?incomplete=1`)).json();
    await page.locator('#albums-incomplete').check();
    await settled(page, expected.items.length);
    assert.ok((await page.locator('.album-completeness').allTextContents()).every(value => /待补|待读/.test(value)));
  }));

  await check('Album pagination asks the backend for every page and survives navigation', () => withPage(async ({ page }) => {
    const requests = [];
    const collection = Array.from({ length: 51 }, (_, i) => sampleAlbum(`Album ${String(i + 1).padStart(2, '0')}`, `Artist ${i + 1}`));
    await page.route('**/api/albums?**', async route => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(Object.fromEntries(params));
      const page = Math.min(3, Math.max(1, Number(params.get('page')) || 1));
      await route.fulfill({ json: albumResponse(collection.slice((page - 1) * 24, page * 24), { total: 51, page, pages: 3 }) });
    });
    await ready(page, 24);
    assert.match(await page.locator('#albums-total').innerText(), /51/);
    await page.locator('#albums-next').click();
    await page.waitForFunction(() => document.querySelector('#albums-page')?.textContent.includes('2 / 3'));
    assert.equal(await page.locator('.album-title').first().innerText(), 'Album 25');
    await page.locator('#albums-next').click();
    await settled(page, 3);
    assert.equal(await page.locator('#albums-next').isDisabled(), true);
    assert.equal(await page.locator('.album-title').last().innerText(), 'Album 51');
    await page.locator('#tab-settings').click();
    await page.locator('#tab-albums').click();
    await settled(page, 3);
    assert.match(await page.locator('#albums-page').innerText(), /3 \/ 3/);
    assert.deepEqual(requests.map(r => Number(r.page)), [1, 2, 3]);
    assert.ok(requests.every(r => Number(r.page_size) === 24));
  }));

  await check('Same-name releases and compilation albums open an exact album scope that can be saved', () => withPage(async ({ page, context }) => {
    const originals = await (await context.request.get(`${base}/api/tracks`)).json();
    const groups = [sampleAlbum('同名专辑', '艺术家甲'), sampleAlbum('同名专辑', '群星', { track_count: 2 }), sampleAlbum('同名专辑', '')];
    const tracks = originals.items.slice(0, 2).map((row, i) => ({ ...row, title: `合辑曲目 ${i + 1}`, artist: `演唱者 ${i + 1}`, album: '同名专辑', albumartist: '群星' }));
    const groupedRequests = [];
    await page.route('**/api/albums?**', route => route.fulfill({ json: albumResponse(groups) }));
    await page.route('**/api/tracks?**', route => {
      const params = new URL(route.request().url()).searchParams;
      if (!params.has('album_group')) return route.continue();
      groupedRequests.push(Object.fromEntries(params));
      return route.fulfill({ json: { ...originals, items: tracks, total: 2, pages: 1, page: 1 } });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
    await page.locator('#tracks-tbody input[type=checkbox]').first().check();
    await page.locator('#tracks-q').fill('contradictory search');
    await page.locator('#tracks-q').press('Enter');
    await page.waitForFunction(() => document.querySelector('#tracks-total')?.textContent.includes('0 首'));
    await page.locator('#tab-albums').click();
    await settled(page, 3);
    await card(page, '同名专辑', '群星').locator('.album-open').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 2);
    const expected = JSON.stringify(['同名专辑', '群星']);
    assert.equal(groupedRequests.at(-1).album_group, expected);
    assert.equal(groupedRequests.at(-1).q, undefined);
    assert.equal(groupedRequests.at(-1).artist, undefined);
    assert.equal(groupedRequests.at(-1).album, undefined);
    assert.equal(groupedRequests.at(-1).sort, 'disc_track');
    assert.equal(await page.locator('#tracks-q').inputValue(), '');
    assert.match(await page.locator('#filter-chips').innerText(), /同名专辑.*群星/);
    assert.match(await page.locator('#selection-bar').innerText(), /已选 1 首/);
    await revealSavedFilters(page); await page.locator('#saved-filter-save').click();
    await page.locator('#saved-filter-name').fill('这张群星合辑');
    await page.locator('#saved-filter-submit').click();
    await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
    await page.locator('[data-filter-key="album_group"] button').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
    await revealSavedFilters(page); await page.locator('.saved-filter-chip').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 2);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 2);
    assert.equal(groupedRequests.at(-1).album_group, expected);
    assert.equal(await page.locator('.saved-filter-chip').getAttribute('aria-pressed'), 'true');
  }));

  await check('Album groups with an empty artist preserve the empty value when opening tracks', () => withPage(async ({ page }) => {
    const key = JSON.stringify(['晚间收藏', '']);
    const seen = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/tracks') seen.push(new URL(request.url()).searchParams); });
    await ready(page);
    await card(page, '晚间收藏', '未知专辑艺术家').locator('.album-open').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 1);
    assert.equal(seen.at(-1).get('album_group'), key);
    assert.match(await page.locator('#tracks-tbody').innerText(), /青石巷/);
  }));

  await check('A stale album search cannot replace a newer query', () => withPage(async ({ page }) => {
    const entered = deferred(), release = deferred();
    await page.route('**/api/albums?**', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === 'old') {
        entered.resolve();
        await release.promise;
        await route.fulfill({ json: albumResponse([sampleAlbum('STALE SEARCH RESULT', 'Old')]) }).catch(() => {});
      } else if (q === 'new') await route.fulfill({ json: albumResponse([sampleAlbum('NEW SEARCH RESULT', 'New')]) });
      else await route.continue();
    });
    try {
      await ready(page);
      await page.locator('#albums-q').fill('old');
      await page.locator('#albums-q').press('Enter');
      await entered.promise;
      await page.locator('#albums-q').fill('new');
      await page.locator('#albums-q').press('Enter');
      await settled(page, 1);
      release.resolve();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.album-title').innerText(), 'NEW SEARCH RESULT');
      assert.equal(await page.locator('#albums-q').inputValue(), 'new');
    } finally { release.resolve(); }
  }));

  await check('Leaving albums cancels pending work and re-entry reloads the current query', () => withPage(async ({ page }) => {
    const entered = deferred(), release = deferred();
    let held = false;
    await page.route('**/api/albums?**', async route => {
      if (!held && new URL(route.request().url()).searchParams.get('q') === '周杰伦') {
        held = true;
        entered.resolve();
        await release.promise;
        return route.fulfill({ json: albumResponse([sampleAlbum('OUTDATED AFTER LEAVING', 'Old')]) }).catch(() => {});
      }
      return route.continue();
    });
    try {
      await ready(page);
      await page.locator('#albums-q').fill('周杰伦');
      await page.locator('#albums-q').press('Enter');
      await entered.promise;
      await page.locator('#tab-settings').click();
      release.resolve();
      await page.locator('#tab-albums').click();
      await settled(page, 3);
      assert.equal(await page.locator('#albums-q').inputValue(), '周杰伦');
      assert.equal((await page.locator('#albums-grid').innerText()).includes('OUTDATED AFTER LEAVING'), false);
    } finally { release.resolve(); }
  }));

  await check('A failed refresh preserves visible albums and retries without losing filters', () => withPage(async ({ page }) => {
    let fail = false;
    await page.route('**/api/albums?**', route => fail ? route.fulfill({ status: 503, json: { detail: '数据库暂不可用' } }) : route.continue());
    await ready(page);
    await page.locator('#albums-q').fill('周杰伦');
    await page.locator('#albums-q').press('Enter');
    await settled(page, 3);
    fail = true;
    await page.locator('#albums-refresh').click();
    await page.locator('#albums-retry').waitFor();
    assert.equal(await page.locator('.album-card[data-album-key]').count(), 3);
    assert.match(await page.locator('#albums-status').innerText(), /数据库暂不可用/);
    fail = false;
    await page.locator('#albums-retry').click();
    await settled(page, 3);
    assert.equal(await page.locator('#albums-q').inputValue(), '周杰伦');
    assert.equal(await page.locator('#albums-retry').count(), 0);
  }));

  await check('Background album updates retain focused actions and honor the apply guard', () => withPage(async ({ page }) => {
    const model = [sampleAlbum('A collection', 'Artist', { track_count: 1 })];
    await page.route('**/api/albums?**', route => route.fulfill({ json: albumResponse(model) }));
    await ready(page, 1);
    const action = page.locator('.album-open');
    await action.focus();
    model[0].track_count = 3;
    await page.evaluate(async () => (await import('/albums.js')).refresh({ background: true, canApply: () => false }));
    assert.equal(await page.locator('.album-count').innerText(), '1 首');
    await page.evaluate(async () => (await import('/albums.js')).refresh({ background: true }));
    assert.equal(await page.locator('.album-count').innerText(), '3 首');
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.album-card').evaluate(node => getComputedStyle(node).animationName), 'none');
  }));

  await check('Unchanged album cards retain identity and do not replay entry motion on background refresh', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#albums-root').evaluate(async node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
    await page.locator('.album-card').first().evaluate(node => { window.albumOriginalCard = node; window.albumEntryEvents = 0; node.addEventListener('animationstart', () => { window.albumEntryEvents++; }); });
    await page.evaluate(async () => (await import('/albums.js')).refresh({ background: true }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.album-card').first().evaluate(node => node === window.albumOriginalCard), true);
    assert.equal(await page.evaluate(() => window.albumEntryEvents), 0, 'The same album must not replay entry animation on polling');
  }, { reducedMotion: 'no-preference' }));

  await check('Automatic scan completion refreshes albums only after focused inputs or dialogs release them', () => withPage(async ({ page, context }) => {
    const jobs = await (await context.request.get(`${base}/api/jobs`)).json();
    const model = [sampleAlbum('自动更新的专辑', 'Artist', { track_count: 1 })];
    let requests = 0;
    await page.route('**/api/jobs', route => route.fulfill({ json: jobs }));
    await page.route('**/api/albums?**', route => { requests++; return route.fulfill({ json: albumResponse(model) }); });
    await page.clock.install();
    await ready(page, 1);
    const baseline = requests;
    await page.clock.runFor(15500);
    assert.equal(requests, baseline, 'Routine status polling must not repeatedly fetch the album shelf');
    const complete = async count => {
      model[0].track_count = count;
      jobs.jobs.unshift({ id: `album-watch-${count}`, kind: 'scan', state: 'done', total: 1, done: 1, message: '自动更新测试', error: '', created_at: Math.floor(Date.now() / 1000), result: JSON.stringify({ trigger: 'watch', scanned: 1, added: 1, updated: 0, skipped: 0 }) });
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/jobs');
      await page.evaluate(async () => (await import('/store.js')).emit('jobs:refresh'));
      await (await response).finished();
      await page.clock.runFor(600);
    };
    await page.locator('#albums-q').focus();
    await complete(2);
    assert.equal(requests, baseline, 'Focused search must defer background album refresh');
    await page.locator('#main').focus();
    await page.clock.runFor(600);
    await page.waitForFunction(() => document.querySelector('.album-count')?.textContent === '2 首');
    const afterInput = requests;
    await page.locator('#btn-shortcuts-footer').click();
    await page.locator('#keyboard-shortcuts').waitFor();
    await complete(3);
    assert.equal(requests, afterInput, 'Open dialog must defer background album refresh');
    await page.keyboard.press('Escape');
    await page.clock.runFor(600);
    await page.waitForFunction(() => document.querySelector('.album-count')?.textContent === '3 首');
    assert.equal(requests, afterInput + 1);
  }));

  await check('Compilation handoff uses numeric disc order across multiple performing artists', () => withPage(async ({ page, context }) => {
    const original = await (await context.request.get(`${base}/api/tracks`)).json();
    const rows = original.items.filter(row => [1, 2, 3, 4].includes(row.id));
    const discs = { 1: ['2/2', '1/12'], 2: ['1', '10'], 3: ['1', '2'], 4: ['', 'unknown'] };
    try {
      for (const row of rows) {
        await context.request.post(`${base}/api/tracks/apply`, { data: { ids: [row.id], fields: { album: '  合辑排序验收  ', albumartist: ' 群星 ', artist: `演唱者 ${row.id}`, disc: discs[row.id][0], track: discs[row.id][1] } } });
      }
      await ready(page, 14);
      const release = card(page, '合辑排序验收', '群星');
      assert.equal(await release.locator('.album-count').innerText(), '4 首');
      await release.locator('.album-open').click();
      await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 4);
      assert.deepEqual(await page.locator('#tracks-tbody tr[data-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.id))), [3, 2, 4, 1]);
      assert.equal(await page.locator('#tracks-sort').inputValue(), 'disc_track');
      assert.equal(await page.locator('#tracks-order').inputValue(), 'asc');
    } finally {
      for (const row of rows) await context.request.post(`${base}/api/tracks/apply`, { data: { ids: [row.id], fields: row } });
    }
  }));

  await check('Album text remains inert and missing artwork does not request a cover', () => withPage(async ({ page }) => {
    const unsafe = '<img src=x onerror=window.albumInjected=true>';
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.route('**/api/albums?**', route => route.fulfill({ json: albumResponse([sampleAlbum(unsafe, unsafe, { missing_cover: 2, missing_lyrics: 2, not_loaded: 2 })]) }));
    await ready(page, 1);
    assert.equal(await page.locator('.album-title').innerText(), unsafe);
    assert.equal(await page.locator('.album-artist img').count(), 0);
    assert.equal(await page.evaluate(() => window.albumInjected), undefined);
    assert.equal(requests.some(path => path.endsWith('/cover')), false);
    assert.match(await page.locator('.album-completeness').innerText(), /待读标签 2/);
    await noOverflow(page);
  }));

  await check('Empty albums guide users to untagged tracks and filtered emptiness can reset', () => withPage(async ({ page }) => {
    await page.goto(`${emptyBase}/#albums`);
    await page.locator('#albums-untagged').waitFor();
    assert.equal(await page.locator('#albums-grid').isVisible(), false);
    await page.locator('#albums-untagged').click();
    await page.waitForFunction(() => document.querySelector('#panel-tracks')?.dataset.active === 'true');
    assert.equal(await page.locator('#filter-no-album').isChecked(), true);
    await ready(page);
    await page.locator('#albums-q').fill('NO_ALBUM_MATCH_XYZ');
    await page.locator('#albums-q').press('Enter');
    await settled(page, 0);
    assert.match(await page.locator('#albums-status').innerText(), /没有符合条件/);
    await page.locator('#albums-clear-filters').click();
    await settled(page, 17);
  }));

  await check('Album deep links cannot request private data before login', () => withPage(async ({ page }) => {
    const data = [];
    page.on('request', request => { if (/\/api\/(albums|tracks|status|settings|sources|jobs)/.test(request.url())) data.push(request.url()); });
    await page.goto(`${authBase}/#albums`);
    await page.locator('#auth-password').waitFor({ state: 'visible' });
    assert.equal(data.length, 0);
    await page.locator('#auth-password').fill('fixture');
    await page.locator('#auth-submit').click();
    await settled(page, 17);
    assert.equal(await page.locator('#panel-albums').getAttribute('data-active'), 'true');
    assert.ok(data.some(url => new URL(url).pathname === '/api/albums'));
  }));

  await check('Album navigation and cards fit phones and themes with finite motion', async () => {
    for (const [width, height, colorScheme, reducedMotion] of [[1440, 1000, 'light', 'no-preference'], [1440, 1000, 'dark', 'reduce'], [390, 844, 'light', 'reduce'], [320, 568, 'dark', 'reduce']]) {
      await withPage(async ({ page }) => {
        await ready(page);
        await noOverflow(page);
        assert.equal(await page.locator('#albums-root').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity)), false);
        if (reducedMotion === 'reduce') assert.equal(await page.locator('.album-card').first().evaluate(node => getComputedStyle(node).animationName), 'none');
        await page.locator('#albums-root').evaluate(async node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
        await page.screenshot({ path: path.join(outputDir, `albums-${width}-${colorScheme}.png`), fullPage: width > 1000 });
        if (width < 700) {
          await page.locator('#sidebar-toggle').click();
          await page.locator('#tab-tracks').click();
          await page.locator('#sidebar-toggle').click();
          await page.locator('#tab-albums').click();
          assert.equal(await page.locator('#panel-albums').getAttribute('data-active'), 'true');
        } else {
          await page.locator('#tab-tracks').focus();
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator('#tab-artists').getAttribute('aria-selected'), 'true');
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator('#tab-albums').getAttribute('aria-selected'), 'true');
        }
      }, { viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} album checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
