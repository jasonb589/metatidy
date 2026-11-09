/** Library layout acceptance against isolated fixtures; no scans or music writes. */
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
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Use the installed local or CI runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const port = Number(process.env.METATIDY_LAYOUT_UI_PORT || 18983), base = `http://127.0.0.1:${port}`;
const readonlyPosts = new Set(['/api/tracks/selection']);
const stableIds = ['library-overview', 'library-overview-toggle', 'library-tools', 'library-tools-toggle', 'stats-strip', 'library-health',
  'btn-library-folders', 'btn-duplicates', 'btn-tracks-reload', 'btn-edit-selected', 'btn-library-shortcuts', 'tracks-q', 'tracks-sort', 'tracks-order'];
const failures = [];
let server, browser, passed = 0;

async function check(name, action) {
  if (process.env.METATIDY_LAYOUT_UI_CHECK && !name.includes(process.env.METATIDY_LAYOUT_UI_CHECK)) return;
  try { await action(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}

async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage(), errors = [], calls = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith('/api/')) calls.push({ path: url.pathname, method: request.method(), query: Object.fromEntries(url.searchParams) });
  });
  try {
    await action({ page, context, calls });
    assert.deepEqual(errors, [], 'Layout changes must not raise browser errors');
    assert.deepEqual(calls.filter(call => !['GET', 'HEAD'].includes(call.method) && !readonlyPosts.has(call.path)), [], 'Layout controls must not scan, save settings, modify tags, move files, or write collections');
  } finally { await context.close(); }
}

