/**
 * Orthogonal (Manhattan-world) plane fitting for building scans.
 *
 * Input: points in world metres, Y up. Output: planes snapped to the building's three axes, each
 * split into trimmed regions (outline + holes) with deviation statistics.
 *
 *  1. voxel PCA          -> local normal + planarity per voxel
 *  2. building axes      -> vertical = Y; horizontal rotation from the wall-normal azimuth histogram
 *  3. plane candidates   -> per axis, peaks in the histogram of point offsets; peaks within the
 *                           tolerance merge, peaks further apart stay separate planes
 *  4. assignment         -> nearest plane within the band; signed deviation
 *  5. regions            -> occupancy grid -> close -> components -> fill small holes -> outlines
 */
import { DEFAULT_PARAMS, type PlaneFitResult, type PlaneParams, type Region, type V3 } from './types';
import { Grid, close, components, fillSmallHoles, loopArea, simplifyLoop, traceLoops } from './grid2d';

const MIN_VOXEL_POINTS = 6;
const HIST_BIN = 0.002; // 2 mm offset histogram bins

// ---------------------------------------------------------------------------------------------
// 3x3 symmetric eigen decomposition (Jacobi)
// ---------------------------------------------------------------------------------------------

/** Returns eigenvalues ascending and the eigenvector of the smallest eigenvalue. */
export function eigenSym3(a: number[]): { values: [number, number, number]; vectors: number[][] } {
  // a = [xx, xy, xz, yy, yz, zz]
  const m = [
    [a[0], a[1], a[2]],
    [a[1], a[3], a[4]],
    [a[2], a[4], a[5]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = m[0][1] * m[0][1] + m[0][2] * m[0][2] + m[1][2] * m[1][2];
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => m[i][i] - m[j][j]);
  return {
    values: [m[idx[0]][idx[0]], m[idx[1]][idx[1]], m[idx[2]][idx[2]]],
    vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]]),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function foldAngle(deg: number): number {
  // fold to (-45, 45]
  let a = ((deg % 90) + 90) % 90; // [0, 90)
  if (a > 45) a -= 90;
  return a;
}

export function axesFromRotation(deg: number): [V3, V3, V3] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

/** In-plane basis with U x V = normal (axis index into building axes). */
function planeBasis(axes: [V3, V3, V3], axis: number): [V3, V3] {
  const [A1, Y, A3] = axes;
  if (axis === 0) return [Y, A3];
  if (axis === 1) return [A3, A1];
  return [A1, Y];
}

function smooth(h: Float64Array, sigmaBins: number): Float64Array {
  const r = Math.ceil(sigmaBins * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigmaBins * sigmaBins)));
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const ii = i + j;
      if (ii >= 0 && ii < h.length) s += h[ii] * k[j + r];
    }
    out[i] = s;
  }
  return out;
}

