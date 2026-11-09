/** Native command-palette focus, stable nodes and asynchronous search contracts. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Existing local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_PALETTE_UI_PORT || 18976);
const base = `http://127.0.0.1:${port}`, authBase = `http://127.0.0.1:${port + 1}`;
const servers = [], failures = [];
let browser, passed = 0;
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const gate = () => ({ entered: defer(), released: defer(), done: defer() });
async function waitGate(gated) {
  let timer;
  try { await Promise.race([gated.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Search request did not arrive')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function release(page, gated) { gated.released.resolve(); await gated.done.promise; await flush(page); }
async function check(name, action) {
  if (process.env.METATIDY_PALETTE_UI_CHECK && !name.includes(process.env.METATIDY_PALETTE_UI_CHECK)) return;
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], writes = [], gates = [], searches = [];
  const controls = new Map();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET' && request.method() !== 'HEAD' && !['/api/login', '/api/logout'].includes(url.pathname)) writes.push(url.pathname);
    if (url.pathname !== '/api/tracks' || url.searchParams.get('page_size') !== '8') return route.continue();
    const query = url.searchParams.get('q') || ''; searches.push(query);
    const plan = controls.get(query);
    if (!plan) return route.fulfill({ json: { items: [] } });
    try {
      if (plan.gate) { plan.gate.entered.resolve(); await plan.gate.released.promise; }
      await route.fulfill({ status: plan.status || 200, json: plan.status ? { detail: '会话过期' } : { items: plan.items || [] } });
    } finally { plan.gate?.done.resolve(); }
  });
  const plan = (query, value) => { controls.set(query, value); if (value.gate) gates.push(value.gate); };
  try {
    await action({ page, context, plan, searches });
    assert.deepEqual(errors, [], 'Palette interactions must not raise browser errors');
    assert.deepEqual(writes, [], 'Palette focus/navigation must not start file or database mutations');
  } finally { for (const pending of gates) pending.released.resolve(); await context.close(); }
}
async function ready(page, url = base) { await page.goto(url); await page.locator('#tracks-tbody tr').first().waitFor(); }
async function open(page) { await page.locator('#btn-palette').click(); await page.waitForFunction(() => document.querySelector('dialog.palette-veil')?.open && document.activeElement?.id === 'palette-input'); }
async function closed(page) { await page.waitForFunction(() => !document.querySelector('dialog.palette-veil')?.open); }
async function focusInside(page) { assert.equal(await page.evaluate(() => document.querySelector('dialog.palette-veil')?.contains(document.activeElement)), true); }

try {
  await mkdir(output, { recursive: true });
  for (const [listenPort, args] of [[port, []], [port + 1, ['--auth']]]) {
    const child = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${listenPort}`, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Palette fixture timeout')), 10000); child.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
  }
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Native modality traps both Tab boundaries and prevents header, sidebar and footer focus', () => withPage(async ({ page }) => {
    await ready(page); await open(page);
    assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.matches(':modal')), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.palette-item:last-child')), true);
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'palette-input');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.palette-item')), true);
    for (const selector of ['#btn-theme', '#tab-settings', '#btn-shortcuts-footer', '#tracks-q']) {
      await page.locator(selector).evaluate(node => node.focus()); await focusInside(page);
    }
    await page.keyboard.press('Escape'); await closed(page); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-palette');
  }));

  await check('Hover and arrow navigation preserve every command node and the focused button', () => withPage(async ({ page }) => {
    await ready(page); await open(page); await page.keyboard.press('Tab');
    await page.evaluate(() => { window.paletteOriginalNodes = [...document.querySelectorAll('.palette-item')]; });
    await page.locator('.palette-item').nth(1).hover();
    assert.equal(await page.evaluate(() => document.activeElement === window.paletteOriginalNodes[0]), true, 'Hover must not remove or replace the focused first command');
    assert.equal(await page.evaluate(() => window.paletteOriginalNodes[1].getAttribute('aria-current')), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement === window.paletteOriginalNodes[1]), true);
    await page.keyboard.press('ArrowUp'); assert.equal(await page.evaluate(() => document.activeElement === window.paletteOriginalNodes[0]), true);
    await page.locator('#palette-input').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'palette-input');
    assert.equal(await page.evaluate(() => window.paletteOriginalNodes.every((row, index) => row.isConnected && row === document.querySelectorAll('.palette-item')[index])), true);
    assert.equal(await page.locator('.palette-item[aria-current="true"]').count(), 1);
  }));

  await check('Ctrl K toggles a native palette, reopening resets the query, and removed openers use a visible fallback', () => withPage(async ({ page }) => {
    await ready(page); await page.locator('#tracks-q').focus(); await page.keyboard.press('Control+k'); await focusInside(page);
    await page.locator('#palette-input').fill('曲库'); await page.keyboard.press('Control+k'); await closed(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tracks-q');
    await page.keyboard.press('Control+k'); assert.equal(await page.locator('#palette-input').inputValue(), '');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { const button = document.createElement('button'); button.id = 'temporary-palette-opener'; document.body.append(button); button.focus(); (await import('/palette.js')).openPalette(); button.remove(); });
    await page.keyboard.press('Escape'); await closed(page); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-palette');
    await open(page); await page.mouse.click(3, 3); await closed(page); assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-palette');
  }));

  await check('Delayed search appends tracks without replacing or moving the selected local command', () => withPage(async ({ page, plan }) => {
    const pending = gate(); plan('曲库', { gate: pending, items: [{ id: 333, title: '曲库中的歌 <img>', artist: '远端', album: '相册' }] });
    await ready(page); await open(page); await page.locator('#palette-input').fill('曲库'); await waitGate(pending);
    await page.keyboard.press('Tab'); await page.keyboard.press('ArrowDown');
    const before = await page.evaluate(() => { window.paletteLocalNodes = [...document.querySelectorAll('.palette-item')]; window.paletteFocusedCommand = document.activeElement; return { count: window.paletteLocalNodes.length, text: document.querySelector('.palette-item.is-active').innerText }; });
    await release(page, pending); await page.waitForFunction(count => document.querySelectorAll('.palette-item').length === count + 1, before.count);
    assert.equal(await page.evaluate(() => document.activeElement === window.paletteFocusedCommand), true);
    assert.equal(await page.evaluate(() => window.paletteLocalNodes.every((row, index) => row === document.querySelectorAll('.palette-item')[index])), true);
    assert.equal(await page.locator('.palette-item.is-active').innerText(), before.text);
    assert.equal(await page.locator('.palette-list img').count(), 0);
    assert.equal(await page.locator('.palette-list').getAttribute('aria-busy'), 'false');
  }));

  await check('Fresh local commands execute immediately and old search scopes cannot populate a reopened palette', () => withPage(async ({ page, plan }) => {
    const local = gate(); plan('聚焦搜索框', { gate: local });
    await ready(page); await open(page); await page.locator('#palette-input').fill('聚焦搜索框'); await waitGate(local);
    await page.keyboard.press('Enter'); await closed(page); await page.waitForFunction(() => document.activeElement?.id === 'tracks-q');
    await open(page); const initial = await page.locator('.palette-item').count(); await release(page, local);
    assert.equal(await page.locator('.palette-item').count(), initial);
    const old = gate(), fresh = gate(); plan('旧查询', { gate: old, items: [{ id: 991, title: '旧结果不应出现' }] }); plan('新查询', { gate: fresh, items: [{ id: 992, title: '新结果' }] });
    await page.locator('#palette-input').fill('旧查询'); await waitGate(old); await page.locator('#palette-input').fill('新查询'); await waitGate(fresh);
    await page.keyboard.press('Enter'); assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), true, 'No stale command may execute while the new query has no results');
    await release(page, fresh); await page.locator('.palette-item').filter({ hasText: '新结果' }).waitFor(); await release(page, old);
    assert.equal(await page.locator('.palette-item').count(), 1); assert.equal(await page.locator('.palette-title').innerText(), '新结果'); assert.equal(await page.locator('.palette-hint').innerText(), '曲目');
  }));

  await check('One Escape closes only the palette above jobs or the editor and native dialogs keep Ctrl K', () => withPage(async ({ page }) => {
    await ready(page); await page.locator('#btn-jobs').click(); await page.waitForFunction(() => document.querySelector('#jobs-pop')?.dataset.open === 'true');
    // Opening by an outside pointer intentionally dismisses the jobs widget;
    // use its own header trigger so this isolates Escape layering instead.
    await page.locator('#btn-jobs').focus(); await page.keyboard.press('Control+k'); await focusInside(page);
    assert.equal(await page.locator('#jobs-pop').getAttribute('data-open'), 'true');
    await page.keyboard.press('Escape'); await closed(page);
    assert.equal(await page.locator('#jobs-pop').getAttribute('data-open'), 'true', 'Palette Escape must not close jobs underneath');
    await page.locator('#jobs-close').click();
    await page.locator('#tracks-tbody button[data-edit-id]').first().click(); await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'true');
    await page.keyboard.press('Control+k'); await focusInside(page); await page.keyboard.press('Escape'); await closed(page);
    assert.equal(await page.locator('#edit-drawer').getAttribute('data-open'), 'true', 'Palette Escape must not close metadata drawer underneath');
    await page.keyboard.press('Escape');
    await page.locator('#btn-shortcuts-footer').click(); await page.locator('#keyboard-shortcuts').waitFor();
    await page.keyboard.press('Control+k'); assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), false);
    await page.evaluate(async () => (await import('/palette.js')).openPalette());
    assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), false); await page.keyboard.press('Escape');
  }));

  await check('Empty results retain an input-only focus loop and composition keys do not execute commands', () => withPage(async ({ page }) => {
    await ready(page); await open(page); await page.locator('#palette-input').fill('空结果');
    await page.waitForFunction(() => document.querySelector('.palette-list')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.palette-item').count(), 0);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'palette-input');
    await page.locator('#palette-input').fill('聚焦搜索框');
    await page.locator('#palette-input').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), true);
  }));

  await check('Login gates block palette opening and a 401 closes it without reviving delayed results', () => withPage(async ({ page, plan, searches }) => {
    await page.goto(authBase); await page.locator('#auth-password').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+k'); await page.evaluate(async () => (await import('/palette.js')).openPalette());
    assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), false); assert.equal(searches.length, 0);
    await page.locator('#auth-password').fill('fixture'); await page.locator('#auth-submit').click(); await page.locator('#tracks-tbody tr').first().waitFor();
    plan('过期查询', { status: 401 }); await open(page); await page.locator('#palette-input').fill('过期查询');
    await page.locator('#auth-veil').waitFor({ state: 'visible' }); await closed(page);
    await page.keyboard.press('Control+k'); assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('#auth-veil') !== null), true);
  }));

  await check('Short phone and landscape viewports keep the header, footer and last command visible with no reduced-motion animation', async () => {
    for (const [width, height, colorScheme] of [[320, 480, 'dark'], [844, 390, 'light']]) await withPage(async ({ page }) => {
      await ready(page); await open(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      for (const selector of ['.palette-head', '.palette-foot']) assert.equal(await page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('.palette-item').last().evaluate(node => { const r = node.getBoundingClientRect(), body = node.closest('.palette-body').getBoundingClientRect(); return r.top >= body.top && r.bottom <= body.bottom + 1; }), true);
      assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
      await page.screenshot({ path: path.join(output, `palette-focus-${width}x${height}-${colorScheme}.png`) });
    }, { viewport: { width, height }, colorScheme });
  });

  await check('Normal entrance animation lasts 180ms once and leaves no running animation', () => withPage(async ({ page }) => {
    await ready(page);
    const timing = await page.evaluate(async () => { (await import('/palette.js')).openPalette(); return document.querySelector('.palette').getAnimations().map(animation => { const timing = animation.effect.getTiming(); return { duration: timing.duration, iterations: timing.iterations }; }); });
    assert.deepEqual(timing, [{ duration: 180, iterations: 1 }]);
    await page.evaluate(async () => { await Promise.all(document.querySelector('dialog.palette-veil').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    assert.equal(await page.locator('dialog.palette-veil').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), 0);
  }, { reducedMotion: 'no-preference' }));

  console.log(`\n${passed} palette checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); for (const child of servers) child.kill(); }
