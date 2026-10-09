import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bandOf, effectiveRules, median } from '../../scripts/lib/social-bands.mjs';
import { renderSocialReport, socialReportState } from '../../scripts/lib/social-report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'web/.next/social-report-validation');
await fs.mkdir(output, { recursive: true });
const data = JSON.parse(await fs.readFile(path.join(root, 'Social_Media_Report_HTML/example-data.json'), 'utf8'));
// Synthetic data only. Exercise production scope and custom rules without contacting any account.
for (const p of data.platforms) {
  p.scope = 'account';
  p.engagementBasis = 'views';
  p.bandRules = effectiveRules([
    { metric: 'views', mode: 'absolute', low: 5000, high: 10000 },
    { metric: 'reach', mode: 'followers', low: 10, high: 20 },
    { metric: 'engagement', mode: 'median', low: 50, high: 150 },
    { metric: 'engagementRate', mode: 'absolute', low: 3, high: 10 },
  ]);
  p.followersByMonth = Object.fromEntries(p.monthly.map(m => [m.month, { fixture: m.followersEnd }]));
  p.posts.forEach(post => { post.accountId = 'fixture'; });
}
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath && process.platform === 'win32') {
  for (const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort());
  const ready = () => page.evaluate(async () => { await window.SocialReport.ready; });
  const state = socialReportState(data, { name: 'Qiriness', endMonth: '2026-09', months: 1 });
  const html = renderSocialReport(state);
  await page.setContent(html);
  await ready();
  assert.equal(await page.locator('.overfull').count(), 0);
  const monthRows = await page.locator('.post-table tbody tr').count();
  assert.equal(monthRows, data.platforms.reduce((n, p) => n + p.posts.filter(post => post.publishedAt >= '2026-09-01' && post.publishedAt <= '2026-09-30' && post.observedAt <= '2026-09-30').length, 0));
  const actual = await page.evaluate(() => [...document.querySelectorAll('.post-table tbody tr')].map(row => ({ id: row.dataset.postId, classes: [...row.querySelectorAll('td')].slice(1).map(cell => cell.className) })));
  for (const p of data.platforms) {
    const posts = p.posts.filter(post => post.publishedAt >= '2026-09-01' && post.publishedAt <= '2026-09-30' && post.observedAt <= '2026-09-30');
    for (const post of posts) {
      const values = [post.views, post.reach, post.interactions / post.views * 100, post.interactions];
      const metrics = ['views', 'reach', 'engagementRate', 'engagement'];
      const expected = values.map((value, i) => {
        const peers = posts.map(x => i === 2 ? x.interactions / x.views * 100 : i === 3 ? x.interactions : x[metrics[i]]);
        const band = bandOf(value, p.bandRules[metrics[i]], { followers: p.followersByMonth['2026-09'].fixture, median: median(peers) });
        return band ? 'band-' + ({ low: 'weak', medium: 'moderate', high: 'strong' }[band]) : '';
      });
      assert.deepEqual(actual.find(x => x.id === post.id).classes, [...expected, '']);
    }
  }
  await page.locator('[data-include-platform="tiktok"]').uncheck();
  await ready();
  assert.deepEqual(await page.evaluate(() => SocialReport.getComputed().platforms.map(p => p.id)), ['instagram']);
  assert.equal(await page.locator('#platform-select option[value="tiktok"]').count(), 0);
  await page.locator('[data-include-platform="instagram"]').click();
  await ready();
  assert.equal(await page.locator('[data-include-platform="instagram"]').isChecked(), true);
  await page.locator('[data-include-platform="tiktok"]').check();
  await ready();
  for (const months of [6, 12]) {
    await page.evaluate(months => SocialReport.setContext({ months }), months);
    await ready();
    assert.equal(await page.locator('.post-table tbody tr').count(), 20);
    assert.equal(await page.locator('.overfull').count(), 0);
    const range = await page.evaluate(() => SocialReport.getComputed().range);
    assert.equal(range.current.months.length, months);
    assert.ok(range.previous.end < range.current.start);
  }
  // Historical end: future post observations must never leak into the report.
  await page.evaluate(() => SocialReport.setContext({ months: 1, endMonth: '2026-08' }));
  await ready();
  assert.equal(await page.locator('.post-table tbody tr').count(), 0);
  await page.evaluate(() => SocialReport.setContext({ endMonth: '2026-09' }));
  await ready();
  await page.locator('[data-edit="overview.interpretationTitle"]').click();
  await page.locator('#edit-text').fill('Verified editable report');
  await page.locator('#apply-text').click();
  await ready();
  // Exercise the supplied Save HTML control, then open that exact portable revision.
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save-html").click();
  const downloaded = await downloadPromise;
  const savedHtmlPath = path.join(output, "saved-report.html");
  await downloaded.saveAs(savedHtmlPath);
  const savedHtml = await fs.readFile(savedHtmlPath, "utf8");
  const saved = await page.evaluate(() => SocialReport.getState());
  await page.goto("about:blank");
  await page.setContent(savedHtml);
  await ready();
  assert.equal(await page.locator('[data-edit="overview.interpretationTitle"]').textContent(), 'Verified editable report');
  await page.screenshot({ path: path.join(output, 'report-editor.png'), fullPage: false });
  await page.pdf({ path: path.join(output, 'report.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  // Table and long commentary continuation must retain every row and word.
  const stress = structuredClone(saved);
  stress.companies[0].data.platforms[0].posts = Array.from({ length: 90 }, (_, i) => ({ ...data.platforms[0].posts.find(p => p.publishedAt >= '2026-09-01'), id: 'stress-' + i, caption: 'Dummy post ' + i }));
  const draft = Object.values(stress.companies[0].drafts)[0];
  draft.text['overview.interpretation'] = Array.from({ length: 1200 }, (_, i) => 'word' + i).join(' ');
  await page.goto("about:blank");
  await page.setContent(renderSocialReport(stress));
  await ready();
  assert.equal(await page.locator('[data-post-id^="stress-"]').count(), 90);
  assert.equal(await page.locator('.overfull').count(), 0);
  assert.ok((await page.locator('#report').textContent()).includes('word1199'));
  assert.deepEqual(errors, []);
  console.log('PASS: calendar modes, dated snapshots, platform inclusion, saved bands, editing/reopen, 90-post pagination, long commentary, PDF rendering.');
  console.log('Synthetic QA output: ' + output);
} finally {
  await browser.close();
}
