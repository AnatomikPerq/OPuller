import { describe, it, expect } from 'vitest';
import { sanitizeSvgMarkup, safeImageSrc } from '@/io/sanitizeSvg';
import { validateDocument } from '@/io/project';

describe('sanitizeSvgMarkup', () => {
  it('keeps what the pattern renderer produces', () => {
    const cell =
      '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/><g transform="translate(1 2)"><path d="M0 0L5 5" fill="url(#g1)" stroke="#000000" stroke-width="1.5"/></g>' +
      '<defs><linearGradient id="g1"><stop offset="0" stop-color="#000000"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
      '<text x="1" y="2" style="font-family:Inter"><tspan>Hi</tspan></text><image href="data:image/png;base64,AAAA" width="4" height="4"/>';
    expect(sanitizeSvgMarkup(cell)).toBe(cell);
  });

  it('drops script, foreign content and event handlers', () => {
    const out = sanitizeSvgMarkup('<rect width="1" height="1" onload="alert(1)"/><script>alert(1)</script><foreignObject><div>x</div></foreignObject><set attributeName="x" to="1" onbegin="alert(1)"/>');
    expect(out).toBe('<rect width="1" height="1"/>');
  });

  it('drops external and javascript references', () => {
    expect(sanitizeSvgMarkup('<image href="https://evil.example/p.png" width="1" height="1"/>')).toBe('<image width="1" height="1"/>');
    expect(sanitizeSvgMarkup('<image xlink:href="javascript:alert(1)" width="1" height="1"/>')).toBe('<image width="1" height="1"/>');
    expect(sanitizeSvgMarkup('<use href="#sym"/>')).toBe('<use href="#sym"/>');
    expect(sanitizeSvgMarkup('<rect fill="url(https://evil.example/x.svg#p)" width="1" height="1"/>')).toBe('<rect width="1" height="1"/>');
    expect(sanitizeSvgMarkup('<rect style="fill:url(https://evil.example/x.svg#p)" width="1" height="1"/>')).toBe('<rect width="1" height="1"/>');
    expect(sanitizeSvgMarkup('<style>@import url(https://evil.example/x.css);</style><rect width="1" height="1"/>')).toBe('<rect width="1" height="1"/>');
    expect(sanitizeSvgMarkup('<style>@font-face{src:url(data:font/woff2;base64,AAAA)}</style>')).toBe('<style>@font-face{src:url(data:font/woff2;base64,AAAA)}</style>');
  });

  it('returns nothing for markup that does not parse', () => {
    expect(sanitizeSvgMarkup('<rect width="1"')).toBe('');
    expect(sanitizeSvgMarkup('')).toBe('');
  });

  it('is applied to pattern cells of project files', () => {
    const doc = validateDocument({
      layers: ['l'],
      nodes: { l: { id: 'l', type: 'layer', name: 'Layer', parent: null, children: [] } },
      patterns: [{ id: 'p1', name: 'P', width: 10, height: 10, svg: '<rect width="1" height="1" onclick="alert(1)"/><script>alert(1)</script>' }],
    });
    expect(doc.patterns[0].svg).toBe('<rect width="1" height="1"/>');
  });
});

describe('safeImageSrc', () => {
  it('accepts data, blob and http(s) sources only', () => {
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageSrc(' blob:http://localhost/abc ')).toBe('blob:http://localhost/abc');
    expect(safeImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(safeImageSrc('javascript:alert(1)')).toBe('');
    expect(safeImageSrc('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeImageSrc('file:///etc/passwd')).toBe('');
  });

  it('is applied to image nodes of project files', () => {
    const doc = validateDocument({
      layers: ['l'],
      nodes: {
        l: { id: 'l', type: 'layer', name: 'Layer', parent: null, children: ['i'] },
        i: { id: 'i', type: 'image', name: 'Image', parent: 'l', src: 'javascript:alert(1)', width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 },
      },
    });
    const img = Object.values(doc.nodes).find((n) => n.type === 'image') as { src: string } | undefined;
    expect(img?.src).toBe('');
  });
});
