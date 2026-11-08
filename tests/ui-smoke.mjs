/**
 * Browser acceptance checks for the UI against isolated local fixtures.
 * Requires Playwright and a browser; production has no npm dependency.
 * Run: node tests/ui-smoke.mjs
 * Optional: PLAYWRIGHT_MODULE=<module folder> PLAYWRIGHT_CHANNEL=chrome
 * Screenshots are saved under .codex/ui-preview/ (not production assets).
 */
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
  try { playwright = require(candidate); break; } catch { /* Try the next installed location. */ }
}
if (!playwright) throw new Error('Install Playwright for UI testing, or set PLAYWRIGHT_MODULE to an existing installation.');

const failures = [];
const servers = [];
const checks = [];
let browser;

async function startFixture(port, extra = []) {
  const child = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`, ...extra], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture server ${port} did not start`)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Metatidy UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', data => { clearTimeout(timer); reject(new Error(String(data))); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
  return `http://127.0.0.1:${port}`;
}

async function check(name, fn) {
  try { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}

async function waitRows(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('#tracks-tbody tr').length === expected, count);
}

async function noPageOverflow(page) {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(dimensions.width <= dimensions.viewport + 1, `Page overflows horizontally: ${dimensions.width}px > ${dimensions.viewport}px`);
}

