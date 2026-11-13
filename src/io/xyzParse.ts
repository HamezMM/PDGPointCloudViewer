/**
 * Pure, allocation-light parsing helpers for ASCII point cloud files (.xyz / .txt / .pts / .csv).
 *
 * The scanner works directly on bytes (no TextDecoder, no per-line strings) because a typical
 * scan is 1+ GB and tens of millions of lines; string allocation dominates otherwise.
 */

export const MAX_FIELDS = 32;

/** Which column holds which attribute. Indices are 0-based; -1 = absent. */
export interface ColumnMap {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  i: number;
  /** Multiplier that converts raw colour values into 0..255. */
  rgbScale: number;
}

export interface Detection {
  map: ColumnMap;
  columnCount: number;
  /** True when some columns could not be classified confidently. */
  guessed: boolean;
  /** Human readable token string, e.g. "x y z i r g b" ("_" = ignored column). */
  tokens: string;
  notes: string[];
}

const C_NL = 10, C_CR = 13, C_SP = 32, C_TAB = 9, C_COMMA = 44, C_SEMI = 59;
const C_MINUS = 45, C_PLUS = 43, C_DOT = 46, C_0 = 48, C_9 = 57, C_e = 101, C_E = 69;

const POW10: number[] = [];
for (let i = 0; i <= 40; i++) POW10.push(Math.pow(10, i));

function isSep(c: number): boolean {
  return c === C_SP || c === C_TAB || c === C_COMMA || c === C_SEMI;
}

/**
 * Parse one line (bytes [start, end)) into `out`. Returns the number of fields, or -1 when the
 * line contains anything that is not a number (header / comment lines).
 */
export function parseLineBytes(buf: Uint8Array, start: number, end: number, out: Float64Array): number {
  let n = 0;
  let p = start;
  while (p < end) {
    let c = buf[p];
    if (isSep(c) || c === C_CR) { p++; continue; }
    // number token
    let neg = false;
    if (c === C_MINUS) { neg = true; p++; } else if (c === C_PLUS) { p++; }
    let mant = 0;
    let digits = 0;
    let frac = 0;
    let any = false;
    while (p < end) {
      c = buf[p];
      if (c >= C_0 && c <= C_9) {
        if (digits < 17) { mant = mant * 10 + (c - C_0); digits++; } else { frac--; }
        any = true; p++;
      } else break;
    }
    if (p < end && buf[p] === C_DOT) {
      p++;
      while (p < end) {
        c = buf[p];
        if (c >= C_0 && c <= C_9) {
          if (digits < 17) { mant = mant * 10 + (c - C_0); digits++; frac++; }
          any = true; p++;
        } else break;
      }
    }
    if (!any) return -1;
    let exp = 0;
    if (p < end && (buf[p] === C_e || buf[p] === C_E)) {
      p++;
      let eneg = false;
      if (buf[p] === C_MINUS) { eneg = true; p++; } else if (buf[p] === C_PLUS) { p++; }
      let eany = false;
      while (p < end && buf[p] >= C_0 && buf[p] <= C_9) { exp = exp * 10 + (buf[p] - C_0); p++; eany = true; }
      if (!eany) return -1;
      if (eneg) exp = -exp;
    }
    // token must end at a separator or end of line
    if (p < end && !isSep(buf[p]) && buf[p] !== C_CR) return -1;
    const e10 = exp - frac;
    let v: number;
    if (e10 === 0) v = mant;
    else if (e10 > 0) v = e10 <= 40 ? mant * POW10[e10] : mant * Math.pow(10, e10);
    else v = -e10 <= 40 ? mant / POW10[-e10] : mant / Math.pow(10, -e10);
    if (n < out.length) out[n] = neg ? -v : v;
    n++;
  }
  return n;
}

/**
 * Incremental line scanner. Feed it arbitrary byte chunks; it calls `onLine` once per complete
 * line, carrying partial lines across chunk boundaries.
 */
export class LineScanner {
  private carry: Uint8Array = new Uint8Array(0);
  private fields = new Float64Array(MAX_FIELDS);
  /** Lines that were skipped because they were not numeric (headers, comments). */
  skipped = 0;
  /** The first few raw non-empty lines, for display. */
  readonly preview: string[] = [];
  private previewMax: number;

  constructor(previewMax = 5) {
    this.previewMax = previewMax;
  }

