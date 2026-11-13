/**
 * Binary 2D grid utilities used to turn a plane's inlier points into trimmed outlines:
 * morphology, connected components, hole filling, boundary tracing and polygon simplification.
 * Cell (i, j) covers [i, i+1] x [j, j+1] in grid units; index = j * w + i.
 */

export class Grid {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, data?: Uint8Array) {
    this.data = data ?? new Uint8Array(w * h);
  }
  get(i: number, j: number): number {
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? 0 : this.data[j * this.w + i];
  }
  set(i: number, j: number, v = 1) {
    this.data[j * this.w + i] = v;
  }
  count(): number {
    let n = 0;
    for (let k = 0; k < this.data.length; k++) n += this.data[k] ? 1 : 0;
    return n;
  }
}

/** 3x3 dilation. */
export function dilate(g: Grid): Grid {
  const out = new Grid(g.w, g.h);
  const { w, h } = g;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!g.data[j * w + i]) continue;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= h) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= w) continue;
          out.data[jj * w + ii] = 1;
        }
      }
    }
  }
  return out;
}

/** 3x3 erosion (outside the grid counts as empty). */
export function erode(g: Grid): Grid {
  const out = new Grid(g.w, g.h);
  const { w, h } = g;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!g.data[j * w + i]) continue;
      let all = 1;
      for (let dj = -1; dj <= 1 && all; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!g.get(i + di, j + dj)) { all = 0; break; }
        }
      }
      out.data[j * w + i] = all;
    }
  }
  return out;
}

/** Morphological closing (dilate then erode), padded so shapes at the border are not eaten. */
export function close(g: Grid): Grid {
  const pad = new Grid(g.w + 2, g.h + 2);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.data[j * g.w + i]) pad.set(i + 1, j + 1);
  const c = erode(dilate(pad));
  const out = new Grid(g.w, g.h);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) out.data[j * g.w + i] = c.data[(j + 1) * pad.w + i + 1] | g.data[j * g.w + i];
  return out;
}

export interface Components {
  labels: Int32Array; // 0 = background, 1..count
  count: number;
  sizes: number[]; // sizes[label]
}

/** Connected components of set cells (value = target). 8- or 4-connectivity. */
export function components(g: Grid, conn8 = true, target = 1): Components {
  const { w, h } = g;
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || (g.data[start] ? 1 : 0) !== target) continue;
    count++;
    let size = 0, sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp) {
      const k = stack[--sp];
      size++;
      const i = k % w, j = (k - i) / w;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= h) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          if (!conn8 && di && dj) continue;
          const ii = i + di;
          if (ii < 0 || ii >= w) continue;
          const kk = jj * w + ii;
          if (labels[kk] || (g.data[kk] ? 1 : 0) !== target) continue;
          labels[kk] = count;
          stack[sp++] = kk;
        }
      }
    }
    sizes.push(size);
  }
  return { labels, count, sizes };
}

/** Fill enclosed empty areas (4-connected, not touching the border) of at most maxCells cells. */
export function fillSmallHoles(g: Grid, maxCells: number): Grid {
  const out = new Grid(g.w, g.h, g.data.slice());
  if (maxCells <= 0) return out;
  const bg = components(g, false, 0);
  const touches = new Uint8Array(bg.count + 1);
  const { w, h } = g;
  for (let i = 0; i < w; i++) { touches[bg.labels[i]] = 1; touches[bg.labels[(h - 1) * w + i]] = 1; }
  for (let j = 0; j < h; j++) { touches[bg.labels[j * w]] = 1; touches[bg.labels[j * w + w - 1]] = 1; }
  for (let k = 0; k < w * h; k++) {
    const l = bg.labels[k];
    if (l && !touches[l] && bg.sizes[l] <= maxCells) out.data[k] = 1;
  }
  return out;
}

export type Loop = number[]; // flat [x0, y0, x1, y1, ...] in grid units, closed (last != first)

/**
 * Trace the boundary of set cells as closed loops along cell edges. Set cells are on the left of
 * every edge, so outer boundaries come out counter-clockwise (positive area) and holes clockwise.
 */
