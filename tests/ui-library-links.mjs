/** Library artist/album navigation and selection-sized scraper handoff. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { revealSelectionActions } from './ui-library-controls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview'), require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Existing local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_LINKS_UI_PORT || 18991), base = `http://127.0.0.1:${port}`;
const composite = '周杰伦 & A-Lin / 五月天; 合作计划', albumName = '相同专辑名称';
const trim = value => String(value || '').replace(/^ +| +$/g, '');
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rowsOf = (count = 106) => Array.from({ length: count }, (_, index) => {
  const id = index + 1;
  const special = [
    { artist: composite, album: albumName, albumartist: '  唱片艺术家甲  ' },
    { artist: composite, album: '另张专辑', albumartist: '联合演出' },
    { artist: '另一位曲目歌手', album: albumName, albumartist: '唱片艺术家乙' },
    { artist: '曲目歌手回退', album: albumName, albumartist: '   ' },
    { artist: '', album: '', albumartist: '' },
    { artist: '   ', album: '   ', albumartist: '' },
    { artist: `前缀 ${composite}`, album: '不同专辑', albumartist: '' },
  ][index] || { artist: `普通歌手 ${id}`, album: `普通专辑 ${id}`, albumartist: '' };
  return { id, title: `库内曲目 ${id}`, ...special, filename: `${id}.flac`, ext: 'flac', dir: '/fixture-music/链接', path: `/fixture-music/链接/${id}.flac`,
    track: String(id), disc: '1', year: '2026', genre: 'Pop', language: '中文', albumtype: '专辑', duration: 180, size: 100000,
    has_cover: 0, has_lyrics: 0, tags_loaded: true, path_derived: false, indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000 };
});
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_LINKS_UI_CHECK && !name.includes(process.env.METATIDY_LINKS_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const callsFor = (calls, path) => calls.filter(call => call.path === path);
function albumDetail(group, rows) {
  const items = rows.filter(row => trim(row.album) === group[0] && (trim(row.albumartist) || trim(row.artist)) === group[1]);
  return { group, summary: { album: group[0], album_artist: group[1], track_count: items.length, disc_count: 1, duration: items.length * 180, bytes: items.length * 100000,
    missing_cover: items.length, missing_lyrics: items.length, not_loaded: 0, cover_track_id: null, year: '2026', indexed_at: 1700000000 },
    revision: createHash('md5').update(JSON.stringify(items)).digest('hex'), total: items.length, page: 1, page_size: 100, pages: 1, items };
}
async function withPage(action, { view = 'list', viewport = { width: 1440, height: 1000 }, colorScheme = 'light', long = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' }), page = await context.newPage(), calls = [], errors = [], rows = rowsOf();
  if (long) Object.assign(rows[0], { artist: '很长的合作歌手 名称与符号 & / ; '.repeat(25), album: '很长的专辑名称 现场纪念版 '.repeat(35), albumartist: '专辑艺术家 '.repeat(25) });
  page.setDefaultTimeout(10000);
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), call = { path: url.pathname, method: req.method(), query: Object.fromEntries(url.searchParams), body: req.postData() ? req.postDataJSON() : {} };
    calls.push(call);
    if (call.path === '/api/tracks') {
      let matches = [...rows];
      if (call.query.artist) matches = matches.filter(row => row.artist === call.query.artist);
      if (call.query.q) matches = matches.filter(row => `${row.title} ${row.artist} ${row.album}`.includes(call.query.q));
      if (call.query.album_group) { const group = JSON.parse(call.query.album_group); matches = matches.filter(row => trim(row.album) === group[0] && (trim(row.albumartist) || trim(row.artist)) === group[1]); }
      const size = Number(call.query.page_size) || 100, pages = Math.max(1, Math.ceil(matches.length / size)), number = Math.min(pages, Math.max(1, Number(call.query.page) || 1));
      return route.fulfill({ json: { items: matches.slice((number - 1) * size, number * size), total: matches.length, page: number, page_size: size, pages } });
    }
    if (call.path === '/api/albums/detail') return route.fulfill({ json: albumDetail(JSON.parse(call.query.album_group), rows) });
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base); await page.locator('#tracks-tbody tr[data-id]').first().waitFor();
    if (view === 'cards') { await page.locator('#view-cards').click(); await page.locator('#tracks-grid .track-card').first().waitFor(); }
    await flush(page); await action({ page, context, rows, calls, view });
    assert.deepEqual(errors, [], 'Library navigation must not raise browser errors');
    assert.deepEqual(calls.filter(call => !['GET', 'HEAD'].includes(call.method)), [], 'Navigation and scraper handoff must not search, scan or write automatically');
    assert.equal(calls.some(call => call.path.endsWith('/audio')), false, 'Artist and album links must not start playback');
  } finally { await context.close(); }
}
async function selection(page) { return page.evaluate(async () => { const store = await import('/store.js'); return { ids: store.selectionIds(), rows: store.selectionRows(), revision: store.selectionRevision() }; }); }
async function seed(page, rows) { await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, rows); }
const container = (page, view, id) => page.locator(view === 'cards' ? `#tracks-grid .track-card[data-id="${id}"]` : `#tracks-tbody tr[data-id="${id}"]`);
const artistLink = (page, view, id) => container(page, view, id).locator(`[data-library-artist="${id}"]:visible`);
const albumLink = (page, view, id) => container(page, view, id).locator(`[data-library-album="${id}"]:visible`);
async function settled(page) { await page.waitForFunction(async () => !(await import('/store.js')).state.tracks.loading); await flush(page); }
async function scope(page) { return page.evaluate(async () => { const { state } = await import('/store.js'); return { q: state.tracks.q, page: state.tracks.page, filters: { ...state.tracks.filters }, current: state.currentTrackId }; }); }
async function setupConflicts(page) {
  await page.evaluate(async () => {
    const { state } = await import('/store.js');
    Object.assign(state.tracks, { q: '旧关键词', page: 9 });
    Object.assign(state.tracks.filters, { folder: '/fixture-music/旧目录', folder_recursive: false, album_group: JSON.stringify(['旧专辑', '旧艺术家']), artist: '旧艺术家', album: '旧专辑',
      language: '日文', albumtype: '单曲', genre: 'Jazz', year: '1999', missing_cover: true, missing_lyrics: true, no_artist: true, no_album: true, not_loaded: true });
    for (const [id, value] of Object.entries({ 'tracks-q': '旧关键词', 'filter-artist': '旧艺术家', 'filter-album': '旧专辑', 'filter-genre': 'Jazz', 'filter-year': '1999' })) document.getElementById(id).value = value;
  });
}
async function accessibleLink(page, link) {
  assert.equal(await link.count(), 1); assert.equal(await link.getAttribute('type'), 'button');
  await link.scrollIntoViewIfNeeded(); await link.focus();
  const result = await link.evaluate(node => {
    const rect = node.getBoundingClientRect(); return { focus: document.activeElement === node, width: rect.width, height: rect.height,
      hit: document.elementFromPoint(rect.left + Math.min(rect.width / 2, node.clientWidth / 2), rect.top + rect.height / 2)?.closest('button') === node,
      label: node.getAttribute('aria-label') || node.textContent, title: node.title };
  });
  assert.ok(result.focus && result.width > 0 && result.height > 0 && result.hit && result.label.trim(), JSON.stringify(result));
}
async function scraperState(page) { return page.evaluate(async () => { const { state, currentTrackRow } = await import('/store.js'); return { tab: state.tab, id: state.currentTrackId, row: currentTrackRow(), focus: document.activeElement.id, batch: document.activeElement.matches('input[name="batch-mode"]:checked') }; }); }
async function backToTracks(page) {
  await page.evaluate(() => document.getElementById('tab-tracks').click()); await page.waitForFunction(() => document.body.dataset.page === 'tracks'); await settled(page);
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Library links fixture timeout')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); }); server.on('error', reject);
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Artist links clear conflicting scopes, retain composite artist text and preserve all selected snapshots', async () => {
    for (const view of ['list', 'cards']) await withPage(async ({ page, rows, calls }) => {
      await seed(page, [rows[1], { ...rows[105], title: '离页保留的已选快照' }]); const before = await selection(page);
      await setupConflicts(page); const prior = callsFor(calls, '/api/tracks').length;
      await artistLink(page, view, 1).click(); await settled(page);
      const current = await scope(page); assert.equal(current.q, ''); assert.equal(current.page, 1); assert.equal(current.filters.artist, composite);
      for (const [key, value] of Object.entries(current.filters)) if (key !== 'artist') assert.equal(value, key === 'folder_recursive' ? true : typeof value === 'boolean' ? false : '', key);
      assert.equal(callsFor(calls, '/api/tracks').length, prior + 1); const query = callsFor(calls, '/api/tracks').at(-1).query;
      assert.equal(query.artist, composite); assert.ok(!query.q && !query.album_group && !query.folder && !query.album);
      assert.equal(await container(page, view, 1).count(), 1); assert.equal(await container(page, view, 2).count(), 1); assert.equal(await container(page, view, 7).count(), 0);
      assert.deepEqual(await selection(page), before); assert.equal(await page.locator('#track-detail-dialog').count(), 0);
      assert.equal(await page.locator('#filter-artist').inputValue(), composite); assert.equal(await page.locator('#tracks-q').inputValue(), '');
    }, { view });
  });

  await check('Artist links preserve actual selections made across library pages', () => withPage(async ({ page, rows, calls }) => {
    await container(page, 'list', 1).locator('input[type="checkbox"]').check();
    await page.locator('#tracks-pager input.jump').fill('2'); await page.locator('#tracks-pager input.jump').press('Enter'); await page.locator('#tracks-tbody tr[data-id="101"]').waitFor();
    await container(page, 'list', 106).locator('input[type="checkbox"]').check();
    const before = await selection(page); assert.deepEqual(before.ids, [1, 106]);
    await page.locator('#tracks-pager input.jump').fill('1'); await page.locator('#tracks-pager input.jump').press('Enter'); await page.locator('#tracks-tbody tr[data-id="1"]').waitFor();
    await artistLink(page, 'list', 1).click(); await settled(page); assert.deepEqual(await selection(page), before);
    assert.equal(callsFor(calls, '/api/tracks').at(-1).query.artist, rows[0].artist);
  }));

  await check('Album links resolve exact same-name groups with albumartist priority and artist fallback', async () => {
    for (const view of ['list', 'cards']) await withPage(async ({ page, rows, calls }) => {
      await seed(page, [rows[105]]); const before = await selection(page), prior = await scope(page);
      for (const [id, artist] of [[1, '唱片艺术家甲'], [3, '唱片艺术家乙'], [4, '曲目歌手回退']]) {
        await albumLink(page, view, id).click(); await page.locator('#album-detail-dialog[open]').waitFor();
        await page.waitForFunction(() => document.getElementById('album-detail-list').getAttribute('aria-busy') === 'false');
        assert.deepEqual(JSON.parse(callsFor(calls, '/api/albums/detail').at(-1).query.album_group), [albumName, artist]);
        assert.equal(await page.locator('#album-detail-title').textContent(), albumName); assert.equal(await page.locator('.ad-artist').textContent(), artist);
        assert.equal(await page.locator('.ad-track').count(), 1); assert.equal(await page.locator('.ad-track').getAttribute('data-album-track-id'), String(id));
        assert.deepEqual(await selection(page), before); assert.deepEqual(await scope(page), prior);
        await page.locator('#album-detail-close').click(); await page.locator('#album-detail-dialog').waitFor({ state: 'detached' });
      }
    }, { view });
  });

  await check('Empty artist and album values remain noninteractive placeholders', async () => {
    for (const view of ['list', 'cards']) await withPage(async ({ page }) => {
      for (const id of [5, 6]) {
        assert.equal(await container(page, view, id).locator('[data-library-artist]').count(), 0);
        assert.equal(await container(page, view, id).locator('[data-library-album]').count(), 0);
      }
    }, { view });
  });

  await check('Keyboard activation navigates artist and album links without selecting their tracks', async () => {
    for (const view of ['list', 'cards']) await withPage(async ({ page, rows, calls }) => {
      await seed(page, [rows[105]]); const before = await selection(page);
      await accessibleLink(page, albumLink(page, view, 1)); await page.keyboard.press('Enter'); await page.locator('#album-detail-dialog[open]').waitFor();
      assert.deepEqual(await selection(page), before); await page.locator('#album-detail-close').click();
      await accessibleLink(page, artistLink(page, view, 1)); await page.keyboard.press('Space'); await settled(page);
      assert.equal(callsFor(calls, '/api/tracks').at(-1).query.artist, composite); assert.deepEqual(await selection(page), before);
      assert.equal(await container(page, view, 1).locator('input[type="checkbox"]').isChecked(), false);
    }, { view });
  });

  await check('Selection footer changes 1 to 2 to 1 labels and routes single and batch scraping correctly', async () => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await withPage(async ({ page, rows, calls }) => {
      await container(page, 'list', 1).locator('input[type="checkbox"]').check(); await revealSelectionActions(page);
      assert.equal((await page.locator('#selection-scrape').textContent()).trim(), '刮削');
      await page.locator('#selection-scrape').click(); await page.waitForFunction(() => document.activeElement.id === 'search-keyword');
      let state = await scraperState(page); assert.equal(state.tab, 'scrape'); assert.equal(state.id, 1); assert.equal(state.row.title, rows[0].title);
      assert.match(await page.locator('#cand-hidden').textContent(), /库内曲目 1/); assert.equal(await page.locator('#cand-list .cand').count(), 0);
      await backToTracks(page); await container(page, 'list', 2).locator('input[type="checkbox"]').check(); await revealSelectionActions(page);
      assert.equal((await page.locator('#selection-scrape').textContent()).trim(), '批量刮削');
      await page.locator('#selection-scrape').click(); await page.waitForFunction(() => document.activeElement.matches('input[name="batch-mode"]:checked'));
      state = await scraperState(page); assert.equal(state.batch, true); assert.deepEqual((await selection(page)).ids, [1, 2]);
      await backToTracks(page); await container(page, 'list', 1).locator('input[type="checkbox"]').uncheck(); await revealSelectionActions(page);
      assert.equal((await page.locator('#selection-scrape').textContent()).trim(), '刮削');
      await page.locator('#selection-scrape').click(); await page.waitForFunction(() => document.activeElement.id === 'search-keyword');
      assert.equal((await scraperState(page)).id, 2); assert.deepEqual((await selection(page)).ids, [2]);
      assert.equal(callsFor(calls, '/api/search').length, 0); assert.equal(callsFor(calls, '/api/scrape/batch').length, 0);
    }, { viewport });
  });

  await check('One off-page selected snapshot opens the same current track without a library lookup', () => withPage(async ({ page, rows, calls }) => {
    const snapshot = { ...rows[105], title: '跨页已有标题快照', artist: '跨页歌手快照' };
    await seed(page, [snapshot]); const before = await selection(page); await revealSelectionActions(page); await page.locator('#selection-scrape').click();
    await page.waitForFunction(() => document.activeElement.id === 'search-keyword'); const current = await scraperState(page);
    assert.equal(current.id, 106); assert.equal(current.row.title, snapshot.title); assert.equal(current.row.artist, snapshot.artist);
    assert.deepEqual(await selection(page), before); assert.equal(calls.some(call => call.path === '/api/tracks/106'), false);
  }));

  await check('Selection review labels reflect complete selection despite search and update after removal', () => withPage(async ({ page, rows }) => {
    await seed(page, [rows[0], rows[1]]); await page.locator('#selection-review').click();
    assert.match(await page.locator('#selection-review-scrape').textContent(), /批量刮削.*2/);
    await page.locator('#selection-review-q').fill('库内曲目 1'); assert.equal(await page.locator('.sr-track').count(), 1);
    assert.match(await page.locator('#selection-review-scrape').textContent(), /批量刮削.*2/);
    await page.locator('#selection-review-q').fill(''); await page.locator('.sr-remove[data-remove-id="1"]').click();
    assert.match(await page.locator('#selection-review-scrape').textContent(), /^刮削.*1/);
    await page.locator('#selection-review-scrape').click(); await page.waitForFunction(() => document.activeElement.id === 'search-keyword');
    assert.equal((await scraperState(page)).id, 2); assert.deepEqual((await selection(page)).ids, [2]);
  }));

  await check('Selection review batch handoff retains every selected row and focuses the multi-track workflow', () => withPage(async ({ page, rows }) => {
    await seed(page, [rows[0], rows[105]]); const before = await selection(page); await page.locator('#selection-review').click();
    await page.locator('#selection-review-q').fill('库内曲目 1');
    await page.locator('#selection-review-scrape').click(); await page.waitForFunction(() => document.activeElement.matches('input[name="batch-mode"]:checked'));
    assert.deepEqual(await selection(page), before); assert.equal((await scraperState(page)).batch, true);
  }));

  await check('Table, card and phone links remain reachable in both themes with long names and selection bar', async () => {
    for (const viewport of [{ width: 320, height: 480 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) for (const view of ['list', 'cards']) for (const colorScheme of ['light', 'dark']) {
      await withPage(async ({ page, rows, calls }) => {
        await seed(page, [rows[105]]); const before = await selection(page);
        await accessibleLink(page, artistLink(page, view, 1)); await accessibleLink(page, albumLink(page, view, 1));
        const geometry = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
        assert.ok(geometry.document <= geometry.width + 1, JSON.stringify(geometry));
        await page.screenshot({ path: path.join(output, `library-links-${view}-${viewport.width}x${viewport.height}-${colorScheme}.png`) });
        await albumLink(page, view, 1).click(); await page.locator('#album-detail-dialog[open]').waitFor();
        assert.deepEqual(JSON.parse(callsFor(calls, '/api/albums/detail').at(-1).query.album_group), [trim(rows[0].album), trim(rows[0].albumartist)]);
        await page.locator('#album-detail-close').click(); await artistLink(page, view, 1).click(); await settled(page);
        assert.equal(callsFor(calls, '/api/tracks').at(-1).query.artist, trim(rows[0].artist)); assert.deepEqual(await selection(page), before);
      }, { viewport, view, colorScheme, long: true });
    }
  });

  console.log(`\n${passed} library link checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
