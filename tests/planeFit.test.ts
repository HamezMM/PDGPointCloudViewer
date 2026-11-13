import { describe, expect, it } from 'vitest';
import { Grid, components, fillSmallHoles, loopArea, simplifyLoop, traceLoops, close } from '../src/analysis/grid2d';
import { eigenSym3, fitPlanes } from '../src/analysis/planeFit';
import type { PlaneFitResult } from '../src/analysis/types';

// ---------------------------------------------------------------------------------------------
// grid2d
// ---------------------------------------------------------------------------------------------

function gridFrom(rows: string[]): Grid {
  const h = rows.length, w = rows[0].length;
  const g = new Grid(w, h);
  rows.forEach((r, j) => [...r].forEach((c, i) => { if (c === '#') g.set(i, j); }));
  return g;
}

describe('grid2d', () => {
  it('traces a square with a hole as one CCW outer and one CW hole', () => {
    const g = gridFrom([
      '......',
      '.####.',
      '.#..#.',
      '.#..#.',
      '.####.',
      '......',
    ]);
    const loops = traceLoops(g);
    expect(loops.length).toBe(2);
    const areas = loops.map(loopArea).sort((a, b) => a - b);
    expect(areas).toEqual([-4, 16]);
    // outer square simplifies to 4 corners
    const outer = loops.find((l) => loopArea(l) > 0)!;
    expect(simplifyLoop(outer, 0.5).length / 2).toBe(4);
  });

  it('labels components and fills small enclosed holes only', () => {
    const g = gridFrom([
      '#####...##',
      '#.#.#...##',
      '#####.....',
    ]);
    expect(components(g, true).count).toBe(2);
    const f = fillSmallHoles(g, 1);
    expect(f.get(1, 1)).toBe(1);
    expect(f.get(3, 1)).toBe(1);
    expect(f.get(6, 1)).toBe(0); // open to the border
  });

  it('closing bridges one-cell gaps', () => {
    const g = gridFrom(['#.#.#', '.....', '#.#.#']);
    expect(components(close(g), true).count).toBe(1);
  });
});

