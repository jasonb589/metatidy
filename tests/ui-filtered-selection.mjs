/** Complete filtered selection against isolated index snapshots; no music writes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { revealLibraryTools } from './ui-library-controls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Use the installed local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_FILTERED_UI_PORT || 18987), base = `http://127.0.0.1:${port}`;
const endpoint = '/api/tracks/filtered-selection', dialog = '#filtered-selection-dialog';
const defaults = { q: '', artist: '', artist_group: '', album: '', language: '', albumtype: '', genre: '', year: '', sort: 'artist', order: 'asc',
  album_group: null, folder: '', folder_recursive: true, missing_cover: false, missing_lyrics: false, no_artist: false, no_album: false, not_loaded: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred(), index: -1 });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rowsOf = (count = 407, offset = 0) => Array.from({ length: count }, (_, index) => {
  const id = offset + index + 1;
  return { id, path: `/fixture-music/全部筛选/${id}.flac`, dir: '/fixture-music/全部筛选', filename: `${id}.flac`, ext: 'flac',
    title: `筛选曲目 ${id}`, artist: `歌手 ${id % 7}`, album: `专辑 ${Math.floor(id / 10)}`, albumartist: '专辑艺术家', genre: 'Pop', year: '2025',
    track: String(id), disc: '1', language: '中文', albumtype: '专辑', has_cover: 0, has_lyrics: 0, duration: 180,
    indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000, size: 123456, tags_loaded: true, path_derived: false };
});
const modelOf = (count = 407) => ({ rows: rowsOf(count), calls: [], filtered: [], plans: [], gates: [], allowedListCoverIds: new Set(), readStart: 0, fixture: false });
const snapshotOf = (query, items) => ({ query: structuredClone(query), revision: createHash('sha256').update(JSON.stringify([query, items])).digest('hex'),
  total: items.length, limit: 20000, items: structuredClone(items) });
let server, browser, passed = 0;
const failures = [];

async function check(name, action) {
  if (process.env.METATIDY_FILTERED_UI_CHECK && !name.includes(process.env.METATIDY_FILTERED_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
function plan(model, value) { model.plans.push(value); if (value.gate) model.gates.push(value.gate); return value; }
async function entered(delay) {
  let timer;
  try { await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected filtered request did not start')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, delay) {
  delay.release.resolve(); await delay.done.promise;
  await page.waitForFunction(index => window.filteredFetchEvents[index]?.returned === true, delay.index);
  await flush(page);
}
async function withPage(action, { model = modelOf(), ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  // Deliberately deliver aborted requests. A passing late-response check must
  // prove lifecycle/revision guards, rather than rely on fetch being cancelled.
  await page.addInitScript(endpoint => {
    const fetch = window.fetch.bind(window); window.filteredFetchEvents = [];
    window.fetch = (input, options = {}) => {
      if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname !== endpoint) return fetch(input, options);
      const event = { returned: false, aborted: Boolean(options.signal?.aborted) }; window.filteredFetchEvents.push(event);
      options.signal?.addEventListener('abort', () => { event.aborted = true; });
      return fetch(input, { ...options, signal: undefined }).then(response => {
        const text = response.text.bind(response);
        response.text = async () => { const body = await text(); event.returned = true; return body; };
        return response;
      });
    };
  }, endpoint);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : null;
    const call = { path: url.pathname, method: request.method(), query: Object.fromEntries(url.searchParams), body };
    model.calls.push(call);
    if (!model.fixture && call.path === '/api/tracks') {
      return route.fulfill({ json: { items: model.rows.slice(0, 18), total: model.rows.length, page: 1, page_size: 18, pages: Math.ceil(model.rows.length / 18) } });
    }
    if (call.path !== endpoint) return route.continue();
    const index = model.filtered.length; model.filtered.push(call);
    if (model.fixture) return route.continue();
    const next = model.plans.shift();
    const result = next?.data ?? snapshotOf(body.query, model.rows);
    try {
      if (next?.gate) { next.gate.index = index; next.gate.entered.resolve(); await next.gate.release.promise; }
      return await route.fulfill({ status: next?.status || 200, json: next?.transform ? next.transform(result) : result });
    } catch (error) { if (!page.isClosed() && !next?.gate) throw error; }
    finally { next?.gate?.done.resolve(); }
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base); await page.locator('#tracks-tbody tr[data-id]').first().waitFor(); await flush(page);
    model.readStart = model.calls.length;
    await action({ page, context, model });
    assert.deepEqual(errors, [], 'Filtered selection must not raise browser errors');
    assert.deepEqual(model.calls.filter(call => !['GET', 'HEAD'].includes(call.method) && call.path !== endpoint), [], 'Preparing, confirming and handing off must not submit writes or scans');
    assert.deepEqual(model.calls.slice(model.readStart).filter(call => {
      if (!/^\/api\/tracks\/\d+(?:\/(?:audio|cover|lyrics))?$/.test(call.path)) return false;
      const cover = /^\/api\/tracks\/(\d+)\/cover$/.exec(call.path);
      return !cover || !model.allowedListCoverIds.has(Number(cover[1]));
    }), [], 'Selection preparation must not open music, artwork, lyrics or per-track files');
  } finally { for (const delay of model.gates) delay.release.resolve(); await context.close(); }
}
async function phase(page, value) { await page.waitForFunction(value => document.querySelector('#filtered-selection-dialog')?.dataset.phase === value, value); }
async function open(page) { await revealLibraryTools(page); await page.locator('#btn-filtered-selection').click(); await page.locator(`${dialog}[open]`).waitFor(); }
async function prepare(page) { await open(page); await phase(page, 'ready'); }
async function close(page, control = '#filtered-selection-cancel') { await page.locator(control).click(); await page.locator(dialog).waitFor({ state: 'detached' }); }
async function selected(page) { return page.evaluate(async () => { const store = await import('/store.js'); return { ids: store.selectionIds(), rows: store.selectionRows(), revision: store.selectionRevision() }; }); }
async function seed(page, rows) { await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, rows); }
async function recordSelection(page) {
  await page.evaluate(async () => {
    const store = await import('/store.js'); window.filteredSelectionEvents = [];
    window.stopFilteredSelectionEvents?.(); window.stopFilteredSelectionEvents = store.on('selection:changed', () => {
      window.filteredSelectionEvents.push({ ids: store.selectionIds(), revision: store.selectionRevision() });
    });
  });
}
async function commit(page) { await page.locator('#filtered-selection-confirm').click(); await page.locator('#selection-review-dialog[open]').waitFor(); }
async function validFocus(page, inside = dialog) {
  const focus = await page.evaluate(selector => {
    const node = document.activeElement;
    return { id: node.id, valid: Boolean(document.querySelector(selector)?.contains(node)) && node.getClientRects().length > 0 && !node.matches(':disabled') && !node.closest('[inert]') };
  }, inside);
  assert.equal(focus.valid, true, `Focus must remain on a visible usable control: ${JSON.stringify(focus)}`);
}
async function motionDone(page) {
  return page.locator(dialog).evaluate(async node => {
    const animations = node.getAnimations({ subtree: true });
    const timing = animations.map(animation => { const t = animation.effect.getTiming(); return { duration: t.duration, delay: t.delay, iterations: t.iterations }; });
    if (timing.every(t => Number.isFinite(t.duration) && t.iterations === 1 && t.duration + t.delay <= 500)) await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    return { timing, running: node.getAnimations({ subtree: true }).filter(animation => ['running', 'pending'].includes(animation.playState)).length };
  });
}
async function geometry(page, controls) {
  const result = await page.locator(dialog).evaluate((node, controls) => {
    const rect = node.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth,
      rect: rect.toJSON(), overflow: node.scrollWidth > node.clientWidth + 1,
      controls: controls.map(id => { const button = document.getElementById(id), box = button.getBoundingClientRect();
        return { id, enabled: !button.disabled, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          reached: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button }; }) };
  }, controls);
  assert.ok(result.pageWidth <= result.width + 1 && !result.overflow && result.rect.left >= 0 && result.rect.right <= result.width && result.rect.top >= 0 && result.rect.bottom <= result.height, JSON.stringify(result));
  for (const item of result.controls) assert.ok(item.enabled && item.reached && item.left >= 0 && item.right <= result.width && item.top >= 0 && item.bottom <= result.height, JSON.stringify({ ...item, width: result.width, height: result.height }));
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Filtered selection fixture timeout')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('The real tool prepares a full summary, confirms twice and atomically opens review with a collection handoff', () => withPage(async ({ page, model }) => {
    await seed(page, [{ ...rowsOf(1, 9000)[0], title: '原有离页快照' }, { ...model.rows[1], title: '保留已选标题', path: '/fixture-music/已有/2.flac' }]);
    const before = await selected(page); await recordSelection(page);
    const loading = gate(); plan(model, { gate: loading }); await open(page); await entered(loading);
    await phase(page, 'loading'); await validFocus(page);
    assert.deepEqual(await selected(page), before);
    await page.locator('#filtered-selection-cancel').focus(); await release(page, loading); await phase(page, 'ready');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'filtered-selection-cancel');
    assert.match(await page.locator('#filtered-selection-scope').textContent(), /整个曲库/);
    for (const [id, value] of [['matched', 407], ['existing', 1], ['new', 406], ['union', 408]]) {
      assert.match((await page.locator(`#filtered-selection-${id}`).textContent()).replaceAll(',', ''), new RegExp(String(value)));
    }
    assert.ok(await page.locator('#filtered-selection-samples *').count() < 100, 'Summary must not render every candidate');
    assert.deepEqual(await selected(page), before, 'Preparation alone must not append any candidate');
    const checking = gate(); plan(model, { gate: checking }); await page.locator('#filtered-selection-confirm').click(); await entered(checking);
    await phase(page, 'checking'); assert.equal(await page.locator('#filtered-selection-confirm').isDisabled(), true); await validFocus(page);
    await page.locator('#filtered-selection-confirm').evaluate(node => node.click());
    assert.equal(model.filtered.length, 2, 'Repeated confirmation cannot submit another request');
    assert.deepEqual(model.filtered[1].body, { query: model.filtered[0].body.query, revision: snapshotOf(model.filtered[0].body.query, model.rows).revision });
    assert.deepEqual(await selected(page), before);
    await release(page, checking); await page.locator('#selection-review-dialog[open]').waitFor();
    const after = await selected(page), expected = [9001, 2, ...model.rows.map(row => row.id).filter(id => id !== 2)];
    assert.deepEqual(after.ids, expected); assert.deepEqual(after.rows.slice(0, 2), before.rows);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(await page.evaluate(() => window.filteredSelectionEvents.map(event => event.ids)), [expected], 'All additions must publish exactly once');
    assert.equal(await page.locator('.sr-track').count(), 50); await validFocus(page, '#selection-review-dialog');
    await page.locator('#selection-review-q').fill('/407.flac'); await flush(page);
    assert.equal(await page.locator('.sr-track').count(), 1);
    await page.locator('#selection-review-save-collection').click(); await page.locator('#collections-dialog[data-action="create"][open]').waitFor();
    assert.match((await page.locator('#collections-dialog-copy').textContent()).replaceAll(',', ''), /408/);
    assert.deepEqual((await selected(page)).ids, expected); await validFocus(page, '#collections-dialog');
    assert.equal(model.calls.some(call => call.path === '/api/collections' && call.method === 'POST'), false);
  }));

  await check('Raw inputs and every query field are captured without page, view or density limits', () => withPage(async ({ page, model }) => {
    const expected = { ...defaults, q: '待补 %_', artist: '歌手', artist_group: '\u00a0精确歌手\u0085', album: '专辑', genre: 'Rock', year: '2025', language: '中文', albumtype: '专辑',
      sort: 'disc_track', order: 'desc', album_group: ['合集', '共同艺术家'], folder: '/fixture-music/  收藏 %_!  ', folder_recursive: false,
      missing_cover: true, missing_lyrics: true, no_artist: true, no_album: true, not_loaded: true };
    await page.evaluate(async expected => {
      const { state } = await import('/store.js'), tracks = await import('/tracks.js');
      Object.assign(state.tracks, { sort: expected.sort, order: expected.order, page: 7, page_size: 50, view: 'cards', density: 'compact' });
      for (const key of Object.keys(state.tracks.filters)) if (key in expected) state.tracks.filters[key] = key === 'album_group' ? JSON.stringify(expected[key]) : expected[key];
      tracks.setFolderScope({ folder: expected.folder, recursive: false });
    }, expected);
    await revealLibraryTools(page);
    await page.evaluate(values => {
      for (const [id, value] of Object.entries(values)) { const input = document.getElementById(id); input.value = `\u0085\u3000  ${value}  \u3000\u0085`; input.dispatchEvent(new Event('input', { bubbles: true })); }
      document.getElementById('btn-filtered-selection').click();
    }, { 'tracks-q': expected.q, 'filter-artist': expected.artist, 'filter-album': expected.album, 'filter-genre': expected.genre, 'filter-year': expected.year });
    await phase(page, 'ready');
    assert.deepEqual(model.filtered[0].body.query, expected);
    assert.deepEqual(Object.keys(model.filtered[0].body).sort(), ['query']);
    await commit(page); assert.deepEqual(model.filtered[1].body.query, expected);
  }));

  await check('The isolated fixture route selects the same complete ordered set as the visible library query', () => withPage(async ({ page, model }) => {
    model.allowedListCoverIds = new Set([1, 2, 3]);
    await page.locator('#tracks-q').fill('周杰伦'); await page.locator('#tracks-q').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    await flush(page);
    const visible = await page.locator('#tracks-tbody tr[data-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.id)));
    await prepare(page); await commit(page);
    assert.deepEqual((await selected(page)).ids, visible); assert.equal(model.filtered.length, 2);
  }, { model: { ...modelOf(), fixture: true } }));

  await check('Opening before search debounce commits the visible query and refreshes the background list', () => withPage(async ({ page, model }) => {
    // Only these current-list thumbnails are allowed while the fresh search
    // renders; audio, lyrics and per-track details remain forbidden throughout.
    model.allowedListCoverIds = new Set([1, 2, 3]);
    await revealLibraryTools(page);
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/tracks' && new URL(request.url()).searchParams.get('q') === '周杰伦');
    await page.evaluate(() => {
      const input = document.getElementById('tracks-q'); input.value = '周杰伦'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-filtered-selection').click();
    });
    await request; await phase(page, 'ready');
    assert.equal(model.filtered[0].body.query.q, '周杰伦');
    await close(page);
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    assert.equal(await page.locator('#tracks-q').inputValue(), '周杰伦');
    assert.ok((await page.locator('#tracks-tbody').textContent()).includes('周杰伦'));
    await flush(page);
  }, { model: { ...modelOf(), fixture: true } }));

  await check('The API rejects pre-aborted requests before fetch and preserves structured errors as readable details', () => withPage(async ({ page }) => {
    const result = await page.evaluate(async query => {
      const module = await import('/api.js'), previous = window.fetch; let fetches = 0;
      const errors = [];
      try {
        window.fetch = async () => { fetches++; return new Response('{}', { status: 200 }); };
        const controller = new AbortController(); controller.abort();
        for (const run of [() => module.request('/api/tracks/filtered-selection', { signal: controller.signal }), () => module.api.filteredSelection({ query }, { signal: controller.signal })]) {
          try { await run(); errors.push({ success: true }); } catch (error) { errors.push({ name: error.name, message: error.message, detail: error.detail, status: error.status }); }
        }
        const preAbortedFetches = fetches;
        window.fetch = async () => new Response(JSON.stringify({ detail: { code: 'selection_changed', message: '受控曲库变化' } }), { status: 409 });
        let structured;
        try { await module.api.filteredSelection({ query }); } catch (error) { structured = { name: error.name, code: error.code, detail: error.detail, status: error.status }; }
        return { preAbortedFetches, errors, structured };
      } finally { window.fetch = previous; }
    }, defaults);
    assert.equal(result.preAbortedFetches, 0);
    for (const error of result.errors) { assert.equal(error.name, 'ApiError'); assert.equal(error.status, 0); assert.match(error.message, /取消/); assert.equal(typeof error.detail, 'string'); }
    assert.deepEqual(result.structured, { name: 'ApiError', code: 'selection_changed', detail: '受控曲库变化', status: 409 });
  }));

  await check('Aborting after headers cancels the pending body and closing ignores a body that arrives late', () => withPage(async ({ page, model }) => {
    const direct = await page.evaluate(async query => {
      const { api } = await import('/api.js'), previous = window.fetch;
      let enter, finish, internalSignal;
      const entered = new Promise(resolve => { enter = resolve; });
      try {
        window.fetch = async (_input, options) => ({ ok: true, status: 200, text: () => {
          internalSignal = options.signal; enter();
          return new Promise((resolve, reject) => { finish = resolve; internalSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
        } });
        const controller = new AbortController();
        const result = api.filteredSelection({ query }, { signal: controller.signal }).then(() => ({ success: true }), error => ({ name: error.name, message: error.message, detail: error.detail }));
        await entered; controller.abort();
        const aborted = internalSignal.aborted;
        // Also release on a broken implementation so the test fails without a
        // timeout instead of depending on its network abort to reject.
        finish(JSON.stringify({ unexpected: 'late body' }));
        return { aborted, result: await result };
      } finally { window.fetch = previous; }
    }, defaults);
    assert.equal(direct.aborted, true); assert.equal(direct.result.name, 'ApiError'); assert.match(direct.result.message, /取消/);
    await seed(page, rowsOf(1, 9000)); const before = await selected(page);
    const snapshot = snapshotOf(defaults, model.rows);
    await page.evaluate(({ endpoint, snapshot }) => {
      const previous = window.fetch;
      window.filteredBodyGate = { entered: false, aborted: false, release: null, delivered: false };
      window.fetch = async (input, options) => {
        if (new URL(input, location.href).pathname !== endpoint) return previous(input, options);
        return { ok: true, status: 200, text: () => {
          const gate = window.filteredBodyGate; gate.entered = true;
          options.signal.addEventListener('abort', () => { gate.aborted = true; });
          return new Promise(resolve => { gate.release = () => { gate.delivered = true; resolve(JSON.stringify(snapshot)); }; });
        } };
      };
    }, { endpoint, snapshot });
    await open(page); await page.waitForFunction(() => window.filteredBodyGate.entered);
    await close(page); assert.equal(await page.evaluate(() => window.filteredBodyGate.aborted), true);
    await page.evaluate(() => window.filteredBodyGate.release()); await flush(page);
    assert.equal(await page.evaluate(() => window.filteredBodyGate.delivered), true); assert.deepEqual(await selected(page), before);
    assert.equal(await page.locator(dialog).count(), 0); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
  }));

  await check('Exactly 20000 candidates append once without rendering a full candidate table', () => withPage(async ({ page, model }) => {
    const before = await selected(page); await recordSelection(page); await prepare(page);
    assert.match((await page.locator('#filtered-selection-matched').textContent()).replaceAll(',', ''), /20000/);
    assert.ok(await page.locator(`${dialog} *`).count() < 150);
    await commit(page);
    assert.deepEqual((await selected(page)).ids, model.rows.map(row => row.id));
    assert.equal((await selected(page)).revision, before.revision + 1);
    assert.equal(await page.evaluate(() => window.filteredSelectionEvents.length), 1);
    assert.equal(await page.locator('.sr-track').count(), 50);
  }, { model: modelOf(20000) }));

  await check('Candidate and union limits reject the entire addition without truncating or issuing confirmation', async () => {
    for (const variant of ['server-limit', 'malformed-over-limit', 'union-limit', 'existing-over-limit']) await withPage(async ({ page, model }) => {
      if (variant === 'server-limit') plan(model, { status: 409, data: { detail: { code: 'selection_limit_exceeded', message: '匹配结果超过 20,000 首', limit: 20000, matched_at_least: 20001 } } });
      if (variant === 'malformed-over-limit') model.rows = rowsOf(20001);
      if (variant === 'union-limit') await seed(page, rowsOf(20000, 50000));
      if (variant === 'existing-over-limit') await seed(page, rowsOf(20001, 50000));
      const before = await selected(page); await recordSelection(page); await open(page);
      await page.waitForFunction(() => ['over-limit', 'error'].includes(document.querySelector('#filtered-selection-dialog')?.dataset.phase));
      assert.equal(await page.locator('#filtered-selection-confirm').isEnabled(), false);
      assert.deepEqual(await selected(page), before, variant); assert.equal(model.filtered.length, 1);
      assert.equal(await page.evaluate(() => window.filteredSelectionEvents.length), 0);
    }, { model: modelOf(2) });
  });

  await check('Empty results cannot confirm and fully selected results review without replacing snapshots', async () => {
    await withPage(async ({ page, model }) => {
      model.rows = []; const before = await selected(page); await open(page); await phase(page, 'empty');
      assert.equal(await page.locator('#filtered-selection-confirm').isEnabled(), false); assert.deepEqual(await selected(page), before);
    });
    await withPage(async ({ page, model }) => {
      await seed(page, [...model.rows].reverse().map(row => ({ ...row, title: `已选 ${row.id}` })));
      const before = await selected(page); await recordSelection(page); await prepare(page);
      assert.match(await page.locator('#filtered-selection-confirm').textContent(), /审阅当前选择/);
      await commit(page); assert.deepEqual(await selected(page), before);
      assert.equal(model.filtered.length, 2); assert.equal(await page.evaluate(() => window.filteredSelectionEvents.length), 0);
    }, { model: modelOf(3) });
  });

  await check('Malformed snapshots are rejected both during preparation and confirmation with no partial selection', async () => {
    const cases = [
      ['duplicate IDs', value => { value.items[1].id = value.items[0].id; }],
      ['missing row', value => { value.items.pop(); }],
      ['unsafe ID', value => { value.items[0].id = Number.MAX_SAFE_INTEGER + 1; }],
      ['string ID', value => { value.items[0].id = '1'; }],
      ['missing identity', value => { delete value.items[0].path; }],
      ['missing light field', value => { delete value.items[0].tags_loaded; }],
      ['wrong query', value => { value.query.folder = '/fixture-music/其他'; }],
      ['missing query field', value => { delete value.query.not_loaded; }],
      ['bad revision', value => { value.revision = 'short'; }],
      ['wrong limit', value => { value.limit = 19999; }],
      ['wrong total type', value => { value.total = String(value.total); }],
    ];
    for (const stage of ['prepare', 'confirm']) for (const [name, mutate] of cases) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page); await recordSelection(page);
      if (stage === 'confirm') await prepare(page);
      plan(model, { transform: value => { mutate(value); return value; } });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await phase(page, 'error'); assert.deepEqual(await selected(page), before, `${stage}: ${name}`);
      assert.equal(await page.evaluate(() => window.filteredSelectionEvents.length), 0);
      assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('Changed revisions, same-count membership changes and changed light fields cannot pass confirmation', async () => {
    for (const variant of ['server-revision', 'different-revision', 'same-count-replacement', 'changed-label', 'changed-order']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page); await prepare(page);
      if (variant === 'server-revision') plan(model, { status: 409, data: { detail: { code: 'selection_changed', message: '曲库结果已变化' } } });
      else plan(model, { transform: value => {
        if (variant === 'different-revision') value.revision = 'f'.repeat(64);
        if (variant === 'same-count-replacement') value.items[1] = rowsOf(1, 8000)[0];
        if (variant === 'changed-label') value.items[1].path = '/fixture-music/新路径.flac';
        if (variant === 'changed-order') value.items.reverse();
        return value;
      } });
      await page.locator('#filtered-selection-confirm').click();
      await page.waitForFunction(() => ['stale', 'error'].includes(document.querySelector('#filtered-selection-dialog')?.dataset.phase));
      assert.deepEqual(await selected(page), before, variant); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('Every raw text input invalidates preparation and confirmation before debounce including ABA and spaces', async () => {
    for (const stage of ['prepare', 'confirm']) for (const input of ['tracks-q', 'filter-artist', 'filter-album', 'filter-genre', 'filter-year']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page);
      if (stage === 'confirm') await prepare(page);
      const delay = gate(); plan(model, { gate: delay });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await entered(delay);
      const immediate = await page.evaluate(id => {
        const input = document.getElementById(id), original = input.value;
        for (const value of [`${original} `, original]) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
        return document.querySelector('#filtered-selection-dialog')?.dataset.phase;
      }, input);
      assert.equal(immediate, 'stale', `${stage} ${input} must expire before a debounce can run`);
      await release(page, delay); assert.deepEqual(await selected(page), before);
      assert.equal(await page.locator('#selection-review-dialog').count(), 0);
      assert.equal(await page.evaluate(index => window.filteredFetchEvents[index].aborted, delay.index), true);
    }, { model: modelOf(3) });
  });

  await check('Scope changes from sorting, directories, artist and album groups and quick filters reject old confirmed snapshots', async () => {
    for (const mutation of ['sort-ABA', 'folder', 'album-group', 'artist-group', 'quick-filter']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page); await prepare(page);
      const delay = gate(); plan(model, { gate: delay }); await page.locator('#filtered-selection-confirm').click(); await entered(delay);
      await page.evaluate(async mutation => {
        const tracks = await import('/tracks.js');
        if (mutation === 'sort-ABA') {
          const node = document.getElementById('tracks-sort'), original = node.value;
          for (const value of ['title', original]) { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }
        } else if (mutation === 'folder') tracks.setFolderScope({ folder: '/fixture-music/  新目录  ', recursive: false });
        else if (mutation === 'album-group') tracks.setAlbumScope({ album: '新专辑', album_artist: '新歌手' });
        else if (mutation === 'artist-group') tracks.setArtistScope('  新歌手\u00a0  ');
        else document.querySelector('[data-quick-filter="missing_cover"]').click();
      }, mutation);
      await phase(page, 'stale'); await release(page, delay); assert.deepEqual(await selected(page), before, mutation);
    }, { model: modelOf(3) });
  });

  await check('Selection membership ABA invalidates both stages while metadata-only updates remain preserved', async () => {
    for (const stage of ['prepare', 'confirm']) await withPage(async ({ page, model }) => {
      await seed(page, [rowsOf(1, 9000)[0], model.rows[1]]); const before = await selected(page);
      if (stage === 'confirm') await prepare(page);
      const delay = gate(); plan(model, { gate: delay });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await entered(delay);
      await page.evaluate(async () => { const store = await import('/store.js'), row = store.state.selection.get(2); store.removeFromSelection([2]); store.selectRows([row]); });
      await phase(page, 'stale'); await release(page, delay);
      assert.deepEqual((await selected(page)).ids, before.ids); assert.deepEqual((await selected(page)).rows, before.rows);
      assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
    await withPage(async ({ page, model }) => {
      await seed(page, [rowsOf(1, 9000)[0], { ...model.rows[1], title: '最初选择' }]); const before = await selected(page);
      await prepare(page); const delay = gate(); plan(model, { gate: delay });
      await page.locator('#filtered-selection-confirm').click(); await entered(delay);
      await page.evaluate(async () => (await import('/store.js')).updateTrackSnapshot({ id: 2, title: '准备期间的新快照', path: '/fixture-music/最新/2.flac' }, { partial: true }));
      assert.equal(await page.locator(dialog).getAttribute('data-phase'), 'checking');
      await release(page, delay); await page.locator('#selection-review-dialog').waitFor();
      const after = await selected(page); assert.deepEqual(after.ids, [9001, 2, 1, 3]);
      assert.equal(after.rows[1].title, '准备期间的新快照'); assert.equal(after.rows[1].path, '/fixture-music/最新/2.flac');
      assert.equal(after.revision, before.revision + 1);
    }, { model: modelOf(3) });
  });

  await check('Paging, density and same-scope refresh do not invalidate a pending selection', () => withPage(async ({ page, model }) => {
    await prepare(page); const delay = gate(); plan(model, { gate: delay }); await page.locator('#filtered-selection-confirm').click(); await entered(delay);
    await page.evaluate(async () => {
      const { state } = await import('/store.js'), tracks = await import('/tracks.js');
      state.tracks.page = 2; state.tracks.page_size = 50; state.tracks.view = 'cards'; state.tracks.density = 'compact';
      await tracks.refresh();
    });
    assert.equal(await page.locator(dialog).getAttribute('data-phase'), 'checking');
    await release(page, delay); await page.locator('#selection-review-dialog').waitFor(); assert.equal((await selected(page)).ids.length, model.rows.length);
  }));

  await check('Cancel, Escape and close ignore late prepare or confirm responses and return visible focus', async () => {
    for (const stage of ['prepare', 'confirm']) for (const action of ['cancel', 'escape', 'close', 'native-close']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page);
      if (stage === 'confirm') await prepare(page);
      const delay = gate(); plan(model, { gate: delay });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await entered(delay);
      if (action === 'escape') { await page.keyboard.press('Escape'); await page.locator(dialog).waitFor({ state: 'detached' }); }
      else if (action === 'native-close') { await page.locator(dialog).evaluate(node => node.close()); await page.locator(dialog).waitFor({ state: 'detached' }); }
      else await close(page, action === 'close' ? '#filtered-selection-close' : '#filtered-selection-cancel');
      const focus = await page.evaluate(() => ({ id: document.activeElement.id, visible: document.activeElement.getClientRects().length > 0, disabled: document.activeElement.matches(':disabled') }));
      assert.ok(['btn-filtered-selection', 'library-tools-toggle', 'tracks-q'].includes(focus.id) && focus.visible && !focus.disabled, JSON.stringify(focus));
      await release(page, delay); assert.deepEqual(await selected(page), before);
      assert.equal(await page.locator(dialog).count(), 0); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('A reopened operation cannot adopt the earlier operation after its delayed response arrives', () => withPage(async ({ page, model }) => {
    const first = gate(); plan(model, { gate: first }); await open(page); await entered(first); await close(page);
    model.rows = rowsOf(4, 100); await prepare(page); const before = await selected(page);
    await release(page, first); assert.equal(await page.locator(dialog).getAttribute('data-phase'), 'ready');
    assert.match(await page.locator('#filtered-selection-matched').textContent(), /4/); assert.deepEqual(await selected(page), before);
    await commit(page); assert.deepEqual((await selected(page)).ids, [101, 102, 103, 104]);
  }, { model: modelOf(3) }));

  await check('Native close or removal wins when the verified body arrives in the same task', async () => {
    for (const action of ['close', 'remove']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page); await prepare(page);
      const response = snapshotOf(model.filtered[0].body.query, model.rows);
      await page.evaluate(({ endpoint, response }) => {
        const previous = window.fetch; window.filteredNativeCloseGate = { entered: false, release: null };
        window.fetch = async (input, options) => {
          if (new URL(input, location.href).pathname !== endpoint) return previous(input, options);
          return { ok: true, status: 200, text: () => new Promise(resolve => {
            window.filteredNativeCloseGate.entered = true;
            window.filteredNativeCloseGate.release = () => resolve(JSON.stringify(response));
          }) };
        };
      }, { endpoint, response });
      await page.locator('#filtered-selection-confirm').click(); await page.waitForFunction(() => window.filteredNativeCloseGate.entered);
      await page.evaluate(action => {
        document.getElementById('filtered-selection-dialog')[action]();
        window.filteredNativeCloseGate.release();
      }, action);
      await flush(page); assert.deepEqual(await selected(page), before, action);
      assert.equal(await page.locator(dialog).count(), 0); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('Synchronous native focus restoration cannot append after it changes selection membership', () => withPage(async ({ page, model }) => {
    await seed(page, rowsOf(1, 9000)); await revealLibraryTools(page);
    // showModal remembers this visible summary as its native focus return.
    await page.locator('#library-tools-toggle').focus();
    await page.locator('#btn-filtered-selection').evaluate(node => node.click()); await phase(page, 'ready');
    const delay = gate(); plan(model, { gate: delay }); await page.locator('#filtered-selection-confirm').click(); await entered(delay);
    await page.evaluate(async row => {
      const store = await import('/store.js'); window.filteredNativeFocusChanged = false;
      document.getElementById('library-tools-toggle').addEventListener('focus', () => {
        window.filteredNativeFocusChanged = true; store.selectRows([row]);
      }, { once: true });
    }, rowsOf(1, 9998)[0]);
    await release(page, delay); await page.locator(dialog).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.filteredNativeFocusChanged), true, 'The test must exercise a synchronous native focus listener');
    assert.deepEqual((await selected(page)).ids, [9001, 9999], 'Only the listener change is allowed; the prepared candidates stay unapplied');
    assert.equal(await page.locator('#selection-review-dialog').count(), 0);
  }, { model: modelOf(3) }));

  await check('Hash navigation and application replaceState navigation close both in-flight stages', async () => {
    for (const stage of ['prepare', 'confirm']) for (const navigation of ['hash', 'replaceState']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page);
      if (stage === 'confirm') await prepare(page);
      const delay = gate(); plan(model, { gate: delay });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await entered(delay);
      await page.evaluate(navigation => {
        if (navigation === 'hash') location.hash = '#settings';
        else document.querySelector('.tab[data-tab="collections"]').click();
      }, navigation);
      await page.locator(dialog).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.body.dataset.page !== 'tracks');
      await release(page, delay); assert.deepEqual(await selected(page), before);
      assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('401 responses and session expiry clear snapshots and cannot be revived by a delayed operation', async () => {
    for (const stage of ['prepare', 'confirm']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); if (stage === 'confirm') await prepare(page);
      const delay = gate(); plan(model, { gate: delay, status: 401, data: { detail: '登录已过期' } });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await entered(delay); await release(page, delay);
      await page.locator('#auth-veil').waitFor({ state: 'visible' }); await page.locator(dialog).waitFor({ state: 'detached' });
      assert.deepEqual((await selected(page)).ids, []); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
    await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); await prepare(page); const delay = gate(); plan(model, { gate: delay });
      await page.locator('#filtered-selection-confirm').click(); await entered(delay);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('metatidy:unauthorized', { detail: '测试会话已过期' })));
      await page.locator(dialog).waitFor({ state: 'detached' }); await release(page, delay);
      assert.deepEqual((await selected(page)).ids, []); assert.equal(await page.locator('#selection-review-dialog').count(), 0);
    }, { model: modelOf(3) });
  });

  await check('Read failures leave selection untouched and retry requires an explicit action with the original scope', async () => {
    for (const stage of ['prepare', 'confirm']) await withPage(async ({ page, model }) => {
      await seed(page, rowsOf(1, 9000)); const before = await selected(page);
      if (stage === 'confirm') await prepare(page);
      plan(model, { status: 503, data: { detail: '受控索引服务暂不可用' } });
      if (stage === 'prepare') await open(page); else await page.locator('#filtered-selection-confirm').click();
      await phase(page, 'error'); assert.deepEqual(await selected(page), before);
      const count = model.filtered.length; await flush(page); assert.equal(model.filtered.length, count);
      await page.locator('#filtered-selection-retry').click();
      if (stage === 'prepare') {
        await phase(page, 'ready'); assert.deepEqual(await selected(page), before);
        assert.equal(model.filtered.at(-1).body.revision, undefined, 'A failed preparation must still require confirmation after retry');
      } else {
        await page.locator('#selection-review-dialog').waitFor();
        assert.deepEqual(model.filtered.at(-1).body, model.filtered[count - 1].body, 'A requested verification retry must retain the original query and revision');
      }
      assert.equal(model.filtered.length, count + 1);
    }, { model: modelOf(3) });
  });

  await check('Dialog focus, finite motion and actionable footer fit phones, landscape and desktop in both themes', async () => {
    for (const [width, height] of [[320, 480], [390, 844], [844, 390], [1440, 900]]) for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['reduce', 'no-preference']) {
      await withPage(async ({ page, model }) => {
        const longFolder = `/fixture-music/  ${'收藏 空格%_ '.repeat(32)}尾部  `;
        for (const row of model.rows.slice(0, 3)) { row.title = '超长曲名与未截断的选择范围 '.repeat(35); row.artist = '艺术家 '.repeat(20); row.album = '专辑 '.repeat(20); }
        await page.evaluate(async folder => (await import('/tracks.js')).setFolderScope({ folder, recursive: false }), longFolder);
        const loading = gate(); plan(model, { gate: loading }); await open(page); await entered(loading);
        const motion = await motionDone(page);
        assert.equal(motion.running, 0);
        for (const timing of motion.timing) assert.ok(Number.isFinite(timing.duration) && timing.iterations === 1 && timing.duration + timing.delay <= 500, JSON.stringify(timing));
        if (reducedMotion === 'reduce') assert.deepEqual(motion.timing, []);
        await geometry(page, ['filtered-selection-cancel']); await validFocus(page);
        await page.locator('#filtered-selection-cancel').focus(); await release(page, loading); await phase(page, 'ready');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'filtered-selection-cancel');
        const scope = page.locator('#filtered-selection-scope strong').filter({ hasText: longFolder });
        assert.equal(await scope.textContent(), `${longFolder}（仅本层）`);
        assert.equal(await scope.getAttribute('title'), `${longFolder}（仅本层）`, 'The complete path remains available when a long summary is visually clamped');
        await geometry(page, ['filtered-selection-confirm', 'filtered-selection-cancel']);
        await page.locator('#filtered-selection-close').focus(); await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'filtered-selection-confirm');
        await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'filtered-selection-close');
        await page.screenshot({ path: path.join(output, `filtered-selection-${width}x${height}-${colorScheme}-${reducedMotion}.png`) });
        const checking = gate(); plan(model, { gate: checking }); await page.locator('#filtered-selection-confirm').click(); await entered(checking);
        await geometry(page, ['filtered-selection-cancel']); await validFocus(page);
        await close(page); await release(page, checking); assert.deepEqual((await selected(page)).ids, []);
      }, { model: modelOf(407), viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} filtered selection checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