const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 18 && document.querySelectorAll('#stats-strip .stat').length === 4);
  await page.locator('#library-overview-toggle').waitFor({ state: 'attached' });
  await page.locator('#library-tools-toggle').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await flush(page);
}
async function settled(page) {
  await page.waitForFunction(async () => !(await import('/store.js')).state.tracks.loading);
  await flush(page);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const store = await import('/store.js'), tracks = store.state.tracks;
    return { q: tracks.q, sort: tracks.sort, order: tracks.order, page: tracks.page, page_size: tracks.page_size,
      view: tracks.view, density: tracks.density, filters: { ...tracks.filters },
      selected: store.selectionIds(), revision: store.selectionRevision(), selectedRows: store.selectionRows().map(row => ({ ...row })),
      visible: tracks.items.map(row => row.id) };
  });
}
async function uniqueControls(page) {
  for (const id of stableIds) assert.equal(await page.locator(`#${id}`).count(), 1, `${id} must retain exactly one live control`);
}
async function noOverflow(page) {
  const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    cardScroll: document.querySelector('.library-card').scrollWidth, cardClient: document.querySelector('.library-card').clientWidth }));
  assert.ok(result.scroll <= result.width + 1 && result.cardScroll <= result.cardClient + 1, JSON.stringify(result));
}
async function geometry(page) {
  return page.locator('#tracks-tbody tr[data-id]').evaluateAll(rows => {
    const wrapper = document.querySelector('#tracks-table-wrap').getBoundingClientRect();
    const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
    const rects = rows.map(row => row.getBoundingClientRect());
    return { firstTop: rects[0]?.top, firstBottom: rects[0]?.bottom,
      fullyVisible: rects.filter(rect => rect.top >= Math.max(0, headerBottom, wrapper.top) && rect.bottom <= Math.min(innerHeight, wrapper.bottom)).length,
      viewport: { width: innerWidth, height: innerHeight }, overviewOpen: document.querySelector('#library-overview').open };
  });
}
async function openTools(page) {
  if (!(await page.locator('#library-tools').evaluate(node => node.open))) await page.locator('#library-tools-toggle').click();
  await page.waitForFunction(() => document.querySelector('#library-tools')?.open === true);
  await flush(page);
}
async function closeTools(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#library-tools')?.open === false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'library-tools-toggle');
}
async function clickOverview(page) { await page.locator('#library-overview-toggle').click(); await flush(page); }
async function validFocus(page, allowed) {
  const focus = await page.evaluate(() => ({ id: document.activeElement.id, visible: document.activeElement.getClientRects().length > 0,
    inert: Boolean(document.activeElement.closest('[inert]')), disabled: document.activeElement.matches(':disabled') }));
  assert.ok(allowed.includes(focus.id) && focus.visible && !focus.inert && !focus.disabled, JSON.stringify(focus));
}
async function withinViewport(page, selector) {
  const result = await page.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { selector: node.id || node.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth };
  });
  assert.ok(result.left >= -1 && result.right <= result.width + 1 && result.top >= -1 && result.bottom <= result.height + 1
    && result.pageWidth <= result.width + 1, JSON.stringify(result));
}
async function finishMotion(page, selector) {
  await page.locator(selector).evaluate(async node => {
    const animations = node.getAnimations({ subtree: true });
    if (animations.some(animation => { const timing = animation.effect.getTiming(); return !Number.isFinite(timing.duration) || timing.iterations !== 1 || timing.duration + timing.delay > 1000; })) {
      throw new Error('Dialog movement must be brief and finite');
    }
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
}
async function pauseFixturePlayback(page) {
  await page.locator('#tracks-tbody button[data-play-id]').first().click();
  await page.waitForFunction(() => {
    const audio = document.querySelector('#audio-player-media');
    return document.querySelector('#audio-player')?.dataset.state === 'playing' && audio && !audio.paused && audio.readyState >= 2 && audio.duration === 12;
  });
  await page.locator('#audio-player-toggle').click();
  await page.waitForFunction(() => document.querySelector('#audio-player')?.dataset.state === 'paused' && document.querySelector('#audio-player-media')?.paused);
  await finishMotion(page, '#audio-player');
}
async function toolTargetsReachable(page) {
  await finishMotion(page, '#library-tools');
  for (const id of ['btn-library-folders', 'btn-duplicates', 'btn-library-shortcuts', 'btn-edit-selected']) {
    const button = page.locator(`#${id}`);
    assert.equal(await button.isEnabled(), true, `${id} must remain available with selected tracks`);
    await button.scrollIntoViewIfNeeded();
    const result = await button.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { id: node.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
        reached: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === node };
    });
    assert.ok(result.left >= 0 && result.right <= result.width && result.top >= 0 && result.bottom <= result.height && result.reached, JSON.stringify(result));
  }
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Layout fixture timeout')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Library first-screen density meets desktop and mobile targets in both themes', async () => {
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 900]]) {
      for (const colorScheme of ['light', 'dark']) await withPage(async ({ page }) => {
        await ready(page); await uniqueControls(page); await noOverflow(page);
        const metrics = await geometry(page);
        if (width <= 390) assert.equal(metrics.overviewOpen, false, 'Mobile overview must initially leave room for tracks');
        if (width === 1440) assert.equal(metrics.overviewOpen, true, 'Desktop overview remains expanded by default');
        if (width === 320) assert.ok(metrics.firstTop <= 430, `320px first track must start by 430px: ${JSON.stringify(metrics)}`);
        if (width === 390) assert.ok(metrics.fullyVisible >= 3, `390px first screen must show at least three complete tracks: ${JSON.stringify(metrics)}`);
        if (width === 1440) assert.ok(metrics.firstTop <= 450, `Desktop first track must start by 450px: ${JSON.stringify(metrics)}`);
        console.log(`METRICS ${width}x${height} ${colorScheme}: ${JSON.stringify(metrics)}`);
        await page.screenshot({ path: path.join(output, `library-layout-${width}x${height}-${colorScheme}.png`) });
      }, { viewport: { width, height }, colorScheme });
    }
  });

  await check('Overview and tool disclosures preserve filters, sort and a complete cross-page selection', () => withPage(async ({ page, calls }) => {
    await ready(page);
    await page.evaluate(async () => {
      const store = await import('/store.js');
      store.selectRows([{ ...store.state.tracks.items[0] }, { id: 999001, title: '来自其他分页的已选曲目', artist: '保留选择', path: '/fixture-music/off-page.flac' }]);
    });
    await page.locator('#tracks-q').fill('周杰伦'); await page.locator('#tracks-q').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#tracks-tbody tr[data-id]').length === 3);
    await page.locator('#library-display-toggle').click();
    await page.locator('#tracks-sort').selectOption('title'); await settled(page);
    await page.locator('#tracks-order').selectOption('desc'); await settled(page);
    await page.keyboard.press('Escape');
    const before = await snapshot(page), callCount = calls.length;
    await clickOverview(page); await clickOverview(page);
    await openTools(page); await closeTools(page);
    assert.deepEqual(await snapshot(page), before, 'Layout changes must not alter current browsing or selected IDs, order and snapshots');
    assert.equal(calls.slice(callCount).some(call => call.path === '/api/tracks' || call.method !== 'GET'), false, 'Disclosure changes must not requery tracks or submit actions');
  }, { viewport: { width: 390, height: 844 } }));

  await check('Tools support Enter, Space, Escape and outside-click focus without hiding the active target', () => withPage(async ({ page }) => {
    await ready(page);
    await page.locator('#library-tools-toggle').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#library-tools')?.open === true);
    await page.locator('#btn-library-folders').focus(); await closeTools(page);
    await page.keyboard.press('Space'); await page.waitForFunction(() => document.querySelector('#library-tools')?.open === true);
    await page.locator('#tracks-q').click(); await page.waitForFunction(() => document.querySelector('#library-tools')?.open === false);
    await validFocus(page, ['tracks-q']);
    await page.locator('#library-overview-toggle').focus();
    const initial = await page.locator('#library-overview').evaluate(node => node.open);
    await page.keyboard.press('Enter'); await flush(page);
    assert.equal(await page.locator('#library-overview').evaluate(node => node.open), !initial);
    await page.keyboard.press('Space'); await flush(page);
    assert.equal(await page.locator('#library-overview').evaluate(node => node.open), initial);
  }, { viewport: { width: 390, height: 844 } }));

  await check('Tools, display, filters and saved filters share one open popover without changing browsing state', () => withPage(async ({ page }) => {
    await ready(page);
    const before = await snapshot(page);
    const disclosures = [['library-tools-toggle', 'library-tools'], ['library-display-toggle', 'library-display-settings'], ['library-filters-toggle', 'library-filters'], ['library-saved-filters-toggle', 'library-saved-filters'], ['library-tools-toggle', 'library-tools']];
    const ids = [...new Set(disclosures.map(([, id]) => id))];
    for (const [toggle, id] of disclosures) {
      await page.locator(`#${toggle}`).click();
      await page.waitForFunction(({ ids, id }) => ids.every(other => document.getElementById(other)?.open === (other === id)), { ids, id });
    }
    await closeTools(page);
    assert.deepEqual(await snapshot(page), before);
  }, { viewport: { width: 390, height: 844 } }));

  await check('Folder and duplicate tools remain reachable and return focus without starting a scan', () => withPage(async ({ page }) => {
    await ready(page);
    const before = await snapshot(page);
    for (const [control, dialog] of [['btn-library-folders', 'folder-browser'], ['btn-duplicates', 'duplicate-review-dialog'], ['btn-library-shortcuts', 'keyboard-shortcuts']]) {
      await openTools(page); await page.locator(`#${control}`).click();
      await page.locator(dialog === 'keyboard-shortcuts' ? 'dialog[open] #keyboard-shortcuts' : `#${dialog}[open]`).waitFor();
      await page.keyboard.press('Escape'); await page.locator(`#${dialog}`).waitFor({ state: 'detached' });
      await validFocus(page, [control, 'library-tools-toggle']);
      assert.deepEqual(await snapshot(page), before);
    }
    await openTools(page); await page.locator('#btn-tracks-reload').click(); await settled(page);
    assert.deepEqual(await snapshot(page), before, 'Refreshing from the reorganized tools must preserve range and presentation');
  }, { viewport: { width: 320, height: 568 } }));

  await check('Selected editing consumes Escape once and returns to the still-open tools', async () => {
    for (const [width, height, reducedMotion] of [[1440, 900, 'no-preference'], [390, 844, 'reduce']]) await withPage(async ({ page }) => {
      await ready(page);
      await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows(store.state.tracks.items.slice(0, 2)); });
      const before = await snapshot(page);
      await openTools(page); await page.locator('#btn-edit-selected').click();
      await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'true');
      await finishMotion(page, '#edit-drawer');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#edit-drawer')?.dataset.open === 'false');
      assert.equal(await page.locator('#library-tools').evaluate(node => node.open), true, 'The editor consumes Escape without closing the underlying tool disclosure');
      await validFocus(page, ['btn-edit-selected']);
      assert.deepEqual(await snapshot(page), before);
      await closeTools(page);
    }, { viewport: { width, height }, reducedMotion });
  });

  await check('Normal-motion saved-filter save and manager keep fixed popovers within the viewport', async () => {
    for (const [width, height, colorScheme] of [[1440, 900, 'light'], [390, 844, 'light'], [320, 480, 'dark']]) await withPage(async ({ page }) => {
      await ready(page);
      const before = await snapshot(page), name = `布局验收 ${width}×${height}`;
      await page.locator('#library-saved-filters-toggle').click();
      await page.waitForFunction(() => document.querySelector('#library-saved-filters')?.open === true);
      await finishMotion(page, '#library-saved-filters');
      await withinViewport(page, '#library-saved-filters-panel'); await noOverflow(page);
      await page.locator('#saved-filter-save').click(); await page.locator('#saved-filters-dialog[open]').waitFor();
      await finishMotion(page, '#saved-filters-dialog');
      await withinViewport(page, '#saved-filters-dialog'); await noOverflow(page);
      await page.locator('#saved-filter-name').fill(name); await page.locator('#saved-filter-submit').click();
      await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' }); await flush(page);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('metatidy.saved-filters.v1') || '{"items":[]}').items);
      assert.equal(saved.some(item => item.name === name), true, 'The save action stores only the local filter preset');
      assert.equal(await page.locator('#library-saved-filters').evaluate(node => node.open), true);
      await withinViewport(page, '#library-saved-filters-panel'); await noOverflow(page);
      await page.locator('#saved-filter-manage').click(); await page.locator('#saved-filters-dialog[open]').waitFor();
      await finishMotion(page, '#saved-filters-dialog');
      await withinViewport(page, '#saved-filters-dialog'); await noOverflow(page);
      await page.screenshot({ path: path.join(output, `library-layout-saved-normal-${width}x${height}-${colorScheme}.png`) });
      await page.keyboard.press('Escape'); await page.locator('#saved-filters-dialog').waitFor({ state: 'detached' });
      await validFocus(page, ['saved-filter-manage']);
      await withinViewport(page, '#library-saved-filters-panel'); await noOverflow(page);
      assert.deepEqual(await snapshot(page), before, 'Saving and managing a local preset must not apply or alter the browsing scope');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('#library-saved-filters')?.open === false);
      await validFocus(page, ['library-saved-filters-toggle']); await noOverflow(page);
    }, { viewport: { width, height }, colorScheme, reducedMotion: 'no-preference' });
  });

  await check('Resizing preserves selected scope and existing control IDs across overview breakpoints', async () => {
    await withPage(async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows([store.state.tracks.items[4], store.state.tracks.items[0]]); });
    await page.locator('[data-quick-filter="missing_lyrics"]').click(); await settled(page);
    await pauseFixturePlayback(page);
    const before = await snapshot(page);
    for (const [width, height] of [[320, 480], [390, 844], [768, 1024], [1440, 900], [844, 390], [320, 568]]) {
      await page.setViewportSize({ width, height }); await flush(page);
      await uniqueControls(page); await noOverflow(page);
      assert.deepEqual(await snapshot(page), before, `Resize ${width}x${height} must only change layout`);
      assert.equal(await page.locator('#selection-bar').isVisible(), true);
      assert.equal(await page.locator('#audio-player').isVisible(), true);
      await openTools(page);
      await toolTargetsReachable(page);
      await page.screenshot({ path: path.join(output, `library-layout-tools-${width}x${height}-dark.png`) });
      await closeTools(page);
      await page.locator('#btn-tracks-reload').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#btn-tracks-reload').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === node;
      }), true, 'The independent refresh control remains reachable after tools close');
    }
    }, { colorScheme: 'dark' });
    // Normal motion creates stacking contexts while opening; cover the two
    // shortest layouts with both fixed bottom surfaces present as well.
    for (const [width, height] of [[320, 480], [844, 390]]) await withPage(async ({ page }) => {
      await ready(page); await pauseFixturePlayback(page);
      await page.evaluate(async () => { const store = await import('/store.js'); store.selectRows([store.state.tracks.items[4], store.state.tracks.items[0]]); });
      const before = await snapshot(page);
      assert.equal(await page.locator('#selection-bar').isVisible(), true);
      assert.equal(await page.locator('#audio-player').isVisible(), true);
      await openTools(page); await toolTargetsReachable(page); await noOverflow(page);
      await page.screenshot({ path: path.join(output, `library-layout-tools-${width}x${height}-dark-normal.png`) });
      assert.deepEqual(await snapshot(page), before);
      await closeTools(page);
    }, { viewport: { width, height }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  });

  await check('Disclosure motion is finite and reduced-motion mode remains still', async () => {
    for (const reducedMotion of ['reduce', 'no-preference']) await withPage(async ({ page }) => {
      await ready(page);
      const runs = [];
      for (const [toggle, host] of [['library-overview-toggle', 'library-overview'], ['library-tools-toggle', 'library-tools']]) {
        const motion = await page.evaluate(async ({ toggle, host }) => {
          document.getElementById(toggle).click();
          await new Promise(resolve => requestAnimationFrame(resolve));
          const node = document.getElementById(host), animations = node.getAnimations({ subtree: true });
          const timing = animations.map(animation => { const value = animation.effect.getTiming(); return { duration: value.duration, delay: value.delay, iterations: value.iterations }; });
          if (timing.every(value => Number.isFinite(value.duration) && value.duration > 0 && value.iterations === 1 && value.duration + value.delay <= 500)) {
            await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
          }
          return { timing, running: node.getAnimations({ subtree: true }).filter(animation => ['running', 'pending'].includes(animation.playState)).length };
        }, { toggle, host });
        if (reducedMotion === 'reduce') assert.deepEqual(motion.timing, [], `${host} must respect reduced motion`);
        for (const timing of motion.timing) assert.ok(Number.isFinite(timing.duration) && timing.duration > 0 && timing.iterations === 1 && timing.duration + timing.delay <= 500, JSON.stringify(timing));
        assert.equal(motion.running, 0); runs.push(...motion.timing);
      }
      if (reducedMotion === 'no-preference') assert.ok(runs.length > 0, 'Disclosure changes should provide a brief finite transition');
      console.log(`MOTION ${reducedMotion}: ${JSON.stringify(runs)}`);
    }, { viewport: { width: 390, height: 844 }, reducedMotion });
  });

  console.log(`\n${passed} layout checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
