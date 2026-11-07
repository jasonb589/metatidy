/** Review queue and editor write contracts, against isolated in-memory UI fixtures. */
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
  try { playwright = require(candidate); break; } catch { /* Existing installation or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const failures = [];
let passed = 0, server, browser, base;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function check(name, action) {
  if (process.env.METATIDY_UI_REVIEW_CHECK && !name.includes(process.env.METATIDY_UI_REVIEW_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(`${base}/api/`)) calls.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null }); });
  try {
    await page.goto(`${base}/#scrape`);
    await page.waitForFunction(() => document.querySelectorAll('#pick-list .pick-row').length === 18 && document.querySelectorAll('#src-chips button').length > 0);
    await action({ page, context, calls });
    assert.deepEqual(errors, [], 'Review interactions must not raise browser errors');
  } finally { await context.close(); }
}
async function select(page, ids) {
  await page.evaluate(async ids => {
    const { state, clearSelection, selectRows } = await import('/store.js');
    clearSelection();
    selectRows(ids.map(id => state.scrape.pickItems.find(row => row.id === id) || { id, title: `额外曲目 ${id}`, artist: '验收歌手' }));
  }, ids);
}
async function start(page, ids) {
  if (ids) await select(page, ids);
  await page.locator('input[name="batch-mode"][value="search"]').check();
  await page.locator('#btn-batch-run').click();
}
async function settled(page, count) {
  await page.waitForFunction(count => document.querySelectorAll('#review-list .review-item').length === count
    && !document.querySelector('#btn-batch-run').disabled
    && !document.querySelector('#review-list [data-status="searching"], #review-list [data-status="queued"]'), count);
}
const entry = (page, id) => page.locator(`#review-list [data-review-id="${id}"]`);
async function open(page, id) {
  await page.locator(`[data-review-open="${id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#search-state').textContent.includes('已载入这首的搜索结果'));
  assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true, 'Opening a cached result must not choose a candidate automatically');
}
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
const writes = calls => calls.filter(call => ['/api/tracks/apply', '/api/scrape/apply', '/api/scrape/batch'].includes(call.path));
async function delayed(page, endpoint, accept = () => true) {
  const entered = deferred(), release = deferred(), finished = deferred();
  let captured;
  const pattern = `**${endpoint}`;
  const handler = async route => {
    const request = route.request();
    const payload = request.postData() ? request.postDataJSON() : null;
    if (captured || !accept(payload)) return route.continue();
    captured = request;
    try {
      const data = await (await route.fetch()).json();
      entered.resolve(payload);
      await release.promise;
      await route.fulfill({ json: data });
    } finally { finished.resolve(); }
  };
  await page.route(pattern, handler);
  return {
    entered: entered.promise,
    async release() {
      const response = page.waitForResponse(response => response.url() === captured.url() && response.request().postData() === captured.postData());
      release.resolve(); await finished.promise; await (await response).finished(); await flush(page);
    },
    async cleanup() { release.resolve(); await page.unroute(pattern, handler); },
  };
}
async function snapshotRows(context, ids) {
  return Promise.all(ids.map(async id => (await context.request.get(`${base}/api/tracks/${id}`)).json()));
}
async function restore(context, rows) {
  for (const row of rows) await context.request.post(`${base}/api/tracks/apply`, { data: { ids: [row.id], fields: row } });
}
async function assertNoOverflow(page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(sizes.width <= sizes.viewport + 1, `Horizontal overflow: ${JSON.stringify(sizes)}`);
}

try {
  await mkdir(outputDir, { recursive: true });
  const port = Number(process.env.METATIDY_UI_REVIEW_PORT) || 18789;
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Review fixture did not start')), 10000);
    server.stdout.on('data', data => { if (String(data).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', data => { clearTimeout(timer); reject(new Error(String(data))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  base = `http://127.0.0.1:${port}`;
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Batch search freezes selected IDs and source settings without writing', () => withPage(async ({ page, calls }) => {
    const hold = await delayed(page, '/api/search', body => body.track_id === 1);
    try {
      await start(page, [1, 2]);
      const first = await hold.entered;
      await select(page, [3]);
      await page.locator('#src-none').click();
      await page.locator('#batch-limit').fill('10');
      await hold.release();
      await settled(page, 2);
      assert.deepEqual(await page.locator('#review-list .review-item').evaluateAll(nodes => nodes.map(node => Number(node.dataset.reviewId))), [1, 2]);
      const searches = calls.filter(call => call.path === '/api/search').map(call => call.body);
      assert.deepEqual(searches.map(body => body.track_id), [1, 2]);
      assert.deepEqual(searches[1].sources, first.sources);
      assert.equal(searches[1].limit, first.limit);
      assert.deepEqual(writes(calls), []);
    } finally { await hold.cleanup(); }
  }));

  await check('Clearing selection preserves cached review results and a fresh independent current track', () => withPage(async ({ page, calls }) => {
    await start(page, [1, 2]); await settled(page, 2);
    await page.locator('#batch-clear').click();
    await page.evaluate(async () => { const { state } = await import('/store.js'); state.tracks.items = []; state.scrape.pickItems = []; });
    const before = calls.filter(call => call.path === '/api/search').length;
    await open(page, 1);
    assert.equal(calls.filter(call => call.path === '/api/search').length, before);
    assert.match(await page.locator('#cand-list').innerText(), /晴天/);
    assert.ok((await page.locator('#source-status').innerText()).length > 0);
    const current = await page.evaluate(async () => { const store = await import('/store.js'); return { id: store.currentTrackRow()?.id, selected: store.selectionCount() }; });
    assert.deepEqual(current, { id: 1, selected: 0 });
    assert.deepEqual(writes(calls), []);
  }));

  await check('More than 200 selected tracks is rejected explicitly without truncation or search', () => withPage(async ({ page, calls }) => {
    await start(page, Array.from({ length: 201 }, (_, index) => index + 1));
    assert.match(await page.locator('#toasts').innerText(), /超过 200 首/);
    assert.equal(await page.locator('#review-list .review-item').count(), 0);
    assert.equal(calls.filter(call => call.path === '/api/search').length, 0);
    assert.equal(await page.evaluate(async () => (await import('/store.js')).selectionCount()), 201);
  }));

  await check('Stopping keeps completed candidates and rejects the pending result without starting remaining tracks', () => withPage(async ({ page, calls }) => {
    const hold = await delayed(page, '/api/search', body => body.track_id === 2);
    try {
      await start(page, [1, 2, 3]); await hold.entered;
      assert.equal(await entry(page, 1).getAttribute('data-status'), 'ready');
      await page.locator('#review-stop').click();
      await hold.release(); await settled(page, 3);
      assert.equal(await entry(page, 1).getAttribute('data-status'), 'ready');
      assert.equal(await entry(page, 2).getAttribute('data-status'), 'stopped');
      assert.equal(await entry(page, 3).getAttribute('data-status'), 'stopped');
      assert.deepEqual(calls.filter(call => call.path === '/api/search').map(call => call.body.track_id), [1, 2]);
      await open(page, 1);
      assert.deepEqual(writes(calls), []);
    } finally { await hold.cleanup(); }
  }));

  await check('Replacing a stopped batch rejects its old search completion', () => withPage(async ({ page }) => {
    const hold = await delayed(page, '/api/search', body => body.track_id === 1);
    try {
      await start(page, [1, 2]); await hold.entered;
      await page.locator('#review-stop').click();
      await start(page, [3]); await settled(page, 1);
      await hold.release();
      assert.equal(await entry(page, 3).getAttribute('data-status'), 'ready');
      assert.equal(await entry(page, 1).count(), 0);
      assert.match(await page.locator('#review-summary').innerText(), /本批 1 首/);
    } finally { await hold.cleanup(); }
  }));

  await check('Fresh track checks reject missing files, changed identities and mismatched search targets', async () => {
    for (const problem of ['missing', 'title-changed', 'artist-changed', 'search-wrong-id']) {
      await withPage(async ({ page, calls }) => {
        if (problem === 'search-wrong-id') await page.route('**/api/search', async route => { const data = await (await route.fetch()).json(); data.track.id = 2; await route.fulfill({ json: data }); });
        await start(page, [1]); await settled(page, 1);
        if (problem !== 'search-wrong-id') {
          await page.route('**/api/tracks/1', async route => {
            const row = await (await route.fetch()).json();
            if (problem === 'missing') row.file_exists = false;
            if (problem === 'title-changed') row.title = '已被外部改名';
            if (problem === 'artist-changed') row.artist = '外部新歌手';
            await route.fulfill({ json: row });
          });
          await page.locator('[data-review-open="1"]').click();
          await page.waitForFunction(() => ['failed', 'expired'].includes(document.querySelector('[data-review-id="1"]').dataset.status));
        }
        assert.ok(['failed', 'expired'].includes(await entry(page, 1).getAttribute('data-status')));
        assert.equal(await page.locator('#cand-list .cand').count(), 0);
        assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true);
        assert.deepEqual(writes(calls), []);
      });
    }
  });

  await check('Delayed open A cannot override B and A to B to A only accepts the newest open', () => withPage(async ({ page }) => {
    await start(page, [1, 2]); await settled(page, 2);
    const hold = await delayed(page, '/api/tracks/1');
    try {
      await page.locator('[data-review-open="1"]').click(); await hold.entered;
      await open(page, 2);
      await page.locator('#cand-list .cand').first().click();
      const before = await page.locator('#write-candidate').innerText();
      await hold.release();
      assert.equal(await page.locator('#write-candidate').innerText(), before);
      assert.match(before, /七里香/);
    } finally { await hold.cleanup(); }
    const again = await delayed(page, '/api/tracks/1');
    try {
      await page.locator('[data-review-open="1"]').click(); await again.entered;
      await open(page, 2); await open(page, 1);
      await page.locator('#cand-list .cand').nth(1).click();
      await again.release();
      assert.equal(await page.locator('#cand-list .cand').nth(1).getAttribute('aria-pressed'), 'true');
    } finally { await again.cleanup(); }
  }));

  await check('A late retry cannot reopen A over the user reviewing B', () => withPage(async ({ page }) => {
    await start(page, [1, 2]); await settled(page, 2); await open(page, 1);
    const hold = await delayed(page, '/api/search', body => body.track_id === 1);
    try {
      await page.locator('#review-current-retry').click(); await hold.entered;
      await open(page, 2); await page.locator('#cand-list .cand').first().click();
      await hold.release();
      assert.match(await page.locator('#write-candidate').innerText(), /七里香/);
      assert.equal(await page.evaluate(async () => (await import('/store.js')).state.currentTrackId), 2);
      assert.equal(await entry(page, 1).getAttribute('data-status'), 'ready');
    } finally { await hold.cleanup(); }
  }));

  await check('Queue progress preserves the focused review action while another song finishes', () => withPage(async ({ page }) => {
    const hold = await delayed(page, '/api/search', body => body.track_id === 2);
    try {
      await start(page, [1, 2]); await hold.entered; await open(page, 1);
      await page.locator('#review-current-skip').focus();
      await hold.release(); await settled(page, 2);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'review-current-skip');
    } finally { await hold.cleanup(); }
  }));

  await check('Thirty-minute expiry invalidates cached candidates and requires a new search', () => withPage(async ({ page, calls }) => {
    await start(page, [1]); await settled(page, 1); await open(page, 1);
    await page.locator('#cand-list .cand').first().click();
    await page.clock.setFixedTime(new Date(Date.now() + 31 * 60 * 1000));
    await page.locator('[data-review-open="1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-review-id="1"]').dataset.status === 'expired');
    assert.equal(await page.locator('#cand-list .cand').count(), 0);
    assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true);
    assert.equal(calls.filter(call => call.path === '/api/search').length, 1);
    await page.locator('#review-current-retry').click();
    await page.waitForFunction(() => document.querySelector('[data-review-id="1"]').dataset.status === 'ready' && document.querySelectorAll('#cand-list .cand').length > 0);
    assert.equal(calls.filter(call => call.path === '/api/search').length, 2);
  }));

  await check('Candidate memory limits expire oversized and evicted responses instead of retaining unbounded data', async () => {
    for (const [bytes, count] of [[2 * 1024 * 1024 + 1, 1], [1800000, 10]]) {
      await withPage(async ({ page, calls }) => {
        await page.route('**/api/search', async route => {
          const data = await (await route.fetch()).json();
          data.candidates[0].context = 'x'.repeat(bytes);
          await route.fulfill({ json: data });
        });
        await start(page, Array.from({ length: count }, (_, index) => index + 1)); await settled(page, count);
        assert.equal(await entry(page, 1).getAttribute('data-status'), 'expired');
        if (count > 1) assert.equal(await entry(page, count).getAttribute('data-status'), 'ready');
        await page.locator('[data-review-open="1"]').click();
        await page.waitForFunction(() => !document.querySelector('#search-state .loading-line'));
        assert.equal(await page.locator('#cand-list .cand').count(), 0);
        assert.deepEqual(writes(calls), []);
      });
    }
  });

  await check('A 401 clears the queue, invalidates pending work and stops further batch requests', () => withPage(async ({ page, calls }) => {
    await page.route('**/api/search', async route => {
      if (route.request().postDataJSON().track_id === 2) return route.fulfill({ status: 401, json: { detail: '审阅会话过期' } });
      await route.continue();
    });
    await start(page, [1, 2, 3]);
    await page.locator('#auth-password').waitFor({ state: 'visible' });
    await flush(page);
    assert.equal(await page.locator('#review-list .review-item').count(), 0);
    assert.equal(await page.locator('#review-count').innerText(), '0');
    assert.equal(await page.locator('#cand-list .cand').count(), 0);
    assert.deepEqual(calls.filter(call => call.path === '/api/search').map(call => call.body.track_id), [1, 2]);
    assert.deepEqual(writes(calls), []);
  }));

  await check('Review applies only after confirmation and advances only through the explicit next action', () => withPage(async ({ page, context, calls }) => {
    const original = await snapshotRows(context, [1]);
    try {
      await page.route('**/api/search', async route => {
        const data = await (await route.fetch()).json();
        data.candidates.forEach(candidate => { candidate.title += '（审阅确认版）'; });
        await route.fulfill({ json: data });
      });
      await start(page, [1, 2]); await settled(page, 2); await open(page, 1);
      await page.locator('#search-keyword').fill('晴天手动修正候选');
      await page.locator('#btn-search').click();
      await page.waitForFunction(() => document.querySelector('#cand-list').textContent.includes('晴天手动修正候选') && !document.querySelector('#btn-search').disabled);
      await page.locator('#cand-list .cand').first().click();
      await page.locator('#write-cover').uncheck(); await page.locator('#write-lyrics').uncheck();
      await page.locator('#btn-scrape-apply').click(); await page.locator('dialog[open]').waitFor();
      assert.deepEqual(writes(calls), []);
      await page.locator('dialog[open]').getByRole('button', { name: '确认写入', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-review-id="1"]').dataset.status === 'done');
      assert.equal(writes(calls).length, 1); assert.equal(writes(calls)[0].body.track_id, 1);
      assert.match(writes(calls)[0].body.candidate.title, /晴天手动修正候选/);
      assert.equal(await page.evaluate(async () => (await import('/store.js')).state.currentTrackId), 1);
      await page.locator('#review-next').click();
      await page.waitForFunction(async () => (await import('/store.js')).state.currentTrackId === 2 && document.querySelectorAll('#cand-list .cand').length > 0);
      assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), true);
      await page.locator('#review-current-skip').click();
      assert.equal(await entry(page, 2).getAttribute('data-status'), 'skipped');
      assert.equal(writes(calls).length, 1);
      await page.locator('[data-review-retry="2"]').click();
      await page.waitForFunction(() => document.querySelector('[data-review-id="2"]').dataset.status === 'ready');
      await page.reload();
      await page.locator('#review-summary').waitFor({ state: 'attached' });
      assert.equal(await page.locator('#review-list .review-item').count(), 0, 'Queues must remain session-only, not persisted across reload');
    } finally { await restore(context, original); }
  }));

  await check('Unchanged review can be completed without sending any apply request', () => withPage(async ({ page, calls }) => {
    await start(page, [1]); await settled(page, 1); await open(page, 1);
    await page.locator('#cand-list .cand').first().click();
    await page.locator('#write-cover').uncheck(); await page.locator('#write-lyrics').uncheck();
    await page.locator('#btn-scrape-apply').click();
    await page.locator('dialog[open]').getByRole('button', { name: '完成审阅', exact: true }).click();
    assert.equal(await entry(page, 1).getAttribute('data-status'), 'done');
    assert.deepEqual(writes(calls), []);
  }));

  await check('Clearing a queue invalidates an open confirmation before it can apply', () => withPage(async ({ page, calls }) => {
    await page.route('**/api/search', async route => { const data = await (await route.fetch()).json(); data.candidates[0].title = '不可复用的队列预览'; await route.fulfill({ json: data }); });
    await start(page, [1]); await settled(page, 1); await open(page, 1);
    await page.locator('#cand-list .cand').first().click();
    await page.locator('#btn-scrape-apply').click(); await page.locator('dialog[open]').waitFor();
    await page.evaluate(() => document.querySelector('#review-clear').click());
    await page.locator('dialog[open]').getByRole('button', { name: '确认写入', exact: true }).click();
    await flush(page);
    assert.equal(await page.locator('#review-list .review-item').count(), 0);
    assert.deepEqual(writes(calls), []);
  }));

  await check('Editor preview honors no-overwrite and confirms exactly the captured policy', () => withPage(async ({ page, context, calls }) => {
    const original = await snapshotRows(context, [1]);
    try {
      await restore(context, [{ ...original[0], genre: '' }]);
      await page.locator('#tab-tracks').click();
      await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
      await page.locator('#tracks-tbody tr[data-id="1"] input[type="checkbox"]').check();
      await page.locator('#btn-edit-selected').click();
      await page.locator('#edit-title').fill('不覆盖的候选标题'); await page.locator('#edit-genre').fill('Fixture Ambient');
      await page.locator('#edit-overwrite').uncheck(); await page.locator('#btn-edit-preview').click();
      const dialog = page.locator('dialog[open]'); await dialog.waitFor();
      assert.equal(calls.filter(call => call.path === '/api/tracks/preview').at(-1).body.overwrite, false);
      assert.match(await dialog.locator('.diff-new').innerText(), /Fixture Ambient/);
      await dialog.locator('.diff-skipped summary').click();
      assert.match(await dialog.locator('.diff-skipped').innerText(), /标题/);
      assert.deepEqual(writes(calls), []);
      await page.evaluate(() => { document.querySelector('#edit-overwrite').checked = true; });
      await dialog.getByRole('button', { name: '确认处理 1 首', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#edit-result').textContent.includes('写入结果'));
      assert.equal(writes(calls).length, 1); assert.equal(writes(calls)[0].body.overwrite, false);
      const track = await (await context.request.get(`${base}/api/tracks/1`)).json();
      assert.equal(track.title, original[0].title); assert.equal(track.genre, 'Fixture Ambient');
      assert.match(await page.locator('.edit-skipped-results').innerText(), /保留与跳过/);
    } finally { await restore(context, original); }
  }));

  await check('A zero-change editor preview offers only close and preserves the selected tracks', () => withPage(async ({ page, calls }) => {
    await page.locator('#tab-tracks').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
    await page.locator('#tracks-tbody tr[data-id="1"] input[type="checkbox"]').check();
    await page.locator('#btn-edit-selected').click(); await page.locator('#edit-overwrite').uncheck();
    await page.locator('#edit-title').fill('不会覆盖的标题'); await page.locator('#btn-edit-preview').click();
    const dialog = page.locator('dialog[open]'); await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: /确认处理/ }).count(), 0);
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();
    assert.deepEqual(writes(calls), []);
    assert.equal(await page.evaluate(async () => (await import('/store.js')).isSelected(1)), true);
  }));

  await check('Queue navigation remains usable on narrow phones, both themes and reduced motion', async () => {
    for (const [width, height, colorScheme, reducedMotion] of [[1440, 1000, 'light', 'no-preference'], [390, 844, 'light', 'reduce'], [320, 568, 'dark', 'reduce']]) {
      await withPage(async ({ page }) => {
        await page.locator('input[name="batch-mode"][value="apply"]').check();
        await page.locator('#batch-cover').check(); await page.locator('#batch-lyrics').check();
        await page.locator('#batch-fields input[data-field="title"]').uncheck();
        await page.locator('input[name="batch-mode"][value="search"]').check();
        assert.equal(await page.locator('#batch-fields-wrap').isVisible(), false);
        assert.equal(await page.locator('#batch-cover').isVisible(), false);
        assert.equal(await page.locator('#batch-threshold').isVisible(), false);
        await page.locator('input[name="batch-mode"][value="apply"]').check();
        assert.equal(await page.locator('#batch-cover').isChecked(), true);
        assert.equal(await page.locator('#batch-lyrics').isChecked(), true);
        assert.equal(await page.locator('#batch-fields input[data-field="title"]').isChecked(), false);
        await start(page, [1, 2, 3]); await settled(page, 3);
        await assertNoOverflow(page);
        await page.locator('#scrape-library-tab').focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('#scrape-review-tab').getAttribute('aria-selected'), 'true');
        await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
        await page.screenshot({ path: path.join(outputDir, `review-queue-${width}-${colorScheme}.png`), fullPage: true });
        await open(page, 1); await assertNoOverflow(page);
        await page.screenshot({ path: path.join(outputDir, `review-open-${width}-${colorScheme}.png`) });
        await page.locator('#cand-list .cand').first().click();
        assert.equal(await page.locator('#btn-scrape-apply').isDisabled(), false);
        if (width < 700) assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-scrape-apply');
        await assertNoOverflow(page);
        await page.screenshot({ path: path.join(outputDir, `review-chosen-${width}-${colorScheme}.png`) });
        await page.locator('#review-return').click();
        assert.equal(await page.locator('[data-review-open="1"]').isVisible(), true);
        assert.equal(await page.locator('#review-queue-root').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity)), false);
      }, { viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} review queue checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
