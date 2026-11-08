/** Metadata editor prefill and change-only submissions against isolated routes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Try the installed runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_METADATA_EDITOR_UI_PORT || 18916);
const base = `http://127.0.0.1:${port}`;
const out = path.join(root, '.codex/ui-preview');
const basic = ['title', 'artist', 'album', 'albumartist', 'genre', 'year', 'track', 'disc', 'language', 'albumtype'];
const extra = ['composer', 'lyricist', 'copyright', 'comment', 'mb_artist_id', 'release_group_id'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred(), done: deferred() });
let browser, server, passed = 0;
const failures = [];

function tracks() {
  return [1, 2, 3].map(id => ({
    id, title: `现有标题 ${id}`, artist: '甲歌手/乙歌手', album: '共同专辑', albumartist: '共同专辑艺人',
    genre: id === 2 ? 'Jazz' : 'Pop', year: '2024', track: String(id), disc: '1', language: '中文', albumtype: '专辑',
    composer: `作曲 ${id}`, lyricist: `作词 ${id}`, copyright: `版权 ${id}`, comment: `现有注释 ${id}`,
    mb_artist_id: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`,
    release_group_id: `10000000-0000-0000-0000-${String(id).padStart(12, '0')}`,
    filename: `${id}.flac`, path: `/fixture-music/元数据验收/${id}.flac`, dir: '/fixture-music/元数据验收', ext: 'flac',
    size: 123456, duration: 180, has_cover: 0, has_lyrics: 1, tags_loaded: true, path_derived: false,
    indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1700000000, file_exists: true,
  }));
}
const light = row => Object.fromEntries(Object.entries(row).filter(([key]) => !extra.includes(key) && key !== 'file_exists'));
const requestsAt = (model, route) => model.calls.filter(call => call.path === route);
const details = model => model.calls.filter(call => /^\/api\/tracks\/\d+$/.test(call.path));
const writes = model => model.calls.filter(call => ['/api/tracks/apply', '/api/scrape/apply', '/api/scrape/batch', '/api/move/execute', '/api/scan'].includes(call.path));
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function check(name, action) {
  if (process.env.METATIDY_METADATA_EDITOR_UI_CHECK && !name.includes(process.env.METATIDY_METADATA_EDITOR_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}

async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const full = tracks();
  const model = { full, rows: full.map(light), calls: [], detailReplies: new Map(), lyricReplies: new Map(),
    lyrics: new Map(full.map(row => [row.id, `[00:01.00] 第${row.id}首原有歌词`])), gates: [], errors: [],
    previewReplies: [], applyReplies: [], expectedWrites: 0 };
  const reply = async (route, plan, fallback) => {
    if (plan?.gate) { plan.gate.entered.resolve(); await plan.gate.release.promise; }
    try { await route.fulfill({ status: plan?.status || 200, json: plan?.data ?? fallback }); }
    finally { plan?.gate?.done.resolve(); }
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() : null;
    model.calls.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === '/api/tracks') return route.fulfill({ json: { items: model.rows, total: model.rows.length, page: 1, page_size: 100, pages: 1 } });
    const match = url.pathname.match(/^\/api\/tracks\/(\d+)(\/lyrics)?$/);
    if (match) {
      const id = Number(match[1]);
      if (match[2]) {
        const lyrics = model.lyrics.get(id) || '';
        return reply(route, model.lyricReplies.get(id)?.shift(), { lyrics, has_lyrics: Boolean(lyrics), lines: lyrics ? 1 : 0, chars: lyrics.length });
      }
      return reply(route, model.detailReplies.get(id)?.shift(), model.full.find(row => row.id === id));
    }
    if (url.pathname === '/api/tracks/preview') {
      const items = body.ids.map(id => {
        const current = model.full.find(row => row.id === id) || { id, title: `曲目${id}`, path: `/fixture-music/${id}.flac` };
        const changes = Object.fromEntries(Object.entries(body.fields).map(([key, value]) => [key, { old: current[key] || '', new: value }]));
        return { track_id: id, path: current.path, filename: current.filename || `${id}.flac`, current, file_exists: true,
          changes, count: Object.keys(changes).length, effective_fields: body.fields, skipped: [] };
      });
      return reply(route, model.previewReplies.shift(), { fields: body.fields, items, changed_fields: items.reduce((sum, item) => sum + item.count, 0),
        selected_total: body.ids.length, previewed_total: body.ids.length, index_missing_total: 0, index_missing_ids: [], truncated: false });
    }
    if (url.pathname === '/api/tracks/apply') {
      const plan = model.applyReplies.shift();
      if (!plan) return route.fulfill({ status: 500, json: { detail: 'Acceptance never authorizes a write' } });
      plan.update?.(body);
      return reply(route, plan, plan.data);
    }
    return route.continue();
  });
  page.on('pageerror', error => model.errors.push(error.message));
  try {
    await action({ page, context, model });
    assert.deepEqual(model.errors, [], 'The editor must not raise browser exceptions');
    assert.equal(writes(model).length, model.expectedWrites, 'Only explicitly simulated apply calls are authorized');
    assert.equal(writes(model).every(call => call.path === '/api/tracks/apply'), true, 'No scan, scrape, or move writes are allowed');
  } finally {
    for (const delay of model.gates) delay.release.resolve();
    await context.close();
  }
}

async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
}
async function openSingle(page, id = 1) {
  await page.locator(`#tracks-tbody button[data-edit-id="${id}"]`).click();
  await page.locator('#edit-drawer[data-open="true"]').waitFor();
}
async function openBatch(page, rows) {
  await page.evaluate(async values => { (await import('/tracks.js')).editSelection(values); }, rows);
  await page.locator('#edit-drawer[data-open="true"]').waitFor();
}
async function loaded(page, expected = '作曲 1', field = 'composer') {
  await page.waitForFunction(({ value, field }) => document.querySelector(`#edit-${field}`)?.value === value, { value: expected, field });
  await flush(page);
}
async function values(page, keys = [...basic, ...extra]) {
  return page.evaluate(fields => Object.fromEntries(fields.map(key => [key, document.querySelector(`#edit-${key}`).value])), keys);
}
async function more(page) {
  await page.locator('#edit-composer').evaluate(input => { input.closest('details').open = true; });
}
async function preview(page, model) {
  const count = requestsAt(model, '/api/tracks/preview').length;
  await page.locator('#btn-edit-preview').click();
  await page.locator('dialog[open]').waitFor();
  assert.equal(requestsAt(model, '/api/tracks/preview').length, count + 1);
  const request = requestsAt(model, '/api/tracks/preview').at(-1).body;
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  return request;
}
async function noPreview(page, model) {
  const count = requestsAt(model, '/api/tracks/preview').length;
  // Disabled means no changes; an enabled no-op button may show a helpful toast.
  await page.locator('#btn-edit-preview').evaluate(button => button.click());
  await flush(page);
  assert.equal(requestsAt(model, '/api/tracks/preview').length, count);
  assert.equal(await page.locator('dialog[open]').count(), 0);
}
function queue(model, kind, id, plan) {
  const map = kind === 'detail' ? model.detailReplies : model.lyricReplies;
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(plan);
  if (plan.gate) model.gates.push(plan.gate);
}
async function entered(delay) {
  let timer;
  try {
    await Promise.race([delay.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected controlled request did not start')), 10000); })]);
  } finally { clearTimeout(timer); }
}
async function release(page, delay) { delay.release.resolve(); await delay.done.promise; await flush(page); }

try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Metadata editor fixture timeout')), 10000);
    server.stdout.on('data', data => { if (String(data).includes('UI FIXTURE')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', data => { clearTimeout(timeout); reject(new Error(String(data))); });
    server.on('error', error => { clearTimeout(timeout); reject(error); });
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Single edit immediately prefills indexed snapshot, then loads all full metadata only on open', () => withPage(async ({ page, model }) => {
    const delay = gate(); queue(model, 'detail', 1, { gate: delay });
    await ready(page);
    assert.equal(details(model).length, 0);
    await openSingle(page); await entered(delay);
    assert.deepEqual(await values(page, basic), Object.fromEntries(basic.map(key => [key, model.rows[0][key]])));
    assert.equal(await page.locator('#edit-composer').inputValue(), '');
    assert.match(await page.locator('#edit-load-status').innerText(), /读取|载入|加载/);
    assert.match(await page.locator('#edit-description').innerText(), /现有|已有|当前|修改/);
    assert.equal(await page.locator('label[data-edit-state]').count(), 16);
    await release(page, delay); await loaded(page);
    assert.deepEqual(await values(page), Object.fromEntries([...basic, ...extra].map(key => [key, model.full[0][key]])));
    assert.equal(details(model).length, 1);
    assert.equal(await page.locator('#edit-load-retry').isVisible(), false);
    assert.equal(requestsAt(model, '/api/tracks/preview').length, 0);
  }));

  await check('Unchanged prefill and normalization never submit; only changed nonempty fields reach preview', () => withPage(async ({ page, model }) => {
    await ready(page); await openSingle(page); await loaded(page);
    await page.waitForFunction(() => document.querySelector('#edit-lyrics')?.value.includes('原有歌词'));
    assert.equal(await page.locator('#edit-normalize').isChecked(), true);
    await noPreview(page, model);
    await page.locator('#edit-genre').fill('Indie Folk');
    const payload = await preview(page, model);
    assert.deepEqual(payload.fields, { genre: 'Indie Folk' });
    assert.deepEqual(payload.ids, [1]); assert.equal(payload.normalize_artist, true);
    await page.locator('#edit-genre').fill(model.full[0].genre);
    await page.locator('#edit-title').fill('   ');
    await noPreview(page, model);
    assert.match(await page.locator('#edit-change-summary').innerText(), /0|没有|未修改|无.*改/);
  }));

  await check('Late full metadata preserves user input and untouched extra fields never become outgoing edits', () => withPage(async ({ page, model }) => {
    const delay = gate();
    queue(model, 'detail', 1, { gate: delay, data: { ...model.full[0], title: '详情新标题', genre: '详情新流派', comment: '详情新注释' } });
    await ready(page); await openSingle(page); await entered(delay);
    await page.locator('#edit-title').fill('用户先输入的标题');
    await more(page); await page.locator('#edit-comment').fill('用户先输入的注释');
    await release(page, delay); await loaded(page);
    assert.equal(await page.locator('#edit-title').inputValue(), '用户先输入的标题');
    assert.equal(await page.locator('#edit-comment').inputValue(), '用户先输入的注释');
    assert.equal(await page.locator('#edit-genre').inputValue(), '详情新流派');
    assert.deepEqual((await preview(page, model)).fields, { title: '用户先输入的标题', comment: '用户先输入的注释' });
  }));

  await check('Reset restores the currently loaded baseline, clears edits, and survives a pending detail response', () => withPage(async ({ page, model }) => {
    const delay = gate(); queue(model, 'detail', 1, { gate: delay, data: { ...model.full[0], title: '新加载的基线' } });
    await ready(page); await openSingle(page); await entered(delay);
    await page.locator('#edit-title').fill('不要提交这段');
    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-title').inputValue(), model.rows[0].title);
    await release(page, delay); await loaded(page);
    assert.equal(await page.locator('#edit-title').inputValue(), '新加载的基线');
    await noPreview(page, model);
    await page.locator('#edit-genre').fill('要重置');
    await more(page); await page.locator('#edit-composer').fill('临时作曲');
    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-genre').inputValue(), model.full[0].genre);
    assert.equal(await page.locator('#edit-composer').inputValue(), model.full[0].composer);
    await noPreview(page, model);
    const field = page.locator('#edit-title');
    await field.fill('另一草稿'); await field.fill('新加载的基线');
    assert.equal(await field.evaluate(node => node.closest('label').dataset.editState), 'unchanged');
  }));

  await check('Failed detail loading exposes retry without destroying the snapshot or a draft', () => withPage(async ({ page, model }) => {
    queue(model, 'detail', 1, { status: 503, data: { detail: '受控详情读取失败' } });
    const delay = gate(); queue(model, 'detail', 1, { gate: delay });
    await ready(page); await openSingle(page);
    await page.locator('#edit-load-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#edit-title').inputValue(), model.rows[0].title);
    assert.match(await page.locator('#edit-load-status').innerText(), /受控详情读取失败/);
    await page.locator('#edit-title').fill('失败期间保存的草稿');
    assert.deepEqual((await preview(page, model)).fields, { title: '失败期间保存的草稿' });
    await page.locator('#edit-load-retry').click(); await entered(delay);
    await release(page, delay); await loaded(page);
    assert.equal(await page.locator('#edit-title').inputValue(), '失败期间保存的草稿');
    assert.deepEqual((await preview(page, model)).fields, { title: '失败期间保存的草稿' });
  }));

  await check('Missing indexed tracks block preview and 401 closes the editor before login', async () => {
    await withPage(async ({ page, model }) => {
      queue(model, 'detail', 1, { status: 404, data: { detail: '索引已删除' } });
      await ready(page); await openSingle(page); await page.locator('#edit-load-retry').waitFor({ state: 'visible' });
      await page.locator('#edit-title').fill('不能写入的标题');
      await noPreview(page, model);
      assert.equal(await page.locator('#btn-edit-preview').isDisabled(), true);
    });
    await withPage(async ({ page, model }) => {
      queue(model, 'detail', 1, { data: { ...model.full[0], file_exists: false } });
      await ready(page); await openSingle(page); await loaded(page);
      await page.locator('#edit-title').fill('离线文件不可提交');
      await noPreview(page, model);
      assert.equal(await page.locator('#btn-edit-preview').isDisabled(), true);
    });
    await withPage(async ({ page, model }) => {
      const delay = gate(); queue(model, 'detail', 1, { gate: delay, status: 401, data: { detail: '会话已失效' } });
      await ready(page); await openSingle(page);
      await entered(delay); await release(page, delay);
      await page.locator('#auth-veil').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'false');
      assert.equal(requestsAt(model, '/api/tracks/preview').length, 0);
    });
  });

  await check('Closed or replaced edits reject late details and lyrics from an earlier track', () => withPage(async ({ page, model }) => {
    const detailDelay = gate(), lyricsDelay = gate();
    queue(model, 'detail', 1, { gate: detailDelay, data: { ...model.full[0], title: '过期旧详情' } });
    queue(model, 'lyrics', 1, { gate: lyricsDelay, data: { lyrics: '过期旧歌词', has_lyrics: true, lines: 1, chars: 5 } });
    await ready(page); await openSingle(page); await entered(detailDelay); await entered(lyricsDelay);
    await page.locator('#edit-close').click(); await openSingle(page, 2); await loaded(page, '作曲 2');
    await release(page, detailDelay); await release(page, lyricsDelay);
    assert.equal(await page.locator('#edit-title').inputValue(), model.full[1].title);
    assert.equal(await page.locator('#edit-lyrics').inputValue(), model.lyrics.get(2));
    await page.locator('#edit-genre').fill('第二首改动');
    const payload = await preview(page, model);
    assert.deepEqual(payload.ids, [2]); assert.deepEqual(payload.fields, { genre: '第二首改动' });
  }));

  await check('Reopening the same track uses the new edit baseline and ignores the old response', () => withPage(async ({ page, model }) => {
    const delay = gate(); queue(model, 'detail', 1, { gate: delay, data: { ...model.full[0], title: '旧面板数据' } });
    queue(model, 'detail', 1, { data: { ...model.full[0], title: '重新打开数据' } });
    await ready(page); await openSingle(page); await entered(delay);
    await page.locator('#edit-close').click(); await openSingle(page); await loaded(page);
    await release(page, delay);
    assert.equal(await page.locator('#edit-title').inputValue(), '重新打开数据');
    await noPreview(page, model);
  }));

  await check('Batch common values prefill, mixed values stay empty, and opening does not make N detail requests', () => withPage(async ({ page, model }) => {
    await ready(page); await openBatch(page, model.rows.slice(0, 2));
    assert.equal(await page.locator('#edit-artist').inputValue(), '甲歌手/乙歌手');
    assert.equal(await page.locator('#edit-album').inputValue(), '共同专辑');
    assert.equal(await page.locator('#edit-title').inputValue(), '');
    assert.match(await page.locator('#edit-title').getAttribute('placeholder'), /多个|不同/);
    assert.equal(await page.locator('#edit-title').evaluate(node => node.closest('label').dataset.editState), 'mixed');
    assert.equal(await page.locator('#edit-genre').inputValue(), '');
    assert.equal(await page.locator('#edit-composer').inputValue(), '');
    assert.match(await page.locator('#edit-composer').evaluate(node => node.closest('label').textContent), /未载入|未加载|未.*读取/);
    assert.equal(details(model).length, 0);
    assert.equal(model.calls.filter(call => call.path.endsWith('/lyrics')).length, 0);
    await noPreview(page, model);
    await page.locator('#edit-genre').fill('统一流派');
    assert.deepEqual((await preview(page, model)).fields, { genre: '统一流派' });
    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-artist').inputValue(), '甲歌手/乙歌手');
    assert.equal(await page.locator('#edit-genre').inputValue(), '');
    await noPreview(page, model);
  }));

  await check('Incomplete batch snapshots show unknown fields and send extra fields only after explicit input', () => withPage(async ({ page, model }) => {
    await ready(page);
    const rows = model.rows.slice(0, 2).map(row => ({ ...row }));
    delete rows[1].album; delete rows[1].language;
    await openBatch(page, rows);
    for (const key of ['album', 'language']) {
      assert.equal(await page.locator(`#edit-${key}`).inputValue(), '');
      assert.match(await page.locator(`#edit-${key}`).evaluate(node => node.closest('label').textContent), /未载入|未加载|未.*读取/);
      assert.equal(await page.locator(`#edit-${key}`).evaluate(node => node.closest('label').dataset.editState), 'unknown');
    }
    await noPreview(page, model);
    await more(page); await page.locator('#edit-composer').fill('显式填写的共同作曲');
    assert.deepEqual((await preview(page, model)).fields, { composer: '显式填写的共同作曲' });
    assert.equal(details(model).length, 0);
  }));

  await check('Multiline tags, zero, null, and invalid types have safe baselines without accidental submissions', () => withPage(async ({ page, model }) => {
    const record = { ...model.full[0], title: '标题\r\n续行', comment: '注释第一行\r\n注释第二行', track: 0,
      year: null, genre: '', composer: { invalid: 'object' }, copyright: false };
    delete record.lyricist;
    model.full[0] = record;
    model.rows[0] = light(record);
    await ready(page); await openSingle(page); await loaded(page, record.mb_artist_id, 'mb_artist_id');
    assert.equal(await page.locator('#edit-title').inputValue(), '标题续行');
    assert.equal(await page.locator('#edit-comment').evaluate(node => node.tagName), 'TEXTAREA');
    assert.equal(await page.locator('#edit-comment').inputValue(), '注释第一行\n注释第二行');
    assert.equal(await page.locator('#edit-track').inputValue(), '0');
    for (const key of ['year', 'genre']) {
      assert.equal(await page.locator(`#edit-${key}`).inputValue(), '');
      assert.equal(await page.locator(`#edit-${key}`).evaluate(node => node.closest('label').dataset.editState), 'empty');
    }
    for (const key of ['composer', 'lyricist', 'copyright']) {
      assert.equal(await page.locator(`#edit-${key}`).inputValue(), '');
      assert.equal(await page.locator(`#edit-${key}`).evaluate(node => node.closest('label').dataset.editState), 'unknown');
    }
    await noPreview(page, model);
    await more(page); await page.locator('#edit-comment').fill('注释第一行\n修改第二行');
    assert.deepEqual((await preview(page, model)).fields, { comment: '注释第一行\n修改第二行' });
  }));

  await check('Mismatched detail identities never prefill another track and retry preserves an existing draft', () => withPage(async ({ page, model }) => {
    queue(model, 'detail', 1, { data: { ...model.full[1], title: '错误身份的标题' } });
    const delay = gate(); queue(model, 'detail', 1, { gate: delay });
    await ready(page); await openSingle(page); await page.locator('#edit-load-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#edit-title').inputValue(), model.rows[0].title);
    assert.equal(await page.locator('#edit-composer').inputValue(), '');
    await page.locator('#edit-title').fill('保留正确曲目草稿');
    await page.locator('#edit-load-retry').click(); await entered(delay);
    // A repeated user action during loading must not create an unguarded second
    // response that can overwrite this draft or change its target identity.
    await page.locator('#edit-load-retry').evaluate(button => button.click());
    await release(page, delay); await loaded(page);
    assert.equal(await page.locator('#edit-title').inputValue(), '保留正确曲目草稿');
    const payload = await preview(page, model);
    assert.deepEqual(payload.ids, [1]); assert.deepEqual(payload.fields, { title: '保留正确曲目草稿' });
  }));

  await check('Fresh incomplete detail marks missing fields unknown instead of retaining stale snapshot values', () => withPage(async ({ page, model }) => {
    const partial = { ...model.full[0] }; delete partial.album; delete partial.genre;
    queue(model, 'detail', 1, { data: partial });
    const delay = gate(); queue(model, 'detail', 1, { gate: delay, data: { ...model.full[0], album: '重新载入专辑' } });
    await ready(page); await openSingle(page); await loaded(page);
    await page.locator('#edit-load-retry').waitFor({ state: 'visible' });
    for (const key of ['album', 'genre']) {
      assert.equal(await page.locator(`#edit-${key}`).inputValue(), '');
      assert.equal(await page.locator(`#edit-${key}`).evaluate(node => node.closest('label').dataset.editState), 'unknown');
    }
    await noPreview(page, model);
    await page.locator('#edit-genre').fill('补全期间的流派草稿');
    await page.locator('#edit-load-retry').click(); await entered(delay); await release(page, delay);
    assert.equal(await page.locator('#edit-album').inputValue(), '重新载入专辑');
    assert.equal(await page.locator('#edit-genre').inputValue(), '补全期间的流派草稿');
    assert.deepEqual((await preview(page, model)).fields, { genre: '补全期间的流派草稿' });
  }));

  await check('Successful simulated writes reload normalized baselines while preserving newer drafts and rejecting old lyrics', () => withPage(async ({ page, model }) => {
    model.expectedWrites = 2;
    const oldLyrics = gate(), previewDelay = gate();
    queue(model, 'lyrics', 1, { gate: oldLyrics, data: { lyrics: '已经过期的原歌词', has_lyrics: true, lines: 1, chars: 9 } });
    model.gates.push(previewDelay); model.previewReplies.push({ gate: previewDelay });
    const applied = { ...model.full[0], artist: '规范歌手 & Guest', title: '第一次提交标题' };
    model.applyReplies.push({
      update: () => { model.full[0] = applied; model.rows[0] = light(applied); model.lyrics.set(1, '已写入的新歌词'); },
      data: { written: 1, skipped: 0, failed: [], fields: ['artist', 'title', 'lyrics'],
        items: [{ track_id: 1, written: ['artist', 'title'], skipped: [{ field: 'genre', reason: 'unsupported' }], file_changed: true, lyrics: true, cover: false }] },
    });
    await ready(page); await openSingle(page); await loaded(page); await entered(oldLyrics);
    await page.locator('#edit-artist').fill('别名/Guest');
    await page.locator('#edit-title').fill('第一次提交标题');
    await page.locator('#edit-genre').fill('未写入的流派草稿');
    await page.locator('#edit-lyrics').fill('已写入的新歌词');
    await page.locator('#btn-edit-preview').click(); await entered(previewDelay);
    // The form remains editable while preview reads the initial submission.
    await page.locator('#edit-title').fill('预览等待时的新标题草稿');
    await release(page, previewDelay); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog[open]').getByRole('button', { name: '确认处理 1 首' }).click();
    await page.waitForFunction(() => document.querySelector('#edit-artist')?.value === '规范歌手 & Guest' && !document.querySelector('#btn-edit-preview').disabled);
    await page.waitForFunction(() => document.querySelector('#edit-lyrics')?.value === '已写入的新歌词');
    await release(page, oldLyrics);
    assert.equal(await page.locator('#edit-title').inputValue(), '预览等待时的新标题草稿');
    assert.equal(await page.locator('#edit-genre').inputValue(), '未写入的流派草稿');
    assert.equal(await page.locator('#edit-lyrics').inputValue(), '已写入的新歌词');
    assert.deepEqual(requestsAt(model, '/api/tracks/apply')[0].body.fields,
      { artist: '别名/Guest', title: '第一次提交标题', genre: '未写入的流派草稿', lyrics: '已写入的新歌词' });
    assert.equal(details(model).length, 2, 'The resulting index must be read after writing');
    assert.equal(requestsAt(model, '/api/tracks/1/lyrics').length, 2, 'Successful lyrics writes must reload their baseline');
    assert.deepEqual((await preview(page, model)).fields, { title: '预览等待时的新标题草稿', genre: '未写入的流派草稿' });

    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-title').inputValue(), '第一次提交标题');
    assert.equal(await page.locator('#edit-artist').inputValue(), '规范歌手 & Guest');
    await noPreview(page, model);
    const second = { ...applied, genre: '最终写入流派' };
    model.applyReplies.push({
      update: () => { model.full[0] = second; model.rows[0] = light(second); },
      data: { written: 1, skipped: 0, failed: [], fields: ['genre'],
        items: [{ track_id: 1, written: ['genre'], skipped: [], file_changed: true, lyrics: false, cover: false }] },
    });
    await page.locator('#edit-genre').fill('最终写入流派');
    await page.locator('#btn-edit-preview').click(); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog[open]').getByRole('button', { name: '确认处理 1 首' }).click();
    await page.waitForFunction(() => document.querySelector('#edit-genre')?.closest('label').dataset.editState === 'unchanged' && !document.querySelector('#btn-edit-preview').disabled);
    assert.equal(details(model).length, 3);
    assert.equal(requestsAt(model, '/api/tracks/1/lyrics').length, 2);
    assert.deepEqual(requestsAt(model, '/api/tracks/apply')[1].body.fields, { genre: '最终写入流派' });
    await noPreview(page, model);
  }));

  await check('Returning edited values to their baseline removes the outgoing change in both single and batch modes', () => withPage(async ({ page, model }) => {
    await ready(page); await openSingle(page); await loaded(page);
    await page.locator('#edit-artist').fill('另一个歌手'); await page.locator('#edit-artist').fill(model.full[0].artist);
    await more(page); await page.locator('#edit-comment').fill('临时'); await page.locator('#edit-comment').fill(model.full[0].comment);
    await noPreview(page, model);
    await page.locator('#edit-close').click(); await openBatch(page, model.rows.slice(0, 2));
    await page.locator('#edit-album').fill('临时专辑'); await page.locator('#edit-album').fill('共同专辑');
    await page.locator('#edit-title').fill('临时标题'); await page.locator('#edit-title').fill('');
    await noPreview(page, model);
  }));

  await check('Lyrics remain separate: unchanged and blank lyrics are omitted, edits submit, reset restores the loaded lyric baseline', () => withPage(async ({ page, model }) => {
    await ready(page); await openSingle(page); await loaded(page);
    await page.waitForFunction(() => document.querySelector('#edit-lyrics')?.value.includes('原有歌词'));
    await page.locator('#edit-title').fill('仅改标题');
    assert.deepEqual((await preview(page, model)).fields, { title: '仅改标题' });
    await page.locator('#btn-edit-clear').click();
    await page.locator('#edit-lyrics').fill('[00:02.00] 手动改动歌词');
    assert.deepEqual((await preview(page, model)).fields, { lyrics: '[00:02.00] 手动改动歌词' });
    await page.locator('#edit-lyrics').fill(''); await noPreview(page, model);
    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-lyrics').inputValue(), model.lyrics.get(1));
    await noPreview(page, model);
  }));

  await check('Late lyrics preserve typed drafts while reset after completion uses the server baseline', () => withPage(async ({ page, model }) => {
    const delay = gate(); queue(model, 'lyrics', 1, { gate: delay });
    await ready(page); await openSingle(page); await loaded(page); await entered(delay);
    await page.locator('#edit-lyrics').fill('网络等待时输入的歌词');
    await release(page, delay);
    assert.equal(await page.locator('#edit-lyrics').inputValue(), '网络等待时输入的歌词');
    assert.deepEqual((await preview(page, model)).fields, { lyrics: '网络等待时输入的歌词' });
    await page.locator('#btn-edit-clear').click();
    assert.equal(await page.locator('#edit-lyrics').inputValue(), model.lyrics.get(1));
    await noPreview(page, model);
  }));

  await check('Editor fits both themes at 320, 390, 768 and 1440px with readable field states and reduced motion', async () => {
    for (const colorScheme of ['light', 'dark']) {
      for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 1000]]) {
        await withPage(async ({ page, model }) => {
          await ready(page); await openSingle(page); await loaded(page);
          await more(page); await page.locator('#edit-comment').fill('布局检查改动');
          const dimensions = await page.locator('#edit-drawer').evaluate(node => {
            const box = node.getBoundingClientRect(), body = node.querySelector('.drawer-body');
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewport: innerWidth, height: innerHeight,
              width: node.scrollWidth, client: node.clientWidth, bodyWidth: body.scrollWidth, bodyClient: body.clientWidth,
              pageWidth: document.documentElement.scrollWidth, animations: node.getAnimations({ subtree: true }).length };
          });
          assert.ok(dimensions.left >= -1 && dimensions.top >= -1 && dimensions.right <= width + 1 && dimensions.bottom <= height + 1, JSON.stringify(dimensions));
          assert.ok(dimensions.width <= dimensions.client + 1 && dimensions.bodyWidth <= dimensions.bodyClient + 1 && dimensions.pageWidth <= width + 1, JSON.stringify(dimensions));
          assert.equal(dimensions.animations, 0);
          assert.equal(await page.locator('#edit-change-summary').isVisible(), true);
          await page.locator('#btn-edit-preview').scrollIntoViewIfNeeded();
          assert.equal(await page.locator('#btn-edit-preview').isVisible(), true);
          await page.screenshot({ path: path.join(out, `metadata-editor-${width}-${colorScheme}.png`) });
          assert.deepEqual((await preview(page, model)).fields, { comment: '布局检查改动' });
          await page.locator('#edit-close').click();
          assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'true');
        }, { viewport: { width, height }, colorScheme });
      }
    }
  });

  console.log(`\n${passed} metadata editor checks passed; ${failures.length} failed. Screenshots: ${out}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
