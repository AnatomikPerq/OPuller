/**
 * Renders public/favicon.svg into the PNG icon set (favicon-16/32/48, apple-touch-icon 180,
 * PWA 192/512) with Playwright's Chromium, then packs favicon.ico (16/32/48) with Python
 * Pillow when it is available. Run: node scripts/gen-icons.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch();
const sizes = [
  { size: 16, file: 'public/favicon-16.png' },
  { size: 32, file: 'public/favicon-32.png' },
  { size: 48, file: 'public/favicon-48.png' },
  { size: 180, file: 'public/apple-touch-icon.png' },
  { size: 192, file: 'public/icon-192.png' },
  { size: 512, file: 'public/icon-512.png' },
];
for (const { size, file } of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="64" height="64"', `width="${size}" height="${size}"`)}</body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
  console.log('wrote', file);
}
await browser.close();

// favicon.ico: 16 + 32 + 48 px frames (Pillow writes multi-size ICO files)
const py = spawnSync('python', ['-c', "from PIL import Image\nim=Image.open('public/favicon-48.png').convert('RGBA')\nim.save('public/favicon.ico', sizes=[(16,16),(32,32),(48,48)])\nprint('wrote public/favicon.ico')"], { encoding: 'utf8' });
if (py.status === 0) process.stdout.write(py.stdout);
else console.warn('favicon.ico not written (Python + Pillow needed):', py.stderr.trim());
