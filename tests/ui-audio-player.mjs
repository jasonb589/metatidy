/** Real browser WAV playback plus bounded failure/race fixtures; no real music or external services. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Installed local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const servers = [], failures = [];
let browser, base, authBase, passed = 0;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const audioPath = id => `/api/tracks/${id}/audio`;
async function check(name, action) {
  if (process.env.METATIDY_AUDIO_UI_CHECK && !name.includes(process.env.METATIDY_AUDIO_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
async function startFixture(port, args = []) {
  const server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Audio fixture timeout')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', reject);
  });
  return `http://127.0.0.1:${port}`;
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const model = { calls: [], handler: null, errors: [], writes: [] };
  await page.addInitScript(() => { window.audioStates = []; window.addEventListener('metatidy:audio-state', event => window.audioStates.push(event.detail)); });
  page.on('pageerror', error => model.errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) model.writes.push(url.pathname); });
  await page.route('**/api/tracks/*/audio', async route => {
    const call = { path: new URL(route.request().url()).pathname, method: route.request().method(), headers: route.request().headers() };
    model.calls.push(call);
    if (model.handler) return model.handler({ route, call });
    return route.continue();
  });
  try {
    await action({ page, context, model });
    assert.deepEqual(model.errors, [], 'Playback must not raise uncaught browser errors');
    assert.ok(model.writes.every(value => ['/api/login', '/api/logout'].includes(value)), `Playback must never mutate library data: ${model.writes}`);
  } finally { await context.close(); }
}
async function ready(page, origin = base) {
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody button[data-play-id]').length === 18);
}
async function playing(page, id) {
  await page.waitForFunction(id => {
    const audio = document.querySelector('#audio-player-media'), player = document.querySelector('#audio-player');
    return player?.dataset.state === 'playing' && player.dataset.trackId === String(id) && audio && !audio.paused && audio.readyState >= 2 && audio.duration === 12;
  }, id);
}
async function paused(page) { await page.waitForFunction(() => document.querySelector('#audio-player')?.dataset.state === 'paused' && document.querySelector('#audio-player-media')?.paused); }
async function clickPlay(page, id = 1, host = '#tracks-tbody') { await page.locator(`${host} button[data-play-id="${id}"]`).click(); }
async function reloadTracks(page) {
  if (!(await page.locator('#btn-tracks-reload').isVisible())) await page.locator('#library-tools-toggle').click();
  await page.locator('#btn-tracks-reload').click();
}
async function rangeValue(page, selector, value) { await page.locator(selector).evaluate((node, value) => { node.value = String(value); node.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function selection(page) { return page.evaluate(async () => [...(await import('/store.js')).state.selection.keys()]); }
const getCalls = model => model.calls.filter(call => call.method === 'GET');
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function waitGate(gate) { let timer; try { await Promise.race([gate.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected audio request did not start')), 5000); })]); } finally { clearTimeout(timer); } }

try {
  await mkdir(out, { recursive: true });
  const port = Number(process.env.METATIDY_AUDIO_UI_PORT) || 18936;
  base = await startFixture(port); authBase = await startFixture(port + 1, ['--auth']);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Browsing lists, cards and details never attaches a media source or requests audio before a play click', () => withPage(async ({ page, model }) => {
    await ready(page);
    assert.equal(await page.locator('#audio-player').isVisible(), false);
    assert.equal(await page.locator('audio[src]').count(), 0);
    await page.locator('#view-cards').click(); await page.locator('#tracks-grid button[data-detail-id="1"]').first().click();
    await page.locator('#track-inspector-play').waitFor();
    assert.equal(await page.locator('audio[src]').count(), 0); assert.equal(model.calls.length, 0);
    await page.keyboard.press('Escape'); await page.locator('#view-list').click();
    await reloadTracks(page); await frame(page);
    assert.equal(model.calls.length, 0); assert.equal(await page.locator('audio[src]').count(), 0);
  }));

  await check('Real WAV plays, pauses, seeks, resumes the same source and updates list state without changing selection', () => withPage(async ({ page, model }) => {
    await ready(page); await page.locator('#tracks-tbody tr[data-id="2"] input[type="checkbox"]').check();
    const selected = await selection(page);
    await clickPlay(page); await playing(page, 1);
    await page.waitForFunction(() => document.querySelector('#audio-player-media').currentTime > .2);
    assert.equal(await page.locator('#audio-player-media').getAttribute('preload'), 'none');
    assert.equal(await page.locator('#tracks-tbody [data-play-id="1"]').getAttribute('aria-label'), '暂停 晴天');
    assert.equal(await page.locator('#tracks-tbody [data-play-id="1"]').getAttribute('aria-pressed'), 'true');
    assert.ok(getCalls(model).some(call => call.path === audioPath(1) && call.headers.range?.startsWith('bytes=')), 'Native media uses the Range endpoint');
    await page.evaluate(() => { window.originalAudio = document.querySelector('#audio-player-media'); });
    await clickPlay(page); await paused(page);
    await rangeValue(page, '#audio-player-seek', 6);
    await page.waitForFunction(() => Math.abs(document.querySelector('#audio-player-media').currentTime - 6) < .2);
    assert.match(await page.locator('#audio-player-seek').getAttribute('aria-valuetext'), /0:06 \/ 0:12/);
    await clickPlay(page); await playing(page, 1);
    assert.equal(await page.evaluate(() => window.originalAudio === document.querySelector('#audio-player-media')), true);
    assert.ok(await page.locator('#audio-player-media').evaluate(node => node.currentTime >= 6));
    await page.locator('#audio-player-toggle').click(); await paused(page);
    await page.locator('#audio-player-seek').focus(); await page.keyboard.press('ArrowRight');
    assert.ok(await page.locator('#audio-player-media').evaluate(node => node.currentTime > 6));
    assert.deepEqual(await selection(page), selected);
    assert.ok((await page.evaluate(() => window.audioStates)).some(event => event.id === 1 && event.status === 'playing'));
  }));

  await check('Volume, mute and keyboard controls affect actual media including recovery from zero volume', () => withPage(async ({ page }) => {
    await ready(page); await clickPlay(page); await playing(page, 1);
    await rangeValue(page, '#audio-player-volume', 30);
    assert.equal(await page.locator('#audio-player-media').evaluate(node => node.volume), .3);
    await page.locator('#audio-player-mute').click();
    assert.equal(await page.locator('#audio-player-media').evaluate(node => node.muted), true);
    await page.locator('#audio-player-mute').click();
    assert.equal(await page.locator('#audio-player-media').evaluate(node => node.muted), false);
    await page.locator('#audio-player-mute').click();
    await rangeValue(page, '#audio-player-volume', 0); await page.locator('#audio-player-mute').click();
    assert.equal(await page.locator('#audio-player-media').evaluate(node => !node.muted && node.volume > 0), true);
    await page.locator('#audio-player-toggle').focus(); await page.keyboard.press('Space'); await paused(page);
    await page.keyboard.press('Space'); await playing(page, 1);
    await page.locator('#audio-player-volume').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#audio-player-media').evaluate(node => Math.round(node.volume * 100)), 79);
  }));

  await check('Card and inspector playback preserve selection and expose the current page queue in order', () => withPage(async ({ page, model }) => {
    await ready(page); await page.locator('#view-cards').click();
    await page.locator('#tracks-grid .track-card[data-id="3"] input').check(); const selected = await selection(page);
    await clickPlay(page, 2, '#tracks-grid'); await playing(page, 2);
    assert.equal(await page.locator('#tracks-grid [data-play-id="2"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#tracks-grid button[data-detail-id="1"]').first().click();
    await page.locator('#track-inspector-play').click(); await playing(page, 1);
    assert.equal(await page.locator('#track-inspector').count(), 0);
    const reads = getCalls(model).length;
    await page.locator('#audio-player-queue-toggle').click();
    const expected = await page.evaluate(async () => (await import('/store.js')).state.tracks.items.map(item => String(item.id)));
    assert.deepEqual(await page.locator('.ap-queue-track').evaluateAll(nodes => nodes.map(node => node.dataset.id)), expected);
    assert.equal(getCalls(model).length, reads, 'Opening a queue must never prefetch a song');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#audio-player-queue-toggle').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await selection(page), selected);
    await page.locator('#view-list').click(); assert.equal(await page.locator('#tracks-tbody [data-play-id="1"]').getAttribute('aria-pressed'), 'true');
  }));

  await check('Playback ends naturally without advancing or preloading and manual queue selection clears the old source', () => withPage(async ({ page, model }) => {
    await ready(page); await clickPlay(page); await playing(page, 1);
    await page.evaluate(() => { window.oldAudio = document.querySelector('#audio-player-media'); });
    await rangeValue(page, '#audio-player-seek', 11.7);
    await page.waitForFunction(() => document.querySelector('#audio-player')?.dataset.state === 'ended' && document.querySelector('#audio-player-media').ended);
    const reads = getCalls(model).length;
    assert.equal(await page.locator('#audio-player').getAttribute('data-track-id'), '1');
    assert.equal(getCalls(model).every(call => call.path === audioPath(1)), true);
    await page.locator('#audio-player-queue-toggle').click(); await frame(page); assert.equal(getCalls(model).length, reads);
    await page.locator('.ap-queue-track[data-id="2"]').click(); await playing(page, 2);
    assert.equal(await page.evaluate(() => window.oldAudio.paused && !window.oldAudio.hasAttribute('src') && !window.oldAudio.isConnected), true);
    assert.equal(await page.locator('.ap-queue-track[data-id="2"]').evaluate(node => node === document.activeElement), true);
    await page.locator('#audio-player-queue-close').click(); await page.locator('#audio-player-close').click();
    assert.equal(await page.locator('audio').count(), 0);
    assert.equal(await page.locator('#audio-player').isVisible(), false);
    assert.equal(await page.evaluate(() => document.body.classList.contains('audio-player-open')), false);
    assert.deepEqual((await page.evaluate(() => window.audioStates)).at(-1), { id: null, status: 'stopped' });
  }));

  await check('Playback survives tab changes and library refresh while reload never restores or autoplays a song', () => withPage(async ({ page, model }) => {
    await ready(page); await clickPlay(page); await playing(page, 1);
    await page.evaluate(() => { window.playingAudio = document.querySelector('#audio-player-media'); });
    const reads = getCalls(model).length;
    await page.locator('#tab-settings').click(); await playing(page, 1);
    await page.locator('#tab-tracks').click(); await reloadTracks(page);
    await page.waitForFunction(() => document.querySelector('#tracks-tbody [data-play-id="1"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await page.evaluate(() => window.playingAudio === document.querySelector('#audio-player-media')), true);
    assert.equal(getCalls(model).length, reads);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody button[data-play-id]').length === 18);
    assert.equal(await page.locator('audio[src]').count(), 0); assert.equal(getCalls(model).length, reads);
    assert.equal(await page.locator('#audio-player').isVisible(), false);
  }));

  await check('Switching or closing delayed native media cancels old playback and ignores late source events', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handler = async ({ route, call }) => { if (call.path === audioPath(1) && call.method === 'GET') { entered.resolve(); await release.promise; } return route.continue().catch(() => {}); };
    try {
      await ready(page); await clickPlay(page); await waitGate(entered);
      await page.evaluate(() => { window.delayedAudio = document.querySelector('#audio-player-media'); });
      await clickPlay(page, 2); await playing(page, 2);
      release.resolve(); await frame(page);
      await page.evaluate(() => { window.delayedAudio.dispatchEvent(new Event('playing')); window.delayedAudio.dispatchEvent(new Event('error')); });
      await playing(page, 2);
      assert.equal(await page.evaluate(() => window.delayedAudio.paused && !window.delayedAudio.hasAttribute('src')), true);
      assert.equal(model.calls.some(call => call.path === audioPath(1) && call.method === 'HEAD'), false);
      const pending = deferred(), complete = deferred();
      model.handler = async ({ route, call }) => { if (call.path === audioPath(3) && call.method === 'GET') { pending.resolve(); await complete.promise; } return route.continue().catch(() => {}); };
      try {
        await clickPlay(page, 3); await waitGate(pending); await page.locator('#audio-player-close').click(); complete.resolve(); await frame(page);
        assert.equal(await page.locator('audio').count(), 0); assert.equal(await page.locator('#audio-player').isVisible(), false);
        assert.equal(await page.locator('#tracks-tbody [data-play-id="3"]').getAttribute('aria-pressed'), 'false');
      } finally { complete.resolve(); }
    } finally { release.resolve(); }
  }));

  await check('Pausing a loading song cannot be undone by its late native play promise', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handler = async ({ route, call }) => { if (call.method === 'GET') { entered.resolve(); await release.promise; } return route.continue().catch(() => {}); };
    try {
      await ready(page); await clickPlay(page); await waitGate(entered); await clickPlay(page); await paused(page);
      release.resolve(); await frame(page);
      assert.equal(await page.locator('#audio-player-media').evaluate(node => node.paused), true);
      assert.equal(await page.locator('#audio-player').getAttribute('data-state'), 'paused');
      await clickPlay(page); await playing(page, 1);
    } finally { release.resolve(); }
  }));

  await check('Native decode failures use one HEAD diagnosis, explain unsupported or missing files, and never retry automatically', () => withPage(async ({ page, model }) => {
    await ready(page);
    for (const [code, expected] of [[200, /浏览器.*格式|无法解码/], [404, /不存在/], [403, /无法访问/], [415, /不支持试听/], [500, /500/]]) {
      model.handler = ({ route, call }) => call.method === 'HEAD' ? route.fulfill({ status: code, contentType: 'audio/wav', body: '' }) : route.fulfill({ contentType: 'audio/wav', body: Buffer.from('not a supported audio file') });
      const heads = model.calls.filter(call => call.method === 'HEAD').length;
      await clickPlay(page);
      await page.waitForFunction(() => document.querySelector('#audio-player')?.dataset.state === 'error');
      await page.waitForFunction(pattern => new RegExp(pattern).test(document.querySelector('#audio-player-status')?.textContent || ''), expected.source);
      assert.match(await page.locator('#audio-player-status').innerText(), expected);
      assert.equal(model.calls.filter(call => call.method === 'HEAD').length, heads + 1);
      const calls = model.calls.length; await frame(page); assert.equal(model.calls.length, calls);
      assert.equal(await page.locator('#tracks-tbody [data-play-id="1"]').getAttribute('aria-label'), '重试播放 晴天');
    }
    model.handler = null; await clickPlay(page); await playing(page, 1);
  }));

  await check('A late failed-track HEAD response cannot stop or rename the newly playing track', () => withPage(async ({ page, model }) => {
    const entered = deferred(), release = deferred();
    model.handler = async ({ route, call }) => {
      if (call.path === audioPath(1)) {
        if (call.method === 'HEAD') { entered.resolve(); await release.promise; return route.fulfill({ status: 401, body: '' }).catch(() => {}); }
        return route.fulfill({ contentType: 'audio/wav', body: 'invalid' });
      }
      return route.continue();
    };
    try {
      await ready(page); await clickPlay(page); await waitGate(entered); await clickPlay(page, 2); await playing(page, 2);
      release.resolve(); await frame(page); await playing(page, 2);
      assert.equal(await page.locator('#auth-veil').isVisible(), false);
    } finally { release.resolve(); }
  }));

  await check('Audio 401 clears the source and locks playback without automatic resume', () => withPage(async ({ page, model }) => {
    await ready(page);
    model.handler = ({ route }) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: '登录已过期' }) });
    await clickPlay(page); await page.locator('#auth-password').waitFor({ state: 'visible' });
    assert.equal(await page.locator('audio').count(), 0); assert.equal(await page.locator('#audio-player').isVisible(), false);
    const calls = model.calls.length;
    await page.evaluate(async () => (await import('/audio-player.js')).playTrack({ id: 2, title: '不得恢复' }));
    await frame(page); assert.equal(model.calls.length, calls); assert.equal(await page.locator('audio').count(), 0);
  }));

  await check('Unauthenticated calls stay silent and logout stops immediately before its HTTP response', () => withPage(async ({ page, model }) => {
    await page.goto(authBase); await page.locator('#auth-password').waitFor({ state: 'visible' });
    await page.evaluate(async () => (await import('/audio-player.js')).playTrack({ id: 1, title: '受保护' }));
    assert.equal(model.calls.length, 0); assert.equal(await page.locator('audio[src]').count(), 0);
    await page.locator('#auth-password').fill('fixture'); await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody button[data-play-id]').length === 18);
    await clickPlay(page); await playing(page, 1);
    const entered = deferred(), release = deferred();
    await page.route('**/api/logout', async route => { entered.resolve(); await release.promise; return route.continue().catch(() => {}); });
    try {
      await page.locator('#btn-logout').click(); await waitGate(entered);
      assert.equal(await page.locator('audio').count(), 0); assert.equal(await page.locator('#audio-player').isVisible(), false);
      const calls = model.calls.length;
      await page.evaluate(async () => (await import('/audio-player.js')).playTrack({ id: 2, title: '退出中' }));
      assert.equal(model.calls.length, calls);
      release.resolve(); await page.locator('#auth-password').waitFor({ state: 'visible' });
      await page.locator('#auth-password').fill('fixture'); await page.locator('#auth-submit').click();
      await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody button[data-play-id]').length === 18);
      assert.equal(await page.locator('audio[src]').count(), 0); assert.equal(model.calls.length, calls);
    } finally { release.resolve(); }
  }));

  await check('Player and queue fit both themes, long titles and 320px layouts without covering selection actions', async () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [768, 1024, 'light'], [390, 844, 'light'], [320, 568, 'dark'], [320, 480, 'dark'], [844, 390, 'dark']]) {
      await withPage(async ({ page }) => {
        await ready(page); await page.locator('#tracks-tbody tr[data-id="2"] input[type="checkbox"]').check();
        await clickPlay(page); await playing(page, 1);
        await page.screenshot({ path: path.join(out, `audio-player-playing-list-${width}-${colorScheme}.png`) });
        await page.locator('#view-cards').click(); await playing(page, 1);
        await page.screenshot({ path: path.join(out, `audio-player-playing-cards-${width}-${colorScheme}.png`) });
        await page.locator('#view-list').click();
        if (width <= 900) {
          await page.locator('#sidebar-toggle').click();
          await page.locator('#tab-settings').click(); await playing(page, 1);
          await page.locator('#sidebar-toggle').click(); await page.locator('#tab-tracks').click(); await playing(page, 1);
        }
        await page.locator('#audio-player-toggle').click(); await paused(page);
        await frame(page);
        const bounds = await page.locator('#audio-player').evaluate(node => { const b = node.getBoundingClientRect(), selection = document.querySelector('#selection-bar').getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom, top: b.top, width: node.scrollWidth, client: node.clientWidth, selectionBottom: selection.bottom, selectionTop: selection.top, animations: node.getAnimations({ subtree: true }).length, page: document.documentElement.scrollWidth }; });
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.bottom <= height + 1 && bounds.width <= bounds.client + 1 && bounds.page <= width + 1, JSON.stringify(bounds));
        assert.ok(bounds.selectionBottom <= bounds.top - 2, JSON.stringify(bounds)); assert.equal(bounds.animations, 0);
        if (width <= 700 || height <= 500) assert.ok(height - bounds.selectionTop <= 145, `Compact bottom controls exceed their space budget: ${JSON.stringify(bounds)}`);
        await page.screenshot({ path: path.join(out, `audio-player-list-${width}-${colorScheme}.png`) });
        await page.locator('#view-cards').click(); await page.screenshot({ path: path.join(out, `audio-player-cards-${width}-${colorScheme}.png`) });
        await page.locator('#audio-player-queue-toggle').click();
        assert.equal(await page.locator('#audio-player-queue').evaluate(node => { const b = node.getBoundingClientRect(); return b.top >= 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight && node.scrollWidth <= node.clientWidth + 1; }), true);
        assert.equal(await page.locator('.ap-queue-track[aria-current="true"]').evaluate(node => { const row = node.getBoundingClientRect(), list = node.closest('ol').getBoundingClientRect(); return row.top >= list.top - 1 && row.bottom <= list.bottom + 1; }), true);
        await page.screenshot({ path: path.join(out, `audio-player-queue-${width}-${colorScheme}.png`) });
        await page.keyboard.press('Escape');
        await page.locator('#tracks-grid button[data-edit-id="1"]').click();
        assert.equal(await page.locator('#edit-close').evaluate(node => { const b = node.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('#edit-drawer') !== null; }), true);
        await page.locator('#edit-close').click();
        await page.evaluate(async () => { const rows = (await import('/store.js')).state.tracks.items; (await import('/audio-player.js')).playTrack({ ...rows[0], title: '长标题与不同版本/'.repeat(50), artist: '长歌手名_'.repeat(40) }, { rows }); });
        await page.waitForFunction(() => document.querySelector('#audio-player-media')?.readyState >= 2);
        await page.locator('#audio-player-toggle').click(); await paused(page); await page.locator('#audio-player-queue-toggle').click();
        assert.equal(await page.locator('#audio-player-queue').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        await page.screenshot({ path: path.join(out, `audio-player-long-${width}-${colorScheme}.png`) });
        await page.keyboard.press('Escape'); await page.locator('#audio-player-close').click();
        assert.equal(await page.locator('#audio-player').isVisible(), false);
        assert.equal(await page.evaluate(() => document.activeElement.closest('#tracks-grid, #app-sidebar') !== null), true);
      }, { viewport: { width, height }, colorScheme });
    }
  });

  await check('Compact controls expand without replacing media, seeking, fetching audio, or changing the selection', async () => {
    for (const [width, height] of [[320, 568], [844, 390]]) await withPage(async ({ page, model }) => {
      await ready(page); await clickPlay(page); await playing(page, 1); await page.locator('#audio-player-toggle').click(); await paused(page);
      await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows(store.state.tracks.items.slice(0, 2)); window.keptAudio = document.querySelector('#audio-player-media'); });
      const selected = await selection(page), reads = model.calls.length;
      assert.equal(await page.locator('#audio-player-seek').isVisible(), false);
      assert.equal(await page.locator('#selection-edit').isVisible(), false);
      await page.locator('#audio-player-expand').click();
      assert.equal(await page.locator('#audio-player-seek').isVisible(), true);
      assert.equal(await page.locator('#audio-player-volume').isVisible(), true);
      await rangeValue(page, '#audio-player-seek', 4); await rangeValue(page, '#audio-player-volume', 27);
      await page.locator('#audio-player-seek').focus(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#audio-player-expand').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('#audio-player-seek').isVisible(), false);
      await page.locator('#selection-more-toggle').click(); await page.locator('#selection-edit').focus();
      const addedId = await page.evaluate(async () => { window.keptSelectionButton = document.activeElement; const store = await import('/store.js'); store.selectRows([store.state.tracks.items[2]]); return store.state.tracks.items[2].id; });
      assert.equal(await page.evaluate(() => document.activeElement === window.keptSelectionButton && window.keptSelectionButton.isConnected), true);
      assert.equal(await page.locator('#selection-more-toggle').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#selection-more-toggle').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('#selection-edit').isVisible(), false);
      await page.locator('#audio-player-expand').click(); await page.locator('#audio-player-volume').focus();
      await page.setViewportSize({ width: 1440, height: 1000 }); await frame(page);
      assert.equal(await page.locator('#audio-player-volume').evaluate(node => node === document.activeElement), true);
      await page.setViewportSize({ width, height }); await frame(page);
      assert.equal(await page.locator('#audio-player-expand').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.querySelector('#audio-player-media') === window.keptAudio && window.keptAudio.paused && Math.abs(window.keptAudio.currentTime - 4) < .2 && window.keptAudio.volume === .27), true);
      assert.equal(model.calls.length, reads, 'Compact expansion must not request the source again');
      assert.deepEqual(await selection(page), [...selected, addedId]);
      await page.evaluate(async () => { const store = await import('/store.js'); store.clearSelection(); store.selectRows([store.state.tracks.items[3]]); });
      assert.equal(await page.locator('#selection-more-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#selection-edit').evaluate(node => node === window.keptSelectionButton), true);
      await page.locator('#audio-player-expand').click(); await page.screenshot({ path: path.join(out, `audio-player-expanded-${width}x${height}.png`) });
    }, { viewport: { width, height }, colorScheme: 'dark' });
  });

  await check('Bottom spacing lets the last music row and pager scroll above both compact bars', async () => {
    for (const [width, height] of [[320, 480], [390, 844], [844, 390]]) await withPage(async ({ page }) => {
      await ready(page); await clickPlay(page); await playing(page, 1); await page.locator('#audio-player-toggle').click(); await paused(page);
      await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows([store.state.tracks.items[0]]); });
      const last = page.locator('#tracks-tbody tr[data-id]').last();
      await last.evaluate(node => node.scrollIntoView({ block: 'end', behavior: 'instant' })); await frame(page);
      const bounds = await last.evaluate(node => { const row = node.getBoundingClientRect(), selection = document.querySelector('#selection-bar').getBoundingClientRect(), wrap = node.closest('.table-wrap'); return { rowTop: row.top, rowBottom: row.bottom, selectionTop: selection.top, pad: getComputedStyle(document.documentElement).scrollPaddingBottom, player: getComputedStyle(document.documentElement).getPropertyValue('--audio-player-height'), selection: getComputedStyle(document.documentElement).getPropertyValue('--selection-bar-height'), scrollY, scrollMax: document.documentElement.scrollHeight-innerHeight, wrapTop:wrap.getBoundingClientRect().top, wrapBottom:wrap.getBoundingClientRect().bottom, wrapScroll:wrap.scrollTop, wrapMax:wrap.scrollHeight-wrap.clientHeight }; });
      assert.ok(bounds.rowBottom <= bounds.selectionTop - 3 && bounds.rowTop >= 0, JSON.stringify({ width, height, ...bounds }));
      await page.locator('#tracks-pager').evaluate(node => node.scrollIntoView({ block: 'end', behavior: 'instant' })); await frame(page);
      assert.equal(await page.locator('#tracks-pager').evaluate(node => { const pager = node.getBoundingClientRect(), bar = document.querySelector('#selection-bar').getBoundingClientRect(); return pager.top >= 0 && pager.bottom <= bar.top - 3; }), true);
      await page.locator('#tracks-pager input').focus(); await page.keyboard.press('Shift+Tab'); await frame(page);
      assert.equal(await page.evaluate(() => { const focus = document.activeElement.getBoundingClientRect(), bar = document.querySelector('#selection-bar').getBoundingClientRect(); return focus.top >= 0 && focus.bottom <= bar.top - 3; }), true);
    }, { viewport: { width, height } });
  });

  await check('Compact expansion uses finite motion and Escape belongs to the foreground dialog', () => withPage(async ({ page }) => {
    await ready(page); await clickPlay(page); await playing(page, 1); await page.locator('#audio-player-toggle').click(); await paused(page);
    await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows([store.state.tracks.items[0]]); });
    await page.locator('#audio-player-expand').click();
    const motion = await page.locator('#audio-player').evaluate(node => node.getAnimations({ subtree: true }).map(animation => ({ duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations })));
    assert.ok(motion.length > 0 && motion.every(animation => animation.duration <= 220 && animation.iterations === 1));
    await page.locator('#audio-player').evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    assert.equal(await page.locator('#audio-player').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')), false);
    await page.locator('#selection-more-toggle').click(); await page.locator('#selection-review').click();
    await page.locator('#selection-review-dialog').waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    assert.equal(await page.locator('#selection-more-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#audio-player-expand').getAttribute('aria-expanded'), 'true');
    await page.locator('#audio-player-expand').click();
    await page.locator('#audio-player').evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    await frame(page);
    const gap = await page.evaluate(() => { const player = document.querySelector('#audio-player').getBoundingClientRect(), selected = document.querySelector('#selection-bar').getBoundingClientRect(); return player.top - selected.bottom; });
    assert.ok(gap >= 7 && gap <= 9, `Measured height must not retain the entry-animation transform: ${gap}`);
  }, { viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' }));

  console.log(`\n${passed} audio player checks passed; ${failures.length} failed. Screenshots: ${out}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); for (const server of servers) server.kill(); }
