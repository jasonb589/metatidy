/** Browser acceptance for filename proposals, immutable previews and recoverable jobs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFilenameTagsFixture } from './filename-tags-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Use the installed local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_FILENAME_UI_PORT || 18989), base = `http://127.0.0.1:${port}`;
const prefix = '/api/tracks/filename-tags', dialog = '#filename-tags-dialog', standard = '{track} - {artist} - {title}';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred(), index: -1 });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rowsOf = (count = 105, offset = 0) => Array.from({ length: count }, (_, index) => {
  const id = offset + index + 1, filename = `${String(id).padStart(3, '0')} - 候选歌手 ${id} - 候选曲名 ${id}.flac`;
  return { id, path: `/fixture-music/文件名提取/${filename}`, dir: '/fixture-music/文件名提取', filename, ext: 'flac',
    title: `索引标题 ${id}`, artist: `索引歌手 ${id}`, album: '测试专辑', albumartist: '', genre: '', year: '',
    track: '', disc: '', language: '中文', albumtype: '', has_cover: 0, has_lyrics: 0, duration: 180,
    indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000, size: 123456, tags_loaded: true, path_derived: false,
    fixture_current: { title: '', artist: '', track: '' } };
});
function modelOf(count = 105, options = {}) {
  const rows = rowsOf(count), fixture = createFilenameTagsFixture(rows, options);
  return { rows, fixture, calls: [], workflow: [], responses: [], gates: [], fixtureServer: false, start: 0 };
}
let server, browser, passed = 0;
const failures = [];
async function check(name, action) {
  if (process.env.METATIDY_FILENAME_UI_CHECK && !name.includes(process.env.METATIDY_FILENAME_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
function response(model, stage, value = {}) {
  model.responses.push({ stage, ...value }); if (value.gate) model.gates.push(value.gate); return value;
}
async function entered(delay) {
  let timer;
  try { await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected filename request did not start')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, delay) {
  delay.release.resolve(); await delay.done.promise;
  await page.waitForFunction(index => window.filenameFetchEvents[index]?.returned === true, delay.index);
  await flush(page);
}
async function withPage(action, { model = modelOf(), ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  // Deliver even aborted bodies: lifecycle checks must not pass merely because
  // the network cancellation hid a late reply from the application.
  await page.addInitScript(prefix => {
    const fetch = window.fetch.bind(window); window.filenameFetchEvents = [];
    window.fetch = (input, options = {}) => {
      if (!new URL(typeof input === 'string' ? input : input.url, location.href).pathname.startsWith(`${prefix}/`)) return fetch(input, options);
      const event = { returned: false, aborted: Boolean(options.signal?.aborted) }; window.filenameFetchEvents.push(event);
      options.signal?.addEventListener('abort', () => { event.aborted = true; });
      return fetch(input, { ...options, signal: undefined }).then(result => {
        const text = result.text.bind(result);
        result.text = async () => { const body = await text(); event.returned = true; return body; }; return result;
      }).catch(error => { event.returned = true; throw error; });
    };
  }, prefix);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const call = { path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : {}, query: Object.fromEntries(url.searchParams) };
    model.calls.push(call);
    if (!model.fixtureServer && call.path === '/api/tracks') return route.fulfill({ json: { items: model.rows.slice(0, 18), total: model.rows.length, page: 1, page_size: 18, pages: Math.ceil(model.rows.length / 18) } });
    if (!call.path.startsWith(`${prefix}/`)) return route.continue();
    const index = model.workflow.length; model.workflow.push(call);
    if (model.fixtureServer) return route.continue();
    const stage = call.path.startsWith(`${prefix}/plans/`) ? 'plan' : call.path.split('/').at(-1);
    const pendingIndex = model.responses.findIndex(value => value.stage === stage), next = pendingIndex < 0 ? null : model.responses.splice(pendingIndex, 1)[0];
    let result, status = next?.status || 200;
    try {
      if (next?.data !== undefined) result = next.data;
      else result = model.fixture.handle(call.path, call.method, url.searchParams, call.body);
      if (next?.transform) result = next.transform(result, call);
    } catch (error) { result = { detail: error.detail || error.message }; status = error.status || 500; }
    try {
      if (next?.gate) { next.gate.index = index; next.gate.entered.resolve(); await next.gate.release.promise; }
      if (next?.abort) return await route.abort('connectionreset');
      return await route.fulfill({ status, json: result });
    } catch (error) { if (!page.isClosed() && !next?.gate) throw error; }
    finally { next?.gate?.done.resolve(); }
  });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base); await page.locator('#tracks-tbody tr[data-id]').first().waitFor(); await flush(page); model.start = model.calls.length;
    await action({ page, context, model });
    assert.deepEqual(errors, [], 'Filename-tag workflow must not raise browser errors');
    assert.deepEqual(model.calls.filter(call => !['GET', 'HEAD'].includes(call.method) && ![`${prefix}/parse`, `${prefix}/preview`, `${prefix}/apply`].includes(call.path)), [], 'Workflow must not call legacy tag writes, scans or other mutating APIs');
    assert.deepEqual(model.calls.slice(model.start).filter(call => /^\/api\/tracks\/\d+(?:\/(?:audio|cover|lyrics))?$/.test(call.path)), [], 'Workflow must not load audio, covers, lyrics or legacy per-track detail endpoints');
  } finally { for (const delay of model.gates) delay.release.resolve(); await context.close(); }
}
async function phase(page, value) { await page.waitForFunction(value => document.querySelector('#filename-tags-dialog')?.dataset.phase === value, value); }
async function selected(page) { return page.evaluate(async () => { const store = await import('/store.js'); return { ids: store.selectionIds(), rows: store.selectionRows(), revision: store.selectionRevision() }; }); }
async function seed(page, rows) { await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, rows); }
async function open(page, rows, { real = false } = {}) {
  await seed(page, rows);
  if (real) { await page.locator('#selection-review').click(); await page.locator('#selection-review-filename-tags').click(); }
  else await page.evaluate(async () => {
    const store = await import('/store.js'), workflow = await import('/filename-tags.js');
    workflow.openFilenameTags({ rows: store.selectionRows(), revision: store.selectionRevision() });
  });
  await page.locator(`${dialog}[open]`).waitFor();
}
async function analyze(page, template = standard) {
  if (await page.locator('#filename-tags-template').inputValue() !== template) await page.locator('#filename-tags-template').fill(template);
  await page.locator('#filename-tags-analyze').click(); await phase(page, 'analysis-ready');
}
async function preview(page) { await page.locator('#filename-tags-preview').click(); await phase(page, 'preview-ready'); }
async function prepare(page, rows, template = standard) { await open(page, rows); await analyze(page, template); await preview(page); }
async function close(page) { await page.locator('#filename-tags-close').click(); await page.locator(dialog).waitFor({ state: 'detached' }); }
async function validFocus(page) {
  const focus = await page.evaluate(() => {
    const node = document.activeElement;
    return { id: node.id, valid: Boolean(document.getElementById('filename-tags-dialog')?.contains(node)) && node.getClientRects().length > 0 && !node.matches(':disabled') && !node.closest('[inert]') };
  });
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
    return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, rect: rect.toJSON(), overflow: node.scrollWidth > node.clientWidth + 1,
      controls: controls.map(id => { const button = document.getElementById(id), box = button.getBoundingClientRect();
        return { id, enabled: !button.disabled, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          reached: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button }; }) };
  }, controls);
  assert.ok(result.pageWidth <= result.width + 1 && !result.overflow && result.rect.left >= 0 && result.rect.right <= result.width && result.rect.top >= 0 && result.rect.bottom <= result.height, JSON.stringify(result));
  for (const item of result.controls) assert.ok(item.enabled && item.reached && item.left >= 0 && item.right <= result.width && item.top >= 0 && item.bottom <= result.height, JSON.stringify(item));
}
const callsFor = (model, stage) => model.workflow.filter(call => stage === 'plan' ? call.path.startsWith(`${prefix}/plans/`) : call.path === `${prefix}/${stage}`);
const card = (page, id) => page.locator(`.ft-track[data-track-id="${id}"]`);

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Filename-tag fixture timeout')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Real selection review opens a fixed complete scope with explicit analysis and safe defaults', () => withPage(async ({ page, model }) => {
    await seed(page, model.rows); const before = await selected(page);
    await page.locator('#selection-review').click(); await page.locator('#selection-review-q').fill('索引标题 105');
    assert.equal(await page.locator('.sr-track').count(), 1);
    await page.locator('#selection-review-filename-tags').click(); await phase(page, 'template');
    assert.equal(model.workflow.length, 0); assert.match(await page.locator('#filename-tags-description').textContent(), /105/);
    assert.equal(await page.locator('#filename-tags-overwrite').isChecked(), false); assert.equal(await page.locator('#filename-tags-normalize').isChecked(), false);
    await analyze(page);
    assert.deepEqual(callsFor(model, 'parse')[0].body, { ids: model.rows.map(row => row.id), template: standard });
    assert.equal(await page.locator('.ft-track').count(), 50); assert.equal(await page.locator('#filename-tags-count-total').textContent(), '105');
    assert.equal(callsFor(model, 'preview').length, 0); assert.equal(callsFor(model, 'apply').length, 0);
    assert.deepEqual(await selected(page), before); await validFocus(page);
  }));

  await check('Fixture route preserves every ID and previews existing tags without a write', () => withPage(async ({ page, model }) => {
    model.fixtureServer = true;
    const result = await page.request.get(`${base}/api/tracks`), tracks = (await result.json()).items;
    await open(page, tracks.slice(0, 3)); await analyze(page, '{track} - {title}'); await preview(page);
    assert.equal(await page.locator('.ft-track[data-status="unchanged"]').count(), 3);
    assert.match(await page.locator('#filename-tags-status').textContent(), /没有需要写入/);
    assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false);
    assert.equal(callsFor(model, 'apply').length, 0);
  }, { model: modelOf(3) }));

  await check('Ambiguous, unmatched and missing indexed files remain visible and excluded from preview', () => withPage(async ({ page, model }) => {
    model.rows[0].filename = '艺术家 - 曲名.flac'; model.rows[1].filename = 'A - B - C.flac'; model.rows[2].filename = '没有分隔符.flac';
    const missing = { ...rowsOf(1, 9000)[0] };
    await open(page, [...model.rows, missing]); const before = await selected(page); await analyze(page, '{artist} - {title}');
    assert.deepEqual(await page.locator('.ft-track').evaluateAll(nodes => nodes.map(node => [Number(node.dataset.trackId), node.dataset.status])), [[1, 'matched'], [2, 'ambiguous'], [3, 'unmatched'], [9001, 'index_missing']]);
    for (const id of [2, 3, 9001]) assert.equal(await page.locator(`[data-include-id="${id}"]`).isDisabled(), true);
    await preview(page); assert.deepEqual(callsFor(model, 'preview')[0].body.include_ids, [1]);
    assert.deepEqual(callsFor(model, 'preview')[0].body.ids, [1, 2, 3, 9001]);
    assert.equal(await page.locator('.ft-track').count(), 4); assert.deepEqual(await selected(page), before);
  }, { model: modelOf(3) }));

  await check('Template validation errors stay recoverable and never read tags automatically', async () => {
    for (const template of ['{artist}{title}', '{title} - {title}', '{composer}', '{artist} - {title']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); await page.locator('#filename-tags-template').fill(template); await page.locator('#filename-tags-analyze').click(); await phase(page, 'error');
      assert.equal(callsFor(model, 'preview').length, 0); assert.equal(callsFor(model, 'apply').length, 0);
      await page.locator('#filename-tags-template').fill(standard); await analyze(page); assert.equal(await page.locator('.ft-track').count(), 3);
    }, { model: modelOf(3) });
  });

  await check('Pagination, row 51 exclusions and last-row search never shrink the fixed submission scope', () => withPage(async ({ page, model }) => {
    await open(page, model.rows); const before = await selected(page); await analyze(page);
    await page.locator('#filename-tags-next').click(); assert.equal(await card(page, 51).count(), 1);
    await page.locator('[data-include-id="51"]').uncheck();
    await page.locator('#filename-tags-search').fill('候选曲名 105'); await page.locator('[data-include-id="105"]').uncheck();
    assert.equal(await page.locator('.ft-track').count(), 1);
    await preview(page);
    const body = callsFor(model, 'preview')[0].body;
    assert.deepEqual(body.ids, model.rows.map(row => row.id)); assert.deepEqual(body.include_ids, body.ids.filter(id => ![51, 105].includes(id)));
    assert.equal(body.overwrite, false); assert.equal(body.normalize_artist, false);
    assert.equal(await card(page, 105).getAttribute('data-status'), 'excluded');
    await page.locator('#filename-tags-search').fill(''); assert.equal(await page.locator('.ft-track').count(), 50);
    await page.locator('#filename-tags-next').click(); assert.equal(await page.locator('[data-include-id="51"]').isChecked(), false);
    assert.deepEqual(await selected(page), before); assert.equal(callsFor(model, 'apply').length, 0);
  }));

  await check('Bulk inclusion affects the entire analysis even while viewing a filtered row', () => withPage(async ({ page, model }) => {
    await open(page, model.rows); await analyze(page); await page.locator('#filename-tags-search').fill('候选曲名 105');
    await page.locator('#filename-tags-exclude-all').click(); assert.equal(await page.locator('#filename-tags-preview').isDisabled(), true);
    assert.equal(await page.locator('#filename-tags-count-matched').textContent(), '0');
    await page.locator('#filename-tags-include-ready').click(); await preview(page);
    assert.equal(callsFor(model, 'preview')[0].body.include_ids.length, 105);
    assert.equal((await selected(page)).ids.length, 105);
  }));

  await check('Exactly 500 IDs are retained while 501 are rejected without truncation or requests', async () => {
    await withPage(async ({ page, model }) => {
      await open(page, model.rows); await analyze(page); await preview(page);
      assert.equal(callsFor(model, 'parse')[0].body.ids.length, 500); assert.equal(callsFor(model, 'preview')[0].body.include_ids.length, 500);
      await page.locator('#filename-tags-search').fill('候选曲名 500'); assert.equal(await card(page, 500).count(), 1);
    }, { model: modelOf(500) });
    await withPage(async ({ page, model }) => {
      await open(page, model.rows, { real: true }); await phase(page, 'over-limit');
      assert.match(await page.locator('#filename-tags-status').textContent(), /501/); assert.match(await page.locator('#filename-tags-status').textContent(), /500/);
      assert.equal(model.workflow.length, 0); assert.equal((await selected(page)).ids.length, 501);
    }, { model: modelOf(501) });
  });

  await check('Preview shows real current tags, proposed values, retained fields and unreadable rows', () => withPage(async ({ page, model }) => {
    model.rows[0].fixture_current.artist = '文件里已有艺术家';
    model.rows[1].fixture_current = { title: '已有曲名', artist: '已有歌手', track: '2' };
    model.rows[2].fixture_read_error = '受控读取失败：云盘暂时不可用';
    await prepare(page, model.rows);
    assert.match(await card(page, 1).textContent(), /文件里已有艺术家/); assert.match(await card(page, 1).textContent(), /候选歌手 1/);
    assert.match(await card(page, 1).textContent(), /保留/); assert.equal(await card(page, 2).getAttribute('data-status'), 'unchanged');
    assert.equal(await card(page, 3).getAttribute('data-status'), 'unreadable'); assert.match(await card(page, 3).textContent(), /云盘暂时不可用/);
    assert.equal(await card(page, 3).locator('.ft-field-row').count(), 0, 'A failed real read must never display fabricated empty current tags');
    assert.equal(await card(page, 3).locator('.ft-field-chip').count(), 3);
    assert.match(await page.locator('#filename-tags-confirm').textContent(), /1/);
    assert.equal(callsFor(model, 'apply').length, 0);
  }, { model: modelOf(3) }));

  await check('Every template, option and inclusion edit invalidates the old immutable preview', async () => {
    for (const edit of ['template', 'overwrite', 'normalize', 'include']) await withPage(async ({ page, model }) => {
      await prepare(page, model.rows); const first = [...model.fixture.plans.values()][0];
      if (edit === 'template') { await page.locator('#filename-tags-template').fill('{title}'); await phase(page, 'template'); await analyze(page, '{title}'); }
      else if (edit === 'include') await page.locator('[data-include-id="3"]').uncheck();
      else await page.locator(`#filename-tags-${edit}`).check();
      assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); assert.equal(callsFor(model, 'apply').length, 0);
      await preview(page); const second = [...model.fixture.plans.values()].at(-1); assert.notEqual(first.token, second.token);
      assert.equal(callsFor(model, 'preview').length, 2); assert.equal(callsFor(model, 'apply').length, 0);
    }, { model: modelOf(3) });
  });

  await check('Late parse and preview responses cannot restore ABA input changes', async () => {
    for (const stage of ['parse', 'preview']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); if (stage === 'preview') await analyze(page);
      const delay = gate(); response(model, stage, { gate: delay });
      await page.locator(stage === 'parse' ? '#filename-tags-analyze' : '#filename-tags-preview').click(); await entered(delay);
      await page.evaluate(({ stage, standard }) => {
        const node = document.getElementById(stage === 'parse' ? 'filename-tags-template' : 'filename-tags-overwrite');
        if (stage === 'parse') { node.value = '{title}'; node.dispatchEvent(new Event('input')); node.value = standard; node.dispatchEvent(new Event('input')); }
        else { node.checked = true; node.dispatchEvent(new Event('change')); node.checked = false; node.dispatchEvent(new Event('change')); }
      }, { stage, standard });
      await release(page, delay); await phase(page, stage === 'parse' ? 'template' : 'analysis-ready');
      assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); assert.equal(callsFor(model, 'apply').length, 0);
      if (stage === 'parse') await analyze(page); await preview(page);
      assert.equal(callsFor(model, stage).length, 2);
    }, { model: modelOf(3) });
  });

  await check('Explicit confirmation claims one immutable plan once even when clicked repeatedly', () => withPage(async ({ page, model }) => {
    await prepare(page, model.rows); const before = await selected(page), expected = [...model.fixture.plans.values()][0];
    const delay = gate(); response(model, 'apply', { gate: delay });
    await page.locator('#filename-tags-confirm').click(); await entered(delay); await phase(page, 'submitting');
    await page.locator('#filename-tags-confirm').evaluate(node => { node.click(); node.click(); });
    assert.equal(callsFor(model, 'apply').length, 1);
    const body = callsFor(model, 'apply')[0].body; assert.deepEqual(Object.keys(body).sort(), ['request_id', 'revision', 'token']);
    assert.equal(body.token, expected.token); assert.equal(body.revision, expected.revision); assert.match(body.request_id, /^[a-f\d]{8}-[a-f\d-]{27}$/i);
    await release(page, delay); await phase(page, 'results');
    assert.equal(await page.locator('.ft-track[data-status="written"]').count(), 3); assert.equal(callsFor(model, 'apply').length, 1);
    assert.deepEqual(await selected(page), before); assert.ok(callsFor(model, 'plan').length >= 1);
  }, { model: modelOf(3) }));

  await check('Uncertain apply responses recover the same saved plan without another write request', async () => {
    for (const accepted of [true, false]) await withPage(async ({ page, model }) => {
      await prepare(page, model.rows); response(model, 'apply', accepted ? { abort: true } : { abort: true, data: {} });
      await page.locator('#filename-tags-confirm').click(); await phase(page, 'submission-unknown');
      assert.equal(callsFor(model, 'apply').length, 1); assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false);
      await page.locator('#filename-tags-retry').click(); await phase(page, accepted ? 'results' : 'submission-unknown');
      await page.locator('#filename-tags-retry').click(); await phase(page, accepted ? 'results' : 'submission-unknown');
      assert.equal(callsFor(model, 'apply').length, 1); assert.equal(callsFor(model, 'plan').length, 2);
      assert.deepEqual([...new Set(callsFor(model, 'plan').map(call => call.path.split('/').at(-1)))], [callsFor(model, 'apply')[0].body.token]);
    }, { model: modelOf(3) });
  });

  await check('Definite server rejections discard confirmation and require a new explicit preview', async () => {
    for (const [status, code] of [[429, 'queue_full'], [409, 'plan_expired'], [409, 'plan_changed'], [404, 'plan_missing'], [409, 'no_changes']]) await withPage(async ({ page, model }) => {
      await prepare(page, model.rows); const first = [...model.fixture.plans.values()][0];
      response(model, 'apply', { status, data: { detail: { code, message: '服务器明确拒绝此计划' } } });
      await page.locator('#filename-tags-confirm').click(); await phase(page, 'stale');
      assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); assert.equal(callsFor(model, 'apply').length, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('metatidy-filename-tags-recovery')), null);
      await page.locator('#filename-tags-retry').click(); await phase(page, 'preview-ready');
      assert.equal(callsFor(model, 'apply').length, 1); assert.equal(callsFor(model, 'plan').length, 0);
      assert.notEqual([...model.fixture.plans.values()].at(-1).token, first.token);
    }, { model: modelOf(3) });
  });

  await check('Already-submitted response keeps the original plan read-only and never retries apply', () => withPage(async ({ page, model }) => {
    await prepare(page, model.rows);
    response(model, 'apply', { status: 409, transform: () => ({ detail: { code: 'already_submitted', message: '计划已经提交' } }) });
    await page.locator('#filename-tags-confirm').click(); await phase(page, 'submission-unknown');
    await page.locator('#filename-tags-retry').click(); await phase(page, 'results');
    assert.equal(callsFor(model, 'apply').length, 1); assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false);
  }, { model: modelOf(3) }));

  await check('Background progress and complete partial outcomes retain failures and exclusions', () => withPage(async ({ page, model }) => {
    model.rows[1].fixture_current = { title: '已有', artist: '已有', track: '2' };
    await open(page, model.rows); await analyze(page); await page.locator('[data-include-id="7"]').uncheck(); await preview(page);
    await page.locator('#filename-tags-confirm').click(); await phase(page, 'submitted');
    await page.waitForFunction(() => document.querySelector('.ft-track[data-status="pending"]'));
    const token = callsFor(model, 'apply')[0].body.token;
    model.fixture.settle(token, { 1: 'written', 3: { status: 'stale', reason: '文件在预览后被修改' }, 4: { status: 'failed', reason: '写入失败', stage: 'write' },
      5: { status: 'needs_verification', reason: '结果未能核验', stage: 'verify', file_changed: true }, 6: { status: 'not_started', reason: '任务已停止' } });
    await phase(page, 'results');
    assert.deepEqual(await page.locator('.ft-track').evaluateAll(nodes => nodes.map(node => node.dataset.status)), ['written', 'unchanged', 'stale', 'failed', 'needs_verification', 'not_started', 'excluded']);
    assert.match(await card(page, 5).textContent(), /核对/); assert.match(await page.locator('#filename-tags-status').textContent(), /不会自动重试/);
    await page.locator('#filename-tags-filter').selectOption('needs_verification'); assert.equal(await page.locator('.ft-track').count(), 1);
    await page.locator('#filename-tags-retry').click(); await phase(page, 'results'); assert.equal(callsFor(model, 'apply').length, 1);
    assert.equal((await selected(page)).ids.length, 7);
  }, { model: modelOf(7, { autoComplete: false }) }));

  await check('Reload recovery reads saved results and does not reopen a writable preview', () => withPage(async ({ page, model }) => {
    await prepare(page, model.rows); await page.locator('#filename-tags-confirm').click(); await phase(page, 'results');
    const token = callsFor(model, 'apply')[0].body.token; await close(page); await page.reload(); await page.locator('#tracks-tbody tr[data-id]').first().waitFor();
    await page.locator('#btn-jobs').click(); await page.locator('#jobs-filename-tags-resume').click(); await phase(page, 'results');
    assert.equal(callsFor(model, 'plan').at(-1).path, `${prefix}/plans/${token}`); assert.equal(callsFor(model, 'apply').length, 1);
    assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); assert.equal(await page.locator('.ft-track').count(), 3);
  }, { model: modelOf(3) }));

  await check('Explicit unresolved recovery opens only unfinished IDs with safe defaults and no automatic requests', () => withPage(async ({ page, model }) => {
    model.rows[1].fixture_current = { title: '候选曲名 2', artist: '候选歌手 2', track: '2' };
    await open(page, model.rows); await analyze(page); await page.locator('#filename-tags-overwrite').check(); await page.locator('#filename-tags-normalize').check();
    await page.locator('[data-include-id="7"]').uncheck(); await preview(page); const before = await selected(page);
    const delay = gate(); response(model, 'plan', { gate: delay }); await page.locator('#filename-tags-confirm').click(); await entered(delay);
    const token = callsFor(model, 'apply')[0].body.token;
    model.fixture.settle(token, { 3: 'stale', 4: 'failed', 5: { status: 'needs_verification', file_changed: true }, 6: 'not_started' });
    await release(page, delay); await phase(page, 'submitted');
    await phase(page, 'results'); assert.match(await page.locator('#filename-tags-recheck').textContent(), /4/);
    const requests = model.workflow.length; await page.locator('#filename-tags-search').fill('候选曲名 5');
    await page.locator('#filename-tags-recheck').click(); await phase(page, 'template');
    assert.equal(model.workflow.length, requests, 'Opening recheck cannot analyze, read tags or write automatically');
    assert.equal(await page.locator('#filename-tags-template').inputValue(), standard);
    assert.equal(await page.locator('#filename-tags-overwrite').isChecked(), false); assert.equal(await page.locator('#filename-tags-normalize').isChecked(), false);
    assert.match(await page.locator('#filename-tags-description').textContent(), /4/); assert.deepEqual(await selected(page), before);
    await analyze(page); assert.deepEqual(callsFor(model, 'parse').at(-1).body.ids, [3, 4, 5, 6]);
    await preview(page); assert.deepEqual(callsFor(model, 'preview').at(-1).body.ids, [3, 4, 5, 6]);
    assert.equal(callsFor(model, 'apply').length, 1); assert.deepEqual(await selected(page), before);
  }, { model: modelOf(7, { autoComplete: false }) }));

  await check('Native close focus listeners cannot reopen unresolved recovery after selection changes', () => withPage(async ({ page, model }) => {
    await page.locator('#tracks-q').focus(); await prepare(page, model.rows);
    const delay = gate(); response(model, 'plan', { gate: delay }); await page.locator('#filename-tags-confirm').click(); await entered(delay);
    model.fixture.settle(callsFor(model, 'apply')[0].body.token, { 3: 'failed' }); await release(page, delay); await phase(page, 'results');
    await page.evaluate(async () => {
      const store = await import('/store.js'); window.filenameNativeFocusChanged = false;
      document.getElementById('tracks-q').addEventListener('focus', () => { window.filenameNativeFocusChanged = true; store.clearSelection(); }, { once: true });
    });
    await page.locator('#filename-tags-recheck').click(); await page.locator(dialog).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.filenameNativeFocusChanged), true, 'Must exercise synchronous native focus restoration');
    assert.deepEqual((await selected(page)).ids, []); assert.equal(callsFor(model, 'apply').length, 1);
  }, { model: modelOf(3, { autoComplete: false }) }));

  await check('JSON map serialization order cannot invalidate an unchanged saved plan', () => withPage(async ({ page, model }) => {
    await prepare(page, model.rows); await page.locator('#filename-tags-confirm').click(); await phase(page, 'results');
    response(model, 'plan', { transform: data => ({ ...data, items: data.items.map(item => ({ ...item, ...Object.fromEntries(['parsed_fields', 'processed_fields', 'current', 'effective_fields', 'changes'].map(key => [key, Object.fromEntries(Object.entries(item[key]).reverse())])) })) }) });
    await page.locator('#filename-tags-retry').click(); await phase(page, 'results'); assert.equal(callsFor(model, 'apply').length, 1);
  }, { model: modelOf(3) }));

  await check('Malformed parse snapshots cannot hide rows or change the identity of the fixed scope', async () => {
    const changes = [data => ({ ...data, total: 2 }), data => ({ ...data, items: data.items.slice(0, -1) }), data => ({ ...data, items: [...data.items].reverse() }),
      data => ({ ...data, items: [data.items[0], data.items[0], data.items[2]] }), data => ({ ...data, counts: { ...data.counts, matched: 1 } }), data => ({ ...data, template: '{title}' })];
    for (const transform of changes) await withPage(async ({ page, model }) => {
      await open(page, model.rows); response(model, 'parse', { transform }); await page.locator('#filename-tags-analyze').click(); await phase(page, 'error');
      assert.match(await page.locator('#filename-tags-status').textContent(), /不完整|不一致/); assert.equal(callsFor(model, 'preview').length, 0);
      await page.locator('#filename-tags-retry').click(); await phase(page, 'analysis-ready');
    }, { model: modelOf(3) });
  });

  await check('Malformed preview snapshots cannot become a writable confirmation', async () => {
    const changes = [data => ({ ...data, items: data.items.slice(1) }), data => ({ ...data, items: [...data.items].reverse() }), data => ({ ...data, ready_total: 500 }),
      data => ({ ...data, overwrite: true }), data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, included: false }) }),
      data => ({ ...data, state: 'running', job_id: randomUUID() }), data => ({ ...data, changed_fields: data.changed_fields + 1 })];
    for (const transform of changes) await withPage(async ({ page, model }) => {
      await open(page, model.rows); await analyze(page); response(model, 'preview', { transform }); await page.locator('#filename-tags-preview').click(); await phase(page, 'error');
      assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); assert.equal(callsFor(model, 'apply').length, 0);
      await page.locator('#filename-tags-retry').click(); await phase(page, 'preview-ready');
    }, { model: modelOf(3) });
  });

  await check('Result identity, revision and immutable field changes are rejected without losing the prior report', async () => {
    for (const transform of [data => ({ ...data, token: randomUUID() }), data => ({ ...data, revision: 'b'.repeat(64) }), data => ({ ...data, items: data.items.map((item, i) => i ? item : { ...item, current: { ...item.current, title: '意外替换预览' } }) })]) {
      await withPage(async ({ page, model }) => {
        await prepare(page, model.rows); await page.locator('#filename-tags-confirm').click(); await phase(page, 'results');
        response(model, 'plan', { transform }); await page.locator('#filename-tags-retry').click(); await phase(page, 'results-error');
        assert.equal(await page.locator('.ft-track[data-status="written"]').count(), 3); assert.equal(callsFor(model, 'apply').length, 1);
        await page.locator('#filename-tags-retry').click(); await phase(page, 'results');
      }, { model: modelOf(3) });
    }
  });

  await check('Cancellation, Escape, native close and removal reject late parse and preview replies', async () => {
    for (const stage of ['parse', 'preview']) for (const action of ['cancel', 'escape', 'close', 'remove']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); const before = await selected(page); if (stage === 'preview') await analyze(page);
      const delay = gate(); response(model, stage, { gate: delay }); await page.locator(stage === 'parse' ? '#filename-tags-analyze' : '#filename-tags-preview').click(); await entered(delay);
      if (action === 'cancel') await page.locator('#filename-tags-cancel').click();
      else if (action === 'escape') await page.keyboard.press('Escape');
      else await page.locator(dialog).evaluate((node, action) => node[action](), action);
      await release(page, delay);
      if (action === 'cancel') { await phase(page, stage === 'parse' ? 'template' : 'analysis-ready'); assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); }
      else assert.equal(await page.locator(dialog).count(), 0);
      assert.deepEqual(await selected(page), before); assert.equal(callsFor(model, 'apply').length, 0);
    }, { model: modelOf(3) });
  });

  await check('Selection membership ABA, hash navigation and internal tab navigation invalidate pending work', async () => {
    for (const stage of ['parse', 'preview']) for (const action of ['selection', 'hash', 'tab']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); if (stage === 'preview') await analyze(page);
      const delay = gate(); response(model, stage, { gate: delay }); await page.locator(stage === 'parse' ? '#filename-tags-analyze' : '#filename-tags-preview').click(); await entered(delay);
      if (action === 'selection') await page.evaluate(async rows => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(rows); }, model.rows);
      else await page.evaluate(action => { if (action === 'hash') location.hash = '#settings'; else document.getElementById('tab-collections').click(); }, action);
      await release(page, delay);
      if (action === 'selection') { await phase(page, 'stale'); assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false); }
      else await page.locator(dialog).waitFor({ state: 'detached' });
      assert.equal(callsFor(model, 'apply').length, 0);
    }, { model: modelOf(3) });
  });

  await check('401, logout and session expiry close all stages and prevent stale revival', async () => {
    for (const stage of ['parse', 'preview', 'apply']) for (const reason of ['401', 'logout', 'expired']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); if (stage !== 'parse') await analyze(page); if (stage === 'apply') await preview(page);
      const delay = gate(); response(model, stage, { gate: delay, ...(reason === '401' ? { status: 401, data: { detail: { code: 'unauthorized', message: '登录已过期' } } } : {}) });
      await page.locator(stage === 'parse' ? '#filename-tags-analyze' : stage === 'preview' ? '#filename-tags-preview' : '#filename-tags-confirm').click(); await entered(delay);
      if (reason !== '401') await page.evaluate(reason => window.dispatchEvent(new CustomEvent(reason === 'logout' ? 'metatidy:logout' : 'metatidy:unauthorized', { detail: '测试会话已过期' })), reason);
      await release(page, delay); await page.locator(dialog).waitFor({ state: 'detached' });
      assert.equal(callsFor(model, 'apply').length, stage === 'apply' ? 1 : 0);
      if (reason !== 'logout') { assert.deepEqual((await selected(page)).ids, []); await page.locator('#auth-veil').waitFor({ state: 'visible' }); }
    }, { model: modelOf(3) });
  });

  await check('Closing an in-flight submitted write retains recovery but never resubmits automatically', () => withPage(async ({ page, model }) => {
    await prepare(page, model.rows); const delay = gate(); response(model, 'apply', { gate: delay });
    await page.locator('#filename-tags-confirm').click(); await entered(delay); await close(page); await release(page, delay);
    assert.equal(await page.locator(dialog).count(), 0); assert.equal(callsFor(model, 'apply').length, 1);
    const token = callsFor(model, 'apply')[0].body.token;
    await page.evaluate(async token => (await import('/filename-tags.js')).openFilenameTagResults(token), token); await phase(page, 'results');
    assert.equal(callsFor(model, 'apply').length, 1); assert.equal(await page.locator('.ft-track[data-status="written"]').count(), 3);
  }, { model: modelOf(3) }));

  await check('Expired and changed plans require a new explicit preview', async () => {
    for (const error of ['analysis_changed', 'plan_expired', 'plan_changed']) await withPage(async ({ page, model }) => {
      await open(page, model.rows); await analyze(page);
      response(model, 'preview', { status: 409, data: { detail: { code: error, message: '受控计划冲突' } } });
      await page.locator('#filename-tags-preview').click(); await phase(page, 'stale');
      assert.equal(callsFor(model, 'apply').length, 0); assert.equal(await page.locator('#filename-tags-confirm').isVisible(), false);
      await page.locator('#filename-tags-retry').click(); await phase(page, error === 'analysis_changed' ? 'analysis-ready' : 'preview-ready');
    }, { model: modelOf(3) });
    await withPage(async ({ page, model }) => {
      await open(page, model.rows); await analyze(page); response(model, 'preview', { transform: data => ({ ...data, expires_at: Date.now() / 1000 - 1 }) });
      await page.locator('#filename-tags-preview').click(); await phase(page, 'stale'); assert.equal(callsFor(model, 'apply').length, 0);
    }, { model: modelOf(3) });
  });

  await check('Dialog focus, finite motion and footer fit phone, landscape and desktop in both themes', async () => {
    for (const [width, height] of [[320, 480], [390, 844], [844, 390], [1440, 900]]) for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['reduce', 'no-preference']) {
      await withPage(async ({ page, model }) => {
        model.rows[0].filename = `001 - ${'很长的歌手 名称 '.repeat(12)} - ${'很长的候选曲目 名称 '.repeat(24)}.flac`;
        model.rows[0].path = `/fixture-music/${'很长的目录 空格%_ '.repeat(24)}/${model.rows[0].filename}`;
        await open(page, model.rows); const motion = await motionDone(page); assert.equal(motion.running, 0);
        for (const timing of motion.timing) assert.ok(Number.isFinite(timing.duration) && timing.iterations === 1 && timing.duration + timing.delay <= 500, JSON.stringify(timing));
        if (reducedMotion === 'reduce') assert.deepEqual(motion.timing, []);
        await validFocus(page); await geometry(page, ['filename-tags-cancel', 'filename-tags-analyze']);
        await analyze(page); await motionDone(page); await geometry(page, ['filename-tags-cancel', 'filename-tags-preview']);
        const delay = gate(); response(model, 'preview', { gate: delay }); await page.locator('#filename-tags-preview').click(); await entered(delay);
        await validFocus(page); await geometry(page, ['filename-tags-cancel']); await page.locator('#filename-tags-cancel').focus();
        await release(page, delay); await phase(page, 'preview-ready'); await motionDone(page);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'filename-tags-cancel');
        await geometry(page, ['filename-tags-cancel', 'filename-tags-confirm']);
        await page.locator('#filename-tags-close').focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'filename-tags-confirm');
        await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'filename-tags-close');
        await page.screenshot({ path: path.join(output, `filename-tags-${width}x${height}-${colorScheme}-${reducedMotion}.png`) });
        assert.equal(callsFor(model, 'apply').length, 0);
      }, { model: modelOf(105), viewport: { width, height }, colorScheme, reducedMotion });
    }
  });

  console.log(`\n${passed} filename tag checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