/** Fill one empty cell of every 2x2 diagonal-only pattern so components are 4-connected and loops are simple. */
function fixDiagonals(g: Grid) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j + 1 < g.h; j++) {
      for (let i = 0; i + 1 < g.w; i++) {
        const a = g.get(i, j), b = g.get(i + 1, j), c = g.get(i, j + 1), d = g.get(i + 1, j + 1);
        if (a && d && !b && !c) { g.set(i + 1, j); changed = true; }
        else if (b && c && !a && !d) { g.set(i, j); changed = true; }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export function fitPlanes(pos: Float32Array, paramsIn: Partial<PlaneParams> = {}, onStage?: (s: string) => void): PlaneFitResult {
  const t0 = performance.now();
  const auto = paramsIn.rotationDeg == null;
  let r = fitOnce(pos, paramsIn, onStage);
  if (auto && r.planes.length) {
    // Voxel normals give the rotation to ~0.05°; over a 10 m wall that is several mm. Refine it
    // from line fits of the detected wall points and run again.
    const refined = refineRotation(pos, r, paramsIn.tolerance ?? DEFAULT_PARAMS.tolerance);
    if (refined != null && Math.abs(refined - r.rotationDeg) > 0.001) {
      onStage?.('Refining building rotation');
      r = fitOnce(pos, { ...paramsIn, rotationDeg: refined }, onStage);
      r.rotationAuto = true;
    }
  }
  r.stats.seconds = (performance.now() - t0) / 1000;
  return r;
}

/** Weighted mean of wall directions from 2D PCA of each vertical plane's in-tolerance points. */
function refineRotation(pos: Float32Array, r: PlaneFitResult, tol: number): number | null {
  const n = pos.length / 3;
  const acc = r.planes.map(() => [0, 0, 0, 0, 0, 0]); // count, sx, sz, sxx, sxz, szz
  // reassign quickly: a point belongs to plane p if its deviation is within tol and it is near p
  for (let k = 0; k < n; k++) {
    const d = r.deviation[k];
    if (Number.isNaN(d) || Math.abs(d) > tol) continue;
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    for (let pi = 0; pi < r.planes.length; pi++) {
      const pl = r.planes[pi];
      if (pl.axis === 1) continue;
      const A = r.axes[pl.axis];
      if (Math.abs(x * A[0] + y * A[1] + z * A[2] - pl.offset - d) > 1e-4) continue;
      const a = acc[pi];
      a[0]++; a[1] += x; a[2] += z; a[3] += x * x; a[4] += x * z; a[5] += z * z;
      break;
    }
  }
  let sw = 0, sa = 0;
  r.planes.forEach((pl, pi) => {
    const [c, sx, sz, sxx, sxz, szz] = acc[pi];
    if (pl.axis === 1 || c < 500) return;
    const mx = sx / c, mz = sz / c;
    const cxx = sxx / c - mx * mx, cxz = sxz / c - mx * mz, czz = szz / c - mz * mz;
    // direction of the smallest-variance axis = wall normal in xz
    const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz); // major axis angle
    const normalAz = (ang * 180) / Math.PI + 90;
    let f = foldAngle(normalAz);
    // keep within ±45° of the current estimate
    while (f - r.rotationDeg > 45) f -= 90;
    while (f - r.rotationDeg < -45) f += 90;
    // weight by count and wall length (longer walls constrain the angle better), and down-weight
    // walls that are not one clean line (merged set-backs, bulges): minor variance vs ~1 mm noise
    const len2 = Math.max(cxx + czz, 1e-6);
    const minor = Math.max(0, (cxx + czz) / 2 - Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz));
    const wgt = (c * len2) / (minor + 1e-6);
    sw += wgt; sa += f * wgt;
  });
  return sw > 0 ? foldAngle(sa / sw) : null;
}

