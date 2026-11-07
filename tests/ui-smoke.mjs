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
    assert.ok((await page.locator('#status-kv').innerText()).includes('fixture'));
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
    authPage.on('request', request => { if (/\/api\/(status|settings|tracks|sources|jobs)/.test(request.url())) dataRequests.push(request.url()); });
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

  console.log(`\n${checks.length} checks passed; ${failures.length} failed. Screenshots: ${outputDir}`);
  if (injectedRequests.length) console.log(`Observed ${injectedRequests.length} known local AdGuard injection requests; all other external requests were checked.`);
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const server of servers) server.kill();
}
