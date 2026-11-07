/** Single-track scraper isolation checks against an in-memory fixture, never real music. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Existing installation or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const failures = [];
let passed = 0;
let server;
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
async function startFixture(port) {
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scrape fixture ${port} did not start`)), 10000);
    server.stdout.on('data', data => { if (String(data).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', data => { clearTimeout(timer); reject(new Error(String(data))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  return `http://127.0.0.1:${port}`;
}
async function withPage(action) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/scrape/apply') writes.push(request.postDataJSON());
  });
  try {
    await page.goto(`${base}/#scrape`);
    await page.waitForFunction(() => document.querySelectorAll('#pick-list .pick-row').length === 18 && document.querySelectorAll('#src-chips button').length > 0);
    await action({ page, context, writes });
    assert.deepEqual(errors, [], 'Scrape interactions must not raise browser exceptions');
  } finally { await context.close(); }
}
async function selectTrack(page, title, id) {
  await page.locator('#pick-list .pick-row').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${title}$`) }) }).click();
  assert.equal(await page.evaluate(async () => (await import('/store.js')).state.currentTrackId), id);
}
async function search(page, keyword) {
  if (keyword !== undefined) await page.locator('#search-keyword').fill(keyword);
  await page.locator('#btn-search').click();
  await page.waitForFunction(() => document.querySelectorAll('#cand-list .cand').length > 0 && !document.querySelector('#btn-search').disabled);
}
async function choose(page, index = 0) {
  await page.locator('#cand-list .cand').nth(index).click();
  assert.equal(await page.locator('#cand-list .cand').nth(index).getAttribute('aria-pressed'), 'true');
}
async function flush(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function assertCleared(page) {
  assert.equal(await page.locator('#cand-list .cand').count(), 0);
  assert.equal(await page.locator('#cand-count').innerText(), '0');
  assert.equal(await page.locator('#source-status').innerText(), '');
  assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true);
  assert.equal(await page.locator('#btn-lyrics-try').isDisabled(), true);
  assert.equal(await page.locator('#write-lyrics-text').textContent(), '');
  const choice = await page.evaluate(async () => {
    const { state } = await import('/store.js');
    return { index: state.scrape.chosenIndex, fields: [...state.scrape.chosenFields] };
  });
  assert.deepEqual(choice, { index: -1, fields: [] });
}
/** Hold exactly one real fixture response; later calls continue normally. */
async function delayNext(page, endpoint, transform = data => data) {
  const entered = deferred();
  const released = deferred();
  const finished = deferred();
  let held = false;
  const pattern = `**${endpoint}`;
  const handler = async route => {
    if (held) return route.continue();
    held = true;
    try {
      const response = await route.fetch();
      const data = transform(await response.json());
      entered.resolve(route.request().postDataJSON());
      await released.promise;
      await route.fulfill({ json: data });
    } finally { finished.resolve(); }
  };
  await page.route(pattern, handler);
  return {
    entered: entered.promise,
    async release() {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
      released.resolve();
      await finished.promise;
      await (await response).finished();
      await flush(page);
      await page.unroute(pattern, handler);
    },
    async cleanup() { released.resolve(); await page.unroute(pattern, handler); },
  };
}
async function changeUnderModal(page, id) {
  // Native dialogs make the page inert. Model a current-track event from another
  // application action while its asynchronous confirmation promise is pending.
  await page.evaluate(async id => {
    const { state, setCurrentTrack } = await import('/store.js');
    setCurrentTrack(state.scrape.pickItems.find(track => track.id === id));
  }, id);
}

