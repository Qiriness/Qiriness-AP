import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { adaptSocialReport } from '../../scripts/lib/social-report-data.mjs';
import { renderSocialReport, socialReportState } from '../../scripts/lib/social-report.mjs';

const data = adaptSocialReport({ companyId: 'dummy-history', timezone: 'Europe/Paris', endMonth: '2025-12', asOf: '2026-10-09',
  accounts: [{ id: 'ig', kind: 'instagram', enabled: true, engagement_basis: 'views' }], days: [], audience: [],
  posts: [{ account_id: 'ig', external_id: 'dec-post', published_at: '2025-12-15T12:00:00Z', fetched_at: '2026-10-08T12:00:00Z', insights_at: '2026-10-08T12:00:00Z',
    caption_excerpt: 'Dummy December post', media_type: 'video', views: 100, reach: 80, likes: 5, comments: 2, shares: 1, engagement: 8 }]
});
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort());
  await page.setContent(renderSocialReport(socialReportState(data, { name: 'Dummy Brand', endMonth: '2025-12', months: 1 })));
  await page.evaluate(async () => { await window.SocialReport.ready; });
  const rows = await page.locator('.post-table tbody tr').count();
  console.log('December 2025 post rows:', rows);
  assert.equal(rows, 1, 'A stored December post must remain visible when first synced later.');
  assert.match(await page.locator('#report').textContent(), /Lifetime figures observed 2026-10-08/);
  assert.match(await page.locator('#report').textContent(), /Published 2025-12-15/);
  assert.equal((await page.evaluate(() => SocialReport.getComputed())).platforms[0].current.views, null, 'Lifetime views cannot become daily December views.');
  const historical = structuredClone(data);
  delete historical.postObservationPolicy;
  await page.goto('about:blank');
  await page.setContent(renderSocialReport(socialReportState(historical, { name: 'Dummy historical snapshot', endMonth: '2025-12', months: 1 })));
  await page.evaluate(async () => { await window.SocialReport.ready; });
  assert.equal(await page.locator('.post-table tbody tr').count(), 0, 'Imported historical-snapshot datasets retain their strict observation cutoff.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
