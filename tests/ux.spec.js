import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const meta = { model: 'Snap', cityLabel: 'LA', count: 320, eventTokens: 185432, windowTokens: 384000, ctaUrl: 'https://example.com/snap' };
const events = Array.from({ length: 14 }, (_, i) => ({
  id: `test-${i}`, title: `Test event ${i + 1}: ${i === 0 ? 'AI evaluation and developer tools' : 'Founders and builders'}`,
  start: `2026-10-${String(5 + i % 7).padStart(2, '0')}T18:00:00-07:00`,
  end: `2026-10-${String(5 + i % 7).padStart(2, '0')}T20:00:00-07:00`,
  host: 'Test host', neighborhood: 'SoMa', url: `https://example.com/event-${i}`,
}));
const result = { mode: 'model', summary: 'Test response: all events scored.', ranked: events.map((event, i) => ({ event, score: 98 - i, why: 'Matches your interest in AI evaluation.' })), stats: { promptTokens: 185440, seconds: 1.2 } };
const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
async function start(page, metadata = meta) {
  await page.route('**/api/events', route => fulfill(route, metadata));
  // A test must never reach the real ranking service, even if a later handler fails.
  await page.route('**/api/rank', route => fulfill(route, result));
  await page.goto('/');
  await expect(page.locator('#events-status')).toBeHidden();
}
// "Build my context" fills the context and then runs Snap on its own.
async function build(page, interests = 'AI evals and developer tools') {
  await page.locator('#interests').fill(interests);
  await page.locator('#continue').click();
}
async function rank(page) {
  await build(page);
  await expect(page.locator('#results')).toBeVisible();
}
async function noOverflow(page) {
  const problems = await page.evaluate(() => [...document.querySelectorAll('.panel, .item-link, .big-value, .ingest-feed, .file, input, textarea')]
    .filter(el => el.getClientRects().length && (el.getBoundingClientRect().right > innerWidth + 1 || el.getBoundingClientRect().left < -1 || (!el.matches('input,textarea') && el.scrollWidth > el.clientWidth + 1)))
    .map(el => ({ selector: el.id || el.className, client: el.clientWidth, scroll: el.scrollWidth })));
  expect(problems).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}