try {
  base = await startFixture(Number(process.env.METATIDY_UI_SCRAPE_PORT) || 18788);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Changing the current track clears candidates, chosen fields and fetched lyrics', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    await search(page);
    await choose(page);
    await page.locator('#btn-lyrics-try').click();
    await page.waitForFunction(() => document.querySelector('#write-lyrics-text').textContent.includes('UI 测试歌词'));
    await selectTrack(page, '七里香', 2);
    await assertCleared(page);
    assert.match(await page.locator('#cand-hidden').innerText(), /七里香/);
    await search(page);
    await choose(page);
    assert.match(await page.locator('#write-candidate').innerText(), /七里香/);
    assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), false);
    assert.deepEqual(writes, []);
  }));

  await check('A late A search cannot replace B results or their chosen candidate', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    const delayed = await delayNext(page, '/api/search');
    try {
      await page.locator('#btn-search').click();
      assert.equal((await delayed.entered).track_id, 1);
      await selectTrack(page, '七里香', 2);
      assert.equal(await page.locator('#btn-search').isDisabled(), false, 'A new track must be searchable while the old request finishes');
      await search(page);
      await choose(page, 1);
      const before = await page.locator('#write-candidate').innerText();
      await delayed.release();
      assert.equal(await page.locator('#write-candidate').innerText(), before);
      assert.equal(await page.locator('#cand-list .cand').nth(1).getAttribute('aria-pressed'), 'true');
      assert.equal((await page.locator('#cand-list').innerText()).includes('晴天'), false);
      assert.deepEqual(writes, []);
    } finally { await delayed.cleanup(); }
  }));

  await check('A to B to A does not revive an abandoned search for the same track ID', () => withPage(async ({ page }) => {
    await selectTrack(page, '晴天', 1);
    const delayed = await delayNext(page, '/api/search');
    try {
      await page.locator('#btn-search').click();
      await delayed.entered;
      await selectTrack(page, '七里香', 2);
      await selectTrack(page, '晴天', 1);
      await delayed.release();
      await assertCleared(page);
      assert.equal(await page.locator('#btn-search').isDisabled(), false);
    } finally { await delayed.cleanup(); }
  }));

  await check('Keyword-only results remain viewable but cannot be applied to a later track', () => withPage(async ({ page, writes }) => {
    assert.equal(await page.evaluate(async () => (await import('/store.js')).state.currentTrackId), null);
    await search(page, '无曲目关键词验收');
    await choose(page);
    assert.match(await page.locator('#write-candidate').innerText(), /无曲目关键词验收/);
    assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true);
    assert.equal(await page.locator('#btn-lyrics-try').isDisabled(), true);
    await selectTrack(page, '七里香', 2);
    await assertCleared(page);
    assert.deepEqual(writes, []);
  }));

  await check('Late lyrics from A cannot fill the panel for B', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    await search(page);
    await choose(page);
    const delayed = await delayNext(page, '/api/lyrics/preview', data => ({ ...data, lyrics: '[00:01.00] 仅属于晴天的迟到歌词' }));
    try {
      await page.locator('#btn-lyrics-try').click();
      assert.equal((await delayed.entered).track_id, 1);
      assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true, 'Wait for the chosen lyrics preview before confirming a write');
      await selectTrack(page, '七里香', 2);
      await search(page);
      await choose(page);
      await delayed.release();
      assert.equal(await page.locator('#write-lyrics-text').textContent(), '');
      assert.match(await page.locator('#write-candidate').innerText(), /七里香/);
      assert.equal(await page.locator('#btn-lyrics-try').isDisabled(), false);
      assert.deepEqual(writes, []);
    } finally { await delayed.cleanup(); }
  }));

  await check('Changing candidates on the same track invalidates an earlier lyrics request', () => withPage(async ({ page }) => {
    await selectTrack(page, '晴天', 1);
    await search(page);
    await choose(page);
    const delayed = await delayNext(page, '/api/lyrics/preview', data => ({ ...data, lyrics: '[00:01.00] 旧候选歌词不可复用' }));
    try {
      await page.locator('#btn-lyrics-try').click();
      await delayed.entered;
      await choose(page, 1);
      await delayed.release();
      assert.equal(await page.locator('#write-lyrics-text').textContent(), '');
      assert.equal(await page.locator('#cand-list .cand').nth(1).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#btn-lyrics-try').isDisabled(), false);
      assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), false);
    } finally { await delayed.cleanup(); }
  }));

  await check('Session expiry invalidates a pending search before its successful response arrives', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    const delayed = await delayNext(page, '/api/search');
    try {
      await page.locator('#btn-search').click();
      await delayed.entered;
      await page.route('**/api/status', route => route.fulfill({ status: 401, json: { detail: '验收会话已过期' } }));
      const status = await page.evaluate(async () => {
        try { await (await import('/api.js')).api.status(); return 200; }
        catch (error) { return error.status; }
      });
      assert.equal(status, 401);
      await page.locator('#auth-password').waitFor({ state: 'visible' });
      await delayed.release();
      await assertCleared(page);
      assert.equal(await page.locator('#auth-veil').isVisible(), true);
      assert.deepEqual(writes, []);
    } finally { await delayed.cleanup(); }
  }));

  await check('A preview response arriving after a track switch cannot open confirmation or write', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    await search(page, '晴天候选修正版');
    await choose(page);
    const delayed = await delayNext(page, '/api/tracks/preview');
    try {
      await page.locator('#btn-scrape-apply').click();
      assert.deepEqual((await delayed.entered).ids, [1]);
      await selectTrack(page, '七里香', 2);
      await delayed.release();
      await assertCleared(page);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.deepEqual(writes, []);
    } finally { await delayed.cleanup(); }
  }));

  await check('A successful preview response must include the readable target before confirmation', async () => {
    for (const problem of ['wrong-track', 'missing-file', 'unreadable-tags']) {
      await withPage(async ({ page, writes }) => {
        await selectTrack(page, '晴天', 1);
        await search(page, '晴天候选修正版');
        await choose(page);
        await page.route('**/api/tracks/preview', async route => {
          const data = await (await route.fetch()).json();
          if (problem === 'wrong-track') data.items[0].track_id = 2;
          if (problem === 'missing-file') data.items[0].file_exists = false;
          if (problem === 'unreadable-tags') data.items[0].current = { ...data.items[0].current, error: '验收读取标签失败' };
          await route.fulfill({ json: data });
        });
        await page.locator('#btn-scrape-apply').click();
        await page.locator('#scrape-result .notice-err').waitFor();
        assert.equal(await page.locator('dialog[open]').count(), 0, `${problem} must not offer confirmation`);
        assert.deepEqual(writes, [], `${problem} must remain read-only`);
        assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), false);
      });
    }
  });

  await check('Confirming an already open A preview after switching to B sends no apply request', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    await search(page, '晴天候选修正版');
    await choose(page);
    await page.locator('#btn-scrape-apply').click();
    await page.locator('dialog[open]').waitFor();
    await changeUnderModal(page, 2);
    await page.locator('dialog[open]').getByRole('button', { name: '确认写入', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await flush(page);
    await assertCleared(page);
    assert.deepEqual(writes, []);
  }));

  await check('Lyrics-only confirmation also revalidates the track before applying', () => withPage(async ({ page, writes }) => {
    await selectTrack(page, '晴天', 1);
    await search(page);
    await choose(page);
    await page.locator('#btn-write-none').click();
    await page.locator('#write-cover').uncheck();
    await page.locator('#write-lyrics').check();
    await page.locator('#btn-scrape-apply').click();
    await page.locator('dialog[open]').waitFor();
    await changeUnderModal(page, 2);
    await page.locator('dialog[open]').getByRole('button', { name: '确认写入', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await flush(page);
    assert.deepEqual(writes, []);
    await assertCleared(page);
  }));

  await check('A normal search, fetched lyrics, preview and confirmation apply once to the captured track', () => withPage(async ({ page, context, writes }) => {
    const original = await (await context.request.get(`${base}/api/tracks/1`)).json();
    try {
      await selectTrack(page, '晴天', 1);
      await search(page, '晴天（验收修正版）');
      await choose(page);
      await page.locator('#btn-lyrics-try').click();
      await page.waitForFunction(() => document.querySelector('#write-lyrics-text').textContent.includes('UI 测试歌词'));
      const lyrics = await page.locator('#write-lyrics-text').textContent();
      await page.locator('#write-cover').uncheck();
      await page.locator('#write-lyrics').uncheck();
      await page.locator('#write-lyrics').check();
      assert.equal(await page.locator('#write-lyrics-text').textContent(), lyrics, 'Panel rerenders must preserve the fetched lyrics selected for writing');
      await page.locator('#btn-scrape-apply').click();
      const dialog = page.locator('dialog[open]');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /晴天（验收修正版）/);
      assert.deepEqual(writes, [], 'Preview and lyrics lookup are read-only until confirmation');
      await dialog.getByRole('button', { name: '确认写入', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#scrape-result').textContent.includes('已写入：'));
      assert.equal(await page.locator('#write-lyrics-text').textContent(), lyrics, 'The boolean lyrics success flag must never replace the submitted lyrics body');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].track_id, 1);
      assert.equal(writes[0].candidate.title, '晴天（验收修正版）');
      assert.equal(writes[0].candidate.lyrics, lyrics);
      assert.equal(writes[0].write_lyrics, true);
      assert.ok(writes[0].fields.includes('title'));
      assert.equal((await (await context.request.get(`${base}/api/tracks/1`)).json()).title, '晴天（验收修正版）');
      assert.equal((await (await context.request.get(`${base}/api/tracks/2`)).json()).title, '七里香');
    } finally {
      await context.request.post(`${base}/api/tracks/apply`, { data: { ids: [1], fields: original } });
    }
  }));

  console.log(`\n${passed} scraper scope checks passed; ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill();
}
