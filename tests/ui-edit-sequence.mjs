/** Sequential editing against isolated metadata routes; every simulated write is explicit. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Use the installed local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_EDIT_SEQUENCE_UI_PORT || 18946), base = `http://127.0.0.1:${port}`;
const extra = ['composer', 'lyricist', 'copyright', 'comment', 'mb_artist_id', 'release_group_id'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred() });
const light = row => Object.fromEntries(Object.entries(row).filter(([key]) => !extra.includes(key) && key !== 'file_exists'));
const callsAt = (model, endpoint) => model.calls.filter(call => call.path === endpoint);
const details = model => model.calls.filter(call => /^\/api\/tracks\/\d+$/.test(call.path));
const writes = model => model.calls.filter(call => ['/api/tracks/apply', '/api/scrape/apply', '/api/scrape/batch', '/api/move/execute', '/api/scan'].includes(call.path));
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const selectedIds = page => page.evaluate(async () => (await import('/store.js')).selectionIds());
let server, browser, passed = 0;
const failures = [];

function makeRows(count = 3) {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return { id, title: `逐首标题 ${id}`, artist: `歌手 ${id}`, album: '逐首验收专辑', albumartist: '专辑歌手', genre: 'Pop',
      year: '2025', track: String(id), disc: '1', language: '中文', albumtype: '专辑', composer: `作曲 ${id}`, lyricist: `作词 ${id}`,
      copyright: `版权 ${id}`, comment: `原注释 ${id}`, mb_artist_id: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`,
      release_group_id: `10000000-0000-0000-0000-${String(id).padStart(12, '0')}`, filename: `${id}.flac`, path: `/fixture-music/逐首验收/${id}.flac`,
      dir: '/fixture-music/逐首验收', ext: 'flac', duration: 180, size: 123456, has_cover: 0, has_lyrics: 1, tags_loaded: true, path_derived: false,
      indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000, file_exists: true };
  });
}
async function check(name, action) {
  if (process.env.METATIDY_EDIT_SEQUENCE_UI_CHECK && !name.includes(process.env.METATIDY_EDIT_SEQUENCE_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
async function withPage(action, { count = 3, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const full = makeRows(count);
  const model = { full, calls: [], errors: [], detailReplies: new Map(), lyricReplies: new Map(), previewReplies: [], applyReplies: [],
    gates: [], expectedWrites: 0, missing: new Set(), lyrics: new Map(full.map(row => [row.id, `[00:01.00] 第${row.id}首原歌词`])) };
  const reply = async (route, plan, fallback, body) => {
    if (plan?.gate) { plan.gate.entered.resolve(); await plan.gate.release.promise; }
    try {
      plan?.update?.(body);
      await route.fulfill({ status: plan?.status || 200, json: plan?.data ?? (typeof fallback === 'function' ? fallback() : fallback) });
    } catch (error) {
      if (!plan?.gate) throw error; // Disposed requests may be aborted before their gate is released.
    } finally { plan?.gate?.done.resolve(); }
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : null;
    model.calls.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === '/api/tracks') return route.fulfill({ json: { items: model.full.slice(0, 18).map(light), total: model.full.length, page: 1, page_size: 18, pages: Math.ceil(model.full.length / 18) } });
    const match = url.pathname.match(/^\/api\/tracks\/(\d+)(\/lyrics)?$/);
    if (match) {
      const id = Number(match[1]);
      if (match[2]) return reply(route, model.lyricReplies.get(id)?.shift(), () => {
        const lyrics = model.lyrics.get(id) || ''; return { lyrics, has_lyrics: Boolean(lyrics), lines: lyrics ? 1 : 0, chars: lyrics.length };
      });
      const plan = model.detailReplies.get(id)?.shift();
      return reply(route, plan || (model.missing.has(id) ? { status: 404, data: { detail: '曲目已不在索引中' } } : null), () => model.full.find(row => row.id === id));
    }
    if (url.pathname === '/api/tracks/selection') {
      const ids = [...new Set(body.ids)], size = body.page_size, pages = Math.ceil(ids.length / size), pageNumber = Math.max(1, Math.min(pages || 1, body.page));
      const missing = ids.filter(id => model.missing.has(id)).length;
      return route.fulfill({ json: { total: ids.length, selected_total: ids.length, found_total: ids.length - missing, missing_total: missing,
        page: pageNumber, page_size: size, pages, items: ids.slice((pageNumber - 1) * size, pageNumber * size).map(id => ({ id,
          status: model.missing.has(id) ? 'missing' : 'found', track: model.missing.has(id) ? null : light(model.full.find(row => row.id === id)) })) } });
    }
    if (url.pathname === '/api/tracks/preview') return reply(route, model.previewReplies.shift(), () => {
      const items = body.ids.filter(id => !model.missing.has(id)).map(id => {
        const current = model.full.find(row => row.id === id), effective = {}, skipped = [];
        for (const [field, value] of Object.entries(body.fields)) {
          const reason = !String(value).trim() ? 'blank' : String(current[field] || '').trim() === String(value).trim() ? 'unchanged'
            : body.overwrite === false && current[field] && field !== 'lyrics' ? 'existing' : null;
          if (reason) skipped.push({ field, reason }); else effective[field] = value;
        }
        const changes = Object.fromEntries(Object.entries(effective).map(([field, value]) => [field, { old: current[field] || '', new: value }]));
        return { track_id: id, filename: current.filename, path: current.path, current, file_exists: current.file_exists,
          changes, count: Object.keys(changes).length, effective_fields: effective, skipped };
      });
      const missing = body.ids.filter(id => model.missing.has(id));
      return { fields: body.fields, items, changed_fields: items.reduce((sum, item) => sum + item.count, 0), selected_total: body.ids.length,
        previewed_total: items.length, index_missing_total: missing.length, index_missing_ids: missing, truncated: false };
    }, body);
    if (url.pathname === '/api/tracks/apply') {
      const plan = model.applyReplies.shift();
      if (!plan) return route.fulfill({ status: 500, json: { detail: 'Acceptance did not authorize this write' } });
      return reply(route, plan, plan.data, body);
    }
    return route.continue();
  });
  page.on('pageerror', error => model.errors.push(error.message));
  try {
    await action({ page, context, model });
    assert.deepEqual(model.errors, [], 'Sequential editing must not raise browser exceptions');
    assert.equal(writes(model).length, model.expectedWrites, 'Only explicitly simulated apply calls are authorized');
    assert.equal(writes(model).every(call => call.path === '/api/tracks/apply'), true, 'Sequence operations never scan, move, scrape or batch-write');
  } finally { for (const delay of model.gates) delay.release.resolve(); await context.close(); }
}
function queue(model, kind, id, plan) {
  const map = kind === 'detail' ? model.detailReplies : model.lyricReplies;
  if (!map.has(id)) map.set(id, []); map.get(id).push(plan);
  if (plan.gate) model.gates.push(plan.gate);
}
function applyPlan(model, id, { fields = { title: `已写入标题 ${id}` }, delay = null, outcome = 'saved', status = 200, data, update = true } = {}) {
  model.expectedWrites++;
  if (delay) model.gates.push(delay);
  const written = outcome === 'saved' ? Object.keys(fields).filter(key => key !== 'lyrics') : [];
  model.applyReplies.push({ gate: delay, status,
    update: status === 200 && outcome === 'saved' && update ? () => {
      Object.assign(model.full.find(row => row.id === id), Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'lyrics')));
      if (Object.hasOwn(fields, 'lyrics')) model.lyrics.set(id, fields.lyrics);
    } : null,
    data: data || { written: outcome === 'saved' ? 1 : 0, skipped: outcome === 'unchanged' ? 1 : 0,
      failed: outcome === 'error' ? [{ track_id: id, error: '受控写入失败', stage: 'write', file_changed: false }] : [], fields: written,
      items: outcome === 'error' ? [] : [{ track_id: id, written, skipped: outcome === 'unchanged' ? [{ field: 'title', reason: 'unchanged' }] : [],
        file_changed: outcome === 'saved', lyrics: outcome === 'saved' && Object.hasOwn(fields, 'lyrics'), cover: false }] } });
}
async function entered(delay) {
  let timer;
  try { await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected controlled request did not start')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, delay) { delay.release.resolve(); await delay.done.promise; await flush(page); }
async function ready(page, model) {
  await page.goto(base);
  await page.waitForFunction(count => document.querySelectorAll('#tracks-tbody tr[data-id]').length === count, Math.min(model.full.length, 18));
}
async function select(page, rows) {
  await page.evaluate(async values => { const store = await import('/store.js'); store.clearSelection(); store.selectRows(values); }, rows.map(light));
}
async function openReview(page) { await page.locator('#selection-review').click(); await page.locator('#selection-review-dialog').waitFor(); }
async function enterSequence(page) {
  await page.locator('#selection-review-edit-sequence').click();
  await page.locator('#edit-drawer[data-open="true"][data-edit-mode="sequence"]').waitFor();
  assert.equal(await page.locator('#selection-review-dialog').count(), 0);
}
async function start(page, model, rows = model.full) { await ready(page, model); await select(page, rows); await openReview(page); await enterSequence(page); }
async function current(page, id, index, total) {
  await page.waitForFunction(({ id, index }) => {
    const node = document.querySelector('#edit-sequence'); return !node?.hidden && node.dataset.trackId === String(id) && node.dataset.index === String(index);
  }, { id, index });
  if (total !== undefined) assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.max), total);
  assert.deepEqual(await page.evaluate(async () => (await import('/store.js')).state.edit.rows.map(row => Number(row.id))), [id]);
}
async function loaded(page, id) {
  await page.waitForFunction(id => document.querySelector('#edit-composer')?.value === `作曲 ${id}`, id);
  await page.waitForFunction(id => document.querySelector('#edit-lyrics')?.value.includes(`第${id}首原歌词`), id);
  await flush(page);
}
async function settled(page) { await page.waitForFunction(() => document.querySelector('#edit-sequence')?.dataset.busy === 'false'); await flush(page); }
async function leavePrompt(page) {
  await page.locator('#edit-sequence-leave-dialog[open]').waitFor();
  assert.equal(await page.locator('#edit-sequence-keep').evaluate(node => node === document.activeElement), true, 'Keeping the draft is the safe default');
}
async function cancelLeave(page) { await page.keyboard.press('Escape'); await page.locator('#edit-sequence-leave-dialog').waitFor({ state: 'detached' }); await flush(page); }
async function discard(page) { await page.locator('#edit-sequence-discard').click(); await page.locator('#edit-sequence-leave-dialog').waitFor({ state: 'detached' }); await flush(page); }
async function preview(page) { await page.locator('#btn-edit-preview').click(); await page.locator('#edit-preview-dialog[open]').waitFor(); }
async function confirmApply(page) { await page.locator('#edit-preview-dialog').getByRole('button', { name: '确认处理 1 首', exact: true }).click(); }
async function assertBusy(page) {
  for (const id of ['edit-sequence-prev', 'edit-sequence-next', 'edit-sequence-skip', 'edit-close']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} must be disabled while busy`);
  assert.equal(await page.locator('#edit-sequence').getAttribute('aria-busy'), 'true');
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Edit sequence fixture timeout')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Review pagination and search preserve all 1105 selected IDs in their fixed insertion order without prefetch', () => withPage(async ({ page, model }) => {
    const order = [1105, 7, 1002, ...model.full.map(row => row.id).filter(id => ![1105, 7, 1002].includes(id))];
    await ready(page, model); await select(page, order.map(id => model.full[id - 1])); await openReview(page);
    await page.locator('#selection-review-next').click(); assert.equal(await page.locator('#selection-review-page').innerText(), '2 / 23');
    await page.locator('#selection-review-q').fill('/1002.flac'); await flush(page);
    assert.equal(await page.locator('.sr-track').count(), 1);
    assert.match(await page.locator('#selection-review-edit-sequence').innerText(), /1,105/);
    assert.equal(details(model).length, 0);
    await enterSequence(page); await current(page, 1105, 0, 1105); await loaded(page, 1105);
    assert.equal(await page.locator('#edit-sequence-prev').isDisabled(), true);
    assert.deepEqual(details(model).map(call => call.path), ['/api/tracks/1105']);
    assert.equal(model.calls.filter(call => call.path.endsWith('/lyrics')).length, 1);
    await select(page, [model.full[2]]); // Global selection membership may change; this session is already frozen.
    await page.locator('#edit-sequence-next').click(); await current(page, 7, 1, 1105); await loaded(page, 7);
    await page.locator('#edit-sequence-next').click(); await current(page, 1002, 2, 1105); await loaded(page, 1002);
    await page.locator('#edit-sequence-prev').click(); await current(page, 7, 1, 1105);
    assert.deepEqual(await selectedIds(page), [3]); assert.equal(callsAt(model, '/api/tracks/selection').length, 0);
  }, { count: 1105 }));

  await check('Unchanged, restored and blank fields never ask to discard; skipping only marks the current song', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1);
    await page.locator('#edit-title').fill('临时改动'); await page.locator('#edit-title').fill(model.full[0].title);
    await page.locator('#edit-title').fill('   '); await page.locator('#edit-lyrics').fill('  ');
    await page.locator('#edit-normalize').uncheck(); await page.locator('#edit-overwrite').uncheck();
    await page.locator('#edit-sequence-next').click(); await current(page, 2, 1, 3); await loaded(page, 2);
    assert.equal(await page.locator('#edit-sequence-leave-dialog').count(), 0);
    await page.locator('#edit-sequence-skip').click(); await current(page, 2, 1, 3);
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'skipped');
    assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 1);
    await page.locator('#edit-sequence-prev').click(); await current(page, 1, 0, 3); await loaded(page, 1);
    assert.equal(await page.locator('#edit-title').inputValue(), model.full[0].title);
    await page.locator('#edit-close').click(); assert.equal(await page.locator('#edit-drawer').getAttribute('data-open'), 'false');
    assert.equal(callsAt(model, '/api/tracks/preview').length, 0);
  }));

  await check('Dirty previous, next, skip and close default to keeping the draft; one discard advances once', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1); await page.locator('#edit-sequence-next').click(); await loaded(page, 2);
    await page.locator('#edit-title').fill('第二首未提交草稿');
    for (const id of ['edit-sequence-prev', 'edit-sequence-next', 'edit-sequence-skip', 'edit-close']) {
      await page.locator(`#${id}`).click(); await leavePrompt(page); await cancelLeave(page);
      await current(page, 2, 1, 3); assert.equal(await page.locator('#edit-title').inputValue(), '第二首未提交草稿');
      assert.equal(await page.locator(`#${id}`).evaluate(node => node === document.activeElement), true);
    }
    await page.locator('#edit-sequence-next').click(); await leavePrompt(page);
    await page.locator('#edit-sequence-next').evaluate(button => { button.click(); button.click(); });
    assert.equal(await page.locator('#edit-sequence-leave-dialog').count(), 1);
    await page.locator('#edit-sequence-discard').evaluate(button => { button.click(); button.click(); });
    await current(page, 3, 2, 3); await loaded(page, 3);
    assert.equal(await page.locator('#edit-sequence-next').isDisabled(), true);
    assert.equal(details(model).filter(call => call.path === '/api/tracks/3').length, 1);
    await page.locator('#edit-sequence-prev').click(); await loaded(page, 2);
    assert.equal(await page.locator('#edit-title').inputValue(), model.full[1].title);
  }));

  await check('Other single or batch edit entry points cannot bypass an active sequence draft or replace its pending decision', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1); await page.locator('#edit-title').fill('保留逐首草稿');
    const open = rows => page.evaluate(async rows => (await import('/tracks.js')).editSelection(rows), rows.map(light));
    await open([model.full[1]]); await leavePrompt(page); await cancelLeave(page); await current(page, 1, 0, 3);
    await open(model.full.slice(1)); await leavePrompt(page); await cancelLeave(page);
    assert.equal(await page.locator('#edit-title').inputValue(), '保留逐首草稿');
    await open([model.full[1]]); await leavePrompt(page); await open([model.full[2]]);
    assert.equal(await page.locator('#edit-sequence-leave-dialog').count(), 1);
    await discard(page); await loaded(page, 2);
    assert.equal(await page.locator('#edit-drawer').getAttribute('data-edit-mode'), 'standard');
    assert.equal(await page.locator('#edit-sequence').isVisible(), false);
    assert.deepEqual(await page.evaluate(async () => (await import('/store.js')).state.edit.rows.map(row => row.id)), [2]);
    await page.locator('#edit-close').click(); await open(model.full.slice(1));
    assert.equal(await page.locator('#edit-sequence').isVisible(), false);
    assert.equal(await page.locator('#edit-scope').innerText(), '2 首');
  }));

  await check('Late detail and lyrics responses cannot cross navigation or a newly opened session for the same ID', () => withPage(async ({ page, model }) => {
    const detail = gate(), lyrics = gate();
    queue(model, 'detail', 1, { gate: detail, data: { ...model.full[0], title: '旧会话详情' } });
    queue(model, 'lyrics', 1, { gate: lyrics, data: { lyrics: '旧会话歌词', has_lyrics: true, lines: 1, chars: 5 } });
    await start(page, model); await entered(detail); await entered(lyrics);
    await page.locator('#edit-sequence-next').click(); await current(page, 2, 1, 3); await loaded(page, 2);
    await release(page, detail); await release(page, lyrics);
    assert.equal(await page.locator('#edit-title').inputValue(), model.full[1].title);
    assert.equal(await page.locator('#edit-lyrics').inputValue(), model.lyrics.get(2));
    const reopened = gate(); queue(model, 'detail', 1, { gate: reopened, data: { ...model.full[0], title: '已关闭会话详情' } });
    await page.locator('#edit-sequence-prev').click(); await entered(reopened); await page.locator('#edit-close').click();
    await openReview(page); await enterSequence(page); await loaded(page, 1);
    await release(page, reopened); await current(page, 1, 0, 3);
    assert.equal(await page.locator('#edit-title').inputValue(), model.full[0].title);
  }));

  await check('A discard prompt preserves late metadata baselines and typed lyrics when the user keeps editing', () => withPage(async ({ page, model }) => {
    const detail = gate(), lyrics = gate();
    queue(model, 'detail', 1, { gate: detail, data: { ...model.full[0], title: '新索引基线' } });
    queue(model, 'lyrics', 1, { gate: lyrics });
    await start(page, model); await entered(detail); await entered(lyrics);
    await page.locator('#edit-title').fill('等待中的标题草稿'); await page.locator('#edit-lyrics').fill('等待中的歌词草稿');
    await page.locator('#edit-sequence-next').click(); await leavePrompt(page);
    await release(page, detail); await release(page, lyrics); await page.locator('#edit-sequence-keep').click();
    await current(page, 1, 0, 3); assert.equal(await page.locator('#edit-title').inputValue(), '等待中的标题草稿');
    assert.equal(await page.locator('#edit-lyrics').inputValue(), '等待中的歌词草稿');
    await page.locator('#btn-edit-clear').click(); assert.equal(await page.locator('#edit-title').inputValue(), '新索引基线');
    assert.equal(await page.locator('#edit-lyrics').inputValue(), model.lyrics.get(1));
    await page.locator('#edit-sequence-next').click(); await current(page, 2, 1, 3);
    assert.equal(await page.locator('#edit-sequence-leave-dialog').count(), 0);
  }));

  await check('Preview and apply lock navigation while captured single-song payloads preserve newer input and the fixed queue', () => withPage(async ({ page, model }) => {
    const previewDelay = gate(), applyDelay = gate(); model.gates.push(previewDelay); model.previewReplies.push({ gate: previewDelay });
    const submitted = { title: '本次提交标题', genre: '本次提交流派' };
    applyPlan(model, 1, { fields: submitted, delay: applyDelay });
    await start(page, model); await loaded(page, 1);
    await page.locator('#edit-title').fill(submitted.title); await page.locator('#edit-genre').fill(submitted.genre);
    await page.locator('#btn-edit-preview').click(); await entered(previewDelay); await assertBusy(page);
    await page.locator('#edit-title').fill('预览期间的新标题');
    await page.keyboard.press('Escape'); await current(page, 1, 0, 3);
    await page.evaluate(async row => (await import('/tracks.js')).editSelection([row]), model.full[2]);
    await current(page, 1, 0, 3); assert.equal(await page.locator('#edit-sequence-leave-dialog').count(), 0);
    await release(page, previewDelay); await page.locator('#edit-preview-dialog[open]').waitFor(); await assertBusy(page);
    await confirmApply(page); await entered(applyDelay); await assertBusy(page);
    await page.locator('#edit-genre').fill('写入期间的新流派'); await page.locator('#edit-lyrics').fill('写入期间的新歌词');
    await release(page, applyDelay); await settled(page); await current(page, 1, 0, 3);
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'saved');
    assert.equal(await page.locator('#edit-sequence').getAttribute('data-dirty'), 'true');
    assert.deepEqual(callsAt(model, '/api/tracks/apply')[0].body.ids, [1]);
    assert.deepEqual(callsAt(model, '/api/tracks/apply')[0].body.fields, submitted);
    assert.equal(await page.locator('#edit-title').inputValue(), '预览期间的新标题');
    assert.equal(await page.locator('#edit-genre').inputValue(), '写入期间的新流派');
    assert.equal(await page.locator('#edit-lyrics').inputValue(), '写入期间的新歌词');
    assert.deepEqual(await selectedIds(page), [2, 3]);
    await preview(page); assert.deepEqual(callsAt(model, '/api/tracks/preview').at(-1).body.fields,
      { title: '预览期间的新标题', genre: '写入期间的新流派', lyrics: '写入期间的新歌词' });
    await page.keyboard.press('Escape'); await settled(page); await current(page, 1, 0, 3);
    await page.locator('#edit-sequence-next').click(); await leavePrompt(page); await discard(page); await loaded(page, 2);
    await page.locator('#edit-sequence-prev').click(); await settled(page);
    await page.waitForFunction(() => document.querySelector('#edit-title')?.value === '本次提交标题');
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'saved');
    assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 1);
    await page.locator('#edit-sequence-skip').click();
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'saved');
  }));

  await check('No-change preview and unchanged apply record their results without advancing or overwriting them with skip', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1); await page.locator('#edit-title').fill('保留原值'); await page.locator('#edit-overwrite').uncheck();
    await preview(page); assert.equal(await page.locator('#edit-preview-dialog').getByRole('button', { name: '确认处理 1 首' }).count(), 0);
    await page.keyboard.press('Escape'); await settled(page); await current(page, 1, 0, 3);
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'unchanged');
    await page.locator('#btn-edit-clear').click(); await page.locator('#edit-sequence-skip').click();
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'unchanged');
    await page.locator('#edit-sequence-next').click(); await loaded(page, 2); await page.locator('#edit-overwrite').check();
    applyPlan(model, 2, { outcome: 'unchanged' });
    await page.locator('#edit-title').fill('服务端已无变化'); await preview(page); await confirmApply(page); await settled(page);
    await current(page, 2, 1, 3); assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'unchanged');
    assert.deepEqual(await selectedIds(page), [1, 2, 3]);
    assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 2);
  }));

  await check('Failed or mismatched apply results stay on the current song, preserve drafts and never count as saved', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1); await page.locator('#edit-title').fill('需要重试的标题');
    for (const plan of [
      { outcome: 'error' },
      { update: false, data: { written: 0, skipped: 0, fields: [], items: [], failed: [
        { track_id: 1, error: '文件已写入，但索引同步失败', stage: 'index', file_changed: true },
      ] } },
      { status: 503, data: { detail: '受控服务不可用' } },
      { update: false, data: { written: 1, skipped: 0, failed: [], fields: ['title'], items: [{ track_id: 2, written: ['title'], skipped: [], file_changed: true, cover: false, lyrics: false }] } },
    ]) {
      applyPlan(model, 1, plan); await preview(page); await confirmApply(page); await settled(page); await current(page, 1, 0, 3);
      assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'error');
      assert.equal(await page.locator('#edit-title').inputValue(), '需要重试的标题');
      assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 0);
      assert.deepEqual(await selectedIds(page), [1, 2, 3]);
    }
    await page.locator('#edit-sequence-next').click(); await leavePrompt(page); await cancelLeave(page);
    assert.equal(callsAt(model, '/api/tracks/apply').every(call => call.body.ids.length === 1 && call.body.ids[0] === 1), true);
  }));

  await check('A successful write with a failed detail reload preserves newer drafts and cannot silently advance', () => withPage(async ({ page, model }) => {
    queue(model, 'detail', 1, {}); queue(model, 'detail', 1, { status: 503, data: { detail: '写入后索引读取失败' } });
    const delay = gate(); applyPlan(model, 1, { fields: { title: '已经写入的标题' }, delay });
    await start(page, model); await loaded(page, 1); await page.locator('#edit-title').fill('已经写入的标题');
    await preview(page); await confirmApply(page); await entered(delay); await page.locator('#edit-title').fill('不能算已保存的新草稿');
    await release(page, delay); await settled(page); await current(page, 1, 0, 3);
    assert.equal(await page.locator('#edit-load-retry').isVisible(), true);
    assert.equal(await page.locator('#edit-title').inputValue(), '不能算已保存的新草稿');
    assert.equal(await page.locator('#edit-sequence').getAttribute('data-dirty'), 'true');
    await page.locator('#edit-sequence-next').click(); await leavePrompt(page); await cancelLeave(page);
    assert.equal(details(model).filter(call => call.path === '/api/tracks/2').length, 0);
  }));

  await check('Missing indexes and offline files can be marked skipped and navigated past without any preview or write', () => withPage(async ({ page, model }) => {
    model.missing.add(1); model.full[1].file_exists = false;
    await start(page, model); await page.locator('#edit-load-retry').waitFor({ state: 'visible' });
    for (const [id, index] of [[1, 0], [2, 1]]) {
      await current(page, id, index, 3);
      await page.waitForFunction(() => document.querySelector('#edit-sequence')?.dataset.unavailable === 'true');
      assert.equal(await page.locator('#btn-edit-preview').isDisabled(), true);
      await page.locator('#edit-title').fill('缺失文件上的草稿'); await page.locator('#btn-edit-preview').evaluate(button => button.click());
      await page.locator('#edit-sequence-skip').click(); await leavePrompt(page); await discard(page);
      await current(page, id, index, 3); assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'skipped');
      await page.locator('#edit-sequence-next').click();
    }
    await current(page, 3, 2, 3); await loaded(page, 3);
    assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 2);
    assert.equal(callsAt(model, '/api/tracks/preview').length, 0);
  }));

  await check('401 during a draft decision, preview or apply forces closure and prevents stale editor restoration', async () => {
    for (const phase of ['detail', 'preview', 'apply']) {
      await withPage(async ({ page, model }) => {
        const delay = gate();
        if (phase === 'detail') queue(model, 'detail', 1, { gate: delay, status: 401, data: { detail: '会话已失效' } });
        if (phase === 'preview') { model.gates.push(delay); model.previewReplies.push({ gate: delay, status: 401, data: { detail: '会话已失效' } }); }
        if (phase === 'apply') applyPlan(model, 1, { delay, status: 401, data: { detail: '会话已失效' } });
        await start(page, model);
        if (phase !== 'detail') await loaded(page, 1);
        await page.locator('#edit-title').fill('会话过期前的草稿');
        if (phase === 'detail') { await entered(delay); await page.locator('#edit-sequence-next').click(); await leavePrompt(page); }
        if (phase === 'preview') { await page.locator('#btn-edit-preview').click(); await entered(delay); await assertBusy(page); }
        if (phase === 'apply') { await preview(page); await confirmApply(page); await entered(delay); await assertBusy(page); }
        await release(page, delay); await page.locator('#auth-veil').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'false');
        assert.equal(await page.locator('#edit-sequence').isVisible(), false);
        assert.equal(await page.locator('#edit-sequence-leave-dialog, #edit-preview-dialog').count(), 0);
        assert.deepEqual(await selectedIds(page), []);
        const reads = details(model).length;
        await page.evaluate(async rows => (await import('/tracks.js')).editSelectionSequence(rows), model.full);
        await flush(page); assert.equal(details(model).length, reads);
        assert.equal(await page.locator('#edit-drawer').getAttribute('data-open'), 'false');
      });
    }
  });

  await check('Ending or reloading discards the in-memory sequence and never restores position, drafts or result counters', () => withPage(async ({ page, model }) => {
    await start(page, model); await loaded(page, 1); await page.locator('#edit-sequence-skip').click();
    await page.locator('#edit-sequence-next').click(); await loaded(page, 2);
    await page.locator('#edit-title').fill('结束时丢弃'); await page.locator('#edit-close').click(); await leavePrompt(page); await discard(page);
    assert.equal(await page.locator('#edit-drawer').getAttribute('data-open'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id === 'selection-review' || document.activeElement.id === 'tracks-q'), true);
    await openReview(page); await enterSequence(page); await current(page, 1, 0, 3); await loaded(page, 1);
    assert.equal(await page.locator('#edit-sequence-progress').evaluate(node => node.value), 0);
    assert.equal(await page.locator('#edit-sequence-status').getAttribute('data-state'), 'pending');
    await page.locator('#edit-title').fill('刷新时丢弃'); await page.reload();
    await page.waitForSelector('#tracks-tbody tr[data-id]');
    assert.equal(await page.locator('#edit-drawer').getAttribute('data-open'), 'false');
    assert.equal(await page.locator('#edit-sequence').isVisible(), false); assert.deepEqual(await selectedIds(page), []);
  }));

  await check('Review entry, sequence controls and discard preview layers fit themes, 320px and short viewports', async () => {
    for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [320, 480, 'light'], [320, 480, 'dark'], [844, 390, 'dark']]) {
      await withPage(async ({ page, model }) => {
        model.full[0].title = '很长的逐首编辑标题 / '.repeat(35); model.full[0].artist = '很长的艺术家 '.repeat(20);
        await ready(page, model); await select(page, model.full); await openReview(page);
        await page.locator('#selection-review-edit-sequence').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#selection-review-edit-sequence').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true);
        await page.screenshot({ path: path.join(output, `edit-sequence-entry-${width}x${height}-${colorScheme}.png`) });
        await enterSequence(page); await loaded(page, 1); await page.locator('#edit-sequence-next').click(); await loaded(page, 2);
        await page.locator('#edit-sequence-prev').click(); await loaded(page, 1); await flush(page);
        const bounds = await page.locator('#edit-drawer').evaluate(node => {
          const box = node.getBoundingClientRect(), body = node.querySelector('.drawer-body'), sequence = document.querySelector('#edit-sequence');
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: node.scrollWidth, client: node.clientWidth,
            bodyWidth: body.scrollWidth, bodyClient: body.clientWidth, bodyHeight: body.clientHeight, sequenceWidth: sequence.scrollWidth,
            sequenceClient: sequence.clientWidth, pageWidth: document.documentElement.scrollWidth, animations: node.getAnimations({ subtree: true }).length };
        });
        assert.ok(bounds.left >= -1 && bounds.right <= width + 1 && bounds.top >= -1 && bounds.bottom <= height + 1, JSON.stringify(bounds));
        assert.ok(bounds.width <= bounds.client + 1 && bounds.bodyWidth <= bounds.bodyClient + 1 && bounds.sequenceWidth <= bounds.sequenceClient + 1 && bounds.pageWidth <= width + 1, JSON.stringify(bounds));
        assert.ok(bounds.bodyHeight >= 60, `Fields must remain usable on short screens: ${JSON.stringify(bounds)}`);
        assert.equal(bounds.animations, 0);
        for (const id of ['edit-sequence-next', 'edit-sequence-skip', 'edit-close']) assert.equal(await page.locator(`#${id}`).evaluate(node => {
          const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === node;
        }), true, `${id} must stay visible and clickable`);
        await page.screenshot({ path: path.join(output, `edit-sequence-editor-${width}x${height}-${colorScheme}.png`) });
        await page.locator('#edit-title').fill('视觉验收中的未提交草稿'); await page.locator('#edit-sequence-next').click(); await leavePrompt(page);
        for (const id of ['edit-sequence-keep', 'edit-sequence-discard']) assert.equal(await page.locator(`#${id}`).evaluate(node => {
          const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
        }), true);
        await page.screenshot({ path: path.join(output, `edit-sequence-confirm-${width}x${height}-${colorScheme}.png`) });
        await cancelLeave(page); await page.locator('#btn-edit-preview').scrollIntoViewIfNeeded(); await preview(page);
        await page.keyboard.press('Escape'); await settled(page); await current(page, 1, 0, 3);
        assert.equal(await page.locator('#edit-title').inputValue(), '视觉验收中的未提交草稿');
        await page.locator('#edit-close').click(); await leavePrompt(page); await discard(page);
      }, { viewport: { width, height }, colorScheme });
    }
  });

  console.log(`\n${passed} edit sequence checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
