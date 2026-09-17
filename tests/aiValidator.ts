/**
 * Shared by the unit and e2e tests: a strict checker for the AI 7 operator syntax.
 */
// ---------------------------------------------------------------------------
// A strict validator for the AI 7 operator syntax (operand counts from the
// Adobe Illustrator File Format Specification 7.0). Illustrator refuses files
// with the wrong number of operands ("illegal operand"), so the exporter must
// leave the operand stack empty after every operator.
// ---------------------------------------------------------------------------

const OPERANDS: Record<string, number> = {
  m: 2, l: 2, L: 2, c: 6, C: 6, v: 4, V: 4, y: 4, Y: 4, h: 0, H: 0,
  f: 0, F: 0, s: 0, S: 0, b: 0, B: 0, n: 0, N: 0, W: 0,
  k: 4, K: 4, g: 1, G: 1, x: 6, X: 6, Xa: 3, XA: 3, Xx: 6, XX: 6,
  w: 1, j: 1, J: 1, d: 2, M: 1, O: 1, R: 1, D: 1, i: 1, XR: 1, A: 1, Ap: 1, Ar: 1,
  u: 0, U: 0, '*u': 0, '*U': 0, q: 0, Q: 0, Lb: 10, LB: 0, Ln: 1,
  Bn: 1, Bd: 3, BD: 0, Bb: 0, Bg: 12, Bh: 4, BB: 1, Bm: 6, Bc: 6, Xm: 6,
  To: 1, TO: 0, Tp: 7, TP: 0, Tr: 1, Tf: 2, Ts: 1, Tz: 2, Tt: 1, TA: 1, TC: 3, TW: 3, Ti: 3, Ta: 1, Tq: 1, Tl: 2, Tc: 1, Tw: 1, Tx: 1, Tj: 1, TX: 1, Tk: 2, TK: 2,
  XI: 13,
};
const PAIRS: Array<[string, string]> = [['u', 'U'], ['*u', '*U'], ['q', 'Q'], ['Lb', 'LB'], ['To', 'TO'], ['Bb', 'BB'], ['Tp', 'TP']];

interface Tok {
  kind: 'num' | 'str' | 'name' | 'arr' | 'op';
  text: string;
}

function tokenizeLine(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < line.length && depth > 0) {
        if (line[j] === '\\') j += 2;
        else {
          if (line[j] === '(') depth++;
          else if (line[j] === ')') depth--;
          j++;
        }
      }
      out.push({ kind: 'str', text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '[') {
      const j = line.indexOf(']', i);
      if (j < 0) throw new Error(`unterminated array: ${line}`);
      out.push({ kind: 'arr', text: line.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s()[\]]/.test(line[j])) j++;
    const word = line.slice(i, j);
    i = j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) out.push({ kind: 'num', text: word });
    else if (word.startsWith('/')) out.push({ kind: 'name', text: word });
    else out.push({ kind: 'op', text: word });
  }
  return out;
}

export interface Validation {
  errors: string[];
  ops: Record<string, number>;
  layers: string[];
}

/** Walk the body of an AI file and report syntax problems. */
export function validateAi(text: string): Validation {
  const errors: string[] = [];
  const ops: Record<string, number> = {};
  const layers: string[] = [];
  const lines = text.split('\n');
  const must = ['%!PS-Adobe-3.0', '%%Creator: Adobe Illustrator', '%%BoundingBox:', '%%HiResBoundingBox:', '%%EndComments', '%%BeginProlog', '%%EndProlog', '%%BeginSetup', '%%EndSetup', '%AI5_ArtSize:', '%AI5_NumLayers:', '%%Trailer', '%%EOF'];
  for (const m of must) if (!lines.some((l) => l.startsWith(m))) errors.push(`missing ${m}`);
  if (lines[0] !== '%!PS-Adobe-3.0') errors.push('first line must be %!PS-Adobe-3.0');
  const setupStart = lines.indexOf('%%BeginSetup');
  const setupEnd = lines.indexOf('%%EndSetup');
  const trailer = lines.indexOf('%%PageTrailer') >= 0 ? lines.indexOf('%%PageTrailer') : lines.indexOf('%%Trailer');
  if (!(setupStart < setupEnd && setupEnd < trailer)) errors.push('sections out of order');
  // gradient definitions: colour stops
  let inGradient = false;
  for (let i = setupStart + 1; i < setupEnd; i++) {
    const l = lines[i];
    if (l.startsWith('%AI5_BeginGradient:')) inGradient = true;
    else if (l.startsWith('%AI5_EndGradient')) inGradient = false;
    else if (inGradient && l.endsWith('%_Bs')) {
      const toks = tokenizeLine(l.slice(0, -4));
      const nums = toks.filter((t) => t.kind === 'num');
      const style = Number(nums[nums.length - 3]?.text);
      const expected = style === 0 ? 4 : style === 1 ? 7 : style === 2 ? 10 : style === 3 ? 8 : style === 4 ? 12 : -1;
      if (nums.length !== expected) errors.push(`gradient stop has ${nums.length} numbers for colour style ${style}: ${l}`);
      const strCount = toks.filter((t) => t.kind === 'str').length;
      if ((style === 3 || style === 4) !== (strCount === 1)) errors.push(`gradient stop name mismatch: ${l}`);
    }
  }
  // body
  const stack: Tok[] = [];
  const open: string[] = [];
  let inRaster = false;
  for (let i = setupEnd + 1; i < trailer; i++) {
    const l = lines[i];
    if (l.startsWith('%AI5_BeginRaster')) inRaster = true;
    if (l.startsWith('%AI5_EndRaster')) inRaster = false;
    if (l.startsWith('%')) {
      if (inRaster && l.length > 1 && !/^%[0-9a-f]*$/.test(l) && !l.startsWith('%AI5_')) errors.push(`raster data line is not lower-case hex: ${l.slice(0, 30)}`);
      continue;
    }
    if (!l.trim()) continue;
    let toks: Tok[];
    try {
      toks = tokenizeLine(l);
    } catch (e: any) {
      errors.push(String(e.message));
      continue;
    }
    for (const t of toks) {
      if (t.kind !== 'op') {
        stack.push(t);
        continue;
      }
      const need = OPERANDS[t.text];
      if (need === undefined) {
        errors.push(`unknown operator ${t.text} on line ${i + 1}: ${l}`);
        stack.length = 0;
        continue;
      }
      ops[t.text] = (ops[t.text] ?? 0) + 1;
      if (stack.length !== need) errors.push(`${t.text} expects ${need} operands, got ${stack.length} on line ${i + 1}: ${l}`);
      if (t.text === 'Ln') layers.push(stack[0]?.text ?? '');
      if (t.text === 'Tf' && stack[0]?.kind !== 'name') errors.push(`Tf needs a font name: ${l}`);
      if (t.text === 'Bg' && stack[1]?.kind !== 'str') errors.push(`Bg needs a gradient name: ${l}`);
      if (t.text === 'XI' && stack[0]?.kind !== 'arr') errors.push(`XI needs a matrix: ${l}`);
      stack.length = 0;
      for (const [a, b] of PAIRS) {
        if (t.text === a) open.push(a);
        if (t.text === b) {
          const top = open.pop();
          if (top !== a) errors.push(`${b} without matching ${a} on line ${i + 1}`);
        }
      }
    }
    if (stack.length) {
      errors.push(`operands left on the stack after line ${i + 1}: ${l}`);
      stack.length = 0;
    }
  }
  if (open.length) errors.push(`unclosed containers: ${open.join(' ')}`);
  return { errors, ops, layers };
}

