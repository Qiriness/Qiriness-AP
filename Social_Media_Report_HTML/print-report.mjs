/**
 * Export the report in a controlled Chromium environment.
 * Install in your own project: npm install playwright
 * Install the browser:        npx playwright install chromium
 * Run: node print-report.mjs template.html report-state.json output.pdf
 * The JSON argument is a saved report state, or a compatible dataset.
 * Use "-" for the template's embedded/default data.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [templateFile, jsonFile, pdfFile] = process.argv.slice(2);
if (!templateFile || !jsonFile || !pdfFile) {
  console.error('Usage: node print-report.mjs template.html report-state.json output.pdf');
  process.exit(1);
}
const template = path.resolve(templateFile);
const output = path.resolve(pdfFile);
const payload = jsonFile === '-' ? null : JSON.parse(await fs.readFile(path.resolve(jsonFile), 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // All assets in this template are embedded. Reject unexpected external requests.
  await page.route(/^https?:\/\//, route => route.abort());
  await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
  await page.evaluate(async data => {
    if (!window.SocialReport) throw new Error('This HTML does not expose SocialReport.');
    await SocialReport.ready;
    if (data) {
      if (data.companies) await SocialReport.setState(data);
      else await SocialReport.setData(data);
    }
    await SocialReport.ready;
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    if (document.querySelector('.overfull')) throw new Error('A report block exceeds the printable page.');
    if (!document.querySelector('.report-page')) throw new Error('There are no report pages to print.');
  }, payload);
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await page.pdf({
    path: output,
    format: 'A4',
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    tagged: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    scale: 1,
  });
  console.log(output);
} finally {
  await browser.close();
}