export function traceLoops(g: Grid): Loop[] {
  const { w, h } = g;
  const W = w + 1;
  // directed edges: from vertex -> to vertex (vertex key = y * W + x)
  const from: number[] = [], to: number[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!g.data[j * w + i]) continue;
      if (!g.get(i, j - 1)) { from.push(j * W + i); to.push(j * W + i + 1); }
      if (!g.get(i + 1, j)) { from.push(j * W + i + 1); to.push((j + 1) * W + i + 1); }
      if (!g.get(i, j + 1)) { from.push((j + 1) * W + i + 1); to.push((j + 1) * W + i); }
      if (!g.get(i - 1, j)) { from.push((j + 1) * W + i); to.push(j * W + i); }
    }
  }
  const out = new Map<number, number[]>();
  from.forEach((f, e) => {
    const l = out.get(f);
    if (l) l.push(e); else out.set(f, [e]);
  });
  const used = new Uint8Array(from.length);
  const loops: Loop[] = [];
  const dir = (e: number) => {
    const fx = from[e] % W, fy = (from[e] - fx) / W, tx = to[e] % W, ty = (to[e] - tx) / W;
    return [tx - fx, ty - fy];
  };
  for (let s = 0; s < from.length; s++) {
    if (used[s]) continue;
    const loop: number[] = [];
    let e = s;
    while (!used[e]) {
      used[e] = 1;
      const x = from[e] % W;
      loop.push(x, (from[e] - x) / W);
      const cands = (out.get(to[e]) ?? []).filter((c) => !used[c]);
      if (!cands.length) break;
      if (cands.length === 1) { e = cands[0]; continue; }
      // pinch vertex: prefer the left turn so diagonally touching cells form separate loops
      const [dx, dy] = dir(e);
      let best = cands[0], bestCross = -Infinity;
      for (const c of cands) {
        const [cx, cy] = dir(c);
        const cross = dx * cy - dy * cx;
        if (cross > bestCross) { bestCross = cross; best = c; }
      }
      e = best;
    }
    if (loop.length >= 6) loops.push(removeCollinear(loop));
  }
  return loops;
}

function removeCollinear(loop: Loop): Loop {
  const n = loop.length / 2;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = (k + n - 1) % n, q = (k + 1) % n;
    const ax = loop[k * 2] - loop[p * 2], ay = loop[k * 2 + 1] - loop[p * 2 + 1];
    const bx = loop[q * 2] - loop[k * 2], by = loop[q * 2 + 1] - loop[k * 2 + 1];
    if (ax * by - ay * bx !== 0) out.push(loop[k * 2], loop[k * 2 + 1]);
  }
  return out;
}

/** Signed area (shoelace). Positive = counter-clockwise. */
export function loopArea(loop: Loop): number {
  let a = 0;
  const n = loop.length / 2;
  for (let k = 0; k < n; k++) {
    const q = (k + 1) % n;
    a += loop[k * 2] * loop[q * 2 + 1] - loop[q * 2] * loop[k * 2 + 1];
  }
  return a / 2;
}

function perpDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function dpOpen(pts: number[][], eps: number): number[][] {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  let idx = -1, max = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const d = perpDist(pts[k][0], pts[k][1], ax, ay, bx, by);
    if (d > max) { max = d; idx = k; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  const left = dpOpen(pts.slice(0, idx + 1), eps);
  const right = dpOpen(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Douglas-Peucker on a closed loop. Keeps orientation. Returns the original loop if it would collapse. */
export function simplifyLoop(loop: Loop, eps: number): Loop {
  const n = loop.length / 2;
  if (n <= 4 || eps <= 0) return loop.slice();
  const pts: number[][] = [];
  for (let k = 0; k < n; k++) pts.push([loop[k * 2], loop[k * 2 + 1]]);
  // split at the vertex farthest from vertex 0
  let far = 0, fd = -1;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  const a = dpOpen(pts.slice(0, far + 1), eps);
  const b = dpOpen(pts.slice(far).concat([pts[0]]), eps);
  const res = a.slice(0, -1).concat(b.slice(0, -1));
  if (res.length < 3) return loop.slice();
  const flat = res.flat();
  if (Math.abs(loopArea(flat)) < 1e-9) return loop.slice();
  return flat;
}