  feed(chunk: Uint8Array, onLine: (fields: Float64Array, n: number) => void): void {
    const buf = chunk;
    let startOffset = 0;
    if (this.carry.length) {
      // Only join the carry with the first line of the new chunk, not the whole chunk.
      const nl = chunk.indexOf(C_NL);
      if (nl < 0) {
        const joined = new Uint8Array(this.carry.length + chunk.length);
        joined.set(this.carry, 0);
        joined.set(chunk, this.carry.length);
        this.carry = joined;
        return;
      }
      const joined = new Uint8Array(this.carry.length + nl);
      joined.set(this.carry, 0);
      joined.set(chunk.subarray(0, nl), this.carry.length);
      this.carry = new Uint8Array(0);
      this.emit(joined, 0, joined.length, onLine);
      startOffset = nl + 1;
    }
    let s = startOffset;
    const len = buf.length;
    for (let p = startOffset; p < len; p++) {
      if (buf[p] === C_NL) {
        if (p > s) this.emit(buf, s, p, onLine);
        s = p + 1;
      }
    }
    if (s < len) this.carry = buf.slice(s);
  }

  flush(onLine: (fields: Float64Array, n: number) => void): void {
    if (this.carry.length) {
      this.emit(this.carry, 0, this.carry.length, onLine);
      this.carry = new Uint8Array(0);
    }
  }

  private emit(buf: Uint8Array, s: number, e: number, onLine: (fields: Float64Array, n: number) => void) {
    if (this.preview.length < this.previewMax) {
      const text = new TextDecoder().decode(buf.subarray(s, e)).trim();
      if (text) this.preview.push(text.length > 200 ? text.slice(0, 200) + '…' : text);
    }
    const n = parseLineBytes(buf, s, e, this.fields);
    if (n < 0) { this.skipped++; return; }
    if (n === 0) return;
    onLine(this.fields, n);
  }
}

// ---------------------------------------------------------------------------------------------
// Column detection
// ---------------------------------------------------------------------------------------------

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0] ?? 0, bestN = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestN) { bestN = c; best = v; }
  }
  return best;
}

interface ColStats { min: number; max: number; allInt: boolean; }

function colStats(rows: number[][], col: number): ColStats {
  let min = Infinity, max = -Infinity, allInt = true;
  for (const r of rows) {
    const v = r[col];
    if (v < min) min = v;
    if (v > max) max = v;
    if (allInt && v !== Math.round(v)) allInt = false;
  }
  return { min, max, allInt };
}

function isUnitTriple(rows: number[][], c: number): boolean {
  let ok = 0;
  for (const r of rows) {
    const a = r[c], b = r[c + 1], d = r[c + 2];
    if (Math.abs(a) > 1.0001 || Math.abs(b) > 1.0001 || Math.abs(d) > 1.0001) return false;
    const len = Math.sqrt(a * a + b * b + d * d);
    if (Math.abs(len - 1) < 0.02) ok++;
  }
  return ok >= rows.length * 0.95;
}

type ColourKind = 'u8' | 'u16' | 'unit' | null;

function colourTripleKind(rows: number[][], c: number): ColourKind {
  const s = [colStats(rows, c), colStats(rows, c + 1), colStats(rows, c + 2)];
  if (s.some((x) => x.min < 0)) return null;
  const max = Math.max(s[0].max, s[1].max, s[2].max);
  const allInt = s.every((x) => x.allInt);
  if (allInt && max <= 255) return 'u8';
  if (allInt && max <= 65535) return 'u16';
  if (!allInt && max <= 1.0) return 'unit';
  return null;
}

function scaleForKind(k: ColourKind): number {
  return k === 'unit' ? 255 : k === 'u16' ? 255 / 65535 : 1;
}

/** Compute the rgb scale for given colour columns from sample rows. */
export function rgbScaleFor(rows: number[][], r: number, g: number, b: number): number {
  if (r < 0 || g < 0 || b < 0 || rows.length === 0) return 1;
  const max = Math.max(colStats(rows, r).max, colStats(rows, g).max, colStats(rows, b).max);
  const allInt = [r, g, b].every((c) => colStats(rows, c).allInt);
  if (!allInt && max <= 1.0) return 255;
  if (max > 255) return 255 / 65535;
  return 1;
}

export function emptyMap(): ColumnMap {
  return { x: 0, y: 1, z: 2, r: -1, g: -1, b: -1, i: -1, rgbScale: 1 };
}

export function mapToTokens(map: ColumnMap, columnCount: number): string {
  const t: string[] = new Array(columnCount).fill('_');
  const set = (k: string, idx: number) => { if (idx >= 0 && idx < columnCount) t[idx] = k; };
  set('x', map.x); set('y', map.y); set('z', map.z);
  set('r', map.r); set('g', map.g); set('b', map.b); set('i', map.i);
  return t.join(' ');
}

/**
 * Parse a token override like "x y z i r g b" or "x,y,z,_,_,_,r,g,b".
 * Tokens: x y z r g b i (intensity), _ (ignore). Throws on invalid input.
 */