describe('eigenSym3', () => {
  it('finds the normal of a flat covariance', () => {
    const { values, vectors } = eigenSym3([1, 0, 0, 1e-6, 0, 0.5]);
    expect(values[0]).toBeCloseTo(1e-6, 9);
    expect(Math.abs(vectors[0][1])).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// synthetic rooms (world frame, Y up). Room 10 (x) x 3 (y) x 8 (z), column at x 4..4.6, z 3..3.6
// ---------------------------------------------------------------------------------------------

interface RoomOpts { rotate?: number; window?: boolean; step?: boolean; offsetHalf?: boolean; bulge?: boolean; points?: number }
const W = 10, H = 3, D = 8, IN = 0.0254;

function makeRoom(o: RoomOpts = {}): Float32Array {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = () => (rnd() + rnd() + rnd() - 1.5) * 0.002;
  const N = o.points ?? 1_200_000;
  type S = { area: number; gen: () => number[] | null };
  const s: S[] = [
    { area: W * D, gen: () => [rnd() * W, noise(), rnd() * D] }, // floor
    { area: W * D, gen: () => [rnd() * W, H + noise(), rnd() * D] }, // ceiling
    { area: W * H, gen: () => { // south wall z=0 (window)
      const x = rnd() * W, y = rnd() * H;
      if (o.window && x > 3 && x < 4.2 && y > 1 && y < 2) return null;
      return [x, y, noise()];
    } },
    { area: W * H, gen: () => { // north wall z=D (bulge)
      const x = rnd() * W, y = rnd() * H;
      let z = D + noise();
      if (o.bulge) {
        const r2 = ((x - 5) ** 2 + (y - 1.5) ** 2) / (0.4 * 0.4);
        if (r2 < 1) z += 1.5 * IN * (1 - r2);
      }
      return [x, y, z];
    } },
    { area: D * H, gen: () => { // west wall x=0 (0.5" set back on half)
      const z = rnd() * D;
      return [noise() - (o.offsetHalf && z > D / 2 ? 0.5 * IN : 0), rnd() * H, z];
    } },
    { area: D * H, gen: () => { // east wall x=W (2" step on half)
      const z = rnd() * D;
      return [W + noise() + (o.step && z > D / 2 ? 2 * IN : 0), rnd() * H, z];
    } },
    { area: 2.4 * H, gen: () => { // column
      const t = rnd() * 2.4, y = rnd() * H;
      if (t < 0.6) return [4 + t, y, 3 + noise()];
      if (t < 1.2) return [4.6 + noise(), y, 3 + (t - 0.6)];
      if (t < 1.8) return [4.6 - (t - 1.2), y, 3.6 + noise()];
      return [4 + noise(), y, 3.6 - (t - 1.8)];
    } },
  ];
  const total = s.reduce((a, b) => a + b.area, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const x of s) cdf.push((acc += x.area / total));
  const out = new Float32Array(N * 3);
  const t = ((o.rotate ?? 0) * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
  let k = 0;
  while (k < N) {
    const u = rnd();
    let i = 0;
    while (cdf[i] < u) i++;
    const p = s[i].gen();
    if (!p) continue;
    // rotate about Y so room X -> (cos t, 0, sin t)
    out[k * 3] = p[0] * c - p[2] * sn;
    out[k * 3 + 1] = p[1];
    out[k * 3 + 2] = p[0] * sn + p[2] * c;
    k++;
  }
  return out;
}

function planesOn(r: PlaneFitResult, axis: number) {
  return r.planes.filter((p) => p.axis === axis).map((p) => p.offset).sort((a, b) => a - b);
}
function hasPlane(r: PlaneFitResult, axis: number, offset: number, tol = 0.002) {
  return planesOn(r, axis).some((o) => Math.abs(o - offset) <= tol);
}
function regionAt(r: PlaneFitResult, axis: number, offset: number) {
  return r.regions.filter((g) => g.axis === axis && Math.abs(g.offset - offset) < 0.01).sort((a, b) => b.area - a.area)[0];
}

describe('fitPlanes on a rotated room', () => {
  const pts = makeRoom({ rotate: 17 });
  const r = fitPlanes(pts);

  it('finds the building rotation', () => {
    expect(Math.abs(r.rotationDeg - 17)).toBeLessThan(0.2);
  });

  it('finds floor, ceiling, 4 walls and 4 column faces within 2 mm', () => {
    expect(planesOn(r, 1).length).toBe(2);
    expect(hasPlane(r, 1, 0) && hasPlane(r, 1, H)).toBe(true);
    for (const x of [0, 4, 4.6, W]) expect(hasPlane(r, 0, x)).toBe(true);
    for (const z of [0, 3, 3.6, D]) expect(hasPlane(r, 2, z)).toBe(true);
    expect(r.planes.length).toBe(10);
  });

  it('builds trimmed regions with sensible areas', () => {
    const floor = regionAt(r, 1, 0);
    // floor with the column footprint not scanned (closed over by the hole filling? no: 0.36 m² > minHole)
    expect(floor.area).toBeGreaterThan(W * D - 1.5);
    expect(floor.area).toBeLessThan(W * D + 1.5);
    const wall = regionAt(r, 2, 0);
    expect(wall.area).toBeGreaterThan(W * H - 1);
    expect(wall.area).toBeLessThan(W * H + 1);
    const col = regionAt(r, 0, 4);
    expect(col.area).toBeGreaterThan(1.4);
    expect(col.area).toBeLessThan(2.2);
    expect(wall.rms).toBeLessThan(0.002);
    expect(wall.pctOver).toBe(0);
  });

  it('honours a manual rotation override', () => {
    const r2 = fitPlanes(pts, { rotationDeg: 17 });
    expect(r2.rotationAuto).toBe(false);
    expect(r2.planes.length).toBe(10);
  });
});

describe('fitPlanes features', () => {
  const r = fitPlanes(makeRoom({ window: true, step: true, offsetHalf: true, bulge: true, rotate: -8 }));

  it('finds the rotation despite merged set-backs', () => {
    expect(Math.abs(r.rotationDeg + 8)).toBeLessThan(0.05);
  });

  it('keeps a window as a hole', () => {
    const wall = regionAt(r, 2, 0);
    expect(wall.holes.length).toBe(1);
    const holeArea = Math.abs(loopArea(wall.holes[0]));
    expect(holeArea).toBeGreaterThan(1.2 * 0.75);
    expect(holeArea).toBeLessThan(1.2 * 1.25);
  });

  it('splits a 2" step into two planes', () => {
    expect(hasPlane(r, 0, W, 0.004)).toBe(true);
    expect(hasPlane(r, 0, W + 2 * IN, 0.004)).toBe(true);
  });

  it('merges a 0.5" set-back into one plane', () => {
    const near = planesOn(r, 0).filter((o) => o > -0.05 && o < 0.05);
    expect(near.length).toBe(1);
  });

  it('does not turn the bulge into a plane: 11 planes in total', () => {
    expect(r.planes.length).toBe(11);
  });

  it('flags a 1.5" bulge as out of tolerance', () => {
    const wall = regionAt(r, 2, D);
    expect(wall.pctOver).toBeGreaterThan(0);
    expect(wall.maxDev).toBeGreaterThan(1.2 * IN);
    expect(wall.maxDev).toBeLessThan(1.7 * IN);
  });
});