test('initial screen: real fonts, complete labels, keyboard order, no console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('600 16px "Inter Tight"'))).toBeTruthy();
  expect(await page.evaluate(() => [...document.fonts].some(f => f.family === 'Inter Tight' && f.status === 'loaded'))).toBeTruthy();
  // The GitHub field has focus as soon as the events load.
  await expect(page.locator('#github')).toBeFocused();
  // The skip link is the first stop on the page and lands just before the GitHub field.
  expect(await page.evaluate(() => document.querySelector('a[href], button, input, textarea, [tabindex]').className)).toBe('skip-link');
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.locator('#github')).toBeFocused();
  await page.keyboard.press('Tab');
  // The LinkedIn "?" help is a tab stop where the browser makes buttons tabbable (not WebKit by default).
  if (await page.locator('#linkedin-help-btn').evaluate(b => b === document.activeElement)) {
    await page.keyboard.press('Enter');
    await expect(page.locator('#linkedin-help')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#linkedin-help')).toBeHidden();
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('#files')).toBeFocused();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserPromise;
  await chooser.setFiles([]);
  await page.keyboard.press('Tab');
  await expect(page.locator('#interests')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.idea').first()).toBeFocused();
  await page.locator('#continue').focus();
  await expect(page.locator('#continue')).toBeFocused();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('profile can be edited while event metadata is loading', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/api/events', async route => { await gate; await fulfill(route, meta); });
  await page.goto('/');
  await page.locator('#interests').fill('Typed before loading completes');
  await expect(page.locator('#continue')).toBeDisabled();
  release();
  await expect(page.locator('#continue')).toBeEnabled();
  await page.route('**/api/rank', route => fulfill(route, result));
  await page.locator('#continue').click();
  await expect(page.locator('#results')).toBeVisible();
});

test('event load error and empty list both recover without a page refresh', async ({ page }) => {
  let attempt = 0;
  await page.route('**/api/events', route => {
    attempt++;
    return attempt === 1 ? fulfill(route, { error: 'Temporarily unavailable.' }, 503) : fulfill(route, attempt === 2 ? { ...meta, count: 0 } : meta);
  });
  await page.goto('/');
  await expect(page.locator('#events-error')).toBeVisible();
  await page.locator('#retry-events').click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty-title')).toBeFocused();
  await expect(page.locator('.steps')).toBeHidden();
  await page.locator('#refresh-events').click();
  await expect(page.locator('.steps')).toBeVisible();
  await expect(page.locator('#step-1-title')).toBeFocused();
  await expect(page.locator('#continue')).toBeEnabled();
});

test('empty and invalid profiles explain how to recover', async ({ page }) => {
  await start(page);
  await page.locator('#continue').click();
  await expect(page.locator('#form-error')).toContainText('Add at least one');
  await expect(page.locator('#form-error')).toBeFocused();
  await page.locator('#github').fill('invalid user!');
  await page.locator('#continue').click();
  await expect(page.locator('#github')).toBeFocused();
  await expect(page.locator('#github')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#github').fill('');
  await build(page, 'I build tools for ML evaluation.');
  await expect(page.locator('#form-error')).toBeHidden();
  await expect(page.locator('#results')).toBeVisible();
});

test('GitHub URL is normalized and the fetched profile reaches the rank payload', async ({ page }) => {
  await start(page);
  let login;
  await page.route('**/api/github?*', route => { login = new URL(route.request().url()).searchParams.get('user'); return fulfill(route, { repos: 8, readmes: 3, text: 'Public GitHub profile text' }); });
  await page.locator('#github').fill('https://github.com/test-user/');
  const request = page.waitForRequest('**/api/rank');
  await page.locator('#continue').click();
  expect((await request).postDataJSON().github).toBe('Public GitHub profile text');
  expect(login).toBe('test-user');
  await expect(page.locator('#results')).toBeVisible();
});

test('unavailable GitHub blocks an empty profile but allows other sources', async ({ page }) => {
  await start(page);
  await page.route('**/api/github?*', route => fulfill(route, { error: 'No such GitHub user.' }, 404));
  await page.locator('#github').fill('missing-user');
  await page.locator('#continue').click();
  await expect(page.locator('#form-error')).toContainText("couldn't read your GitHub");
  await expect(page.locator('#continue')).toBeEnabled();
  const request = page.waitForRequest('**/api/rank');
  await build(page, 'AI evaluation');
  expect((await request).postDataJSON()).toMatchObject({ github: '', interests: 'AI evaluation' });
  await expect(page.locator('#results')).toBeVisible();
  await noOverflow(page);
});

test('editing during a slow parse cancels stale results and allows another submission', async ({ page }) => {
  await start(page);
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/api/github?*', async route => { await gate; await fulfill(route, { text: 'Old profile', repos: 1, readmes: 1 }).catch(() => {}); });
  await page.locator('#github').fill('old-user');
  await page.locator('#continue').click();
  await expect(page.locator('#continue')).toBeDisabled();
  await page.locator('#github').fill('');
  const request = page.waitForRequest('**/api/rank');
  await build(page, 'New profile interests');
  release();
  expect((await request).postDataJSON()).toMatchObject({ github: '', interests: 'New profile interests' });
  await expect(page.locator('#results')).toBeVisible();
});

test('text uploads deduplicate, preserve full filenames, and remove with keyboard focus', async ({ page }) => {
  await start(page);
  await page.evaluate(() => document.addEventListener('change', (e) => {
    if (e.target.id === 'files') window.__testFile = e.target.files[0];
  }, true));
  const file = { name: 'A-very-long-resume-filename-for-testing-small-mobile-screen-layouts.txt', mimeType: 'text/plain', buffer: Buffer.from('Engineer building AI evaluation tools') };
  await page.locator('#files').setInputFiles(file);
  await expect(page.locator('.file-status')).toContainText('5 words');
  // Re-drop the same File object so its modification timestamp remains stable.
  await page.locator('#drop').evaluate((drop) => {
    const transfer = new DataTransfer();
    transfer.items.add(window.__testFile);
    drop.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.file')).toHaveCount(1);
  // The file takes the uploader's place until it's removed.
  await expect(page.locator('#drop')).toBeHidden();
  await noOverflow(page);
  await page.getByRole('button', { name: `Remove ${file.name}` }).click();
  await expect(page.locator('#drop')).toBeVisible();
  await expect(page.locator('#files')).toBeFocused();
  await expect(page.locator('.file')).toHaveCount(0);
});

test('unsupported, oversized, empty, and corrupt files have recoverable errors', async ({ page }) => {
  await start(page);
  await page.locator('#files').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not a document') });
  await expect(page.locator('#upload-error')).toContainText('PDF, TXT, or MD');
  await page.locator('#files').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 'a') });
  await expect(page.locator('#upload-error')).toContainText('over 10 MB');
  await page.locator('#files').setInputFiles({ name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.from('   ') });
  await expect(page.locator('.file-status')).toContainText('No readable text');
  await page.route('https://cdnjs.cloudflare.com/**', route => route.abort());
  await page.locator('#files').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await expect(page.locator('.file-status').last()).toContainText("Couldn't read this file");
  await expect(page.locator('#continue')).toBeEnabled();
  await noOverflow(page);
});

test('long profile input is rejected before any silent server truncation', async ({ page }) => {
  await start(page);
  await page.locator('#interests').fill('x'.repeat(120001));
  await page.locator('#continue').click();
  await expect(page.locator('#form-error')).toContainText('120,000');
  await expect(page.locator('#readout')).toBeHidden();
});

test('context beyond the displayed window cannot run', async ({ page }) => {
  await start(page, { ...meta, eventTokens: 400_000 });
  let ranked = false;
  await page.route('**/api/rank', route => { ranked = true; return fulfill(route, result); });
  await build(page, 'AI');
  await expect(page.locator('#form-error')).toContainText('384K-token window');
  await expect(page.locator('#readout')).toBeHidden();
  expect(ranked).toBe(false);
  await expect(page.locator('#continue')).toBeEnabled();
});

test('ranking: top three, day filters on the rest, focus, and external links', async ({ page }) => {
  await start(page);
  await rank(page);
  await expect(page.locator('#results-title')).toBeFocused();
  await expect(page.locator('#top-list > li')).toHaveCount(3);
  await expect(page.locator('#list > li')).toHaveCount(11);
  await expect(page.locator('#results-count')).toContainText('Times in Pacific Time');
  const filters = page.locator('#days button');
  await expect(filters).toHaveCount(8);
  for (let i = 1; i <= 7; i++) {
    await filters.nth(i).focus();
    await page.keyboard.press('Enter');
    await expect(filters.nth(i)).toBeFocused();
    await expect(filters.nth(i)).toHaveAttribute('aria-pressed', 'true');
    const day = await filters.nth(i).textContent();
    for (const meta of await page.locator('#list .item-meta').allTextContents()) expect(meta).toContain(day);
  }
  await filters.first().click();
  await expect(page.locator('#list > li')).toHaveCount(11);
  await expect(page.locator('#list > li').first()).toHaveAttribute('value', '4');
  const link = page.locator('.item-link').first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('href', events[0].url);
  await expect(link).toContainText('Opens event page in a new tab');
  await noOverflow(page);
});

test('HTTP ranking failure allows retry and resets the elapsed clock', async ({ page }) => {
  await start(page);
  let attempts = 0;
  await page.route('**/api/rank', route => ++attempts === 1 ? fulfill(route, { error: 'Service unavailable. Try again.' }, 503) : fulfill(route, result));
  await build(page);
  await expect(page.locator('#run-error')).toContainText('Service unavailable');
  await expect(page.locator('#run')).toBeFocused();
  await expect(page.locator('#interests')).toBeEnabled();
  await page.locator('#run').click();
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#run-error')).toBeHidden();
  expect(attempts).toBe(2);
});

test('pending ranking locks the profile; cancel restores editing and stops its clock', async ({ page }) => {
  await start(page);
  await page.route('**/api/rank', () => {});
  await build(page);
  await expect(page.locator('#interests')).toBeDisabled();
  await expect(page.locator('#cancel-run')).toBeVisible();
  await page.locator('#cancel-run').click();
  await expect(page.locator('#run-error')).toContainText('Stopped waiting');
  await expect(page.locator('#interests')).toBeEnabled();
  await expect(page.locator('#cancel-run')).toBeHidden();
  await page.locator('#interests').fill('A different profile');
  await expect(page.locator('#readout')).toBeHidden();
  await expect(page.locator('#run')).toBeHidden();
  await expect(page.locator('#continue')).toBeVisible();
});

test('timeout does not leave the ranking spinner or profile locked', async ({ page }) => {
  await start(page);
  await page.clock.install();
  await page.route('**/api/rank', () => {});
  await build(page);
  await page.clock.runFor(181_000);
  await expect(page.locator('#run-error')).toContainText('longer than expected');
  await expect(page.locator('#run')).toBeVisible();
  await expect(page.locator('#interests')).toBeEnabled();
});

test('invalid JSON, empty results, and rate limits remain retryable', async ({ page }) => {
  await start(page);
  let attempt = 0;
  await page.route('**/api/rank', route => {
    attempt++;
    if (attempt === 1) return route.fulfill({ contentType: 'application/json', body: 'not json' });
    if (attempt === 2) return fulfill(route, { ranked: [] });
    if (attempt === 3) return fulfill(route, {}, 429);
    return fulfill(route, result);
  });
  await build(page);
  for (const [i, message] of ['unreadable response', 'No event picks', 'Wait a minute'].entries()) {
    if (i) await page.locator('#run').click();
    await expect(page.locator('#run-error')).toContainText(message);
    await expect(page.locator('#results')).toBeHidden();
  }
  await page.locator('#run').click();
  await expect(page.locator('#results')).toBeVisible();
});

test('missing dates, unsafe URLs, long titles, and missing usage never break results', async ({ page }) => {
  await start(page);
  await page.route('**/api/rank', route => fulfill(route, { mode: 'model', ranked: [
    { event: { title: 'LongTitle'.repeat(25), start: 'invalid', url: 'javascript:alert(1)', host: 'Host'.repeat(60) }, score: 120 },
    { event: { ...events[1], end: '2026-10-07T02:00:00-07:00' }, score: -5 },
  ] }));
  await rank(page);
  await expect(page.locator('#results')).toContainText('Date and time to be announced');
  await expect(page.locator('#results')).toContainText('Wed, Oct 7');
  await expect(page.locator('#results a.item-link')).toHaveCount(1);
  await expect(page.locator('.score-num').first()).toHaveAttribute('aria-label', 'Match: 100 out of 100');
  await expect(page.locator('#big-tokens-label')).toContainText('estimated');
  await noOverflow(page);
});

test('layout fits from 320 to 1920 pixels, including long readout values', async ({ page }) => {
  await start(page);
  await page.route('**/api/rank', route => fulfill(route, { ...result, stats: { promptTokens: 999999 } }));
  for (const width of [320, 375, 390, 560, 561, 640, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
  }
  await rank(page);
  for (const width of [320, 375, 560, 561, 640, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
  }
});

test('light and dark initial and completed screens pass automated accessibility checks', async ({ page }) => {
  await start(page);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(audit.violations).toEqual([]);
  }
  await rank(page);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(audit.violations).toEqual([]);
  }
});

test('reduced motion disables decorative and loading animations', async ({ page }) => {
  await start(page);
  await page.route('**/api/rank', () => {});
  await build(page);
  await expect(page.locator('#cancel-run')).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).animationName !== 'none').map(el => el.className))).toEqual([]);
  await page.locator('#cancel-run').click();
});