export function tokensToMap(tokens: string, rows: number[][] = []): ColumnMap {
  const parts = tokens.trim().toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const map = { ...emptyMap(), x: -1, y: -1, z: -1 };
  const seen = new Set<string>();
  parts.forEach((p, idx) => {
    if (p === '_' || p === '-') return;
    if (!['x', 'y', 'z', 'r', 'g', 'b', 'i'].includes(p)) throw new Error(`Unknown column token "${p}"`);
    if (seen.has(p)) throw new Error(`Column "${p}" given twice`);
    seen.add(p);
    (map as any)[p] = idx;
  });
  if (map.x < 0 || map.y < 0 || map.z < 0) throw new Error('Columns x, y and z are required');
  const hasRgb = [map.r, map.g, map.b].filter((v) => v >= 0).length;
  if (hasRgb !== 0 && hasRgb !== 3) throw new Error('Give all three of r, g, b or none');
  map.rgbScale = rgbScaleFor(rows, map.r, map.g, map.b);
  return map;
}

/**
 * Guess the column layout from a sample of parsed rows.
 * Columns 0..2 are always x y z (true for every common .xyz export).
 * Extra columns are classified as normals (unit-length triple), colour (0..255 / 0..65535
 * integers or 0..1 floats) or intensity (remaining single column).
 */
export function detectColumns(rowsIn: number[][]): Detection {
  const notes: string[] = [];
  if (rowsIn.length === 0) throw new Error('No numeric data lines found');
  const count = mode(rowsIn.map((r) => r.length));
  const rows = rowsIn.filter((r) => r.length === count);
  if (rows.length < rowsIn.length) notes.push(`${rowsIn.length - rows.length} sample lines had a different column count`);
  if (count < 3) throw new Error(`Only ${count} column(s) per line; need at least x y z`);

  const map = emptyMap();
  const used = new Array(count).fill(false);
  used[0] = used[1] = used[2] = true;
  let guessed = false;

  // Normals first (they would otherwise look like 'unit' colour).
  for (let c = 3; c + 2 < count; c++) {
    if (used[c] || used[c + 1] || used[c + 2]) continue;
    if (isUnitTriple(rows, c)) {
      used[c] = used[c + 1] = used[c + 2] = true;
      notes.push(`columns ${c + 1}-${c + 3} look like normals (ignored)`);
      c += 2;
    }
  }
  // Colour: prefer a triple of integers, scanning from the end (most exports put rgb last or right after xyz).
  const candidates: { c: number; k: ColourKind }[] = [];
  for (let c = 3; c + 2 < count; c++) {
    if (used[c] || used[c + 1] || used[c + 2]) continue;
    const k = colourTripleKind(rows, c);
    if (k) candidates.push({ c, k });
  }
  if (candidates.length) {
    // Prefer u8, then u16, then unit floats.
    const rank = (k: ColourKind) => (k === 'u8' ? 0 : k === 'u16' ? 1 : 2);
    candidates.sort((a, b) => rank(a.k) - rank(b.k) || b.c - a.c);
    // If there's an integer triple that is immediately after a single remaining column (x y z i r g b),
    // the sort by position (latest first) picks the trailing triple, which matches common exports.
    const pick = candidates[0];
    map.r = pick.c; map.g = pick.c + 1; map.b = pick.c + 2;
    map.rgbScale = scaleForKind(pick.k);
    used[pick.c] = used[pick.c + 1] = used[pick.c + 2] = true;
    if (candidates.length > 1) { guessed = true; notes.push('several column triples could be colour; picked the last one'); }
  }
  // Intensity: first remaining column.
  const remaining: number[] = [];
  for (let c = 3; c < count; c++) if (!used[c]) remaining.push(c);
  if (remaining.length) {
    map.i = remaining[0];
    used[map.i] = true;
    if (remaining.length > 1) {
      guessed = true;
      notes.push(`${remaining.length - 1} column(s) not recognised (ignored)`);
    }
  }
  return { map, columnCount: count, guessed, tokens: mapToTokens(map, count), notes };
}

// ---------------------------------------------------------------------------------------------
// Reservoir sampling
// ---------------------------------------------------------------------------------------------

/**
 * Algorithm R reservoir sampler over point indices. `offer()` returns the slot to write into,
 * or -1 when the point should be dropped. Keeps a uniform random sample of size <= capacity.
 */
export class Reservoir {
  seen = 0;
  constructor(readonly capacity: number, private rand: () => number = Math.random) {}
  offer(): number {
    const n = this.seen++;
    if (n < this.capacity) return n;
    const j = Math.floor(this.rand() * (n + 1));
    return j < this.capacity ? j : -1;
  }
  get size(): number {
    return Math.min(this.seen, this.capacity);
  }
}
