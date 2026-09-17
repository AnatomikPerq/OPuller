/**
 * The public site around the editor: crawlable start page (head metadata, boot screen with
 * links), static pages, robots.txt / sitemap.xml — and the hardening of project files.
 */
import { test, expect } from '@playwright/test';
import { openApp } from './helpers';

const PAGES = [
  { path: '/features/', title: /Features — OPuller/ },
  { path: '/guide/', title: /User guide & keyboard shortcuts — OPuller/ },
  { path: '/ai/', title: /AI integration \(MCP\)/ },
];

test.describe('public site', () => {
  test('start page carries the metadata search engines and social cards need', async ({ page }) => {
    const res = await page.request.get('/');
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://opuller.huhusova67.online/" />');
    expect(html).toMatch(/<meta name="description" content="[^"]{80,}"/);
    expect(html).toContain('<meta property="og:image" content="https://opuller.huhusova67.online/og.png" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    // JSON-LD parses and describes the application
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(ld).toBeTruthy();
    const graph = JSON.parse(ld!)['@graph'] as Array<{ '@type': string }>;
    expect(graph.map((g) => g['@type'])).toEqual(expect.arrayContaining(['WebSite', 'WebApplication', 'Organization']));
    // the boot screen links the static pages so crawlers can discover them without JavaScript
    for (const p of PAGES) expect(html).toContain(`href="${p.path}"`);
    expect(html).toContain('<h1>');
    expect(html).toContain('<noscript>');
  });

  test('the boot screen is replaced by the editor', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.boot')).toHaveCount(0);
    await expect(page.locator('[data-testid="viewport"]')).toBeVisible();
  });

  test('static pages, robots.txt and sitemap.xml are served', async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page).toHaveTitle(p.title);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://opuller.huhusova67.online${p.path}`);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('header nav a[aria-current="page"]')).toHaveAttribute('href', p.path);
      await expect(page.locator('a.btn', { hasText: 'Open the editor' }).first()).toHaveAttribute('href', '/');
      const ld = await page.locator('script[type="application/ld+json"]').textContent();
      expect(JSON.parse(ld!)['@graph'].some((g: { '@type': string }) => g['@type'] === 'BreadcrumbList')).toBeTruthy();
    }
    // the guide lists the shortcuts of the live registries
    await page.goto('/guide/');
    await expect(page.locator('#shortcuts-tools')).toBeVisible();
    const rows = page.locator('#shortcuts-tools + .table-wrap tbody tr');
    expect(await rows.count()).toBeGreaterThan(30);
    await expect(page.locator('#shortcuts-edit + .table-wrap tbody tr', { hasText: 'Undo' }).locator('kbd').first()).toHaveText('Ctrl');

    const robots = await page.request.get('/robots.txt');
    expect(robots.headers()['content-type']).toContain('text/plain');
    expect(await robots.text()).toContain('Sitemap: https://opuller.huhusova67.online/sitemap.xml');
    const sitemap = await page.request.get('/sitemap.xml');
    expect(sitemap.headers()['content-type']).toMatch(/xml/);
    const xml = await sitemap.text();
    for (const p of ['/', ...PAGES.map((x) => x.path)]) expect(xml).toContain(`<loc>https://opuller.huhusova67.online${p}</loc>`);
    for (const file of ['/og.png', '/screenshot.png', '/site.css', '/manifest.webmanifest', '/favicon-48.png']) expect((await page.request.get(file)).ok(), file).toBeTruthy();
  });

  test('hostile markup in a project file cannot reach the DOM', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      (window as any).__xss = 0;
      (window as any).addEventListener('xss', () => ((window as any).__xss += 1));
    });
    const hostile = {
      format: 'opuller',
      version: 1,
      document: {
        name: 'Hostile',
        layers: ['l'],
        nodes: {
          l: { id: 'l', type: 'layer', name: 'Layer', parent: null, children: ['r', 'i'] },
          r: { id: 'r', type: 'path', name: 'Rect', parent: 'l', subpaths: [{ closed: true, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 100, y: 0 } }, { point: { x: 100, y: 100 } }, { point: { x: 0, y: 100 } }] }], fill: { type: 'pattern', patternId: 'p', scale: 1, angle: 0 }, stroke: { paint: { type: 'none' }, width: 1 } },
          i: { id: 'i', type: 'image', name: 'Img', parent: 'l', src: 'javascript:dispatchEvent(new Event("xss"))', width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 },
        },
        artboards: [{ id: 'a', name: 'Artboard 1', x: 0, y: 0, width: 200, height: 200 }],
        patterns: [
          {
            id: 'p',
            name: 'Evil',
            width: 20,
            height: 20,
            svg: '<rect width="20" height="20" fill="#ff0000" onload="dispatchEvent(new Event(\'xss\'))"/><image href="javascript:dispatchEvent(new Event(\'xss\'))" width="1" height="1"/><script>dispatchEvent(new Event("xss"))</script><set attributeName="x" to="1" onbegin="dispatchEvent(new Event(\'xss\'))"/>',
          },
        ],
      },
    };
    await page.evaluate((json) => (window as any).__opuller.mcp.loadProject({ json }), JSON.stringify(hostile));
    await page.waitForTimeout(300);
    const dom = await page.evaluate(() => {
      const pattern = document.querySelector('pattern');
      return {
        xss: (window as any).__xss,
        patternMarkup: pattern ? pattern.innerHTML : null,
        scripts: document.querySelectorAll('svg script').length,
        handlers: Array.from(document.querySelectorAll('svg *')).filter((el) => Array.from(el.attributes).some((a) => a.name.startsWith('on'))).length,
        imageSrc: (window as any).__opuller.store.getState().doc.nodes.i.src,
      };
    });
    expect(dom.xss).toBe(0);
    expect(dom.scripts).toBe(0);
    expect(dom.handlers).toBe(0);
    expect(dom.patternMarkup).toContain('<rect');
    expect(dom.patternMarkup).not.toContain('javascript:');
    expect(dom.imageSrc).toBe('');
  });
});
