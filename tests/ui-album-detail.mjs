/** Exact album detail and atomic additive selection using fixture indexes only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const out = path.join(root, '.codex/ui-preview'), port = Number(process.env.METATIDY_ALBUM_DETAIL_UI_PORT || 18849), base = `http://127.0.0.1:${port}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred() });
const revision = '0123456789abcdef0123456789abcdef';
const newRevision = 'abcdef0123456789abcdef0123456789';
const group = ['同名收藏', '群星'];
const makeRows = () => Array.from({ length: 1105 }, (_, index) => ({ id: index + 1, title: `专辑曲目 ${index + 1}`, artist: `曲目歌手 ${index % 3}`, album: group[0], albumartist: group[1],
  disc: String(Math.floor(index / 100) + 1), track: String(index % 100 + 1), duration: 181 + index % 7, filename: `${index + 1}.flac`, path: `/music/同名收藏/${index + 1}.flac`,
  has_cover: index % 3 ? 1 : 0, has_lyrics: index % 4 ? 1 : 0, tags_loaded: true, size: 12000000 }));
const summary = (rows, values = {}) => ({ album: group[0], album_artist: group[1], track_count: rows.length, disc_count: 12, duration: 203000, bytes: 13260000000,
  missing_cover: 369, missing_lyrics: 277, not_loaded: 0, cover_track_id: 2, year: '2024', indexed_at: 1700000000, ...values });
let browser, server, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_ALBUM_DETAIL_UI_CHECK && !name.includes(process.env.METATIDY_ALBUM_DETAIL_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
const callsAt = (calls, path) => calls.filter(call => call.path === path);
const writes = calls => calls.filter(call => ['/api/tracks/apply', '/api/scrape/batch', '/api/move/execute', '/api/scan'].includes(call.path));
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const rows = makeRows(), calls = [], errors = [];
  const control = { revision, detailGate: null, detailError: null, detailMalformed: false, selectionGate: null, selectionError: null, selectionMalformed: false, selectionCalls: 0,
    finalConflict: false, resolveGate: null, resolvePage: 2, resolveError: 0, resolveMalformed: 0, resolveMissing: 0, coverError: false };
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), body = route.request().postData() ? route.request().postDataJSON() : null;
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === '/api/albums') return json(route, { items: [summary(rows), summary(rows, { album_artist: '另一位歌手', cover_track_id: null })], total: 2, page: 1, page_size: 24, pages: 1 });
    if (url.pathname === '/api/albums/detail') {
      const requested = JSON.parse(url.searchParams.get('album_group')), size = Number(url.searchParams.get('page_size')), pages = Math.ceil(rows.length / size), pageNumber = Math.max(1, Math.min(pages, Number(url.searchParams.get('page'))));
      const result = { group: requested, summary: summary(rows, { album: requested[0], album_artist: requested[1] }), revision: control.revision, total: rows.length, page: pageNumber, page_size: size, pages,
        items: rows.slice((pageNumber - 1) * size, pageNumber * size).map(row => ({ ...row, album: requested[0], albumartist: requested[1] })) };
      if (control.detailMalformed) result.items[0].albumartist = '错误分组';
      if (control.detailGate) { const delay = control.detailGate; control.detailGate = null; delay.entered.resolve(); await delay.release.promise; }
      if (control.detailError) { const error = control.detailError; control.detailError = null; return json(route, { detail: error.text }, error.status); }
      return json(route, result);
    }
    if (url.pathname === '/api/albums/selection') {
      control.selectionCalls += 1;
      const result = { group: body.album_group, revision: body.revision, total: rows.length, ids: rows.map(row => row.id), selected_at: 1700000001 };
      if (control.selectionMalformed) result.ids[1001] = result.ids[0];
      if (control.selectionGate) { const delay = control.selectionGate; control.selectionGate = null; delay.entered.resolve(); await delay.release.promise; }
      if (control.selectionError) { const error = control.selectionError; control.selectionError = null; return json(route, { detail: error.text }, error.status); }
      if (control.finalConflict && control.selectionCalls % 2 === 0) return json(route, { detail: '成员或曲序已变化' }, 409);
      return json(route, result);
    }
    if (url.pathname === '/api/tracks/selection') {
      const size = body.page_size, pages = Math.ceil(body.ids.length / size);
      const result = { total: body.ids.length, selected_total: body.ids.length, found_total: body.ids.length, missing_total: 0, page: body.page, page_size: size, pages,
        items: body.ids.slice((body.page - 1) * size, body.page * size).map(id => ({ id, status: 'found', track: { ...rows[id - 1] } })) };
      if (control.resolveMalformed === body.page) result.items[0].id = 99999;
      if (control.resolveMissing === body.page) { result.missing_total = 1; result.found_total -= 1; result.items[0] = { id: result.items[0].id, status: 'missing', track: null }; }
      if (control.resolveGate && control.resolvePage === body.page) { const delay = control.resolveGate; control.resolveGate = null; delay.entered.resolve(); await delay.release.promise; }
      if (control.resolveError === body.page) return json(route, { detail: '索引读取失败' }, 503);
      return json(route, result);
    }
    if (url.pathname.endsWith('/cover') && url.searchParams.get('size') === '512' && control.coverError) return route.fulfill({ status: 503, body: 'cover unavailable' });
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/#albums`); await page.waitForFunction(() => document.querySelectorAll('#albums-grid .album-card').length === 2 && document.querySelector('#albums-grid').getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows([{ id: 1, title: '已有本组曲目', path: '/music/已有.flac' }, { id: 9000, title: '其他专辑已选', path: '/music/其他.flac' }]); });
    await action({ page, context, rows, calls, control }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
async function open(page, index = 0) { await page.locator('.album-art-open').nth(index).click(); await page.waitForFunction(() => document.querySelector('#album-detail-list')?.getAttribute('aria-busy') === 'false'); }
async function prepare(page) { await page.locator('#album-detail-prepare').click(); await page.locator('#album-detail-confirm').waitFor(); }
async function ids(page) { return page.evaluate(async () => (await import('/store.js')).selectionIds()); }

try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });

  await check('Album cover opens lazy detail and only then requests its larger thumbnail', () => withPage(async ({ page, calls }) => {
    assert.equal(callsAt(calls, '/api/albums/detail').length, 0); assert.equal(calls.some(call => call.query.size === '512'), false);
    await open(page); assert.equal(await page.locator('.ad-track').count(), 100); assert.equal(await page.locator('#album-detail-title').textContent(), group[0]);
    assert.equal(calls.filter(call => call.query.size === '512').length, 1); assert.deepEqual(JSON.parse(callsAt(calls, '/api/albums/detail')[0].query.album_group), group);
    assert.equal(callsAt(calls, '/api/albums/selection').length, 0); assert.equal(writes(calls).length, 0);
  }));
  await check('Exact same-name artist groups stay separate and footer retains the library route', () => withPage(async ({ page, calls }) => {
    await open(page, 1); assert.equal(await page.locator('.ad-artist').textContent(), '另一位歌手');
    assert.deepEqual(JSON.parse(callsAt(calls, '/api/albums/detail')[0].query.album_group), [group[0], '另一位歌手']);
    await page.locator('#album-detail-close').click(); await page.locator('.album-open').first().click(); await page.waitForFunction(() => location.hash === '#tracks');
    const query = callsAt(calls, '/api/tracks').at(-1).query; assert.deepEqual(JSON.parse(query.album_group), group); assert.equal(query.sort, 'disc_track');
  }));
  await check('Album pages retain server disc-track ordering and retry the failed page', () => withPage(async ({ page, calls, control }) => {
    await open(page); assert.equal(await page.locator('.ad-track-number').first().textContent(), '1 · 1'); assert.doesNotMatch(await page.locator('#album-detail-facts').textContent(), /碟/);
    control.detailError = { status: 503, text: '第二页暂时不可用' }; await page.locator('#album-detail-next').click(); await page.locator('#album-detail-retry').waitFor();
    assert.equal(await page.locator('.ad-track').count(), 0); assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true);
    await page.locator('#album-detail-retry').click(); await page.waitForSelector('[data-album-track-id="101"]');
    assert.equal(await page.locator('.ad-track-number').first().textContent(), '2 · 1'); assert.equal(callsAt(calls, '/api/albums/detail').at(-1).query.page, '2');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'album-detail-next');
  }));
  await check('Same-version repeated pages cannot silently replace their known ordered IDs', () => withPage(async ({ page, rows }) => {
    await open(page); await page.locator('#album-detail-next').click(); await page.waitForSelector('[data-album-track-id="101"]');
    [rows[0], rows[1]] = [rows[1], rows[0]]; await page.locator('#album-detail-prev').click(); await page.locator('#album-detail-retry').waitFor();
    assert.match(await page.locator('#album-detail-status').textContent(), /相同专辑版本.*不一致/); assert.equal(await page.locator('.ad-track').count(), 0);
    assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true);
  }));
  await check('A late page keeps focus on an input the user deliberately chose while waiting', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.detailGate = delay; await page.locator('#album-detail-next').click(); await delay.entered.promise;
    await page.locator('#album-detail-close').focus(); delay.release.resolve(); await page.waitForSelector('[data-album-track-id="101"]');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'album-detail-close');
  }));
  await check('Changed album revision clears the page and requires an explicit fresh detail', () => withPage(async ({ page, control }) => {
    await open(page); control.revision = newRevision; await page.locator('#album-detail-next').click(); await page.locator('#album-detail-retry').waitFor();
    assert.match(await page.locator('#album-detail-status').textContent(), /范围或曲序已经变化/); assert.equal(await page.locator('.ad-track').count(), 0);
    assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true); await page.locator('#album-detail-retry').click(); await page.waitForSelector('[data-album-track-id="1"]');
    assert.equal(await page.locator('#album-detail-page').textContent(), '1 / 12');
  }));
  await check('Entire albums over one thousand prepare atomically then append with exact merge counts', () => withPage(async ({ page, calls, control }) => {
    await open(page); const delay = gate(); control.resolveGate = delay;
    await page.locator('#album-detail-prepare').click(); await delay.entered.promise;
    assert.deepEqual(await ids(page), [1, 9000]); assert.equal(await page.locator('#album-detail-confirm').isHidden(), true); assert.match(await page.locator('#album-detail-add-status').textContent(), /200 \/ 1,105/);
    delay.release.resolve(); await page.locator('#album-detail-confirm').waitFor(); assert.deepEqual(await ids(page), [1, 9000]);
    assert.match(await page.locator('#album-detail-add-status').textContent(), /已有选择 2.*本张 1,105.*重合 1.*合并后 1,106/);
    assert.equal(callsAt(calls, '/api/tracks/selection').length, 6); assert.ok(callsAt(calls, '/api/tracks/selection').every(call => call.body.ids.length === 1105 && call.body.page_size === 200));
    assert.equal(callsAt(calls, '/api/albums/selection').length, 2); await page.locator('#album-detail-confirm').click(); await page.locator('#selection-review-dialog').waitFor();
    const selected = await ids(page); assert.equal(selected.length, 1106); assert.ok(selected.includes(9000)); assert.ok(selected.includes(1105)); assert.equal(await page.locator('#album-detail-dialog').count(), 0);
    assert.equal(writes(calls).length, 0);
  }));
  await check('Cancelling preparation rejects late selection responses without changing existing choices', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.selectionGate = delay; await page.locator('#album-detail-prepare').click(); await delay.entered.promise;
    await page.locator('#album-detail-cancel').click(); delay.release.resolve(); await flush(page);
    assert.deepEqual(await ids(page), [1, 9000]); assert.equal(await page.locator('#album-detail-confirm').isHidden(), true); assert.match(await page.locator('#album-detail-add-status').textContent(), /已取消/);
    await prepare(page); assert.deepEqual(await ids(page), [1, 9000]);
  }));
  await check('Membership changes invalidate both preparing and prepared additions', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.resolveGate = delay; await page.locator('#album-detail-prepare').click(); await delay.entered.promise;
    await page.evaluate(async () => (await import('/store.js')).removeFromSelection([9000])); delay.release.resolve(); await flush(page);
    assert.match(await page.locator('#album-detail-add-status').textContent(), /已有选择范围发生变化/); assert.equal(await page.locator('#album-detail-confirm').isHidden(), true);
    await prepare(page); await page.evaluate(async () => { const store = await import('/store.js'); const row = store.state.selection.get(1); store.clearSelection(); store.selectRows([row]); });
    assert.equal(await page.locator('#album-detail-confirm').isHidden(), true); assert.deepEqual(await ids(page), [1]);
  }));
  await check('Metadata changes alone keep a prepared addition valid while scope remains fixed', () => withPage(async ({ page }) => {
    await open(page); await prepare(page); await page.evaluate(async () => (await import('/store.js')).updateTrackSnapshot({ id: 9000, title: '更新了其他专辑标题' }, { partial: true }));
    assert.equal(await page.locator('#album-detail-confirm').isVisible(), true); await page.locator('#album-detail-confirm').click(); await page.locator('#selection-review-dialog').waitFor();
    assert.equal(await page.evaluate(async () => (await import('/store.js')).state.selection.get(9000).title), '更新了其他专辑标题');
  }));
  await check('Missing index rows or malformed IDs discard every partially resolved row', () => withPage(async ({ page, control }) => {
    await open(page); control.resolveMissing = 2; await page.locator('#album-detail-prepare').click(); await page.waitForFunction(() => document.querySelector('#album-detail-add-status').textContent.startsWith('准备失败'));
    assert.deepEqual(await ids(page), [1, 9000]); assert.equal(await page.locator('#album-detail-confirm').isHidden(), true);
    control.resolveMissing = 0; control.resolveMalformed = 3; await page.locator('#album-detail-prepare').click(); await page.waitForFunction(() => document.querySelector('#album-detail-add-status').textContent.includes('身份或所属专辑'));
    assert.deepEqual(await ids(page), [1, 9000]); control.resolveMalformed = 0; await prepare(page);
  }));
  await check('Duplicate complete-ID responses and cross-group page rows fail validation', () => withPage(async ({ page, control }) => {
    await open(page); control.selectionMalformed = true; await page.locator('#album-detail-prepare').click(); await page.waitForFunction(() => document.querySelector('#album-detail-add-status').textContent.startsWith('准备失败'));
    assert.deepEqual(await ids(page), [1, 9000]); control.detailMalformed = true; await page.locator('#album-detail-refresh').click(); await page.locator('#album-detail-retry').waitFor();
    assert.equal(await page.locator('.ad-track').count(), 0); assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true);
  }));
  await check('A final album revision check catches changes during multi-page resolution', () => withPage(async ({ page, control, calls }) => {
    await open(page); control.finalConflict = true; await page.locator('#album-detail-prepare').click(); await page.waitForFunction(() => document.querySelector('#album-detail-add-status').textContent.startsWith('准备失败'));
    assert.equal(callsAt(calls, '/api/tracks/selection').length, 6); assert.deepEqual(await ids(page), [1, 9000]); assert.equal(await page.locator('#album-detail-confirm').isHidden(), true);
    assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true); assert.match(await page.locator('#album-detail-status').textContent(), /已失效/);
  }));
  await check('Closing detail during a late page or preparation cannot populate a new dialog', () => withPage(async ({ page, control }) => {
    const detail = gate(); control.detailGate = detail; await page.locator('.album-art-open').first().click(); await detail.entered.promise;
    await page.locator('#album-detail-close').click(); await open(page, 1); detail.release.resolve(); await flush(page); assert.equal(await page.locator('.ad-artist').textContent(), '另一位歌手');
    await page.locator('#album-detail-close').click(); await open(page); const resolve = gate(); control.resolveGate = resolve;
    await page.locator('#album-detail-prepare').click(); await resolve.entered.promise; await page.locator('#album-detail-close').click(); resolve.release.resolve(); await flush(page);
    assert.deepEqual(await ids(page), [1, 9000]); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
  }));
  await check('Session expiry discards pending additions and all sensitive selections', () => withPage(async ({ page, control }) => {
    await open(page); const delay = gate(); control.resolveGate = delay; await page.locator('#album-detail-prepare').click(); await delay.entered.promise;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized'))); delay.release.resolve(); await flush(page);
    assert.equal(await page.locator('#album-detail-dialog').count(), 0); assert.equal(await page.locator('#selection-review-dialog').count(), 0); assert.deepEqual(await ids(page), []);
  }));
  await check('Unavailable covers retry on explicit refresh and absent groups show an explicit error', () => withPage(async ({ page, control, calls }) => {
    control.coverError = true; await open(page); await page.waitForFunction(() => document.querySelector('#album-detail-art').dataset.state === 'failed');
    assert.equal(await page.locator('.ad-track').count(), 100); assert.equal(await page.locator('#album-detail-prepare').isDisabled(), false); assert.match(await page.locator('#album-detail-art').textContent(), /封面暂不可用/);
    control.coverError = false; await page.locator('#album-detail-refresh').click(); await page.waitForFunction(() => document.querySelector('#album-detail-art').dataset.state === 'loaded');
    assert.equal(calls.filter(call => call.query.size === '512').length, 2);
    control.detailError = { status: 404, text: '专辑分组不存在' }; await page.locator('#album-detail-refresh').click(); await page.locator('#album-detail-retry').waitFor();
    assert.match(await page.locator('#album-detail-status').textContent(), /专辑分组不存在/); assert.equal(await page.locator('#album-detail-prepare').isDisabled(), true);
  }));
  await check('Album track labels remain plain text and Escape returns focus to the cover', () => withPage(async ({ page, rows }) => {
    rows[0].title = '<img src=x onerror=alert(1)>'; await open(page); assert.equal(await page.locator('.ad-track img').count(), 0); assert.match(await page.locator('.ad-track').first().textContent(), /<img src=x/);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#album-detail-dialog').count(), 0); assert.equal(await page.evaluate(() => document.activeElement.classList.contains('album-art-open')), true);
  }));
  await check('Long album and artist names stay fully accessible without pushing controls off short screens', async () => {
    for (const [width, height] of [[320, 568], [844, 390]]) await withPage(async ({ page, rows }) => {
      const longAlbum = '专辑长标题'.repeat(800), longArtist = '专辑艺术家'.repeat(800);
      await page.evaluate(async item => (await import('/album-detail.js')).openAlbumDetail(item), summary(rows, { album: longAlbum, album_artist: longArtist }));
      await page.waitForSelector('[data-album-track-id="1"]');
      assert.equal(await page.locator('#album-detail-title').textContent(), longAlbum); assert.equal(await page.locator('.ad-artist').textContent(), longArtist);
      const layout = await page.evaluate(() => {
        const overview = document.querySelector('.ad-overview'), list = document.querySelector('#album-detail-list'), footer = document.querySelector('.ad-footer');
        return { overviewScroll: overview.scrollHeight > overview.clientHeight, listHeight: list.clientHeight, footerBottom: footer.getBoundingClientRect().bottom, viewport: innerHeight,
          overflow: document.documentElement.scrollWidth > innerWidth, overviewWidth: overview.clientWidth, overviewContent: overview.scrollWidth };
      });
      assert.equal(layout.overviewScroll, true); assert.ok(layout.listHeight >= 70, JSON.stringify(layout)); assert.ok(layout.footerBottom <= height); assert.equal(layout.overflow, false); assert.equal(layout.overviewWidth, layout.overviewContent);
      await page.screenshot({ path: path.join(out, `album-detail-long-${width}-${height}.png`) });
    }, { viewport: { width, height } });
  });
  await check('Album detail and prepared scope remain reachable across desktop and short mobile screens', async () => {
    for (const [width, height, theme] of [[1440, 950, 'light'], [1440, 950, 'dark'], [390, 844, 'light'], [320, 568, 'dark'], [844, 390, 'dark']]) await withPage(async ({ page }) => {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await open(page); await prepare(page);
      const dimensions = await page.evaluate(() => {
        const dialog = document.querySelector('#album-detail-dialog'), list = document.querySelector('#album-detail-list'), pager = document.querySelector('.ad-pager'), footer = document.querySelector('.ad-footer');
        const before = [pager.getBoundingClientRect().top, footer.getBoundingClientRect().top]; list.scrollTop = 80;
        return { bottom: dialog.getBoundingClientRect().bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
          listHeight: list.clientHeight, scrollable: list.scrollHeight > list.clientHeight, width: list.clientWidth, contentWidth: list.scrollWidth,
          stable: before.every((value, index) => value === [pager.getBoundingClientRect().top, footer.getBoundingClientRect().top][index]), animation: getComputedStyle(dialog).animationName };
      });
      await page.screenshot({ path: path.join(out, `album-detail-${width}-${height}-${theme}.png`) });
      assert.equal(dimensions.overflow, false); assert.ok(dimensions.bottom <= height); assert.ok(dimensions.listHeight >= 70, JSON.stringify(dimensions)); assert.equal(dimensions.scrollable, true);
      assert.equal(dimensions.width, dimensions.contentWidth); assert.equal(dimensions.stable, true); assert.equal(dimensions.animation, 'none');
      const confirm = await page.locator('#album-detail-confirm').boundingBox(); assert.ok(confirm.y >= 0 && confirm.y + confirm.height <= height);
      await page.locator('#album-detail-cancel').click(); assert.equal(await page.locator('#album-detail-prepare').isVisible(), true);
    }, { viewport: { width, height }, colorScheme: theme });
  });
  console.log(`\n${passed} album detail checks passed; ${failures.length} failed.`); if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
