import { chromium } from '@playwright/test';
import fs from 'node:fs';
const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="64" height="64"', `width="${size}" height="${size}"`)}</body></html>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons generated');
