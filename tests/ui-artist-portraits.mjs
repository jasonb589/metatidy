/** Portrait workflow acceptance: all remote services are mocked, no real music or uploads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
let browser;
let base;
let passed = 0;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const artists = [{ name: '周杰伦', track_count: 12, album_count: 3 }, { name: '王菲', track_count: 8, album_count: 2 }];
const targets = [{ id: 'nd-1', name: '周杰伦', album_count: 3, song_count: 12, mbid: 'mbid-a' }, { id: 'nd-2', name: '周杰伦', album_count: 1, song_count: 2, mbid: 'mbid-b' }];
const pageResult = (items, extra = {}) => ({ items, total: items.length, page: 1, page_size: 50, pages: 1, ...extra });
const serviceStatus = model => ({ lastfm: { busy: false, cooldown: false, retry_after_seconds: 0, retry_at: 0, reason: '', min_interval_seconds: 5, ...model.lastfm }, navidrome: { configured: model.configured, url: 'https://music.example.test', min_version: '0.61.0' }, cache_days: 7 });
const uuid = value => createHash('md5').update(String(value)).digest('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
const portraitFor = artist => ({ id: uuid(artist), artist, source_page: `https://www.last.fm/music/${encodeURIComponent(artist)}`, source_image: 'https://lastfm.freetls.fastly.net/i/u/512x512/0123456789abcdef0123456789abcdef.jpg', width: 512, height: 512, created_at: Math.floor(Date.now() / 1000), preview_url: `/api/artist-portraits/${uuid(artist)}/preview`, preview_format: 'avif', upload_format: 'jpeg' });
const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#e8ded3"/><circle cx="256" cy="185" r="87" fill="#76645c"/><path d="M95 512v-80a161 161 0 0 1 322 0v80" fill="#596e69"/></svg>';
async function check(name, action) {
  if (process.env.METATIDY_PORTRAITS_TEST_FILTER && !name.includes(process.env.METATIDY_PORTRAITS_TEST_FILTER)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
async function startFixture(port, extra = []) {
  const server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`, ...extra], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Portrait fixture did not start')), 10000);
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
  const model = { handlers: {}, calls: [], configured: true, lastfm: {}, portraits: new Map(), syncState: 'uploaded', token: 0 };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const relevant = url.pathname === '/api/artists' || url.pathname.startsWith('/api/artist-portraits/') || url.pathname.startsWith('/api/navidrome/');
    if (!relevant) return route.continue();
    const body = request.postDataJSON();
    const call = { url, method: request.method(), body };
    model.calls.push(call);
    const handler = model.handlers[`${request.method()} ${url.pathname}`] || model.handlers[url.pathname];
    if (handler) return handler({ route, url, body, call });
    if (url.pathname === '/api/artists') return route.fulfill({ json: pageResult(artists) });
    if (url.pathname === '/api/artist-portraits/status') return route.fulfill({ json: serviceStatus(model) });
    if (url.pathname === '/api/artist-portraits/fetch') {
      const portrait = portraitFor(body.artist);
      model.portraits.set(portrait.id, portrait);
      return route.fulfill({ json: { portrait, cached: false } });
    }
    if (url.pathname === '/api/navidrome/test') return route.fulfill({ json: { connected: true, user: { name: 'library-user', is_admin: false }, min_version: '0.61.0', message: '连接成功' } });
    if (url.pathname === '/api/navidrome/artists') return route.fulfill({ json: pageResult(targets) });
    if (url.pathname === '/api/artist-portraits/sync-preview') {
      const token = uuid(`token-${++model.token}`);
      return route.fulfill({ json: { token, portrait: model.portraits.get(body.portrait_id), target: targets.find(item => item.id === body.artist_id), sync_state: 'ready', expires_at: Math.floor(Date.now() / 1000) + 600, target_image_url: `/api/artist-portraits/sync/${token}/target-image` } });
    }
    if (url.pathname === '/api/artist-portraits/sync') return route.fulfill({ json: { state: 'uploading', token: body.token, message: '正在上传' } });
    if (url.pathname.endsWith('/preview') || url.pathname.endsWith('/target-image')) return route.fulfill({ contentType: 'image/svg+xml', headers: { 'Cache-Control': 'no-store' }, body: image });
    if (url.pathname.startsWith('/api/artist-portraits/sync/')) return route.fulfill({ json: { state: model.syncState, message: model.syncState === 'uploaded' ? '头像已同步' : '等待结果' } });
    return route.fulfill({ status: 404, json: { detail: 'Fixture not found' } });
  });
  try { await action({ page, context, model }); assert.deepEqual(errors, [], 'Portrait workflow must not throw browser exceptions'); }
  finally { await context.close(); }
}
async function ready(page, origin = base) {
  await page.goto(`${origin}/#artist-portraits`);
  await page.waitForFunction(() => document.querySelectorAll('.portraits-artist').length === 2 && document.querySelector('#portraits-library-list')?.getAttribute('aria-busy') === 'false');
  await page.waitForFunction(() => !document.querySelector('#portraits-test')?.disabled);
}
async function source(page, name = '周杰伦') {
  await page.locator('#portraits-artist').fill(name);
  await page.locator('#portraits-fetch').click();
  await page.locator('#portraits-preview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#portraits-fetch')?.disabled);
  await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0);
}
async function remote(page) {
  if (await page.locator('#portraits-target-q').inputValue() !== '周杰伦') await page.locator('#portraits-target-q').fill('周杰伦');
  await page.locator('#portraits-target-search').click();
  await page.waitForFunction(() => document.querySelectorAll('.portraits-target').length === 2 && document.querySelector('#portraits-target-list')?.getAttribute('aria-busy') === 'false');
}
async function selected(page) { await source(page); await remote(page); await page.locator('[data-artist-id="nd-2"]').click(); }
async function confirmation(page) { await page.locator('#portraits-sync-preview').click(); await page.locator('#portraits-confirmation').waitFor(); }
const uploads = model => model.calls.filter(call => call.url.pathname === '/api/artist-portraits/sync');
const fetches = model => model.calls.filter(call => call.url.pathname === '/api/artist-portraits/fetch');
const targetReads = model => model.calls.filter(call => call.method === 'GET' && call.url.pathname === '/api/navidrome/artists');
const localArtist = (page, name) => page.locator('.portraits-artist').filter({ has: page.locator('strong', { hasText: name }) });
async function settledTargets(page, expected = 2) {
  await page.waitForFunction(expected => document.querySelectorAll('.portraits-target').length === expected && document.querySelector('#portraits-target-list')?.getAttribute('aria-busy') === 'false', expected);
}
async function waitDeferred(pending, label) {
  let timer;
  try { await Promise.race([pending.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal page overflow');
  assert.equal(await page.locator('#artist-portraits-root').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'No portrait workspace overflow');
}

try {
  await mkdir(outputDir, { recursive: true });
  const port = Number(process.env.METATIDY_UI_PORTRAITS_PORT) || 18815;
  base = await startFixture(port);
  const authBase = await startFixture(port + 1, ['--auth']);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Entering and filtering the local singer list never fetch portraits or Navidrome data', () => withPage(async ({ page, model }) => {
    await ready(page);
    assert.equal(await page.locator('#portraits-artist').inputValue(), '');
    assert.equal(fetches(model).length, 0);
    assert.equal(model.calls.some(call => call.url.pathname.startsWith('/api/navidrome/')), false);
    assert.equal(await page.locator('#artist-portraits-root img').count(), 0);
    await page.locator('#portraits-library-q').fill('周杰伦');
    await page.locator('#portraits-library-search').click();
    await page.waitForFunction(() => document.querySelector('#portraits-library-list')?.getAttribute('aria-busy') === 'false');
    assert.equal(fetches(model).length, 0);
    assert.equal(model.calls.some(call => call.url.pathname.startsWith('/api/navidrome/')), false);
  }));

  await check('Choosing a library singer follows both names and reads candidates once without fetching or choosing an ID', () => withPage(async ({ page, model }) => {
    await ready(page);
    await localArtist(page, '周杰伦').click();
    await settledTargets(page);
    assert.equal(await page.locator('#portraits-artist').inputValue(), '周杰伦');
    assert.equal(await page.locator('#portraits-target-q').inputValue(), '周杰伦');
    assert.deepEqual(targetReads(model).map(call => call.url.searchParams.get('q')), ['周杰伦']);
    assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    assert.equal(await page.locator('#artist-portraits-root img').count(), 0);
    assert.equal(fetches(model).length, 0);
    assert.equal(model.calls.some(call => call.url.pathname === '/api/navidrome/test' || call.url.pathname === '/api/artist-portraits/sync-preview'), false);
    assert.equal(uploads(model).length, 0);
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
    await settledTargets(page);
    assert.equal(targetReads(model).length, 1, 'Fetching the selected source reuses the already searched candidates');
    assert.equal(fetches(model).length, 1);
    assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
  }));

  await check('Changing library singers clears the target and stale preflight while a late candidate response stays discarded', () => withPage(async ({ page, model }) => {
    const preflightEntered = deferred(), preflightRelease = deferred();
    const oldSearchEntered = deferred(), oldSearchRelease = deferred();
    await ready(page);
    await selected(page);
    model.handlers['/api/artist-portraits/sync-preview'] = async ({ route, body }) => {
      preflightEntered.resolve(); await preflightRelease.promise;
      return route.fulfill({ json: { token: uuid('stale-follow-preview'), portrait: model.portraits.get(body.portrait_id), target: targets[1], expires_at: Date.now() / 1000 + 600 } }).catch(() => {});
    };
    model.handlers['/api/navidrome/artists'] = async ({ route, url }) => {
      if (url.searchParams.get('q') === '王菲') {
        oldSearchEntered.resolve(); await oldSearchRelease.promise;
        return route.fulfill({ json: pageResult([{ ...targets[0], id: 'late-faye', name: 'STALE 王菲' }]) }).catch(() => {});
      }
      return route.fulfill({ json: pageResult(targets) });
    };
    try {
      await page.locator('#portraits-sync-preview').click();
      await waitDeferred(preflightEntered, 'old source preflight');
      await localArtist(page, '王菲').click();
      await waitDeferred(oldSearchEntered, 'automatic search for the next singer');
      assert.equal(await page.locator('#portraits-artist').inputValue(), '王菲');
      assert.equal(await page.locator('#portraits-target-q').inputValue(), '王菲');
      assert.equal(await page.locator('.portraits-target').count(), 0);
      assert.equal(await page.locator('#portraits-preview').isVisible(), false);
      assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
      preflightRelease.resolve();
      await localArtist(page, '周杰伦').click();
      await settledTargets(page);
      oldSearchRelease.resolve();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#portraits-target-q').inputValue(), '周杰伦');
      assert.equal(await page.locator('.portraits-target[data-artist-id="late-faye"]').count(), 0);
      assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.equal(fetches(model).length, 1, 'Changing library singers does not start another Last.fm request');
      assert.equal(uploads(model).length, 0);
    } finally { preflightRelease.resolve(); oldSearchRelease.resolve(); }
  }));

  await check('Manual source typing follows the target without requests and preserves an edited Navidrome query', () => withPage(async ({ page, model }) => {
    await ready(page);
    for (const name of ['周', '周杰', '周杰伦']) {
      await page.locator('#portraits-artist').fill(name);
      assert.equal(await page.locator('#portraits-target-q').inputValue(), name);
    }
    assert.equal(targetReads(model).length, 0);
    await page.locator('#portraits-target-q').fill('Jay Chou');
    await page.locator('#portraits-artist').fill('王菲');
    assert.equal(await page.locator('#portraits-target-q').inputValue(), 'Jay Chou');
    assert.equal(targetReads(model).length, 0);
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
    assert.equal(targetReads(model).length, 0, 'Fetching a source does not automatically submit a manually edited target query');
    await page.locator('#portraits-target-search').click();
    await settledTargets(page);
    assert.deepEqual(targetReads(model).map(call => call.url.searchParams.get('q')), ['Jay Chou']);
    await localArtist(page, '周杰伦').click();
    await settledTargets(page);
    assert.equal(await page.locator('#portraits-target-q').inputValue(), '周杰伦', 'A deliberate library selection restarts target-name following');
    assert.deepEqual(targetReads(model).map(call => call.url.searchParams.get('q')), ['Jay Chou', '周杰伦']);
    assert.equal(fetches(model).length, 1);
  }));

  await check('Fetching a manually entered source searches its untouched target once and reuses candidates on another fetch', () => withPage(async ({ page, model }) => {
    await ready(page);
    await page.locator('#portraits-artist').fill('周杰伦');
    assert.equal(targetReads(model).length, 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator('#portraits-fetch').click();
      await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
      await settledTargets(page);
      assert.equal(targetReads(model).length, 1);
    }
    await page.locator('#portraits-artist').fill('王菲');
    assert.equal(await page.locator('#portraits-target-q').inputValue(), '王菲');
    assert.equal(await page.locator('.portraits-target').count(), 0);
    assert.equal(targetReads(model).length, 1, 'Editing the source name alone does not contact Navidrome');
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
    await settledTargets(page);
    assert.deepEqual(targetReads(model).map(call => call.url.searchParams.get('q')), ['周杰伦', '王菲']);
    assert.equal(fetches(model).length, 3);
    assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
    assert.equal(uploads(model).length, 0);
  }));

  await check('Selecting singers while configuration loads searches only the latest selection after configuration succeeds', () => withPage(async ({ page, model }) => {
    const statusEntered = deferred(), statusRelease = deferred();
    model.handlers['/api/artist-portraits/status'] = async ({ route }) => {
      statusEntered.resolve(); await statusRelease.promise;
      return route.fulfill({ json: serviceStatus(model) }).catch(() => {});
    };
    try {
      await page.goto(`${base}/#artist-portraits`);
      await waitDeferred(statusEntered, 'initial configuration request');
      await page.locator('.portraits-artist').first().waitFor();
      await localArtist(page, '周杰伦').click();
      await localArtist(page, '王菲').click();
      assert.equal(await page.locator('#portraits-artist').inputValue(), '王菲');
      assert.equal(await page.locator('#portraits-target-q').inputValue(), '王菲');
      assert.equal(targetReads(model).length, 0);
      statusRelease.resolve();
      await settledTargets(page);
      assert.deepEqual(targetReads(model).map(call => call.url.searchParams.get('q')), ['王菲']);
      assert.equal(fetches(model).length, 0);
      assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
      assert.equal(uploads(model).length, 0);
    } finally { statusRelease.resolve(); }
  }));

  await check('An unconfigured Navidrome still receives the selected name locally without any remote request', () => withPage(async ({ page, model }) => {
    model.configured = false;
    await page.goto(`${base}/#artist-portraits`);
    await page.waitForFunction(() => document.querySelector('#portraits-connection')?.textContent.includes('尚未配置'));
    await localArtist(page, '王菲').click();
    assert.equal(await page.locator('#portraits-artist').inputValue(), '王菲');
    assert.equal(await page.locator('#portraits-target-q').inputValue(), '王菲');
    assert.equal(await page.locator('#portraits-target-search').isDisabled(), true);
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
    assert.equal(model.calls.some(call => call.url.pathname.startsWith('/api/navidrome/')), false);
    assert.equal(fetches(model).length, 1);
    assert.equal(uploads(model).length, 0);
  }));

  await check('Leaving cancels an in-flight candidate search and a later explicit fetch retries it once', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    let attempts = 0;
    model.handlers['/api/navidrome/artists'] = async ({ route }) => {
      if (++attempts === 1) {
        entered.resolve(); await release.promise;
        return route.fulfill({ json: pageResult([{ ...targets[0], id: 'left-page-result', name: 'STALE AFTER LEAVING' }]) }).catch(() => {});
      }
      return route.fulfill({ json: pageResult(targets) });
    };
    try {
      await ready(page);
      await localArtist(page, '周杰伦').click();
      await waitDeferred(entered, 'candidate search before leaving');
      await page.locator('#tab-settings').click();
      release.resolve();
      await page.locator('#tab-artist-portraits').click();
      await page.waitForFunction(() => !document.querySelector('#portraits-status-refresh')?.disabled);
      assert.equal(targetReads(model).length, 1, 'Returning does not automatically restart external searches');
      assert.equal(await page.locator('#portraits-target-q').inputValue(), '周杰伦');
      assert.equal(await page.locator('.portraits-target').count(), 0);
      assert.equal(fetches(model).length, 0);
      await page.locator('#portraits-fetch').click();
      await page.waitForFunction(() => document.querySelector('#portraits-preview img')?.naturalWidth > 0 && !document.querySelector('#portraits-fetch')?.disabled);
      await settledTargets(page);
      assert.equal(targetReads(model).length, 2);
      assert.equal(await page.locator('.portraits-target[data-artist-id="left-page-result"]').count(), 0);
      assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
      assert.equal(fetches(model).length, 1);
      assert.equal(uploads(model).length, 0);
    } finally { release.resolve(); }
  }));

  await check('Local paging uses indexed summaries and an edited delayed query cannot replace its successor', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handlers['/api/artists'] = async ({ route, url }) => {
      const q = url.searchParams.get('q');
      if (q === 'old') { entered.resolve(); await release.promise; return route.fulfill({ json: pageResult([{ ...artists[0], name: 'STALE' }]) }).catch(() => {}); }
      const pageNumber = Number(url.searchParams.get('page')) || 1;
      return route.fulfill({ json: pageResult(q === 'new' ? [{ ...artists[0], name: 'NEW' }] : pageNumber === 2 ? [{ ...artists[1], name: 'PAGE TWO' }] : artists, { page: pageNumber, pages: 2, total: 51 }) });
    };
    try {
      await ready(page);
      await page.locator('#portraits-library-next').click();
      await page.locator('.portraits-artist', { hasText: 'PAGE TWO' }).waitFor();
      await page.locator('#portraits-library-q').fill('old');
      await page.locator('#portraits-library-search').click();
      await entered.promise;
      await page.locator('#portraits-library-q').fill('new');
      await page.locator('#portraits-library-search').click();
      await page.locator('.portraits-artist', { hasText: 'NEW' }).waitFor();
      release.resolve();
      assert.equal(await page.locator('.portraits-artist').count(), 1);
      assert.match(await page.locator('.portraits-artist').innerText(), /NEW/);
      assert.ok(model.calls.filter(call => call.url.pathname === '/api/artists').every(call => call.url.searchParams.get('page_size') === '50'));
      assert.equal(targetReads(model).length, 0);
      assert.equal(fetches(model).length, 0);
    } finally { release.resolve(); }
  }));

  await check('Source fetching is explicit and delayed results are invalidated by name or URL edits', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handlers['/api/artist-portraits/fetch'] = async ({ route, body }) => {
      if (body.artist === 'old') { entered.resolve(); await release.promise; }
      return route.fulfill({ json: { portrait: portraitFor(body.artist), cached: true } }).catch(() => {});
    };
    try {
      await ready(page);
      await page.locator('#portraits-artist').fill('old');
      await page.locator('#portraits-fetch').click();
      await entered.promise;
      await page.locator('#portraits-artist').fill('NEW SINGER');
      await page.locator('#portraits-fetch').click();
      await page.locator('#portraits-preview h3', { hasText: 'NEW SINGER' }).waitFor();
      release.resolve();
      assert.equal(await page.locator('#portraits-preview h3').innerText(), 'NEW SINGER');
      assert.match(await page.locator('#portraits-fetch-status').innerText(), /缓存/);
      await page.locator('.portraits-manual summary').click();
      await page.locator('#portraits-image-url').fill('https://lastfm.freetls.fastly.net/i/u/abc.jpg');
      assert.equal(await page.locator('#portraits-preview').isVisible(), false);
      assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    } finally { release.resolve(); }
  }));

  await check('Manual Last.fm CDN fallback is sent only on explicit fetch and preview images stay local', () => withPage(async ({ page, model }) => {
    await ready(page);
    await page.locator('#portraits-artist').fill('手动歌手');
    await page.locator('.portraits-manual summary').click();
    const url = 'https://lastfm.freetls.fastly.net/i/u/512x512/abc.jpg';
    await page.locator('#portraits-image-url').fill(url);
    assert.equal(fetches(model).length, 0);
    await page.locator('#portraits-fetch').click();
    await page.locator('#portraits-preview img').waitFor();
    assert.deepEqual(fetches(model)[0].body, { artist: '手动歌手', image_url: url });
    const preview = new URL(await page.locator('#portraits-preview img').getAttribute('src'), base);
    assert.equal(preview.origin, new URL(base).origin);
    assert.match(await page.locator('#portraits-preview').innerText(), /AVIF.*512/);
    assert.equal(await page.locator('#portraits-preview a').count(), 2);
  }));

  await check('Last.fm source links accept both exact CDN hosts and reject lookalike domains', () => withPage(async ({ page, model }) => {
    let sourceImage = '';
    const externalRequests = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.hostname.includes('fastly')) externalRequests.push(url.href);
    });
    model.handlers['/api/artist-portraits/fetch'] = ({ route, body }) => route.fulfill({ json: { portrait: { ...portraitFor(body.artist), source_image: sourceImage }, cached: true } });
    await ready(page);
    for (const host of ['lastfm.freetls.fastly.net', 'lastfm-img.freetls.fastly.net']) {
      sourceImage = `https://${host}/i/u/770x0/0123456789abcdef0123456789abcdef.jpg`;
      await source(page, '二珂');
      assert.equal(await page.locator('#portraits-preview a').filter({ hasText: '来源图片' }).getAttribute('href'), sourceImage);
      assert.equal(await page.locator('#portraits-preview a').count(), 2);
    }
    for (const host of ['lastfm-img.freetls.fastly.net.evil.test', 'evil-lastfm-img.freetls.fastly.net', 'lastfm.freetls.fastly.net.evil.test']) {
      sourceImage = `https://${host}/i/u/770x0/0123456789abcdef0123456789abcdef.jpg`;
      await source(page, '二珂');
      assert.equal(await page.locator('#portraits-preview a').filter({ hasText: '来源图片' }).count(), 0);
      assert.equal(await page.locator('#portraits-preview a').filter({ hasText: '来源页面' }).count(), 1);
    }
    assert.deepEqual(externalRequests, [], 'Displaying source links must not fetch either CDN');
    assert.match(await page.locator('#portraits-image-url').getAttribute('placeholder'), /Last.fm 图片链接/);
  }));

  await check('429 errors enforce server cooldown for both automatic and manual inputs', () => withPage(async ({ page, model }) => {
    model.handlers['/api/artist-portraits/fetch'] = ({ route }) => {
      model.lastfm = { cooldown: true, retry_after_seconds: 120, retry_at: Math.floor(Date.now() / 1000) + 120, reason: 'Last.fm 429，请稍后重试' };
      return route.fulfill({ status: 429, json: { detail: 'Last.fm 请求过于频繁' } });
    };
    await ready(page);
    await page.locator('#portraits-artist').fill('歌手');
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-limit-status')?.textContent.includes('冷却中'));
    assert.match(await page.locator('#portraits-fetch-status').innerText(), /过于频繁/);
    assert.equal(await page.locator('#portraits-fetch').isDisabled(), true);
    await page.locator('.portraits-manual summary').click();
    await page.locator('#portraits-image-url').fill('https://lastfm.freetls.fastly.net/i/u/abc.jpg');
    assert.equal(await page.locator('#portraits-fetch').isDisabled(), true);
    assert.equal(fetches(model).length, 1);
  }));

  await check('A cooldown without an expiry keeps Last.fm locked until the service recovers', () => withPage(async ({ page, model }) => {
    model.lastfm = { cooldown: true, retry_at: null, retry_after_seconds: null, reason: 'persistence_error' };
    await ready(page);
    await page.locator('#portraits-artist').fill('歌手');
    assert.equal(await page.locator('#portraits-fetch').isDisabled(), true);
    assert.match(await page.locator('#portraits-limit-status').innerText(), /缓存目录权限/);
    model.lastfm = {};
    await page.locator('#portraits-status-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#portraits-fetch')?.disabled);
    assert.equal(fetches(model).length, 0);
  }));

  await check('Source preview failures and mismatched singer or cache URLs cannot authorize upload', () => withPage(async ({ page, model }) => {
    model.handlers[portraitFor('周杰伦').preview_url] = ({ route }) => route.fulfill({ status: 404, body: '' });
    await ready(page);
    await page.locator('#portraits-artist').fill('周杰伦');
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-fetch-status')?.textContent.includes('加载失败'));
    await remote(page);
    await page.locator('[data-artist-id="nd-2"]').click();
    assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    model.handlers['/api/artist-portraits/fetch'] = ({ route }) => route.fulfill({ json: { portrait: portraitFor('WRONG SINGER'), cached: true } });
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-fetch-status')?.textContent.includes('不一致'));
    assert.equal(await page.locator('#portraits-preview').isVisible(), false);
    model.handlers['/api/artist-portraits/fetch'] = ({ route }) => route.fulfill({ json: { portrait: { ...portraitFor('周杰伦'), preview_url: '/api/settings' }, cached: true } });
    await page.locator('#portraits-fetch').click();
    await page.waitForFunction(() => document.querySelector('#portraits-fetch-status')?.textContent.includes('数据不完整'));
    assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    assert.equal(uploads(model).length, 0);
  }));

  await check('Confirmation waits for its own source image; failed or stale loads never enable a new dialog', () => withPage(async ({ page, context, model }) => {
    const entered = deferred(), release = deferred();
    await ready(page); await selected(page);
    await page.locator('#portraits-preview img').evaluate(image => image.remove());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    model.handlers[portraitFor('周杰伦').preview_url] = async ({ route }) => { entered.resolve(); await release.promise; return route.fulfill({ contentType: 'image/svg+xml', body: image }).catch(() => {}); };
    try {
      await confirmation(page);
      await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Confirmation did not request its source image')), 3000))]);
      assert.equal(await page.getByRole('button', { name: '确认替换此歌手头像' }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await source(page, '王菲');
      await remote(page);
      await page.locator('[data-artist-id="nd-2"]').click();
      await page.locator('#portraits-preview img').evaluate(image => image.remove());
      await cdp.send('Network.clearBrowserCache');
      model.handlers[portraitFor('王菲').preview_url] = ({ route }) => route.fulfill({ status: 404, body: '' });
      await confirmation(page);
      await page.waitForFunction(() => document.querySelector('#portraits-confirmation')?.textContent.includes('来源头像加载失败'));
      release.resolve();
      assert.equal(await page.getByRole('button', { name: '确认替换此歌手头像' }).isDisabled(), true);
      await page.keyboard.press('Escape');
      delete model.handlers[portraitFor('王菲').preview_url];
      await cdp.send('Network.clearBrowserCache');
      model.handlers[`/api/artist-portraits/sync/${uuid('token-3')}/target-image`] = ({ route }) => route.fulfill({ status: 404, body: '' });
      await confirmation(page);
      await page.waitForFunction(() => !document.querySelector('dialog[open] .btn-primary')?.disabled);
      assert.equal(await page.getByRole('button', { name: '确认替换此歌手头像' }).isEnabled(), true, 'Missing old target image does not block a visible source review');
      assert.equal(uploads(model).length, 0);
    } finally { release.resolve(); }
  }));

  await check('Navidrome connection test accepts an enabled non-admin account and never runs implicitly', () => withPage(async ({ page, model }) => {
    await ready(page);
    assert.equal(model.calls.some(call => call.url.pathname === '/api/navidrome/test'), false);
    await page.locator('#portraits-test').click();
    await page.waitForFunction(() => document.querySelector('#portraits-connection')?.textContent.includes('已连接'));
    assert.match(await page.locator('#portraits-connection').innerText(), /普通账户/);
    assert.equal(model.calls.filter(call => call.url.pathname === '/api/navidrome/test').length, 1);
  }));

  await check('Target query edits discard delayed results and clear previous exact-ID selection', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handlers['/api/navidrome/artists'] = async ({ route, url }) => {
      if (url.searchParams.get('q') === 'old') { entered.resolve(); await release.promise; return route.fulfill({ json: pageResult([{ ...targets[0], name: 'STALE' }]) }).catch(() => {}); }
      return route.fulfill({ json: pageResult(targets) });
    };
    try {
      await ready(page);
      await selected(page);
      assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), false);
      await page.locator('#portraits-target-q').fill('old');
      assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
      assert.equal(await page.locator('.portraits-target').count(), 0);
      await page.locator('#portraits-target-search').click();
      await entered.promise;
      await page.locator('#portraits-target-q').fill('new');
      await page.locator('#portraits-target-search').click();
      await page.locator('[data-artist-id="nd-2"]').waitFor();
      release.resolve();
      assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
      assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
      assert.equal(await page.locator('.portraits-target', { hasText: 'STALE' }).count(), 0);
    } finally { release.resolve(); }
  }));

  await check('Same-name targets need exact manual selection and a confirmation submits one upload', () => withPage(async ({ page, model }) => {
    await ready(page);
    await source(page);
    await remote(page);
    assert.equal(await page.locator('.portraits-target[aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    await page.locator('[data-artist-id="nd-2"]').click();
    await confirmation(page);
    assert.match(await page.locator('#portraits-confirmation').innerText(), /nd-2/);
    assert.match(await page.locator('#portraits-confirmation').innerText(), /mbid-b/);
    assert.match(await page.locator('#portraits-confirmation').innerText(), /替换.*当前使用的头像/);
    assert.equal(await page.locator('#portraits-confirmation img').count(), 2);
    assert.equal(uploads(model).length, 0);
    await page.getByRole('button', { name: '确认替换此歌手头像' }).click();
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'uploaded');
    assert.equal(uploads(model).length, 1);
    const preflight = model.calls.find(call => call.url.pathname === '/api/artist-portraits/sync-preview');
    assert.equal(preflight.body.artist_id, 'nd-2');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#portraits-sync-result').evaluate(node => node === document.activeElement), true);
  }));

  await check('Pending preflight and open confirmations become unusable after source/target edits or navigation', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handlers['/api/artist-portraits/sync-preview'] = async ({ route, body }) => {
      entered.resolve(); await release.promise;
      return route.fulfill({ json: { token: 'stale-token', portrait: model.portraits.get(body.portrait_id), target: targets[1], expires_at: Math.floor(Date.now() / 1000) + 600 } }).catch(() => {});
    };
    try {
      await ready(page);
      await selected(page);
      await page.locator('#portraits-sync-preview').click();
      await entered.promise;
      await page.locator('#portraits-target-q').fill('changed');
      release.resolve();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#portraits-confirmation').count(), 0);
      delete model.handlers['/api/artist-portraits/sync-preview'];
      await remote(page);
      await page.locator('[data-artist-id="nd-2"]').click();
      await confirmation(page);
      await page.evaluate(() => { const input = document.querySelector('#portraits-artist'); input.value = 'different source'; input.dispatchEvent(new Event('input')); });
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      assert.equal(uploads(model).length, 0);
      await source(page);
      await remote(page);
      await page.locator('[data-artist-id="nd-2"]').click();
      await confirmation(page);
      await page.evaluate(() => { location.hash = '#settings'; });
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      assert.equal(uploads(model).length, 0);
    } finally { release.resolve(); }
  }));

  await check('401 closes confirmation, locks the workspace, and cannot trigger an upload', () => withPage(async ({ page, model }) => {
    await ready(page);
    await selected(page);
    await confirmation(page);
    await page.route('**/api/protected-test', route => route.fulfill({ status: 401, json: { detail: '登录已过期' } }));
    await page.evaluate(async () => { try { await (await import('/api.js')).request('/api/protected-test'); } catch { /* expected */ } });
    await page.locator('#auth-password').waitFor({ state: 'visible' });
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.app-content').evaluate(node => node.inert), true);
    assert.equal(uploads(model).length, 0);
  }));

  await check('Unknown upload results stay locked, query GET status, and survive reload without another POST', () => withPage(async ({ page, model }) => {
    model.handlers['POST /api/artist-portraits/sync'] = ({ route }) => route.abort('failed');
    model.syncState = 'uncertain';
    await ready(page);
    await selected(page);
    await confirmation(page);
    await page.getByRole('button', { name: '确认替换此歌手头像' }).click();
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'uncertain' && !document.querySelector('#portraits-sync-check')?.disabled);
    assert.equal(await page.locator('#portraits-artist').isDisabled(), true);
    assert.equal(await page.locator('#portraits-sync-preview').isDisabled(), true);
    assert.equal(await localArtist(page, '王菲').isDisabled(), true);
    assert.equal(await page.locator('#portraits-target-q').isDisabled(), true);
    const searchesBeforeLockedSelection = targetReads(model).length;
    const artistBeforeLockedSelection = await page.locator('#portraits-artist').inputValue();
    const queryBeforeLockedSelection = await page.locator('#portraits-target-q').inputValue();
    await localArtist(page, '王菲').evaluate(node => node.click());
    assert.equal(await page.locator('#portraits-artist').inputValue(), artistBeforeLockedSelection);
    assert.equal(await page.locator('#portraits-target-q').inputValue(), queryBeforeLockedSelection);
    assert.equal(targetReads(model).length, searchesBeforeLockedSelection);
    assert.equal(uploads(model).length, 1);
    assert.ok(model.calls.some(call => call.method === 'GET' && /\/sync\/[^/]+$/.test(call.url.pathname)));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'uncertain' && !document.querySelector('#portraits-sync-check')?.disabled);
    assert.equal(uploads(model).length, 1);
    model.syncState = 'uploaded';
    await page.locator('#portraits-sync-check').click();
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'uploaded');
    assert.equal(uploads(model).length, 1);
  }));

  await check('Uncertain result can only be released by explicit acknowledgment after checking Navidrome', () => withPage(async ({ page, model }) => {
    model.syncState = 'uncertain';
    await ready(page); await selected(page); await confirmation(page);
    await page.getByRole('button', { name: '确认替换此歌手头像' }).click();
    await page.locator('#portraits-sync-acknowledge').waitFor({ state: 'visible' });
    await page.locator('#portraits-sync-acknowledge').click();
    await page.getByRole('button', { name: '返回核对' }).click();
    assert.equal(await page.locator('#portraits-artist').isDisabled(), true);
    await page.locator('#portraits-sync-acknowledge').click();
    await page.getByRole('button', { name: '我已核对，结束本次' }).click();
    assert.equal(await page.locator('#portraits-artist').isDisabled(), false);
    assert.equal(uploads(model).length, 1);
    await confirmation(page);
    assert.equal(uploads(model).length, 1);
    assert.equal(model.token, 2, 'Another upload needs a newly created preview token');
  }));

  await check('Acknowledged uploading polls GET at five-second intervals and stops after success', () => withPage(async ({ page, model }) => {
    model.syncState = 'uploading';
    await page.clock.install();
    await ready(page); await selected(page); await confirmation(page);
    await page.getByRole('button', { name: '确认替换此歌手头像' }).click();
    await page.waitForFunction(() => !document.querySelector('#portraits-sync-check')?.disabled);
    const reads = () => model.calls.filter(call => call.method === 'GET' && /\/sync\/[^/]+$/.test(call.url.pathname)).length;
    assert.equal(reads(), 1);
    await page.clock.runFor(4000);
    assert.equal(reads(), 1);
    model.syncState = 'uploaded';
    await page.clock.runFor(1100);
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'uploaded');
    await page.clock.runFor(15000);
    assert.equal(reads(), 2);
    assert.equal(uploads(model).length, 1);
  }));

  await check('Target changes rejected by the backend are shown and require a new preview', () => withPage(async ({ page, model }) => {
    model.handlers['POST /api/artist-portraits/sync'] = ({ route }) => route.fulfill({ status: 409, json: { detail: '目标头像已经变化，请重新预览' } });
    model.syncState = 'failed';
    await ready(page); await selected(page); await confirmation(page);
    await page.getByRole('button', { name: '确认替换此歌手头像' }).click();
    await page.waitForFunction(() => document.querySelector('#portraits-sync-result')?.dataset.state === 'failed');
    assert.equal(uploads(model).length, 1);
    await confirmation(page);
    assert.equal(uploads(model).length, 1);
    assert.equal(model.token, 2);
  }));

  await check('Portrait deep links request no protected data before login', () => withPage(async ({ page, model }) => {
    await page.goto(`${authBase}/#artist-portraits`);
    await page.locator('#auth-password').waitFor({ state: 'visible' });
    assert.equal(model.calls.length, 0);
    await page.locator('#auth-password').fill('fixture');
    await page.locator('#auth-submit').click();
    await page.locator('.portraits-artist').first().waitFor();
    assert.equal(fetches(model).length, 0);
  }));

  await check('Unconfigured Navidrome exposes deployment hints without credential inputs or network calls', () => withPage(async ({ page, model }) => {
    model.configured = false;
    await page.goto(`${base}/#artist-portraits`);
    await page.waitForFunction(() => document.querySelector('#portraits-connection')?.textContent.includes('尚未配置'));
    assert.equal(await page.locator('#portraits-test').isDisabled(), true);
    assert.equal(await page.locator('#portraits-target-q').isDisabled(), true);
    await page.locator('#portraits-config summary').click();
    assert.match(await page.locator('#portraits-config').innerText(), /METATIDY_NAVIDROME_URL/);
    assert.match(await page.locator('#portraits-config').innerText(), /EnableArtworkUpload=false/);
    assert.equal(await page.locator('#artist-portraits-root input[type="password"]').count(), 0);
    assert.equal(model.calls.some(call => call.url.pathname.startsWith('/api/navidrome/')), false);
  }));

  await check('Portrait navigation, preview, and confirmation fit narrow screens and both themes', async () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [320, 568, 'dark']]) {
      await withPage(async ({ page }) => {
        await ready(page); await selected(page);
        await noOverflow(page);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: path.join(outputDir, `artist-portraits-${width}-${colorScheme}.png`), fullPage: true });
        await confirmation(page);
        assert.equal(await page.locator('dialog[open]').evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.getBoundingClientRect().bottom <= innerHeight && node.scrollWidth <= node.clientWidth + 1), true);
        await page.screenshot({ path: path.join(outputDir, `artist-portraits-confirm-${width}-${colorScheme}.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#portraits-sync-preview').evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#artist-portraits-root').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
        if (width < 700) {
          await page.locator('#sidebar-toggle').click();
          await page.locator('#tab-albums').click();
          await page.locator('#sidebar-toggle').click();
          await page.locator('#tab-artist-portraits').click();
        } else {
          await page.locator('#tab-albums').focus();
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator('#tab-artist-portraits').getAttribute('aria-selected'), 'true');
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator('#tab-scrape').getAttribute('aria-selected'), 'true');
        }
      }, { viewport: { width, height }, colorScheme });
    }
  });
  console.log(`\n${passed} portrait checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