function fitOnce(pos: Float32Array, paramsIn: Partial<PlaneParams>, onStage?: (s: string) => void): PlaneFitResult {
  const t0 = performance.now();
  const P: PlaneParams = { ...DEFAULT_PARAMS, ...paramsIn };
  const n = Math.floor(pos.length / 3);
  const deviation = new Float32Array(n).fill(NaN);
  const empty = (): PlaneFitResult => ({
    rotationDeg: P.rotationDeg ?? 0, rotationAuto: P.rotationDeg == null, axes: axesFromRotation(P.rotationDeg ?? 0),
    planes: [], regions: [], deviation, stats: { points: n, planarVoxels: 0, voxels: 0, seconds: 0 },
  });
  if (n < 10) return empty();

  // ---- 1. voxel PCA ---------------------------------------------------------------------------
  onStage?.('Estimating normals');
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const vs = P.voxel;
  const nx = Math.floor((maxX - minX) / vs) + 1, ny = Math.floor((maxY - minY) / vs) + 1;
  const voxelOf = new Int32Array(n);
  const ids = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    const ix = Math.floor((pos[k * 3] - minX) / vs), iy = Math.floor((pos[k * 3 + 1] - minY) / vs), iz = Math.floor((pos[k * 3 + 2] - minZ) / vs);
    const key = ix + nx * (iy + ny * iz);
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    voxelOf[k] = id;
  }
  const nv = ids.size;
  const acc = new Float64Array(nv * 10); // cnt, sx, sy, sz, sxx, sxy, sxz, syy, syz, szz (relative to voxel corner)
  for (let k = 0; k < n; k++) {
    const x = pos[k * 3] - minX, y = pos[k * 3 + 1] - minY, z = pos[k * 3 + 2] - minZ;
    const lx = x - Math.floor(x / vs) * vs, ly = y - Math.floor(y / vs) * vs, lz = z - Math.floor(z / vs) * vs;
    const o = voxelOf[k] * 10;
    acc[o]++; acc[o + 1] += lx; acc[o + 2] += ly; acc[o + 3] += lz;
    acc[o + 4] += lx * lx; acc[o + 5] += lx * ly; acc[o + 6] += lx * lz;
    acc[o + 7] += ly * ly; acc[o + 8] += ly * lz; acc[o + 9] += lz * lz;
  }
  const vNormal = new Float32Array(nv * 3);
  const vState = new Int8Array(nv); // 0 = too few points, 1 = non-planar, 2 = planar
  let planarVoxels = 0;
  for (let v = 0; v < nv; v++) {
    const o = v * 10, c = acc[o];
    if (c < MIN_VOXEL_POINTS) continue;
    const mx = acc[o + 1] / c, my = acc[o + 2] / c, mz = acc[o + 3] / c;
    const cov = [
      acc[o + 4] / c - mx * mx, acc[o + 5] / c - mx * my, acc[o + 6] / c - mx * mz,
      acc[o + 7] / c - my * my, acc[o + 8] / c - my * mz, acc[o + 9] / c - mz * mz,
    ];
    const { values, vectors } = eigenSym3(cov);
    const l0 = Math.max(values[0], 0), l1 = values[1], l2 = values[2];
    if (l1 > 0 && l0 / l1 < P.planarity && l1 / Math.max(l2, 1e-30) > 0.05) {
      vState[v] = 2;
      planarVoxels++;
      vNormal[v * 3] = vectors[0][0]; vNormal[v * 3 + 1] = vectors[0][1]; vNormal[v * 3 + 2] = vectors[0][2];
    } else vState[v] = 1;
  }

  // ---- 2. building axes -----------------------------------------------------------------------
  onStage?.('Finding building axes');
  let rotationDeg: number;
  const rotationAuto = P.rotationDeg == null;
  if (!rotationAuto) rotationDeg = foldAngle(P.rotationDeg as number);
  else {
    const BINS = 1800; // 0.05°
    const hist = new Float64Array(BINS);
    for (let v = 0; v < nv; v++) {
      if (vState[v] !== 2 || Math.abs(vNormal[v * 3 + 1]) > 0.2) continue;
      const az = (Math.atan2(vNormal[v * 3 + 2], vNormal[v * 3]) * 180) / Math.PI;
      const f = ((az % 90) + 90) % 90;
      hist[Math.min(BINS - 1, Math.floor(f / 0.05))] += acc[v * 10];
    }
    // circular smoothing
    const sm = new Float64Array(BINS);
    const r = 20, sig = 8;
    for (let i = 0; i < BINS; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += hist[(i + j + BINS) % BINS] * Math.exp(-(j * j) / (2 * sig * sig));
      sm[i] = s;
    }
    let best = 0;
    for (let i = 1; i < BINS; i++) if (sm[i] > sm[best]) best = i;
    // refine: circular weighted mean within ±1° of the peak
    let sw = 0, sa = 0;
    for (let j = -20; j <= 20; j++) {
      const i = (best + j + BINS) % BINS;
      sw += hist[i];
      sa += hist[i] * (best + j + 0.5) * 0.05;
    }
    rotationDeg = foldAngle(sw > 0 ? sa / sw : 0);
  }
  const axes = axesFromRotation(rotationDeg);
  const cosTol = Math.cos((P.angleDeg * Math.PI) / 180);

  // voxel -> aligned axis (-1 none)
  const vAxis = new Int8Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) {
    if (vState[v] !== 2) continue;
    for (let a = 0; a < 3; a++) {
      const A = axes[a];
      const d = Math.abs(vNormal[v * 3] * A[0] + vNormal[v * 3 + 1] * A[1] + vNormal[v * 3 + 2] * A[2]);
      if (d >= cosTol) { vAxis[v] = a; break; }
    }
  }

  // ---- 3. plane candidates per axis ----------------------------------------------------------
  onStage?.('Detecting planes');
  const tol = P.tolerance;
  const planes: { axis: 0 | 1 | 2; offset: number; points: number }[] = [];
  const planeOffsetsByAxis: number[][] = [[], [], []];
  const planeIdsByAxis: number[][] = [[], [], []];
  for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
    const A = axes[a];
    let dmin = Infinity, dmax = -Infinity, cnt = 0;
    for (let k = 0; k < n; k++) {
      if (vAxis[voxelOf[k]] !== a) continue;
      const d = pos[k * 3] * A[0] + pos[k * 3 + 1] * A[1] + pos[k * 3 + 2] * A[2];
      if (d < dmin) dmin = d; if (d > dmax) dmax = d;
      cnt++;
    }
    if (cnt < P.minPoints) continue;
    const bins = Math.floor((dmax - dmin) / HIST_BIN) + 1;
    const hist = new Float64Array(bins);
    for (let k = 0; k < n; k++) {
      if (vAxis[voxelOf[k]] !== a) continue;
      const d = pos[k * 3] * A[0] + pos[k * 3 + 1] * A[1] + pos[k * 3 + 2] * A[2];
      hist[Math.floor((d - dmin) / HIST_BIN)]++;
    }
    const sm = smooth(hist, 1.5);
    const cands: number[] = [];
    for (let i = 0; i < bins; i++) {
      const l = i > 0 ? sm[i - 1] : 0, r = i + 1 < bins ? sm[i + 1] : 0;
      if (sm[i] > 0 && sm[i] >= l && sm[i] > r) cands.push(i);
    }
    cands.sort((x, y) => sm[y] - sm[x]);
    const tolBins = Math.max(2, Math.round(tol / HIST_BIN));
    const halfBins = Math.max(1, Math.round(tolBins / 2));
    const coreBins = Math.max(2, Math.round(tolBins / 4));
    const sumRange = (lo: number, hi: number) => {
      let t = 0;
      for (let i = Math.max(0, lo); i <= Math.min(bins - 1, hi); i++) t += hist[i];
      return t;
    };
    const accepted: number[] = [];
    for (const c of cands) {
      const d = dmin + (c + 0.5) * HIST_BIN;
      if (accepted.some((o) => Math.abs(o - d) <= tol)) continue; // merged into a stronger plane
      const support = sumRange(c - halfBins, c + halfBins);
      if (support < P.minPoints) continue;
      // A real surface is a sharp peak; a bulge or a curved surface smears points over the
      // offsets. Require the core density to clearly exceed the density around it.
      const core = sumRange(c - coreBins, c + coreBins);
      const ring = sumRange(c - tolBins, c + tolBins) - core;
      const coreDensity = core / (2 * coreBins + 1), ringDensity = ring / (2 * (tolBins - coreBins));
      if (coreDensity < 1.8 * ringDensity) continue;
      // refine: median offset within ±tol/2
      let half = support / 2, med = d;
      for (let i = Math.max(0, c - halfBins); i <= Math.min(bins - 1, c + halfBins); i++) {
        half -= hist[i];
        if (half <= 0) { med = dmin + (i + 0.5) * HIST_BIN; break; }
      }
      if (accepted.some((o) => Math.abs(o - med) <= tol)) continue;
      accepted.push(med);
      planes.push({ axis: a, offset: med, points: support });
    }
  }
  // index planes per axis, sorted by offset
  planes.sort((p, q) => p.axis - q.axis || p.offset - q.offset);
  planes.forEach((p, i) => { planeOffsetsByAxis[p.axis].push(p.offset); planeIdsByAxis[p.axis].push(i); });

  const nearest = (a: number, d: number): number => {
    const offs = planeOffsetsByAxis[a];
    if (!offs.length) return -1;
    let lo = 0, hi = offs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (offs[mid] < d) lo = mid; else hi = mid; }
    const best = Math.abs(offs[lo] - d) <= Math.abs(offs[hi] - d) ? lo : hi;
    return best;
  };

  // ---- 4. assignment --------------------------------------------------------------------------
  onStage?.('Assigning points');
  const primary = new Int32Array(n).fill(-1);
  const occ: number[][] = planes.map(() => []);
  for (let k = 0; k < n; k++) {
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    const va = vAxis[voxelOf[k]];
    if (va >= 0) {
      const A = axes[va];
      const d = x * A[0] + y * A[1] + z * A[2];
      const j = nearest(va, d);
      if (j >= 0) {
        const dev = d - planeOffsetsByAxis[va][j];
        if (Math.abs(dev) > tol && Math.abs(dev) <= P.band) {
          // Junction points (e.g. floor points inside a wall voxel) lie on another plane: give
          // them to that plane's outline instead of flagging them as a deviation here.
          let other = -1, odev = 0;
          for (let a2 = 0; a2 < 3 && other < 0; a2++) {
            if (a2 === va) continue;
            const B = axes[a2];
            const d2 = x * B[0] + y * B[1] + z * B[2];
            const j2 = nearest(a2, d2);
            if (j2 >= 0 && Math.abs(d2 - planeOffsetsByAxis[a2][j2]) <= tol) { other = planeIdsByAxis[a2][j2]; odev = d2 - planeOffsetsByAxis[a2][j2]; }
          }
          if (other >= 0) { occ[other].push(k); deviation[k] = odev; continue; }
        }
        if (Math.abs(dev) <= P.band) {
          const pid = planeIdsByAxis[va][j];
          primary[k] = pid;
          deviation[k] = dev;
          occ[pid].push(k);
        }
      }
    } else if (vState[voxelOf[k]] !== 2) {
      // corners / edges / sparse voxels: use them for outlines when they sit on a plane
      for (let a = 0; a < 3; a++) {
        const A = axes[a];
        const d = x * A[0] + y * A[1] + z * A[2];
        const j = nearest(a, d);
        if (j < 0) continue;
        const dev = d - planeOffsetsByAxis[a][j];
        if (Math.abs(dev) <= tol) {
          occ[planeIdsByAxis[a][j]].push(k);
          if (Number.isNaN(deviation[k]) || Math.abs(dev) < Math.abs(deviation[k])) deviation[k] = dev;
        }
      }
    }
  }

  // ---- 5. regions -----------------------------------------------------------------------------
  onStage?.('Tracing outlines');
  const regions: Region[] = [];
  planes.forEach((pl, pid) => {
    const pts = occ[pid];
    if (pts.length < P.minPoints) return;
    const N = axes[pl.axis];
    const [U, V] = planeBasis(axes, pl.axis);
    let umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity;
    for (const k of pts) {
      const u = pos[k * 3] * U[0] + pos[k * 3 + 1] * U[1] + pos[k * 3 + 2] * U[2];
      const v = pos[k * 3] * V[0] + pos[k * 3 + 1] * V[1] + pos[k * 3 + 2] * V[2];
      if (u < umin) umin = u; if (u > umax) umax = u;
      if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
    let cell = P.cell;
    const maxCells = 16e6;
    const est = ((umax - umin) / cell + 1) * ((vmax - vmin) / cell + 1);
    if (est > maxCells) cell *= Math.sqrt(est / maxCells);
    const gw = Math.floor((umax - umin) / cell) + 1, gh = Math.floor((vmax - vmin) / cell) + 1;
    const grid = new Grid(gw, gh);
    const cellOf = new Int32Array(pts.length);
    pts.forEach((k, idx) => {
      const u = pos[k * 3] * U[0] + pos[k * 3 + 1] * U[1] + pos[k * 3 + 2] * U[2];
      const v = pos[k * 3] * V[0] + pos[k * 3 + 1] * V[1] + pos[k * 3 + 2] * V[2];
      const ci = Math.min(gw - 1, Math.floor((u - umin) / cell)), cj = Math.min(gh - 1, Math.floor((v - vmin) / cell));
      grid.set(ci, cj);
      cellOf[idx] = cj * gw + ci;
    });
    const closed = close(grid);
    fixDiagonals(closed);
    const comp = components(closed, false);
    const cellArea = cell * cell;
    // per-component stats from primary points of this plane
    const st = new Float64Array((comp.count + 1) * 4); // count, sum dev², max |dev|, over
    pts.forEach((k, idx) => {
      if (primary[k] !== pid) return;
      const l = comp.labels[cellOf[idx]];
      if (!l) return;
      const d = deviation[k];
      const o = l * 4;
      st[o]++; st[o + 1] += d * d;
      if (Math.abs(d) > st[o + 2]) st[o + 2] = Math.abs(d);
      if (Math.abs(d) > tol) st[o + 3]++;
    });
    // bounding boxes per component
    const bb = new Int32Array((comp.count + 1) * 4).fill(-1);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const l = comp.labels[j * gw + i];
        if (!l) continue;
        const o = l * 4;
        if (bb[o] < 0) { bb[o] = i; bb[o + 1] = j; bb[o + 2] = i; bb[o + 3] = j; }
        else {
          if (i < bb[o]) bb[o] = i; if (j < bb[o + 1]) bb[o + 1] = j;
          if (i > bb[o + 2]) bb[o + 2] = i; if (j > bb[o + 3]) bb[o + 3] = j;
        }
      }
    }
    for (let l = 1; l <= comp.count; l++) {
      if (comp.sizes[l] * cellArea < P.minArea || st[l * 4] < Math.min(P.minPoints, 50)) continue;
      const i0 = bb[l * 4], j0 = bb[l * 4 + 1], i1 = bb[l * 4 + 2], j1 = bb[l * 4 + 3];
      const mw = i1 - i0 + 3, mh = j1 - j0 + 3; // 1-cell empty border
      let mask = new Grid(mw, mh);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (comp.labels[j * gw + i] === l) mask.set(i - i0 + 1, j - j0 + 1);
      mask = fillSmallHoles(mask, Math.floor(P.minHole / cellArea));
      fixDiagonals(mask);
      const loops = traceLoops(mask).map((lp) => simplifyLoop(lp, 0.75));
      const toMetres = (lp: number[]) => lp.map((val, idx) => (idx % 2 === 0 ? umin + (val + i0 - 1) * cell : vmin + (val + j0 - 1) * cell));
      let outer: number[] | null = null, outerArea = 0;
      const holes: number[][] = [];
      for (const lp of loops) {
        const a = loopArea(lp);
        if (a > 0) { if (a > outerArea) { if (outer) holes.push(outer); outer = lp; outerArea = a; } }
        else holes.push(lp);
      }
      if (!outer) continue;
      const holeArea = holes.reduce((s, h) => s + Math.abs(loopArea(h)), 0);
      const area = (outerArea - holeArea) * cellArea;
      if (area < P.minArea) continue;
      const c = st[l * 4];
      regions.push({
        id: regions.length,
        planeIndex: pid,
        axis: pl.axis,
        normal: [...N] as V3,
        offset: pl.offset,
        U: [...U] as V3,
        V: [...V] as V3,
        outer: toMetres(outer),
        holes: holes.filter((h) => loopArea(h) < 0).map(toMetres),
        area,
        points: c,
        rms: c ? Math.sqrt(st[l * 4 + 1] / c) : 0,
        maxDev: st[l * 4 + 2],
        pctOver: c ? (st[l * 4 + 3] / c) * 100 : 0,
      });
    }
  });

  return {
    rotationDeg,
    rotationAuto,
    axes,
    planes,
    regions,
    deviation,
    stats: { points: n, planarVoxels, voxels: nv, seconds: (performance.now() - t0) / 1000 },
  };
}