/** Controlled API snapshots keep polling assertions separate from other UI checks. */
async function withPollingPage(base, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const model = {};
  await Promise.all(['status', 'tracks', 'jobs'].map(async key => {
    model[key] = await (await context.request.get(`${base}/api/${key}`)).json();
  }));
  const calls = { status: 0, tracks: 0, jobs: 0 };
  await page.route('**/api/**', async route => {
    const key = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (!(key in calls)) return route.continue();
    calls[key] += 1;
    await route.fulfill({ json: model[key] });
  });
  await page.clock.install();

  async function pollJobs() {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs');
    await page.evaluate(async () => { (await import('/store.js')).emit('jobs:refresh'); });
    await (await response).finished();
    await page.waitForFunction(id => document.querySelector('#jobs-list')?.textContent.includes(id), model.jobs.jobs[0].id);
    // Allow the response body and the scheduled background refresh to settle.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.clock.runFor(250);
  }

  function completeWatch(id, title) {
    model.tracks.items[0].title = title;
    model.jobs.jobs.unshift({ id, kind: 'scan', state: 'done', total: 1, done: 1, error: '',
      message: '自动增量验收', created_at: Math.floor(Date.now() / 1000),
      result: JSON.stringify({ trigger: 'watch', scanned: 1, added: 0, updated: 1, skipped: 0, removed: 0 }) });
  }

  try {
    await page.goto(base);
    await waitRows(page, 18);
    await page.waitForFunction(() => document.querySelector('#jobs-list')?.textContent.includes('fixture-scan-001'));
    await fn({ page, model, calls, pollJobs, completeWatch });
    assert.deepEqual(errors, [], 'Background updates must not raise browser errors');
  } finally {
    await context.close();
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  const base = await startFixture(18765);
  const emptyBase = await startFixture(18766, ['--empty']);
  const authBase = await startFixture(18767, ['--auth']);
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  const externalRequests = [];
  const injectedRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  const writes = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['POST', 'PUT'].includes(request.method())) writes.push(url.pathname);
    // The local machine's AdGuard content script can inject its own requests.
    // It is not an application dependency and must not affect this assertion.
    const knownInjection = url.protocol === 'http:' && url.hostname === 'local.adguard.org' && url.pathname === '/'
      && ['content-script', 'user-script'].includes(url.searchParams.get('type'));
    if (knownInjection) injectedRequests.push(url.href);
    else if (url.protocol.startsWith('http') && url.origin !== base) externalRequests.push(url.href);
  });
  await page.goto(base);

  await check('Desktop library loads all fixture tracks without horizontal overflow', async () => {
    await waitRows(page, 18);
    assert.match(await page.locator('#tracks-total').innerText(), /\b18\b/);
    await noPageOverflow(page);
    await page.screenshot({ path: path.join(outputDir, 'desktop-light.png'), fullPage: true });
    await page.screenshot({ path: path.join(outputDir, 'desktop-light-viewport.png') });
    console.log(`Desktop first track row starts at y=${Math.round((await page.locator('#tracks-tbody tr').first().boundingBox()).y)}px`);
  });

  await check('Compact artwork requests the shared 128px thumbnail bucket', async () => {
    const art = page.locator('#tracks-tbody .thumb img').first();
    assert.equal(new URL(await art.getAttribute('src'), base).searchParams.get('size'), '128');
    assert.equal(await art.getAttribute('width'), '48');
    assert.equal(await art.getAttribute('height'), '48');
    const box = await art.boundingBox();
    assert.ok(box.width <= 48 && box.height <= 48, 'Encoded thumbnail size must not enlarge the compact row artwork');
    await art.locator('xpath=ancestor::tr').locator('.row-edit').click();
    assert.match(await page.locator('#edit-drawer').evaluate(node => node.style.getPropertyValue('--art')), /cover\?size=128/);
    await page.locator('#edit-close').click();
  });

  await check('Cover view shares selection, search and persisted presentation preferences', async () => {
    await page.locator('#view-cards').click();
    await page.locator('#tracks-grid .track-card').first().waitFor();
    assert.equal(await page.locator('#tracks-grid .track-card').count(), 18);
    assert.equal(await page.locator('#tracks-table-wrap').isVisible(), false);
    const card = page.locator('#tracks-grid .track-card').first();
    const id = await card.getAttribute('data-id');
    await card.locator('input[type="checkbox"]').check();
    assert.equal(await card.getAttribute('data-selected'), 'true');
    const image = page.locator('#tracks-grid .track-card img').first();
    assert.equal(new URL(await image.getAttribute('src'), base).searchParams.get('size'), '256');
    await card.locator('.card-edit').click();
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'false');
    await page.locator('#edit-close').click();
    await page.locator('#view-list').click();
    assert.equal(await page.locator(`#tracks-tbody tr[data-id="${id}"] input[type="checkbox"]`).isChecked(), true);
    await page.locator(`#tracks-tbody tr[data-id="${id}"] input[type="checkbox"]`).uncheck();
    await page.locator('#library-display-toggle').click();
    await page.locator('#density-compact').click();
    assert.equal(await page.locator('.library-card').getAttribute('data-library-density'), 'compact');
    await page.keyboard.press('Escape');
    await page.locator('#view-cards').click();
    await page.reload();
    await page.locator('#tracks-grid .track-card').first().waitFor();
    assert.equal(await page.locator('#view-cards').getAttribute('aria-pressed'), 'true');
    await page.locator('#tracks-q').fill('周杰伦');
    await page.waitForFunction(() => document.querySelectorAll('#tracks-grid .track-card').length === 3);
    await page.locator('#quick-recent-indexed').click();
    assert.equal(await page.locator('#tracks-sort').inputValue(), 'indexed');
    assert.equal(await page.locator('#tracks-order').inputValue(), 'desc');
    assert.equal(await page.locator('#tracks-q').inputValue(), '周杰伦');
    await page.locator('[data-quick-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#tracks-grid .track-card').length === 18);
    await page.screenshot({ path: path.join(outputDir, 'cover-library-desktop.png'), fullPage: true });
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outputDir, 'cover-library-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#view-list').click();
    assert.equal(await page.locator('#density-compact').getAttribute('aria-pressed'), 'true');
    await page.locator('#library-display-toggle').click();
    await page.locator('#density-comfortable').click();
    await page.locator('#tracks-sort').selectOption('artist');
    await page.locator('#tracks-order').selectOption('asc');
    await page.keyboard.press('Escape');
    await waitRows(page, 18);
  });

  await check('Automatic update status explains incremental scanning and retained records', async () => {
    assert.equal(await page.locator('#sidebar-auto-scan').innerText(), '自动更新已开启');
    assert.equal(await page.locator('#sidebar-auto-scan').getAttribute('aria-live'), 'polite');
    await page.locator('#btn-scan-shortcut').click();
    assert.match(await page.locator('#scan-auto-status').innerText(), /自动增量入库/);
    assert.match(await page.locator('#scan-auto-status').innerText(), /不会自动删除/);
  });

  await check('Search and clear filters return the expected tracks', async () => {
    await page.locator('#tracks-q').fill('周杰伦');
    await waitRows(page, 3);
    assert.ok((await page.locator('#tracks-tbody').innerText()).includes('晴天'));
    await page.locator('[data-quick-filter="all"]').click();
    await waitRows(page, 18);
  });

  await check('Quick filters synchronize checkboxes and return only missing metadata', async () => {
    await page.locator('[data-quick-filter="missing_cover"]').click();
    await waitRows(page, 3);
    assert.equal(await page.locator('#filter-missing-cover').isChecked(), true);
    assert.equal(await page.locator('[data-quick-filter="missing_cover"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-quick-filter="missing_lyrics"]').click();
    await waitRows(page, 5);
    assert.equal(await page.locator('#filter-missing-lyrics').isChecked(), true);
    assert.equal(await page.locator('#filter-missing-cover').isChecked(), false);
    await page.locator('[data-quick-filter="all"]').click();
    await waitRows(page, 18);
  });

  await check('Selection opens the metadata drawer; preview never writes before confirmation', async () => {
    await page.locator('#tracks-tbody input[type="checkbox"]').first().check();
    await page.locator('#btn-edit-selected').click();
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'false');
    await page.locator('#edit-title').fill('UI acceptance preview');
    await page.locator('#btn-edit-preview').click();
    await page.locator('.diff-new').first().waitFor();
    assert.ok((await page.locator('dialog.modal').innerText()).includes('UI acceptance preview'));
    assert.equal(writes.includes('/api/tracks/apply'), false);
    await page.screenshot({ path: path.join(outputDir, 'metadata-preview.png'), fullPage: true });
    await page.locator('dialog.modal').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#edit-close').click();
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'true');
  });

  await check('Escape dismisses the frontmost preview before the metadata drawer', async () => {
    await page.locator('#btn-edit-selected').click();
    await page.locator('#edit-title').fill('Escape layer verification');
    await page.locator('#btn-edit-preview').click();
    await page.locator('dialog.modal[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('dialog.modal[open]').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'true');
    assert.equal(writes.includes('/api/tracks/apply'), false);
  });

  await check('Scan shortcut reveals options without starting a scan', async () => {
    await page.locator('#btn-scan-shortcut').click();
    assert.equal(await page.locator('#scan-options').getAttribute('open'), '');
    assert.equal(writes.includes('/api/scan'), false);
  });

  await check('Jobs panel opens and Escape closes it', async () => {
    await page.locator('#btn-jobs').click();
    assert.equal(await page.locator('#btn-jobs').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btn-jobs').getAttribute('aria-expanded'), 'false');
  });

  await check('Task disclosure keyboard controls take priority over the active library card', async () => {
    await page.locator('#view-cards').click();
    await page.locator('#tracks-grid .track-card').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('#btn-jobs').click();
    await page.waitForFunction(() => document.activeElement?.id === 'jobs-close');
    const task = page.locator('.job-card').first();
    await task.evaluate(node => { node.open = false; });
    await task.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await task.getAttribute('open'), '');
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'true');
    await page.keyboard.press('Escape');
    await page.locator('#view-list').click();
  });

  await check('Command palette opens with keyboard and returns focus', async () => {
    await page.locator('#btn-palette').focus();
    await page.keyboard.press('Control+k');
    await page.locator('#palette-input').waitFor({ state: 'visible' });
    await page.locator('#palette-input').fill('聚焦搜索框');
    await page.waitForFunction(() => document.querySelectorAll('.palette-item').length === 1 && document.querySelector('.palette-item')?.textContent.includes('聚焦搜索框'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'tracks-q');
  });

  await check('Command palette executes freshly typed local commands before remote results arrive', async () => {
    const pendingSearches = new Set();
    const delayedSearch = async route => {
      const pending = (async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
        await route.continue();
      })();
      pendingSearches.add(pending);
      try { await pending; } finally { pendingSearches.delete(pending); }
    };
    await page.route('**/api/tracks?**', delayedSearch);
    try {
      await page.locator('#btn-palette').click();
      await page.locator('#palette-input').fill('聚焦搜索框');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'tracks-q');
      assert.equal(await page.locator('#palette-input').isVisible(), false);
    } finally {
      await Promise.all([...pendingSearches]);
      await page.unroute('**/api/tracks?**', delayedSearch);
    }
  });

  await check('Scraper, organizer and settings tabs load; previews render', async () => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('#tab-scrape').click();
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'Switching tabs must return to the page heading');
    await page.locator('#pick-list .pick-row').first().waitFor();
    await page.locator('#pick-list .pick-row').first().click();
    await page.locator('#btn-search').click();
    await page.locator('#cand-list .cand').first().waitFor();
    await page.locator('#cand-list .cand').first().click();
    await noPageOverflow(page);
    await page.screenshot({ path: path.join(outputDir, 'scrape-desktop.png'), fullPage: true });
    await page.locator('#tab-move').click();
    await page.locator('#btn-move-preview').click();
    await page.locator('#move-tbody tr').first().waitFor();
    assert.equal(writes.includes('/api/move/execute'), false);
    await noPageOverflow(page);
    await page.screenshot({ path: path.join(outputDir, 'organizer-desktop.png'), fullPage: true });
    await page.locator('#tab-settings').click();
    await page.locator('#alias-artist-body input').first().waitFor();
    assert.ok((await page.locator('#status-kv').textContent()).includes('fixture'));
    await noPageOverflow(page);
    await page.screenshot({ path: path.join(outputDir, 'settings-desktop.png'), fullPage: true });
  });

  await check('Theme toggles and persists after reload', async () => {
    await page.locator('#tab-tracks').click();
    const before = await page.locator('html').getAttribute('data-theme');
    await page.locator('#btn-theme').click();
    const after = await page.locator('html').getAttribute('data-theme');
    assert.notEqual(after, before);
    await page.reload();
    await waitRows(page, 18);
    assert.equal(await page.locator('html').getAttribute('data-theme'), after);
    await page.screenshot({ path: path.join(outputDir, 'desktop-dark.png'), fullPage: true });
  });

  await check('Storage diagnostics separate PostgreSQL settings from on-demand AVIF caches', async () => {
    await page.locator('#tab-settings').click();
    await page.locator('#storage-cards .storage-card').first().waitFor();
    const copy = await page.locator('#storage-cards').innerText();
    assert.match(copy, /PostgreSQL/);
    assert.match(copy, /应用设置/);
    assert.match(copy, /AVIF/);
    assert.doesNotMatch(await page.locator('#status-kv').textContent(), /metatidy\.db/);
    assert.equal(writes.includes('/api/storage/check'), false, 'Viewing storage must not automatically probe writes');
    const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/check');
    await page.locator('#storage-check-write').click();
    await checked;
    await page.waitForFunction(() => document.querySelectorAll('.storage-check-row').length === 3);
    assert.match(await page.locator('#storage-feedback').innerText(), /可写/);
    await page.screenshot({ path: path.join(outputDir, 'storage-diagnostics-desktop.png'), fullPage: true });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#tab-tracks').click();
  });

  await check('Settings and alias drafts survive navigation and status refresh independently', async () => {
    await page.locator('#tab-settings').click();
    await page.locator('#set-unknown-artist').fill('保留未保存的设置');
    const source = page.locator('#set-sources input[data-source="netease"]');
    const originalSource = await source.isChecked();
    await source.setChecked(!originalSource);
    await page.locator('#alias-artist-body input').first().fill('Keep artist draft');
    await page.locator('#alias-album-body input').first().fill('Keep album draft');
    await page.locator('#tab-tracks').click();
    await page.locator('#tab-settings').click();
    await page.locator('#btn-status-reload').click();
    await page.locator('#btn-status-reload').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#set-unknown-artist').inputValue(), '保留未保存的设置');
    assert.equal(await source.isChecked(), !originalSource);
    assert.equal(await page.locator('#alias-artist-body input').first().inputValue(), 'Keep artist draft');
    assert.equal(await page.locator('#alias-album-body input').first().inputValue(), 'Keep album draft');
    await page.locator('#btn-settings-reload').click();
    await page.locator('dialog.modal[open]').getByRole('button', { name: '放弃修改', exact: true }).click();
    assert.notEqual(await page.locator('#set-unknown-artist').inputValue(), '保留未保存的设置');
    assert.equal(await source.isChecked(), originalSource);
    assert.equal(await page.locator('#alias-artist-body input').first().inputValue(), 'Keep artist draft', 'Discarding settings must not discard alias drafts');
    await page.locator('#tab-tracks').click();
  });

  await check('Mobile navigation opens, closes and activates all functional panels', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#btn-theme').click();
    await noPageOverflow(page);
    await page.screenshot({ path: path.join(outputDir, 'mobile-library.png'), fullPage: true });
    const tableDimensions = await page.locator('#tracks-table-wrap').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(tableDimensions.scrollWidth <= tableDimensions.width + 1, 'Mobile track list should not require horizontal scrolling');
    const editButton = page.locator('#tracks-tbody .row-edit').first();
    assert.equal(await editButton.isVisible(), true);
    const editBox = await editButton.boundingBox();
    assert.ok(editBox.x >= 0 && editBox.x + editBox.width <= 391, 'Mobile edit action should be inside the viewport');
    await editButton.click();
    assert.equal(await page.locator('#edit-drawer').getAttribute('aria-hidden'), 'false');
    await page.locator('#edit-close').click();
    for (const name of ['scrape', 'move', 'settings', 'tracks']) {
      await page.locator('#sidebar-toggle').click();
      assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true');
      await page.locator(`#tab-${name}`).click();
      assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(`#panel-${name}`).getAttribute('data-active'), 'true');
      await noPageOverflow(page);
    }
    await page.locator('#sidebar-toggle').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  });

  await check('No duplicate HTML ids or uncaught browser errors', async () => {
    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicates, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, [], 'UI runtime must not depend on external assets');
  });

  await check('Library fits narrow phones, tablets and compact desktop widths', async () => {
    for (const width of [320, 768, 900, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
    }
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.screenshot({ path: path.join(outputDir, 'tablet-library.png'), fullPage: true });
  });

  await check('Empty library provides a scan entry point and no misleading percentages', async () => {
    const emptyPage = await context.newPage();
    await emptyPage.goto(emptyBase);
    await emptyPage.waitForFunction(() => document.querySelector('#tracks-total')?.textContent.includes('共 0 首'));
    assert.equal(await emptyPage.locator('#tracks-tbody tr').count(), 0);
    const text = await emptyPage.locator('#tracks-table-status').innerText();
    assert.ok(text.includes('扫描'), text);
    await emptyPage.screenshot({ path: path.join(outputDir, 'empty-library.png'), fullPage: true });
    await emptyPage.close();
  });

  await check('Authentication gates data requests until successful login', async () => {
    const authPage = await context.newPage();
    const dataRequests = [];
    authPage.on('request', request => { if (/\/api\/(status|settings|tracks|sources|jobs|storage)/.test(request.url())) dataRequests.push(request.url()); });
    await authPage.goto(authBase);
    await authPage.locator('#auth-password').waitFor({ state: 'visible' });
    assert.equal(dataRequests.length, 0);
    await authPage.keyboard.press('Control+k');
    assert.equal(await authPage.locator('#palette-input').isVisible(), false);
    await authPage.evaluate(() => { location.hash = '#scrape'; });
    await authPage.waitForFunction(() => location.hash === '#scrape');
    await authPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(dataRequests.length, 0, 'Hash navigation must not request protected data before authentication');
    await authPage.evaluate(() => { location.hash = '#tracks'; });
    await authPage.locator('#auth-password').fill('fixture');
    await authPage.locator('#auth-submit').click();
    await waitRows(authPage, 18);
    assert.ok(dataRequests.length >= 4);
    await authPage.close();
  });

  await check('Routine 15-second polling preserves library rows and unsaved settings', () => withPollingPage(base, async ({ page, model, calls }) => {
    await page.locator('#tab-settings').click();
    const draft = '未保存的歌手名称';
    await page.locator('#set-unknown-artist').fill(draft);
    const source = page.locator('#set-sources input[data-source="netease"]');
    const sourceBefore = await source.isChecked();
    await source.setChecked(!sourceBefore);
    const row = await page.locator('#tracks-tbody tr').first().elementHandle();
    const sourceNode = await source.elementHandle();
    const before = { ...calls };
    model.status.auto_scan = { ...model.status.auto_scan, state: 'scanning', last_job_id: 'fixture-watch-running' };
    await page.clock.runFor(15050);
    await page.waitForFunction(() => document.querySelector('#sidebar-auto-scan')?.textContent === '正在更新曲库');
    assert.equal(calls.status, before.status + 1);
    assert.equal(calls.jobs, before.jobs + 1);
    assert.equal(calls.tracks, before.tracks, 'Routine polling must not request the track list');
    assert.equal(await row.evaluate(node => node.isConnected), true, 'Routine polling must retain row DOM');
    assert.equal(await sourceNode.evaluate(node => node.isConnected), true, 'Routine status must retain source controls');
    assert.equal(await source.isChecked(), !sourceBefore);
    assert.equal(await page.locator('#set-unknown-artist').inputValue(), draft);
  }));

  await check('Expanded task details retain focus and disclose structured scan results during polling', () => withPollingPage(base, async ({ page, model, pollJobs }) => {
    await page.locator('#btn-jobs').click();
    const task = page.locator('.job-card[data-job-id="fixture-scan-001"]');
    await task.locator('summary').click();
    assert.equal(await task.getAttribute('open'), '');
    assert.match(await task.innerText(), /新增/);
    const summary = await task.locator('summary').elementHandle();
    await task.locator('summary').focus();
    model.jobs.jobs[0].message = 'Updated progress message';
    await pollJobs();
    assert.equal(await summary.evaluate(node => node.isConnected), true);
    assert.equal(await summary.evaluate(node => node === document.activeElement), true);
    assert.equal(await task.getAttribute('open'), '');
    const result = JSON.parse(model.jobs.jobs[0].result);
    model.jobs.jobs[0].result = JSON.stringify({ ...result, failed: 1, errors: ['<img src=x onerror=alert(1)>Permission denied'] });
    await pollJobs();
    assert.match(await task.locator('.job-errors').innerText(), /Permission denied/);
    assert.equal(await task.locator('.job-errors img').count(), 0, 'Error messages must render as text');
    assert.equal(await task.locator('.job-copy-error').isVisible(), true);
    await page.screenshot({ path: path.join(outputDir, 'task-result-details.png'), fullPage: true });
  }));

  await check('A newly completed automatic job refreshes once without resetting settings', () => withPollingPage(base, async ({ page, model, calls, pollJobs, completeWatch }) => {
    await page.locator('#tab-settings').click();
    await page.locator('#set-unknown-artist').fill('自动刷新期间的草稿');
    const source = page.locator('#set-sources input[data-source="netease"]');
    await source.uncheck();
    const before = { ...calls };
    const title = '自动任务完成后出现的新标题';
    const row = page.locator(`#tracks-tbody tr[data-id="${model.tracks.items[0].id}"] .cell-title`);
    completeWatch('fixture-watch-done-001', title);
    await pollJobs();
    await page.waitForFunction(({ id, title }) => document.querySelector(`#tracks-tbody tr[data-id="${id}"] .cell-title`)?.textContent === title,
      { id: model.tracks.items[0].id, title });
    assert.equal(await row.textContent(), title);
    assert.equal(calls.status, before.status + 1);
    assert.equal(calls.tracks, before.tracks + 1);
    assert.equal(await source.isChecked(), false, 'Full status refresh must preserve unsaved source selection');
    assert.equal(await page.locator('#set-unknown-artist').inputValue(), '自动刷新期间的草稿');
    await pollJobs();
    assert.equal(calls.status, before.status + 1, 'Repeated observation of the same completed job must not refresh again');
    assert.equal(calls.tracks, before.tracks + 1);
  }));

  await check('Automatic refresh waits until a metadata drawer or dialog closes', () => withPollingPage(base, async ({ page, model, calls, pollJobs, completeWatch }) => {
    const id = model.tracks.items[0].id;
    await page.locator(`#tracks-tbody tr[data-id="${id}"] .row-edit`).click();
    await page.locator('#edit-title').fill('正在编辑的标题');
    let before = { ...calls };
    completeWatch('fixture-watch-drawer', '关闭抽屉后显示');
    await pollJobs();
    assert.equal(calls.status, before.status, 'Do not start a full status refresh during metadata editing');
    assert.equal(calls.tracks, before.tracks);
    assert.equal(await page.locator('#edit-title').inputValue(), '正在编辑的标题');
    await page.locator('#edit-close').click();
    await page.waitForFunction(id => document.querySelector(`#tracks-tbody tr[data-id="${id}"] .cell-title`)?.textContent === '关闭抽屉后显示', id);
    assert.equal(calls.tracks, before.tracks + 1);

    await page.evaluate(async () => {
      const ui = await import('/ui.js');
      void ui.confirmDialog({ title: '后台刷新验收', message: '保持此对话框打开以检查后台刷新。' });
    });
    await page.locator('dialog.modal[open]').waitFor();
    before = { ...calls };
    completeWatch('fixture-watch-dialog', '关闭对话框后显示');
    await pollJobs();
    assert.equal(calls.status, before.status, 'Do not start a full status refresh behind a confirmation dialog');
    assert.equal(calls.tracks, before.tracks);
    assert.equal(await page.locator('dialog.modal[open]').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => document.querySelector(`#tracks-tbody tr[data-id="${id}"] .cell-title`)?.textContent === '关闭对话框后显示', id);
    assert.equal(calls.tracks, before.tracks + 1);
  }));

  await check('Storage permission errors remain readable and copied reports exclude credentials', async () => {
    const isolated = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const inspected = await isolated.newPage();
    const report = await (await isolated.request.get(`${base}/api/storage`)).json();
    report.database.password = 'SHOULD_NOT_COPY';
    report.database.connection_string = 'postgres://SHOULD_NOT_COPY';
    report.cache.thumbnails.error = 'Permission denied';
    report.cache.thumbnails.exists = false;
    report.cache.thumbnails.files = 0;
    report.cache.thumbnails.bytes = 0;
    report.write_checks = [{ path: '/fixture-data/thumbs', state: 'error', error: 'Permission denied' }];
    await inspected.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await inspected.route('**/api/storage**', route => route.fulfill({ json: report }));
    try {
      await inspected.goto(`${base}/#settings`);
      await inspected.locator('#storage-cards .storage-card').first().waitFor();
      await inspected.waitForFunction(() => document.querySelector('#storage-feedback')?.textContent.includes('Permission denied'));
      assert.match(await inspected.locator('#storage-cards').innerText(), /至少 200 KB/);
      assert.match(await inspected.locator('.storage-breakdown').innerText(), /读取受限/);
      await inspected.locator('#storage-copy-report').click();
      const text = inspected.locator('textarea.storage-report-text');
      await text.waitFor();
      const copied = await text.inputValue();
      assert.match(copied, /Permission denied/);
      assert.doesNotMatch(copied, /SHOULD_NOT_COPY|connection_string|password/);
      await noPageOverflow(inspected);
    } finally { await isolated.close(); }
  });

  await check('Edits made during a settings save remain unsaved drafts after the response', async () => {
    const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const editor = await isolated.newPage();
    let releaseSave;
    let confirmRequest;
    const saveStarted = new Promise(resolve => { confirmRequest = resolve; });
    const pendingSave = new Promise(resolve => { releaseSave = resolve; });
    await editor.route('**/api/settings', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const submitted = route.request().postDataJSON().values;
      confirmRequest();
      await pendingSave;
      await route.fulfill({ json: { saved: submitted, warnings: [] } });
    });
    try {
      await editor.goto(`${base}/#settings`);
      await editor.locator('#set-unknown-artist').fill('提交时的草稿');
      await editor.locator('#btn-settings-save').click();
      await saveStarted;
      await editor.locator('#set-unknown-artist').fill('请求期间继续修改');
      releaseSave();
      await editor.waitForFunction(() => document.querySelector('#settings-result')?.textContent.includes('之后的修改仍是草稿'));
      assert.equal(await editor.locator('#set-unknown-artist').inputValue(), '请求期间继续修改');
      assert.match(await editor.locator('#settings-dirty').innerText(), /未保存/);
      await editor.locator('#tab-tracks').click();
      await editor.locator('#tab-settings').click();
      assert.equal(await editor.locator('#set-unknown-artist').inputValue(), '请求期间继续修改');
    } finally { releaseSave(); await isolated.close(); }
  });

  console.log(`\n${checks.length} checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (injectedRequests.length) console.log(`Observed ${injectedRequests.length} known local AdGuard injection requests; all other external requests were checked.`);
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const server of servers) server.kill();
}
