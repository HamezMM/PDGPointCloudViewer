import { describe, expect, it } from 'vitest';
import { LineScanner, Reservoir, detectColumns, parseLineBytes, tokensToMap } from '../src/io/xyzParse';
import { formatLength } from '../src/io/units';

const enc = new TextEncoder();

function parse(line: string): number[] | null {
  const b = enc.encode(line);
  const out = new Float64Array(32);
  const n = parseLineBytes(b, 0, b.length, out);
  return n < 0 ? null : Array.from(out.subarray(0, n));
}

function scanAll(chunks: string[]): number[][] {
  const s = new LineScanner();
  const rows: number[][] = [];
  const on = (f: Float64Array, n: number) => rows.push(Array.from(f.subarray(0, n)));
  for (const c of chunks) s.feed(enc.encode(c), on);
  s.flush(on);
  return rows;
}

describe('parseLineBytes', () => {
  it('parses space, tab, comma and semicolon separated numbers', () => {
    expect(parse('1 2 3')).toEqual([1, 2, 3]);
    expect(parse('1\t2\t3')).toEqual([1, 2, 3]);
    expect(parse('1,2,3')).toEqual([1, 2, 3]);
    expect(parse('1;2;3\r')).toEqual([1, 2, 3]);
    expect(parse('  1.5 ,  -2.25 , +3 ')).toEqual([1.5, -2.25, 3]);
  });
  it('parses survey-scale coordinates with full precision', () => {
    const r = parse('512345.123456 5650000.987654 1040.0005')!;
    expect(r[0]).toBeCloseTo(512345.123456, 9);
    expect(r[1]).toBeCloseTo(5650000.987654, 9);
    expect(r[2]).toBeCloseTo(1040.0005, 9);
  });
  it('parses exponents and leading dots', () => {
    expect(parse('1e3 -2.5E-2 .5')).toEqual([1000, -0.025, 0.5]);
  });
  it('rejects header / comment lines', () => {
    expect(parse('X Y Z R G B')).toBeNull();
    expect(parse('// comment')).toBeNull();
    expect(parse('1 2 abc')).toBeNull();
  });
});

describe('LineScanner', () => {
  it('handles lines split across chunks', () => {
    const rows = scanAll(['1 2 3\n4 5', ' 6\n7 8 9', '\n10 11 12']);
    expect(rows).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]);
  });
  it('handles a line spread over many tiny chunks and CRLF', () => {
    const text = '1.25 2.5 3.75\r\n4 5 6\r\n';
    const rows = scanAll(text.split(''));
    expect(rows).toEqual([[1.25, 2.5, 3.75], [4, 5, 6]]);
  });
  it('skips headers and blank lines and keeps a preview', () => {
    const s = new LineScanner(3);
    const rows: number[][] = [];
    s.feed(enc.encode('X Y Z\n\n1 2 3\n'), (f, n) => rows.push(Array.from(f.subarray(0, n))));
    expect(rows).toEqual([[1, 2, 3]]);
    expect(s.skipped).toBe(1);
    expect(s.preview).toEqual(['X Y Z', '1 2 3']);
  });
});

function rows(n: number, fn: (k: number) => number[]): number[][] {
  return Array.from({ length: n }, (_, k) => fn(k));
}

describe('detectColumns', () => {
  it('xyz only', () => {
    const d = detectColumns(rows(100, (k) => [k, k * 2, k * 0.5]));
    expect(d.tokens).toBe('x y z');
  });
  it('xyz + rgb (0..255)', () => {
    const d = detectColumns(rows(100, (k) => [k + 0.1, 2, 3, k % 256, (k * 7) % 256, 10]));
    expect(d.tokens).toBe('x y z r g b');
    expect(d.map.rgbScale).toBe(1);
  });
  it('xyz + rgb as 0..1 floats is scaled to 255', () => {
    const d = detectColumns(rows(100, (k) => [k, 2, 3, (k % 10) / 10 + 0.01, 0.5, 0.25]));
    expect(d.tokens).toBe('x y z r g b');
    expect(d.map.rgbScale).toBe(255);
  });
  it('xyz + intensity (float) + rgb', () => {
    const d = detectColumns(rows(100, (k) => [k, 2, 3, -1500 + k * 3.3, k % 256, 100, 200]));
    expect(d.tokens).toBe('x y z i r g b');
  });
  it('xyz + intensity (int 0..255) + rgb picks the trailing triple', () => {
    const d = detectColumns(rows(100, (k) => [k, 2, 3, (k * 3) % 256, k % 256, 100, 200]));
    expect(d.tokens).toBe('x y z i r g b');
  });
  it('xyz + rgb + normals ignores normals', () => {
    const d = detectColumns(rows(100, (k) => {
      const a = (k / 100) * Math.PI;
      return [k, 2, 3, 10, 20, 30, Math.cos(a), Math.sin(a), 0];
    }));
    expect(d.tokens).toBe('x y z r g b _ _ _');
  });
  it('xyz + intensity only', () => {
    const d = detectColumns(rows(100, (k) => [k, 2, 3, -0.5 + k / 1000]));
    expect(d.tokens).toBe('x y z i');
  });
});

describe('tokensToMap', () => {
  it('parses overrides', () => {
    const m = tokensToMap('x y z _ r g b');
    expect(m).toMatchObject({ x: 0, y: 1, z: 2, r: 4, g: 5, b: 6, i: -1 });
  });
  it('rejects bad overrides', () => {
    expect(() => tokensToMap('x y')).toThrow();
    expect(() => tokensToMap('x y z r g')).toThrow();
    expect(() => tokensToMap('x y z q')).toThrow();
  });
});

describe('Reservoir', () => {
  it('keeps everything below capacity and a bounded, roughly uniform sample above it', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const r = new Reservoir(1000, rand);
    const slots = new Int32Array(1000).fill(-1);
    for (let k = 0; k < 100_000; k++) {
      const s = r.offer();
      if (s >= 0) slots[s] = k;
    }
    expect(r.size).toBe(1000);
    expect(r.seen).toBe(100_000);
    // uniform: the mean kept index should be near the middle of the stream
    const mean = Array.from(slots).reduce((a, b) => a + b, 0) / 1000;
    expect(mean).toBeGreaterThan(40_000);
    expect(mean).toBeLessThan(60_000);
  });
});

describe('formatLength', () => {
  it('formats units', () => {
    expect(formatLength(1, 'mm')).toBe('1000.0 mm');
    expect(formatLength(0.0254, 'in')).toBe('1.000 in');
    expect(formatLength(0.3048 * 10 + 0.0254 * 6.5, 'ft-in')).toBe(`10' 6.5"`);
    expect(formatLength(0, 'ft-in')).toBe(`0' 0"`);
    expect(formatLength(0.3048 * 3, 'ft-in')).toBe(`3' 0"`);
  });
});
