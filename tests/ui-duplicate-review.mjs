/** Duplicate metadata review against isolated fixtures, never real audio. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { revealLibraryTools } from './ui-library-controls.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) { try { playwright = require(value); break; } catch {} }
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const out = path.join(root, '.codex/ui-preview'), port = Number(process.env.METATIDY_DUPLICATES_UI_PORT || 18865), base = `http://127.0.0.1:${port}`;
const revision = '0123456789abcdef0123456789abcdef', changedRevision = '11111111111111111111111111111111';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = () => ({ entered: deferred(), release: deferred() });
const makeRow = (id, group, extra = {}) => ({ id, artist: group.artist, title: group.title, album: id % 2 ? '原始专辑' : '精选现场', albumartist: group.artist, year: id % 2 ? '2012' : '2024', filename: `${id} - ${group.title}.${id % 2 ? 'flac' : 'mp3'}`, path: `/music/${id % 2 ? '专辑' : '精选'}/${group.artist}/${group.title}-${id}.${id % 2 ? 'flac' : 'mp3'}`, dir: '/music', ext: id % 2 ? 'flac' : 'mp3', duration: id % 2 ? 215 : 219, size: id % 2 ? 28000000 : 9000000, has_cover: id % 2, has_lyrics: id % 3 ? 1 : 0, tags_loaded: true, path_derived: false, indexed_at: 1700000000, edited_at: 0, scraped_at: 0, mtime: 1690000000, genre: 'Pop', track: '1', disc: '1', language: '中文', albumtype: '专辑', ...extra });
const sample = (artist, title, count = 3, start = 101) => { const group = { group: [artist.toLowerCase(), title.toLowerCase()], artist, title, track_count: count }; return { ...group, rows: Array.from({ length: count }, (_, index) => makeRow(start + index, group)) }; };
const groupsOf = model => model.groups.map(({ rows, ...group }) => ({ ...group, track_count: rows.length }));
const pagination = (items, size, wanted) => { const pages = Math.ceil(items.length / size), page = Math.max(1, Math.min(pages || 1, wanted)); return { items: items.slice((page - 1) * size, page * size), total: items.length, pages, page, page_size: size }; };
const details = (model, group, wanted, size, rev = model.revision) => ({ ...pagination(group.rows, size, wanted), group: group.group, revision: rev, summary: { bytes: group.rows.reduce((sum, row) => sum + (row.size || 0), 0), duration_min: 215, duration_max: 219, formats: ['flac', 'mp3'], missing_cover: 1, missing_lyrics: 1 } });
const writes = calls => calls.filter(call => ['/api/tracks/apply', '/api/scrape/apply', '/api/scrape/batch', '/api/move/execute', '/api/scan'].includes(call.path) || call.method === 'DELETE');
const callsAt = (model, pathname) => model.calls.filter(call => call.path === pathname);
let browser, server, passed = 0;
const failures = [];
async function check(name, action) { if (process.env.METATIDY_DUPLICATES_UI_FILTER && !name.includes(process.env.METATIDY_DUPLICATES_UI_FILTER)) return; try { await action(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); } }
async function waitGate(value, label) { let timer; try { await Promise.race([value.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 5000); })]); } finally { clearTimeout(timer); } }
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ids(page) { return page.evaluate(async () => (await import('/store.js')).selectionIds()); }
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const model = { groups: [sample('周杰伦', '晴天'), sample('王菲', '红豆', 2, 201)], revision, calls: [], handlers: {} }, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : null;
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), body, method: request.method() }; model.calls.push(call);
    if (!url.pathname.startsWith('/api/duplicates')) return route.continue();
    const handler = model.handlers[url.pathname];
    if (handler) return handler({ route, url, body, call });
    if (url.pathname === '/api/duplicates') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      return route.fulfill({ json: pagination(groupsOf(model).filter(item => `${item.artist} ${item.title}`.toLowerCase().includes(q)), Number(url.searchParams.get('page_size')), Number(url.searchParams.get('page'))) });
    }
    const wantedGroup = url.pathname.endsWith('/selection') ? body.group : JSON.parse(url.searchParams.get('group'));
    const group = model.groups.find(item => JSON.stringify(item.group) === JSON.stringify(wantedGroup));
    if (!group) return route.fulfill({ status: 409, json: { detail: '分组已经变化' } });
    if (url.pathname.endsWith('/detail')) return route.fulfill({ json: details(model, group, Number(url.searchParams.get('page')), Number(url.searchParams.get('page_size'))) });
    const track = group.rows.find(row => row.id === body.track_id);
    if (!track || body.revision !== model.revision) return route.fulfill({ status: 409, json: { detail: '分组版本或目标曲目已经变化' } });
    return route.fulfill({ json: { group: group.group, revision: model.revision, total: group.rows.length, track, selected_at: 1700000001 } });
  });
  try {
    await page.goto(base); await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18);
    await action({ page, context, model }); assert.deepEqual(errors, []); assert.equal(writes(model.calls).length, 0, 'Duplicate review must not mutate music');
  } finally { await context.close(); }
}
async function open(page, expected = 2) { await revealLibraryTools(page); await page.locator('#btn-duplicates').click(); await page.waitForFunction(expected => document.querySelectorAll('.dr-group').length === expected && document.querySelector('#duplicate-review-groups')?.getAttribute('aria-busy') === 'false', expected); }
async function choose(page, index = 0, expected = 3) { await page.locator('.dr-group').nth(index).click(); await page.waitForFunction(expected => document.querySelectorAll('.dr-file').length === expected && document.querySelector('#duplicate-review-files')?.getAttribute('aria-busy') === 'false', expected); }
async function noOverflow(page) { assert.equal(await page.locator('#duplicate-review-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().right <= innerWidth + 1 && node.getBoundingClientRect().bottom <= innerHeight + 1), true); }

try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000); server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Review opens lazily, preserves library filters, and requires a group before reading files', () => withPage(async ({ page, model }) => {
    await page.locator('#tracks-q').fill('周杰伦'); await page.locator('#tracks-q').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    const before = await page.evaluate(async () => { const value = (await import('/store.js')).state.tracks; return JSON.stringify({ q: value.q, filters: value.filters, page: value.page, sort: value.sort }); });
    assert.equal(callsAt(model, '/api/duplicates').length, 0);
    await open(page);
    assert.equal(callsAt(model, '/api/duplicates/detail').length, 0); assert.deepEqual(await ids(page), []);
    await choose(page);
    assert.equal(callsAt(model, '/api/duplicates/detail').length, 1); assert.equal(callsAt(model, '/api/duplicates/selection').length, 0);
    assert.equal(await page.locator('#duplicate-review-dialog img').count(), 0);
    await page.keyboard.press('Escape'); await page.locator('#duplicate-review-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(async () => { const value = (await import('/store.js')).state.tracks; return JSON.stringify({ q: value.q, filters: value.filters, page: value.page, sort: value.sort }); }), before);
    assert.equal(await page.locator('#btn-duplicates').evaluate(node => node === document.activeElement), true);
  }));

  await check('Comparison shows actual file differences and safe full paths without inferring audio equality', () => withPage(async ({ page, model }) => {
    model.groups[0].rows[0].path = '/music/<img src=x onerror=window.duplicateInjected=true>/目录 '.repeat(5) + '/晴天.flac';
    await open(page); await choose(page);
    assert.match(await page.locator('#duplicate-review-differences').innerText(), /专辑.*年份.*格式.*时长.*大小/);
    assert.ok(await page.locator('.dr-field[data-different="true"]').count() > 0);
    assert.equal(await page.locator('.dr-path').first().innerText(), model.groups[0].rows[0].path);
    assert.equal(await page.evaluate(() => window.duplicateInjected), undefined);
    assert.match(await page.locator('.dr-scope').innerText(), /未比较音频内容/);
    assert.match(await page.locator('#duplicate-review-detail-status').innerText(), /未读取或检查磁盘/);
    await noOverflow(page);
  }));

  await check('One validated row appends to existing selection and hands off to the existing selection review', () => withPage(async ({ page, model }) => {
    await page.evaluate(async () => (await import('/store.js')).selectRows([{ id: 9001, title: '先前已选', path: '/old.flac' }]));
    await open(page); await choose(page);
    await page.locator('.dr-add[data-id="102"]').click();
    await page.waitForFunction(() => document.querySelector('.dr-add[data-id="102"]')?.textContent === '已在选择中');
    assert.deepEqual(await ids(page), [9001, 102]);
    assert.deepEqual(callsAt(model, '/api/duplicates/selection')[0].body, { group: model.groups[0].group, revision, track_id: 102 });
    await page.locator('.dr-add[data-id="102"]').evaluate(node => node.click());
    assert.equal(callsAt(model, '/api/duplicates/selection').length, 1);
    await page.locator('#duplicate-review-selection').click();
    await page.locator('#selection-review-dialog').waitFor(); assert.equal(await page.locator('#duplicate-review-dialog').count(), 0);
    assert.equal(await page.locator('dialog[open]').count(), 1); assert.match(await page.locator('#selection-review-total').innerText(), /2 首/);
  }));

  await check('Group and file paging keep server canonical identities and carry revision on later file pages', () => withPage(async ({ page, model }) => {
    model.groups = Array.from({ length: 21 }, (_, index) => sample(`歌手 ${index}`, `歌曲 ${index}`, index ? 2 : 53, index * 1000 + 101));
    model.groups[0].group = ['ı', 'database canonical value'];
    await open(page, 20); await choose(page, 0, 50);
    await page.locator('#duplicate-review-files-next').click();
    await page.waitForFunction(() => document.querySelectorAll('.dr-file').length === 3 && document.querySelector('#duplicate-review-files')?.getAttribute('aria-busy') === 'false');
    const last = callsAt(model, '/api/duplicates/detail').at(-1);
    assert.deepEqual(JSON.parse(last.query.group), ['ı', 'database canonical value']); assert.equal(last.query.revision, revision); assert.equal(last.query.page_size, '50');
    await page.locator('#duplicate-review-groups-next').click();
    await page.waitForFunction(() => document.querySelectorAll('.dr-group').length === 1 && document.querySelector('#duplicate-review-groups')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.dr-file').count(), 0); assert.equal(await page.locator('.dr-group[aria-pressed="true"]').count(), 0);
    assert.equal(callsAt(model, '/api/duplicates').at(-1).query.page_size, '20'); assert.deepEqual(await ids(page), []);
  }));

  await check('File pages reject revision drift and invalid identity while respecting database whitespace semantics', async () => {
    for (const fault of ['revision', 'order', 'path-derived', 'unloaded', 'group']) await withPage(async ({ page, model }) => {
      model.groups[0] = sample('周杰伦', '晴天', 51);
      await open(page); await choose(page, 0, 50);
      model.handlers['/api/duplicates/detail'] = ({ route }) => {
        const result = details(model, model.groups[0], 2, 50);
        if (fault === 'revision') result.revision = changedRevision;
        if (fault === 'order') result.items[0] = model.groups[0].rows[0];
        if (fault === 'path-derived') result.items[0] = { ...result.items[0], path_derived: true };
        if (fault === 'unloaded') result.items[0] = { ...result.items[0], tags_loaded: false };
        if (fault === 'group') result.group = ['wrong', 'group'];
        return route.fulfill({ json: result });
      };
      await page.locator('#duplicate-review-files-next').click(); await page.locator('#duplicate-review-detail-retry').waitFor();
      assert.equal(await page.locator('.dr-file').count(), 0); assert.deepEqual(await ids(page), []);
    });
    await withPage(async ({ page, model }) => {
      model.groups = [sample('\u3000', '\u3000', 2)];
      await open(page, 1); await choose(page, 0, 2);
      await page.locator('.dr-add').first().click(); await page.waitForFunction(() => document.querySelector('.dr-add')?.textContent === '已在选择中');
      assert.deepEqual(await ids(page), [101]);
    });
  });

  await check('Late group searches and switched-group details never replace current results', () => withPage(async ({ page, model }) => {
    const groupGate = gate(), detailGate = gate();
    model.handlers['/api/duplicates'] = async ({ route, url }) => {
      const old = url.searchParams.get('q') === 'old'; if (old) { groupGate.entered.resolve(); await groupGate.release.promise; }
      return route.fulfill({ json: pagination(old ? [groupsOf(model)[0]] : [groupsOf(model)[1]], 20, 1) }).catch(() => {});
    };
    try {
      await open(page, 1);
      await page.locator('#duplicate-review-q').fill('old'); await page.locator('#duplicate-review-search').click(); await waitGate(groupGate.entered, 'old groups');
      await page.locator('#duplicate-review-q').fill('new'); await page.locator('#duplicate-review-search').click();
      await page.locator('.dr-group strong', { hasText: '红豆' }).waitFor(); groupGate.release.resolve();
      delete model.handlers['/api/duplicates']; await page.locator('#duplicate-review-q').fill(''); await page.locator('#duplicate-review-search').click();
      await page.waitForFunction(() => document.querySelectorAll('.dr-group').length === 2);
      model.handlers['/api/duplicates/detail'] = async ({ route, url }) => {
        const g = model.groups.find(item => JSON.stringify(item.group) === url.searchParams.get('group'));
        if (g === model.groups[0]) { detailGate.entered.resolve(); await detailGate.release.promise; }
        return route.fulfill({ json: details(model, g, 1, 50) }).catch(() => {});
      };
      await page.locator('.dr-group').first().click(); await waitGate(detailGate.entered, 'old detail'); await choose(page, 1, 2);
      detailGate.release.resolve(); await flush(page);
      assert.equal(await page.locator('#duplicate-review-group-title').innerText(), '红豆'); assert.equal(await page.locator('.dr-file').first().getAttribute('data-id'), '201'); assert.deepEqual(await ids(page), []);
    } finally { groupGate.release.resolve(); detailGate.release.resolve(); }
  }));

  await check('Selection changes, group changes, and page changes cancel pending additions', async () => {
    for (const action of ['selection', 'group', 'page']) await withPage(async ({ page, model }) => {
      if (action === 'page') model.groups[0] = sample('周杰伦', '晴天', 51);
      const held = gate();
      model.handlers['/api/duplicates/selection'] = async ({ route, body }) => { held.entered.resolve(); await held.release.promise; return route.fulfill({ json: { group: model.groups[0].group, revision, total: model.groups[0].rows.length, track: model.groups[0].rows.find(row => row.id === body.track_id), selected_at: 1700000001 } }).catch(() => {}); };
      try {
        await open(page); await choose(page, 0, action === 'page' ? 50 : 3); await page.locator('.dr-add').first().click(); await waitGate(held.entered, 'pending add');
        if (action === 'selection') await page.evaluate(async () => (await import('/store.js')).selectRows([{ id: 9002, title: '另一处选择' }]));
        else if (action === 'group') await choose(page, 1, 2);
        else { await page.locator('#duplicate-review-files-next').click(); await page.waitForFunction(() => document.querySelectorAll('.dr-file').length === 1); }
        held.release.resolve(); await flush(page); assert.deepEqual(await ids(page), action === 'selection' ? [9002] : []);
      } finally { held.release.resolve(); }
    });
  });

  await check('Changed group revision and malformed selection responses never add a stale row', async () => {
    for (const failure of ['conflict', 'wrong-id', 'wrong-fields', 'wrong-group', 'wrong-revision']) await withPage(async ({ page, model }) => {
      model.handlers['/api/duplicates/selection'] = ({ route }) => {
        if (failure === 'conflict') return route.fulfill({ status: 409, json: { detail: '索引已经变化' } });
        const track = { ...model.groups[0].rows[0] };
        if (failure === 'wrong-id') track.id = 999;
        if (failure === 'wrong-fields') track.path = '/different.flac';
        return route.fulfill({ json: { group: failure === 'wrong-group' ? ['other', 'group'] : model.groups[0].group, revision: failure === 'wrong-revision' ? changedRevision : revision, total: 3, track, selected_at: 1700000001 } });
      };
      await open(page); await choose(page); await page.locator('.dr-add').first().click();
      await page.waitForFunction(() => document.querySelector('#duplicate-review-add-status')?.textContent.includes('未加入选择'));
      assert.deepEqual(await ids(page), []); assert.equal(await page.locator('#duplicate-review-detail-retry').isVisible(), true); assert.equal(await page.locator('.dr-add').first().isDisabled(), true);
    });
  });

  await check('Background index updates preserve comparison order and require an explicit refresh', () => withPage(async ({ page, model }) => {
    await open(page); await choose(page);
    const before = await page.locator('.dr-file').evaluateAll(nodes => nodes.map(node => node.dataset.id));
    const reads = callsAt(model, '/api/duplicates/detail').length;
    await page.locator('.dr-copy').first().focus();
    await page.evaluate(async () => (await import('/store.js')).emit('status:refresh'));
    await page.locator('#duplicate-review-notice').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('.dr-file').evaluateAll(nodes => nodes.map(node => node.dataset.id)), before);
    assert.equal(callsAt(model, '/api/duplicates/detail').length, reads); assert.equal(await page.locator('.dr-copy').first().evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.dr-add').first().isDisabled(), true);
    await page.locator('#duplicate-review-refresh').click(); await page.waitForFunction(() => document.querySelector('#duplicate-review-groups')?.getAttribute('aria-busy') === 'false');
    await choose(page); assert.equal(await page.locator('.dr-add').first().isDisabled(), false);
  }));

  await check('401 and hash navigation close the review and discard late selection responses', async () => {
    for (const kind of ['401', 'hash']) await withPage(async ({ page, model }) => {
      const held = gate();
      model.handlers['/api/duplicates/selection'] = async ({ route }) => { held.entered.resolve(); await held.release.promise; return route.fulfill({ json: { group: model.groups[0].group, revision, total: 3, track: model.groups[0].rows[0], selected_at: 1700000001 } }).catch(() => {}); };
      try {
        await open(page); await choose(page); await page.locator('.dr-add').first().click(); await waitGate(held.entered, 'selection before close');
        if (kind === '401') {
          await page.route('**/api/duplicate-auth-probe', route => route.fulfill({ status: 401, json: { detail: '登录已过期' } }));
          await page.evaluate(async () => { try { await (await import('/api.js')).request('/api/duplicate-auth-probe'); } catch {} });
          await page.locator('#auth-password').waitFor({ state: 'visible' });
        } else await page.evaluate(() => { location.hash = '#settings'; });
        await page.locator('#duplicate-review-dialog').waitFor({ state: 'detached' }); held.release.resolve(); await flush(page); assert.deepEqual(await ids(page), []);
      } finally { held.release.resolve(); }
    });
  });

  await check('Empty groups and detail errors are readable and can recover without changing selection', () => withPage(async ({ page, model }) => {
    const saved = model.groups; model.groups = []; await open(page, 0);
    assert.match(await page.locator('#duplicate-review-group-status').innerText(), /暂未发现/);
    assert.equal(await page.locator('#duplicate-review-groups-next').isDisabled(), true);
    model.groups = saved;
    await page.locator('#duplicate-review-refresh').click(); await page.waitForFunction(() => document.querySelectorAll('.dr-group').length === 2);
    model.handlers['/api/duplicates/detail'] = ({ route }) => route.fulfill({ status: 409, json: { detail: '分组已经变化' } });
    await page.locator('.dr-group').first().click(); await page.locator('#duplicate-review-detail-retry').waitFor(); assert.deepEqual(await ids(page), []);
    delete model.handlers['/api/duplicates/detail']; await page.locator('#duplicate-review-detail-retry').click(); await page.waitForFunction(() => document.querySelectorAll('.dr-file').length === 3); assert.deepEqual(await ids(page), []);
  }));

  await check('Command palette opens duplicate review directly from another tab without changing that tab', () => withPage(async ({ page }) => {
    await page.locator('#tab-settings').click(); await page.locator('#btn-palette').click();
    await page.locator('#palette-input').fill('核对疑似重复曲目'); await page.locator('#palette-input').press('Enter');
    await page.locator('#duplicate-review-dialog').waitFor(); assert.match(page.url(), /#settings$/);
    await page.keyboard.press('Escape'); await page.locator('#duplicate-review-dialog').waitFor({ state: 'detached' });
    assert.match(page.url(), /#settings$/); assert.equal(await page.locator('#btn-palette').evaluate(node => node === document.activeElement), true);
  }));

  await check('Duplicate comparison fits desktop and narrow phones with finite and reduced motion', async () => {
    for (const [width, height, colorScheme, reducedMotion] of [[1440, 1000, 'light', 'no-preference'], [1440, 1000, 'dark', 'reduce'], [390, 844, 'light', 'reduce'], [320, 568, 'dark', 'reduce']]) await withPage(async ({ page }) => {
      await open(page); await choose(page); await noOverflow(page);
      if (width <= 700) {
        assert.ok(await page.locator('.dr-comparison').evaluate(node => node.clientHeight) >= 240, 'Phone file comparison needs a readable scroll area');
        assert.equal(await page.locator('.dr-groups').isVisible(), false);
        await page.locator('#duplicate-review-change-group').click();
        await choose(page, 1, 2);
        assert.equal(await page.locator('#duplicate-review-group-title').innerText(), '红豆');
        assert.ok(await page.locator('.dr-comparison').evaluate(node => node.scrollHeight > node.clientHeight), 'Phone file cards remain scrollable');
      }
      assert.equal(await page.locator('.dr-file').first().evaluate(node => getComputedStyle(node).animationName === 'none'), reducedMotion === 'reduce');
      assert.equal(await page.locator('#duplicate-review-dialog').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity)), false);
      await page.locator('#duplicate-review-dialog').evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
      await page.locator('.dr-add').first().click(); await page.waitForFunction(() => document.querySelector('.dr-add')?.textContent === '已在选择中');
      await noOverflow(page);
      await page.screenshot({ path: path.join(out, `duplicate-review-${width}-${colorScheme}.png`) });
      await page.keyboard.press('Escape'); await page.locator('#duplicate-review-dialog').waitFor({ state: 'detached' });
    }, { viewport: { width, height }, colorScheme, reducedMotion });
  });

  await check('Very long names and paths remain readable in a scrolling phone comparison', () => withPage(async ({ page, model }) => {
    const name = '很长的歌手名称与特别版本 '.repeat(25), title = '这首歌拥有很长的标题 '.repeat(25);
    model.groups = [sample(name, title, 2)];
    model.groups[0].rows[0].path = `/music/${'长路径收藏/'.repeat(70)}file.flac`;
    await open(page, 1); await choose(page, 0, 2); await noOverflow(page);
    assert.ok(await page.locator('.dr-comparison').evaluate(node => node.clientHeight) >= 240);
    await page.locator('.dr-add').first().scrollIntoViewIfNeeded();
    await page.locator('.dr-add').first().click(); await page.waitForFunction(() => document.querySelector('.dr-add')?.textContent === '已在选择中');
    assert.deepEqual(await ids(page), [101]);
    await noOverflow(page);
  }, { viewport: { width: 320, height: 568 }, colorScheme: 'dark' }));

  await check('Long Unicode group labels leave desktop file actions reachable without truncating the stored label', () => withPage(async ({ page, model }) => {
    const artist = '艺'.repeat(4000), title = '长'.repeat(8000);
    model.groups = [sample(artist, title, 2)];
    await open(page, 1); await choose(page, 0, 2);
    assert.equal(await page.locator('#duplicate-review-group-title').textContent(), title);
    assert.equal(await page.locator('#duplicate-review-artist').textContent(), artist);
    assert.ok(await page.locator('#duplicate-review-files').evaluate(node => node.clientHeight) >= 180);
    assert.equal(await page.locator('.dr-comparison-head').evaluate(node => node.scrollHeight > node.clientHeight), true);
    await page.locator('.dr-add').first().click(); await page.waitForFunction(() => document.querySelector('.dr-add')?.textContent === '已在选择中');
    assert.deepEqual(await ids(page), [101]); await noOverflow(page);
    await page.screenshot({ path: path.join(out, 'duplicate-review-long-desktop.png') });
  }));

  console.log(`\n${passed} duplicate review checks passed; ${failures.length} failed. Screenshots: ${out}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