// A tiny, real text PDF keeps this upload test independent of private documents.
function resumePDF() {
  const text = 'BT /F1 12 Tf 72 720 Td (Engineer building AI evaluation tools) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('a real text PDF is extracted and sent with the profile', async ({ page }) => {
  await start(page);
  await page.locator('#files').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: resumePDF() });
  await expect(page.locator('.file-status')).toContainText('5 words', { timeout: 20_000 });
  const request = page.waitForRequest('**/api/rank');
  await page.locator('#continue').click();
  expect((await request).postDataJSON().resume).toContain('Engineer building AI evaluation tools');
  await expect(page.locator('#results')).toBeVisible();
});

test('slow PDF loading cannot leave Continue disabled forever', async ({ page }) => {
  await start(page);
  await page.clock.install();
  await page.route('https://cdnjs.cloudflare.com/**', () => {});
  await page.locator('#files').setInputFiles({ name: 'slow.pdf', mimeType: 'application/pdf', buffer: resumePDF() });
  await expect(page.locator('#continue')).toBeDisabled();
  await page.clock.fastForward(30_100);
  await expect(page.locator('.file-status')).toContainText("Couldn't read");
  await expect(page.locator('#continue')).toBeEnabled();
});

test('dropping documents outside the uploader keeps the profile on the page', async ({ page }) => {
  await start(page);
  await page.locator('#interests').fill('Keep this profile');
  expect(await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['test'], 'resume.txt', { type: 'text/plain' }));
    return !document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  })).toBeTruthy();
  await expect(page.locator('#interests')).toHaveValue('Keep this profile');
});

test('offline ranking shows a clear error and enables retry', async ({ page }) => {
  await start(page);
  await page.route('**/api/rank', route => route.abort());
  await build(page);
  await expect(page.locator('#run-error')).toContainText('Check your connection');
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#interests')).toBeEnabled();
});
