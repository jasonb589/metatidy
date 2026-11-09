/** Exact artist browsing, complete indexed statistics and nested album navigation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createArtistsFixture } from './artists-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview'), require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_ARTISTS_UI_PORT || 18993), base = `http://127.0.0.1:${port}`;
const listPath = '/api/library/artists', detailPath = `${listPath}/detail`, albumPath = '/api/albums/detail';
const mainArtist = '周杰伦 & A-Lin / 五月天; 合作计划', noAlbumArtist = '没有专辑的歌手', literalArtist = '100%_! <img src=x onerror=alert(1)> & 合作';
const trim = value => String(value || '').replace(/^ +| +$/g, '');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred(), index: -1 });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function rowsOf() {
  const row = (id, fields = {}) => ({ id, title: `收藏曲目 ${id}`, artist: mainArtist, album: `专辑 ${String(Math.floor((id - 1) / 4)).padStart(2, '0')}`,
    albumartist: '唱片艺术家', filename: `${id}.flac`, ext: 'flac', dir: '/fixture-music/艺术家', path: `/fixture-music/艺术家/${id}.flac`,
    track: String((id - 1) % 4 + 1), disc: '1', year: '2025', genre: 'Pop', language: '中文', albumtype: '专辑', duration: 180 + id % 7,
    size: 100000 + id, has_cover: 0, has_lyrics: id % 3 ? 1 : 0, tags_loaded: id % 5 !== 0, path_derived: false,
    indexed_at: 1700000000 + id, edited_at: 0, scraped_at: 0, mtime: 1700000000, ...fields });
  const rows = Array.from({ length: 112 }, (_, i) => row(i + 1, i < 8 ? { album: '同名合集', albumartist: i < 4 ? '共同唱片甲' : '共同唱片乙' } : i >= 108 ? { album: '', albumartist: '' } : {}));
  rows[0].artist = `  ${mainArtist}  `;
  rows.push(...Array.from({ length: 5 }, (_, i) => row(5001 + i, { artist: '合辑另一位歌手', album: '同名合集', albumartist: '共同唱片甲' })));
  rows.push(...Array.from({ length: 45 }, (_, i) => row(1001 + i, { artist: `Artist ${String(i + 1).padStart(3, '0')}`, album: `歌手专辑 ${i}`, albumartist: '' })));
  rows.push(row(6001, { artist: noAlbumArtist, album: '', albumartist: '' }), row(6002, { artist: noAlbumArtist, album: '   ', albumartist: '' }),
    row(6003, { artist: literalArtist }), row(6004, { artist: `\u00a0${mainArtist}\u00a0` }), row(6005, { artist: '\u0085特殊空白歌手\u0085' }),
    row(6006, { artist: 'Case Artist' }), row(6007, { artist: 'case artist' }), row(6008, { artist: '   ' }), row(6009, { artist: '' }));
  return rows;
}
function modelOf() { const rows = rowsOf(); return { rows, fixture: createArtistsFixture(rows), calls: [], workflow: [], responses: [], gates: [], allowedPosts: new Set(), server: false }; }
const callsFor = (model, stage) => model.workflow.filter(call => call.path === ({ list: listPath, detail: detailPath, album: albumPath })[stage]);
function response(model, stage, settings = {}) { model.responses.push({ stage, ...settings }); if (settings.gate) model.gates.push(settings.gate); }
async function entered(delay) {
  let timer;
  try { await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected artist request did not start')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, delay) {
  delay.release.resolve(); await delay.done.promise;
  await page.waitForFunction(index => window.artistFetchEvents[index]?.returned, delay.index); await flush(page);
}
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_ARTISTS_UI_CHECK && !name.includes(process.env.METATIDY_ARTISTS_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
async function withPage(action, { model = modelOf(), start = 'artists', ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  await page.addInitScript(paths => {
    const fetch = window.fetch.bind(window); window.artistFetchEvents = [];
    window.fetch = (input, options = {}) => {
      if (!paths.includes(new URL(typeof input === 'string' ? input : input.url, location.href).pathname)) return fetch(input, options);
      const event = { returned: false, aborted: Boolean(options.signal?.aborted) }; window.artistFetchEvents.push(event);
      options.signal?.addEventListener('abort', () => { event.aborted = true; });
      return fetch(input, { ...options, signal: undefined }).then(result => {
        const text = result.text.bind(result); result.text = async () => { const body = await text(); event.returned = true; return body; }; return result;
      });
    };
  }, [listPath, detailPath, albumPath]);
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), call = { path: url.pathname, method: req.method(), query: Object.fromEntries(url.searchParams) };
    model.calls.push(call);
    if (call.path === '/api/albums/selection' && model.preparationGate) {
      const delay = model.preparationGate; model.preparationGate = null;
      try {
        const reply = await route.fetch(); delay.entered.resolve(); await delay.release.promise;
        await route.fulfill({ response: reply });
      } finally { delay.done.resolve(); }
      return;
    }
    if (!model.server && call.path === '/api/tracks') {
      let rows = model.rows;
      if (call.query.artist_group) rows = rows.filter(row => trim(row.artist) === call.query.artist_group);
      if (call.query.no_artist) rows = rows.filter(row => !trim(row.artist));
      const size = Number(call.query.page_size) || 100, pages = Math.ceil(rows.length / size), number = Math.max(1, Math.min(Number(call.query.page) || 1, pages || 1));
      return route.fulfill({ json: { items: rows.slice((number - 1) * size, number * size), total: rows.length, page: number, page_size: size, pages } });
    }
    if (![listPath, detailPath, albumPath].includes(call.path)) return route.continue();
    const index = model.workflow.length; model.workflow.push(call);
    if (model.server) return route.continue();
    const stage = call.path === listPath ? 'list' : call.path === detailPath ? 'detail' : 'album';
    const nextIndex = model.responses.findIndex(value => value.stage === stage && (!value.when || value.when(call))), next = nextIndex < 0 ? null : model.responses.splice(nextIndex, 1)[0];
    let data, status = next?.status || 200;
    try {
      data = next?.data ?? (stage === 'album' ? model.fixture.albumDetail(url.searchParams) : model.fixture.handle(call.path, call.method, url.searchParams));
      if (next?.transform) data = next.transform(data, call);
    } catch (error) { status = error.status || 500; data = { detail: error.detail || error.message }; }
    try {
      if (next?.gate) { next.gate.index = index; next.gate.entered.resolve(); await next.gate.release.promise; }
      await route.fulfill({ status, json: data });
    } catch (error) { if (!page.isClosed() && !next?.gate) throw error; }
    finally { next?.gate?.done.resolve(); }
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/#${start}`);
    if (start === 'artists') await listPhase(page, 'ready'); else await page.locator('#tracks-tbody tr[data-id]').first().waitFor();
    await action({ page, context, model });
    assert.deepEqual(errors, [], 'Artist browsing must not raise browser errors');
    assert.deepEqual(model.calls.filter(call => !['GET', 'HEAD'].includes(call.method) && !model.allowedPosts.has(call.path)), [], 'Artist browsing cannot automatically search, scan or write');
    assert.deepEqual(model.calls.filter(call => /^\/api\/tracks\/\d+(?:\/(?:audio|lyrics))?$/.test(call.path)), [], 'Artist browsing uses index summaries only, never audio/tag/lyrics reads');
    assert.deepEqual(model.calls.filter(call => call.path.startsWith('/api/artist-portraits/') || call.path.startsWith('/api/navidrome/')), [], 'Artist browsing must not fetch remote portraits or use Navidrome');
  } finally { for (const delay of model.gates) delay.release.resolve(); await context.close(); }
}
async function listPhase(page, phase) { await page.waitForFunction(phase => document.getElementById('artists-root')?.dataset.phase === phase, phase); }
async function detailPhase(page, phase = 'ready', section = null) { await page.waitForFunction(({ phase, section }) => { const node = document.getElementById('artist-detail-dialog'); return node?.dataset.phase === phase && (!section || node.dataset.view === section); }, { phase, section }); }
const artistCard = (page, name) => page.locator(`.artist-card[data-artist-name=${JSON.stringify(name)}]`);
async function search(page, text) { await page.locator('#artists-q').fill(text); await page.locator('#artists-q').press('Enter'); await listPhase(page, 'ready'); }
async function openDetail(page, name = mainArtist) { await search(page, name); await artistCard(page, name).locator('.artist-open').click(); await detailPhase(page); }
async function section(page, name) { await page.locator(`#artist-detail-${name}-tab`).click(); await detailPhase(page, 'ready', name); }
async function seed(page, rows) { await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, rows); }
async function selected(page) { return page.evaluate(async () => { const store = await import('/store.js'); return { ids: store.selectionIds(), rows: store.selectionRows(), revision: store.selectionRevision() }; }); }
async function closeDetail(page) { await page.locator('#artist-detail-close').click(); await page.locator('#artist-detail-dialog').waitFor({ state: 'detached' }); }
async function validFocus(page, selector = '#artist-detail-dialog') {
  assert.equal(await page.evaluate(selector => { const active = document.activeElement; return Boolean(document.querySelector(selector)?.contains(active)) && active.getClientRects().length > 0 && !active.matches(':disabled') && !active.closest('[inert]'); }, selector), true);
}
async function motionDone(page, selector) {
  return page.locator(selector).evaluate(async node => {
    const animations = node.getAnimations({ subtree: true }), timings = animations.map(animation => { const t = animation.effect.getTiming(); return { duration: t.duration, delay: t.delay, iterations: t.iterations }; });
    if (timings.every(t => Number.isFinite(t.duration) && t.iterations === 1 && t.duration + t.delay <= 500)) await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    return { timings, running: node.getAnimations({ subtree: true }).filter(animation => ['running', 'pending'].includes(animation.playState)).length };
  });
}
async function geometry(page, selector, buttons) {
  const result = await page.locator(selector).evaluate((node, buttons) => {
    const rect = node.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, overflow: node.scrollWidth > node.clientWidth + 1, rect: rect.toJSON(),
      buttons: buttons.map(id => { const button = document.getElementById(id), box = button.getBoundingClientRect(); return { id, enabled: !button.disabled, rect: box.toJSON(), hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button }; }) };
  }, buttons);
  assert.ok(result.pageWidth <= result.width + 1 && !result.overflow && result.rect.left >= 0 && result.rect.right <= result.width + 1 && result.rect.top >= 0 && result.rect.bottom <= result.height + 1, JSON.stringify(result));
  for (const button of result.buttons) assert.ok(button.enabled && button.hit && button.rect.left >= 0 && button.rect.right <= result.width + 1 && button.rect.top >= 0 && button.rect.bottom <= result.height + 1, JSON.stringify(button));
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Artist fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Artists load lazily through a separate paginated index endpoint and preserve selection', () => withPage(async ({ page, model }) => {
    await seed(page, [model.rows[0], model.rows[111]]); const before = await selected(page);
    assert.equal(callsFor(model, 'list').length, 0); const trackReads = model.calls.filter(call => call.path === '/api/tracks').length;
    await page.evaluate(() => document.getElementById('tab-artists').click()); await listPhase(page, 'ready');
    assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 24);
    assert.deepEqual({ q: '', ...callsFor(model, 'list')[0].query }, { q: '', sort: 'name', order: 'asc', page: '1', page_size: '24' });
    assert.equal(model.calls.filter(call => call.path === '/api/tracks').length, trackReads); assert.equal(model.calls.some(call => call.path === '/api/artists'), false);
    assert.deepEqual(await selected(page), before); assert.equal(await page.locator('#artists-root img').count(), 0);
  }, { start: 'tracks' }));

  await check('Preview fixture keeps the legacy portrait artist contract unchanged', () => withPage(async ({ page, context }) => {
    const old = await (await context.request.get(`${base}/api/artists?page_size=50`)).json();
    const next = await (await context.request.get(`${base}${listPath}?q=&sort=name&order=asc&page=1&page_size=24`)).json();
    assert.ok(old.items.length > 0 && next.items.length > 0);
    assert.deepEqual(Object.keys(old.items[0]).sort(), ['album_count', 'name', 'track_count']); assert.ok(Object.hasOwn(next.items[0], 'unalbumed_count'));
    await search(page, '周杰伦'); await artistCard(page, '周杰伦').locator('.artist-open').click(); await detailPhase(page); assert.equal(await page.locator('.ard-album').count(), 3);
  }, { model: { ...modelOf(), server: true } }));

  await check('Artist pagination reaches every unique group and sort/search keep the server query explicit', () => withPage(async ({ page, model }) => {
    const names = [];
    do { names.push(...await page.locator('.artist-card').evaluateAll(nodes => nodes.filter(node => node.dataset.artistName).map(node => node.dataset.artistName))); if (await page.locator('#artists-next').isDisabled()) break; await page.locator('#artists-next').click(); await listPhase(page, 'ready'); } while (true);
    const expected = model.fixture.list(new URLSearchParams({ page_size: '100' })).items.map(item => item.name);
    assert.equal(new Set(names).size, expected.length); assert.deepEqual([...names].sort(), [...expected].sort());
    await page.locator('#artists-sort').selectOption('tracks'); await listPhase(page, 'ready'); assert.equal(callsFor(model, 'list').at(-1).query.order, 'desc');
    assert.equal(await page.locator('.artist-card-name').first().textContent(), mainArtist);
    await page.locator('#artists-order').selectOption('asc'); await listPhase(page, 'ready'); assert.equal(callsFor(model, 'list').at(-1).query.page, '1');
    await page.locator('#artists-sort').selectOption('recent'); await listPhase(page, 'ready'); assert.equal(callsFor(model, 'list').at(-1).query.sort, 'recent');
    await search(page, 'Artist 0'); assert.ok((await page.locator('.artist-card-name').allTextContents()).every(name => name.includes('Artist 0')));
  }));

  await check('Exact composite names preserve ASCII normalization, Unicode whitespace and literal query characters', () => withPage(async ({ page, model }) => {
    await search(page, mainArtist); assert.equal(await artistCard(page, mainArtist).count(), 1);
    await artistCard(page, mainArtist).locator('.artist-open').click(); await detailPhase(page);
    assert.equal(callsFor(model, 'detail').at(-1).query.artist_group, mainArtist); assert.equal(model.fixture.summary(mainArtist).track_count, 112); await closeDetail(page);
    const unicode = `\u00a0${mainArtist}\u00a0`; assert.equal(await artistCard(page, unicode).count(), 1);
    await artistCard(page, unicode).locator('.artist-open').click(); await detailPhase(page); assert.equal(callsFor(model, 'detail').at(-1).query.artist_group, unicode); await closeDetail(page);
    await search(page, '100%_!'); assert.deepEqual(await page.locator('.artist-card-name').allTextContents(), [literalArtist]); assert.equal(await page.locator('#artists-list img').count(), 0);
    await search(page, 'Case Artist'); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 2);
    await search(page, '没有这个歌手'); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0); assert.match(await page.locator('#artists-status').textContent(), /没有找到/);
    await page.locator('#artists-empty-action').click(); await listPhase(page, 'ready'); assert.equal(await page.locator('#artists-q').inputValue(), '');
  }));

  await check('Detail statistics cover all tracks and both same-name album artist groups', () => withPage(async ({ page, model }) => {
    await seed(page, [model.rows[111]]); const before = await selected(page); await openDetail(page);
    const summary = model.fixture.summary(mainArtist);
    assert.deepEqual(await page.locator('#artist-detail-facts dd').allTextContents(), [String(summary.track_count), String(summary.album_count)]);
    assert.match(await page.locator('.ard-metadata').textContent(), /4 首尚未标注专辑/);
    const quality = await page.locator('.ard-quality').textContent(); for (const [field, text] of [['missing_cover', '待补封面'], ['missing_lyrics', '待补歌词'], ['not_loaded', '待读标签']]) assert.ok(quality.includes(`${text} ${summary[field]}`));
    assert.equal(await page.locator('.ard-album').count(), 24); await page.locator('#artist-detail-next').click(); await detailPhase(page);
    const same = page.locator('.ard-album').filter({ has: page.locator('.ard-album-name', { hasText: '同名合集' }) }); assert.equal(await same.count(), 2);
    assert.match(await same.filter({ has: page.locator('.ard-album-artist', { hasText: '共同唱片甲' }) }).textContent(), /本艺术家 4 首 \/ 全专辑 9 首/);
    assert.match(await same.filter({ has: page.locator('.ard-album-artist', { hasText: '共同唱片乙' }) }).textContent(), /本艺术家 4 首 \/ 全专辑 4 首/);
    assert.deepEqual(await selected(page), before);
  }));

  await check('Artist albums and tracks paginate completely under the same revision and retain section positions', () => withPage(async ({ page, model }) => {
    await openDetail(page); const revision = callsFor(model, 'detail')[0].query.revision;
    assert.ok(!revision); const albums = await page.locator('.ard-album').evaluateAll(nodes => nodes.map(node => node.dataset.albumGroup));
    await page.locator('#artist-detail-next').click(); await detailPhase(page); albums.push(...await page.locator('.ard-album').evaluateAll(nodes => nodes.map(node => node.dataset.albumGroup)));
    assert.equal(new Set(albums).size, 27); await section(page, 'tracks'); const ids = [];
    do { ids.push(...await page.locator('.ard-track').evaluateAll(nodes => nodes.map(node => Number(node.dataset.artistTrackId)))); if (await page.locator('#artist-detail-next').isDisabled()) break; await page.locator('#artist-detail-next').click(); await detailPhase(page); } while (true);
    assert.equal(ids.length, 112); assert.equal(new Set(ids).size, 112); assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 112 }, (_, i) => i + 1));
    assert.ok(callsFor(model, 'detail').slice(1).every(call => call.query.revision === model.fixture.revisionFor(mainArtist)));
    const count = callsFor(model, 'detail').length; await section(page, 'albums'); assert.equal(await page.locator('#artist-detail-page').textContent(), '2 / 2');
    await section(page, 'tracks'); assert.equal(await page.locator('#artist-detail-page').textContent(), '3 / 3'); assert.equal(callsFor(model, 'detail').length, count);
  }));

  await check('Unalbumed artists remain browsable with an empty albums section and complete tracks', () => withPage(async ({ page }) => {
    await openDetail(page, noAlbumArtist); assert.equal(await page.locator('.ard-album').count(), 0); assert.deepEqual(await page.locator('#artist-detail-facts dd').allTextContents(), ['2', '0']);
    await page.locator('#artist-detail-show-tracks').click(); await detailPhase(page, 'ready', 'tracks'); assert.equal(await page.locator('.ard-track').count(), 2); assert.equal(await page.locator('.ard-track-album').count(), 0);
  }));

  await check('Loading an artist never invents zero totals before the complete summary arrives', () => withPage(async ({ page, model }) => {
    await search(page, mainArtist); const delay = gate(); response(model, 'detail', { gate: delay });
    await artistCard(page, mainArtist).locator('.artist-open').click(); await entered(delay); await detailPhase(page, 'loading');
    assert.equal(await page.locator('#artist-detail-facts dd').count(), 0); assert.match(await page.locator('.ard-description').textContent(), /读取/);
    assert.doesNotMatch(await page.locator('#artist-detail-overview').textContent(), /0\s*首|已齐备/); assert.equal(await page.locator('#artist-detail-browse').isDisabled(), true);
    await page.locator('#artist-detail-close').focus(); await release(page, delay); await detailPhase(page); assert.equal(await page.evaluate(() => document.activeElement.id), 'artist-detail-close');
  }));

  await check('Nested albums preserve artist page, scroll, selection and focus through every normal return', async () => {
    for (const action of ['footer', 'close', 'escape', 'native']) await withPage(async ({ page, model }) => {
      await seed(page, [model.rows[111]]); const before = await selected(page); await openDetail(page); await page.locator('#artist-detail-next').click(); await detailPhase(page);
      const button = page.locator('.ard-album-open').last(); await button.scrollIntoViewIfNeeded(); await button.focus();
      const expectedGroup = JSON.parse(await button.locator('..').getAttribute('data-album-group'));
      await page.evaluate(() => { window.artistReturnButton = document.activeElement; window.artistReturnScroll = document.getElementById('artist-detail-content').scrollTop; });
      await button.click(); await page.locator('#album-detail-dialog[open]').waitFor(); assert.equal(await page.locator('#artist-detail-dialog').evaluate(node => node.inert), true);
      await page.waitForFunction(() => document.getElementById('album-detail-list').getAttribute('aria-busy') === 'false');
      assert.deepEqual(JSON.parse(callsFor(model, 'album').at(-1).query.album_group), expectedGroup);
      if (action === 'footer') await page.locator('#album-detail-return').click();
      else if (action === 'close') await page.locator('#album-detail-close').click();
      else if (action === 'escape') await page.keyboard.press('Escape');
      else await page.locator('#album-detail-dialog').evaluate(node => node.close());
      await page.locator('#album-detail-dialog').waitFor({ state: 'detached' }); assert.equal(await page.locator('#artist-detail-dialog').evaluate(node => node.inert), false);
      assert.equal(await page.locator('#artist-detail-page').textContent(), '2 / 2');
      assert.equal(await page.evaluate(() => document.activeElement === window.artistReturnButton), true);
      assert.equal(await page.evaluate(() => document.getElementById('artist-detail-content').scrollTop === window.artistReturnScroll), true);
      assert.deepEqual(await selected(page), before); await validFocus(page);
    });
  });

  await check('Track-section album navigation keeps albumartist priority and returns to the original track', () => withPage(async ({ page, model }) => {
    await openDetail(page); await section(page, 'tracks');
    const target = page.locator('.ard-track[data-artist-track-id="1"] .ard-track-album');
    if (!await target.count()) { while (!(await target.count()) && !await page.locator('#artist-detail-next').isDisabled()) { await page.locator('#artist-detail-next').click(); await detailPhase(page); } }
    await target.click(); await page.locator('#album-detail-dialog[open]').waitFor(); assert.deepEqual(JSON.parse(callsFor(model, 'album').at(-1).query.album_group), ['同名合集', '共同唱片甲']);
    await page.locator('#album-detail-return').click(); await detailPhase(page, 'ready', 'tracks'); assert.equal(await target.evaluate(node => document.activeElement === node), true);
  }));

  await check('Artist-to-library handoffs keep the precise normalized group and all existing selection snapshots', async () => {
    for (const entry of ['card', 'detail']) await withPage(async ({ page, model }) => {
      await seed(page, [{ ...model.rows[0], title: '保留旧快照' }, model.rows[111]]); const before = await selected(page); await search(page, mainArtist);
      if (entry === 'detail') { await artistCard(page, mainArtist).locator('.artist-open').click(); await detailPhase(page); await page.locator('#artist-detail-browse').click(); }
      else await artistCard(page, mainArtist).locator('.artist-browse').click();
      await page.waitForFunction(() => document.body.dataset.page === 'tracks'); await page.locator('#tracks-tbody tr[data-id]').first().waitFor();
      const call = model.calls.filter(call => call.path === '/api/tracks').at(-1); assert.equal(call.query.artist_group, mainArtist); assert.ok(!call.query.artist && !call.query.album_group && !call.query.q);
      assert.deepEqual(await selected(page), before); assert.equal(await page.locator('#artist-detail-dialog').count(), 0);
    });
  });

  await check('Nested whole-album browse and explicit additive selection close the source artist cleanly', async () => {
    for (const action of ['browse', 'select']) await withPage(async ({ page, context, model }) => {
      const tracks = (await (await context.request.get(`${base}/api/tracks`)).json()).items;
      await seed(page, [tracks.find(row => row.id === 18)]); const before = await selected(page);
      await openDetail(page, '周杰伦'); await page.locator('.ard-album-name').first().click();
      await page.waitForFunction(() => document.getElementById('album-detail-list')?.getAttribute('aria-busy') === 'false');
      if (action === 'browse') {
        await page.locator('#album-detail-view-tracks').click(); await page.waitForFunction(() => document.body.dataset.page === 'tracks');
        assert.equal(await page.locator('#artist-detail-dialog').count(), 0); assert.equal(await page.locator('#album-detail-dialog').count(), 0); assert.deepEqual(await selected(page), before);
      } else {
        model.allowedPosts.add('/api/albums/selection'); model.allowedPosts.add('/api/tracks/selection');
        await page.locator('#album-detail-prepare').click(); await page.locator('#album-detail-confirm').waitFor({ state: 'visible' });
        assert.deepEqual(await selected(page), before); await page.locator('#album-detail-confirm').click(); await page.locator('#selection-review-dialog[open]').waitFor();
        assert.equal(await page.locator('dialog[open]').count(), 1); assert.equal(await page.locator('#artist-detail-dialog').count(), 0); assert.equal(await page.locator('#album-detail-dialog').count(), 0);
        const after = await selected(page); assert.equal(after.ids[0], 18); assert.ok(after.ids.length > 1); assert.deepEqual(after.rows[0], before.rows[0]);
        assert.deepEqual([...new Set(model.calls.filter(call => call.method === 'POST').map(call => call.path))].sort(), ['/api/albums/selection', '/api/tracks/selection']);
      }
    }, { model: { ...modelOf(), server: true } });
  });

  await check('Mobile nested album preparation keeps readable controls and a usable track list in every state', async () => {
    for (const [width, height] of [[320, 480], [390, 844]]) for (const colorScheme of ['light', 'dark']) await withPage(async ({ page, context, model }) => {
      const tracks = (await (await context.request.get(`${base}/api/tracks`)).json()).items;
      await seed(page, [tracks.find(row => row.id === 18)]); const before = await selected(page);
      await openDetail(page, '周杰伦'); await page.locator('.ard-album-name').first().click();
      await page.waitForFunction(() => document.getElementById('album-detail-list')?.getAttribute('aria-busy') === 'false');
      const inspect = async state => {
        await flush(page);
        await page.screenshot({ path: path.join(output, `artists-nested-prepare-${width}x${height}-${colorScheme}-${state}.png`) });
        const enabled = ['album-detail-close', 'album-detail-return', 'album-detail-view-tracks', ...(state === 'normal' ? ['album-detail-prepare'] : ['album-detail-cancel']), ...(state === 'prepared' ? ['album-detail-confirm'] : [])];
        await geometry(page, '#album-detail-dialog', enabled);
        const layout = await page.locator('#album-detail-dialog').evaluate(node => {
          const list = node.querySelector('#album-detail-list'), footer = node.querySelector('.ad-footer');
          return { list: list.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight },
            buttons: [...node.querySelectorAll('.ad-footer-actions button')].filter(button => !button.hidden).map(button => {
              const box = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
              return { id: button.id, disabled: button.disabled, box: box.toJSON(), overflow: button.scrollWidth > button.clientWidth + 1,
                text: [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => rect.toJSON()) };
            }) };
        });
        const diagnostic = `${width}x${height} ${colorScheme} ${state}: ${JSON.stringify(layout)}`;
        assert.ok(layout.list.height >= 40 && layout.list.bottom <= layout.footer.top + 1, `The track list must retain a visible, usable reading area. ${diagnostic}`);
        assert.ok(layout.footer.bottom <= height + 1, `Footer must remain reachable without scrolling the page. ${diagnostic}`);
        assert.deepEqual(layout.buttons.map(button => button.id).sort(), [...enabled.filter(id => id !== 'album-detail-close'), ...(state === 'preparing' ? ['album-detail-prepare'] : [])].sort(), diagnostic);
        for (const button of layout.buttons) {
          assert.ok(button.box.width >= 80 && !button.overflow, `Footer labels must not collapse to one-glyph columns. ${diagnostic}`);
          assert.ok(button.box.top >= 0 && button.box.bottom <= height + 1, diagnostic);
          assert.ok(button.text.length > 0 && new Set(button.text.map(rect => Math.round(rect.top))).size <= 2, `Normal two-line wrapping is allowed. ${diagnostic}`);
          for (const text of button.text) assert.ok(text.left >= button.box.left - 1 && text.right <= button.box.right + 1 && text.top >= button.box.top - 1 && text.bottom <= button.box.bottom + 1, diagnostic);
        }
        assert.deepEqual(layout.buttons.filter(button => button.disabled).map(button => button.id), state === 'preparing' ? ['album-detail-prepare'] : [], diagnostic);
        assert.deepEqual(await selected(page), before, 'Preparing and previewing an album must preserve the existing selection');
      };
      await inspect('normal');
      model.allowedPosts.add('/api/albums/selection'); model.allowedPosts.add('/api/tracks/selection');
      const delay = gate(); model.preparationGate = delay; model.gates.push(delay);
      await page.locator('#album-detail-prepare').click(); await entered(delay); await inspect('preparing');
      delay.release.resolve(); await delay.done.promise; await page.locator('#album-detail-confirm').waitFor({ state: 'visible' }); await inspect('prepared');
      await page.locator('#album-detail-cancel').click(); await inspect('normal');
      await page.locator('#album-detail-return').click(); await detailPhase(page); await validFocus(page); assert.deepEqual(await selected(page), before);
    }, { model: { ...modelOf(), server: true }, viewport: { width, height }, colorScheme });
  });

  await check('Search whitespace normalization matches the server while exact artist identity remains unchanged', () => withPage(async ({ page, model }) => {
    await search(page, '\u0085\u3000 Artist 001 \u3000\u0085'); assert.equal(callsFor(model, 'list').at(-1).query.q, 'Artist 001');
    assert.deepEqual(await page.locator('.artist-card-name').allTextContents(), ['Artist 001']);
    await search(page, '\uFEFFArtist 001\uFEFF'); assert.equal(callsFor(model, 'list').at(-1).query.q, '\uFEFFArtist 001\uFEFF');
    assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0);
  }));

  await check('An empty artist index offers the untagged library scope without changing selection', () => withPage(async ({ page, model }) => {
    await seed(page, [model.rows[111]]); const before = await selected(page);
    for (const row of model.rows) row.artist = '';
    await page.locator('#artists-refresh').click(); await listPhase(page, 'ready'); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0);
    await page.locator('#artists-empty-action').click(); await page.waitForFunction(() => document.body.dataset.page === 'tracks');
    await page.locator('#tracks-tbody tr[data-id]').first().waitFor();
    assert.equal(model.calls.filter(call => call.path === '/api/tracks').at(-1).query.no_artist, '1'); assert.deepEqual(await selected(page), before);
  }));

  await check('Background artist refresh respects canApply and preserves the focused name when counts change', () => withPage(async ({ page, model }) => {
    await search(page, 'Artist 001'); await artistCard(page, 'Artist 001').locator('.artist-browse').focus();
    model.rows.find(row => row.artist === 'Artist 001').duration = 3600;
    await page.evaluate(async () => (await import('/artists.js')).refresh({ background: true, canApply: () => true }));
    assert.equal(await artistCard(page, 'Artist 001').locator('.artist-browse').evaluate(node => document.activeElement === node), true);
    const before = await page.locator('.artist-card').textContent(); model.rows.find(row => row.artist === 'Artist 001').duration = 7200;
    await page.evaluate(async () => (await import('/artists.js')).refresh({ background: true, canApply: () => false }));
    assert.equal(await page.locator('.artist-card').textContent(), before);
  }));

  await check('Search ABA and out-of-order replies cannot revive discarded artist results', () => withPage(async ({ page, model }) => {
    const first = gate(); response(model, 'list', { gate: first }); await page.locator('#artists-q').fill('Artist 001'); await page.locator('#artists-q').press('Enter'); await entered(first);
    await page.evaluate(() => { const q = document.getElementById('artists-q'); q.value = 'Artist 002'; q.dispatchEvent(new Event('input')); q.value = 'Artist 001'; q.dispatchEvent(new Event('input')); });
    const second = gate(); response(model, 'list', { gate: second }); await page.locator('#artists-q').press('Enter'); await entered(second);
    await release(page, first); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0);
    await release(page, second); await listPhase(page, 'ready'); assert.deepEqual(await page.locator('.artist-card-name').allTextContents(), ['Artist 001']);
  }));

  await check('Changing detail sections rejects late album replies without replacing the current tracks', () => withPage(async ({ page, model }) => {
    await search(page, mainArtist); const first = gate(); response(model, 'detail', { gate: first }); await artistCard(page, mainArtist).locator('.artist-open').click(); await entered(first);
    await section(page, 'tracks'); const ids = await page.locator('.ard-track').evaluateAll(nodes => nodes.map(node => node.dataset.artistTrackId));
    await release(page, first); await detailPhase(page, 'ready', 'tracks'); assert.deepEqual(await page.locator('.ard-track').evaluateAll(nodes => nodes.map(node => node.dataset.artistTrackId)), ids);
  }));

  await check('Malformed artist list identities, query echoes, counts and page sizes fail closed', async () => {
    for (const transform of [data => ({ ...data, q: 'wrong' }), data => ({ ...data, page_size: 25 }), data => ({ ...data, items: data.items.slice(1) }),
      data => ({ ...data, items: [data.items[0], data.items[0], ...data.items.slice(2)] }), data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, missing_cover: item.track_count + 1 }) })]) await withPage(async ({ page, model }) => {
      response(model, 'list', { transform }); await page.locator('#artists-q').fill('Artist'); await page.locator('#artists-q').press('Enter'); await listPhase(page, 'error');
      assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0); await page.locator('#artists-retry').click(); await listPhase(page, 'ready');
    });
  });

  await check('Wrong artist, section, totals, duplicate tracks and foreign album contributions cannot populate detail', async () => {
    const cases = [
      ['albums', data => ({ ...data, name: 'wrong artist' })], ['albums', data => ({ ...data, section: 'tracks' })], ['albums', data => ({ ...data, items: data.items.slice(1) })],
      ['albums', data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, artist_track_count: item.track_count + 1 }) })],
      ['tracks', data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, artist: 'foreign artist' }) })],
      ['tracks', data => ({ ...data, items: [data.items[0], data.items[0], ...data.items.slice(2)] })],
    ];
    for (const [view, transform] of cases) await withPage(async ({ page, model }) => {
      await search(page, mainArtist); if (view === 'tracks') await openDetail(page);
      response(model, 'detail', { transform });
      if (view === 'albums') await artistCard(page, mainArtist).locator('.artist-open').click(); else await page.locator('#artist-detail-tracks-tab').click();
      await detailPhase(page, 'error'); assert.equal(await page.locator('#artist-detail-list > article').count(), 0);
      await page.locator('#artist-detail-retry').click(); await detailPhase(page, 'ready', view);
    });
  });

  await check('A shared revision conflict clears both sections and requires a fresh explicit detail read', () => withPage(async ({ page, model }) => {
    await openDetail(page); await section(page, 'tracks'); const old = model.fixture.revisionFor(mainArtist);
    model.rows.find(row => row.id === 5001).title = '其他歌手使整个关联专辑版本变化';
    await page.locator('#artist-detail-next').click(); await detailPhase(page, 'stale');
    assert.equal(await page.locator('#artist-detail-list > article').count(), 0); assert.equal(await page.locator('#artist-detail-facts dd').count(), 0);
    assert.equal(await page.locator('#artist-detail-browse').isDisabled(), true);
    await page.locator('#artist-detail-albums-tab').click(); await detailPhase(page, 'stale', 'albums'); assert.equal(await page.locator('.ard-album').count(), 0);
    await page.locator('#artist-detail-retry').click(); await detailPhase(page, 'ready', 'albums');
    assert.ok(!callsFor(model, 'detail').at(-1).query.revision); assert.notEqual(model.fixture.revisionFor(mainArtist), old);
  }));

  await check('Repeated identities across pages and same-revision summary changes are rejected', async () => {
    for (const type of ['duplicate', 'summary']) await withPage(async ({ page, model }) => {
      await openDetail(page); const first = model.fixture.detail(new URLSearchParams({ artist_group: mainArtist, section: 'albums', page: '1', page_size: '24' }));
      response(model, 'detail', { transform: data => type === 'duplicate' ? { ...data, items: [first.items[0], ...data.items.slice(1)] } : { ...data, summary: { ...data.summary, missing_cover: data.summary.missing_cover - 1 } } });
      await page.locator('#artist-detail-next').click(); await detailPhase(page, type === 'summary' ? 'stale' : 'error'); assert.equal(await page.locator('.ard-album').count(), 0);
    });
  });

  await check('Read errors require manual retry and cannot turn old results into a different query', () => withPage(async ({ page, model }) => {
    await openDetail(page); response(model, 'detail', { status: 503, data: { detail: '索引暂不可用' } });
    await page.locator('#artist-detail-next').click(); await detailPhase(page, 'error'); const count = callsFor(model, 'detail').length;
    assert.equal(await page.locator('.ard-album').count(), 0); await flush(page); assert.equal(callsFor(model, 'detail').length, count);
    await page.locator('#artist-detail-retry').click(); await detailPhase(page); assert.equal(callsFor(model, 'detail').at(-1).query.page, '2');
    await closeDetail(page); response(model, 'list', { status: 503, data: { detail: '列表暂不可用' } });
    await page.locator('#artists-q').fill('Artist 001'); await page.locator('#artists-q').press('Enter'); await listPhase(page, 'error'); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0);
    await page.locator('#artists-retry').click(); await listPhase(page, 'ready'); assert.deepEqual(await page.locator('.artist-card-name').allTextContents(), ['Artist 001']);
  }));

  await check('Native close, removal and reopening reject delayed detail results', async () => {
    for (const action of ['close', 'remove', 'escape', 'reopen']) await withPage(async ({ page, model }) => {
      await search(page, mainArtist); const delay = gate(); response(model, 'detail', { gate: delay }); await artistCard(page, mainArtist).locator('.artist-open').click(); await entered(delay);
      if (action === 'escape') await page.keyboard.press('Escape');
      else await page.locator('#artist-detail-dialog').evaluate((node, action) => node[action === 'reopen' ? 'close' : action](), action);
      await page.locator('#artist-detail-dialog').waitFor({ state: 'detached' });
      if (action === 'reopen') await openDetail(page, noAlbumArtist);
      await release(page, delay);
      if (action === 'reopen') { assert.equal(await page.locator('#artist-detail-title').textContent(), noAlbumArtist); assert.deepEqual(await page.locator('#artist-detail-facts dd').allTextContents(), ['2', '0']); }
      else assert.equal(await page.locator('#artist-detail-dialog').count(), 0);
    });
  });

  await check('Hash and internal navigation discard late list, detail and nested album replies', async () => {
    for (const stage of ['list', 'detail', 'album']) for (const method of ['hash', 'tab']) await withPage(async ({ page, model }) => {
      await seed(page, [model.rows[111]]); const before = await selected(page);
      if (stage === 'album') await openDetail(page); else if (stage === 'detail') await search(page, mainArtist);
      const delay = gate(); response(model, stage, { gate: delay });
      if (stage === 'list') await page.locator('#artists-refresh').click();
      else if (stage === 'detail') await artistCard(page, mainArtist).locator('.artist-open').click();
      else await page.locator('.ard-album-open').first().click();
      await entered(delay); await page.evaluate(method => { if (method === 'hash') location.hash = '#settings'; else document.getElementById('tab-collections').click(); }, method);
      await page.waitForFunction(() => document.body.dataset.page !== 'artists'); await release(page, delay);
      assert.equal(await page.locator('#artist-detail-dialog').count(), 0); assert.equal(await page.locator('#album-detail-dialog').count(), 0); assert.deepEqual(await selected(page), before);
    });
  });

  await check('401, logout and session expiry clear artist data and close nested dialogs without restoration', async () => {
    for (const stage of ['list', 'detail', 'album']) for (const reason of ['401', 'logout', 'expired']) await withPage(async ({ page, model }) => {
      if (stage === 'album') await openDetail(page); else if (stage === 'detail') await search(page, mainArtist);
      const delay = gate(); response(model, stage, { gate: delay, ...(reason === '401' ? { status: 401, data: { detail: '会话已过期' } } : {}) });
      if (stage === 'list') await page.locator('#artists-refresh').click(); else if (stage === 'detail') await artistCard(page, mainArtist).locator('.artist-open').click(); else await page.locator('.ard-album-open').first().click();
      await entered(delay); if (reason !== '401') await page.evaluate(reason => window.dispatchEvent(new CustomEvent(reason === 'logout' ? 'metatidy:logout' : 'metatidy:unauthorized', { detail: '受控会话失效' })), reason);
      await release(page, delay); assert.equal(await page.locator('#artist-detail-dialog').count(), 0); assert.equal(await page.locator('#album-detail-dialog').count(), 0); assert.equal(await page.locator('.artist-card[data-artist-name]').count(), 0);
      if (reason !== 'logout') await page.locator('#auth-veil').waitFor({ state: 'visible' });
    });
  });

  await check('Native album return focus cannot revive an artist after synchronous navigation or expiry', async () => {
    for (const action of ['navigate', 'expired']) await withPage(async ({ page }) => {
      await openDetail(page); await page.locator('.ard-album-open').first().click(); await page.locator('#album-detail-dialog[open]').waitFor();
      await page.evaluate(action => document.querySelector('.ard-album-open').addEventListener('focus', () => { window.artistReturnBoundary = true; if (action === 'navigate') document.getElementById('tab-collections').click(); else window.dispatchEvent(new CustomEvent('metatidy:unauthorized', { detail: '焦点恢复时会话失效' })); }, { once: true }), action);
      await page.locator('#album-detail-return').click(); await page.locator('#artist-detail-dialog').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.artistReturnBoundary), true); assert.equal(await page.locator('#album-detail-dialog').count(), 0);
    });
  });

  await check('Keyboard tabs, nested focus, finite motion and reachable footer fit both themes and four sizes', async () => {
    for (const [width, height] of [[320, 480], [390, 844], [844, 390], [1440, 900]]) for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['reduce', 'no-preference']) {
      await withPage(async ({ page, model }) => {
        const long = '很长的艺术家名称 与合作者 & / '.repeat(18); for (const row of model.rows) if (trim(row.artist) === mainArtist) row.artist = long;
        await search(page, long.trim()); const listMotion = await motionDone(page, '#artists-list'); assert.equal(listMotion.running, 0);
        if (reducedMotion === 'reduce') assert.deepEqual(listMotion.timings, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await artistCard(page, long.trim()).locator('.artist-open').click(); await detailPhase(page); const motion = await motionDone(page, '#artist-detail-dialog');
        assert.equal(motion.running, 0); for (const timing of [...listMotion.timings, ...motion.timings]) assert.ok(Number.isFinite(timing.duration) && timing.iterations === 1 && timing.duration + timing.delay <= 500);
        if (reducedMotion === 'reduce') assert.deepEqual(motion.timings, []);
        await validFocus(page); await geometry(page, '#artist-detail-dialog', ['artist-detail-close', 'artist-detail-browse', 'artist-detail-next']);
        await page.locator('#artist-detail-albums-tab').focus(); await page.keyboard.press('ArrowRight'); await detailPhase(page, 'ready', 'tracks'); assert.equal(await page.evaluate(() => document.activeElement.id), 'artist-detail-tracks-tab');
        await page.keyboard.press('ArrowLeft'); await detailPhase(page, 'ready', 'albums'); await page.locator('#artist-detail-refresh').focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'artist-detail-browse');
        await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'artist-detail-refresh');
        await page.screenshot({ path: path.join(output, `artists-${width}x${height}-${colorScheme}-${reducedMotion}.png`) });
        await page.locator('.ard-album-name').first().click(); await page.locator('#album-detail-dialog[open]').waitFor();
        await page.waitForFunction(() => document.getElementById('album-detail-list').getAttribute('aria-busy') === 'false');
        await motionDone(page, '#album-detail-dialog'); await geometry(page, '#album-detail-dialog', ['album-detail-close', 'album-detail-return']); await validFocus(page, '#album-detail-dialog');
        await page.locator('#album-detail-return').click(); await validFocus(page);
      }, { viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} artist checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
