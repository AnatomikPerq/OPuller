/**
 * Renders the social preview (public/og.png, 1200×630) and the product screenshot
 * (public/screenshot.png, 1440×900) with Playwright's Chromium from the running editor:
 * the showcase sample is opened in the dev server, photographed, and composed into the
 * Open Graph card next to the mark and tagline.
 * Needs the dev server (npm run dev) — or set OPULLER_URL. Run: node scripts/gen-og.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const URL = process.env.OPULLER_URL ?? 'http://127.0.0.1:5180/';
const SHOT = 'public/screenshot.png';
const OG = 'public/og.png';

const browser = await chromium.launch();

// 1. product screenshot
const app = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await app.goto(URL);
await app.waitForFunction(() => !!window.__opuller?.allCommands && window.__opuller.allCommands().length > 50);
await app.evaluate(async () => {
  const o = window.__opuller;
  o.home?.getState().setOpen(false);
  await o.runCommand('file.sample.showcase');
  o.store.getState().setSelection([]);
});
await app.waitForTimeout(1200); // fonts, thumbnails, layout
await app.screenshot({ path: SHOT });
await app.close();
console.log('wrote', SHOT);

// 2. Open Graph card
const mark = fs.readFileSync('public/favicon.svg', 'utf8').replace('width="64" height="64"', 'width="72" height="72"');
const shot = `data:image/png;base64,${fs.readFileSync(SHOT).toString('base64')}`;
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative; font-family: 'Segoe UI', Inter, system-ui, -apple-system, Roboto, sans-serif; color: #e6e6ea;
    background: radial-gradient(900px 600px at 15% 20%, #4a1428 0%, #26101a 45%, #1a1a1d 75%);
  }
  .text { position: absolute; left: 72px; top: 92px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 18px; font-size: 44px; font-weight: 700; letter-spacing: -0.01em; }
  h1 { margin: 40px 0 0; font-size: 46px; line-height: 1.12; font-weight: 700; letter-spacing: -0.015em; }
  p { margin: 22px 0 0; font-size: 22px; line-height: 1.4; color: #b9b9c2; }
  .chips { margin-top: 34px; display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { padding: 7px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); font-size: 16px; color: #e6e6ea; }
  .chip.accent { background: #8a2b4f; border-color: #a33660; }
  .window {
    position: absolute; left: 640px; top: 96px; width: 900px; border-radius: 12px; overflow: hidden;
    background: #232326; border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 40px 90px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.5);
    transform: perspective(2400px) rotateY(-9deg) rotateX(2deg);
    transform-origin: left center;
  }
  .bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #2a2a2e; border-bottom: 1px solid #333337; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: #45454b; }
  .dot:nth-child(1) { background: #e5484d; } .dot:nth-child(2) { background: #f0b33f; } .dot:nth-child(3) { background: #3ecf8e; }
  .url { margin-left: 10px; padding: 3px 12px; border-radius: 6px; background: #17171a; color: #9a9aa2; font-size: 14px; }
  img.shot { display: block; width: 900px; height: 562px; object-fit: cover; object-position: left top; }
  .footer { position: absolute; left: 72px; bottom: 44px; font-size: 19px; color: #8f8f98; }
</style></head><body>
  <div class="text">
    <div class="brand">${mark}<span>OPuller</span></div>
    <h1>Free online vector graphics editor</h1>
    <p>An Adobe Illustrator alternative that runs in your browser. Nothing to install, no account.</p>
    <div class="chips"><span class="chip accent">Free</span><span class="chip">SVG</span><span class="chip">PDF</span><span class="chip">EPS</span><span class="chip">AI</span><span class="chip">Image Trace</span><span class="chip">MCP</span></div>
  </div>
  <div class="window">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">opuller.huhusova67.online</span></div>
    <img class="shot" src="${shot}" alt="">
  </div>
  <div class="footer">opuller.huhusova67.online</div>
</body></html>`;

const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await card.setContent(html);
await card.waitForTimeout(300);
await card.screenshot({ path: OG });
await card.close();
console.log('wrote', OG);

await browser.close();
