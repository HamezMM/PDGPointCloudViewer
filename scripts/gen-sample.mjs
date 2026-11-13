#!/usr/bin/env node
/**
 * Generates a synthetic scan of a simple room plus a matching three.js JSON model, for testing.
 *
 *   node scripts/gen-sample.mjs [--points 2000000] [--out samples]
 *                               [--rotate deg] [--window] [--step] [--offset-half] [--bulge]
 *
 * Scan (.xyz): metres, Z up, survey-scale coordinates, columns "x y z intensity r g b" with a
 *              header line. Room is 10 m (X) x 8 m (Y) x 3 m (Z), its floor corner at
 *              (512000, 5650000, 1040). A 0.6 m square column stands at (4, 3)..(4.6, 3.6).
 * Model (.json): the same room in FEET, Y up (three.js convention), origin at the room corner.
 *              Place its origin at scan coordinate 512000, 5650000, 1040 to align.
 *
 * Plane-fitting test features (scan only; the model does not follow them):
 *   --rotate deg    room rotated about Z (off grid north) around the floor corner
 *   --window        1.2 x 1.0 m opening in the south wall (x 3..4.2, z 1..2)
 *   --step          north half of the east wall set back 2" (two planes expected)
 *   --offset-half   north half of the west wall set back 0.5" (one merged plane expected)
 *   --bulge         0.8 m dome on the north wall, 1.5" proud at its centre (flagged)
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const IN = 0.0254;
const ROT = (Number(args.rotate ?? 0) * Math.PI) / 180;
const N = Number(args.points ?? 2_000_000);
const outDir = args.out ?? 'samples';
fs.mkdirSync(outDir, { recursive: true });

const O = [512000, 5650000, 1040];
const W = 10, D = 8, H = 3;
const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.002; // ~2 mm

// surfaces with area weights
const surfaces = [
  { name: 'floor', area: W * D, col: [150, 140, 120], gen: () => [Math.random() * W, Math.random() * D, noise()] },
  { name: 'ceiling', area: W * D, col: [235, 235, 230], gen: () => [Math.random() * W, Math.random() * D, H + noise()] },
  { name: 'wall-s', area: W * H, col: [200, 120, 100], gen: () => {
      const x = Math.random() * W, z = Math.random() * H;
      if (args.window && x > 3 && x < 4.2 && z > 1 && z < 2) return null;
      return [x, noise(), z];
    } },
  { name: 'wall-n', area: W * H, col: [100, 160, 200], gen: () => {
      const x = Math.random() * W, z = Math.random() * H;
      let y = D + noise();
      if (args.bulge) {
        const r2 = ((x - 5) ** 2 + (z - 1.5) ** 2) / 0.16;
        if (r2 < 1) y += 1.5 * IN * (1 - r2);
      }
      return [x, y, z];
    } },
  { name: 'wall-w', area: D * H, col: [120, 190, 120], gen: () => {
      const y = Math.random() * D;
      return [noise() - (args['offset-half'] && y > D / 2 ? 0.5 * IN : 0), y, Math.random() * H];
    } },
  { name: 'wall-e', area: D * H, col: [210, 190, 90], gen: () => {
      const y = Math.random() * D;
      return [W + noise() + (args.step && y > D / 2 ? 2 * IN : 0), y, Math.random() * H];
    } },
  { name: 'column', area: 4 * 0.6 * H, col: [180, 180, 190], gen: () => {
      const t = Math.random() * 2.4, z = Math.random() * H;
      if (t < 0.6) return [4 + t, 3 + noise(), z];
      if (t < 1.2) return [4.6 + noise(), 3 + (t - 0.6), z];
      if (t < 1.8) return [4.6 - (t - 1.2), 3.6 + noise(), z];
      return [4 + noise(), 3.6 - (t - 1.8), z];
    } },
];
const total = surfaces.reduce((a, s) => a + s.area, 0);
let acc = 0;
const cdf = surfaces.map((s) => (acc += s.area / total));

const xyzPath = path.join(outDir, 'room.xyz');
const fd = fs.openSync(xyzPath, 'w');
fs.writeSync(fd, '//X Y Z Intensity R G B\n');
let buf = [];
const t0 = Date.now();
for (let k = 0; k < N; k++) {
  const u = Math.random();
  let si = 0;
  while (cdf[si] < u) si++;
  const s = surfaces[si];
  const g = s.gen();
  if (!g) { k--; continue; }
  const [x0, y0, z] = g;
  const x = x0 * Math.cos(ROT) - y0 * Math.sin(ROT), y = x0 * Math.sin(ROT) + y0 * Math.cos(ROT);
  const shade = 0.85 + Math.random() * 0.15;
  const inten = (-1800 + Math.random() * 1600).toFixed(0);
  buf.push(`${(O[0] + x).toFixed(4)} ${(O[1] + y).toFixed(4)} ${(O[2] + z).toFixed(4)} ${inten} ${Math.round(s.col[0] * shade)} ${Math.round(s.col[1] * shade)} ${Math.round(s.col[2] * shade)}`);
  if (buf.length === 100_000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
}
if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
fs.closeSync(fd);
const size = fs.statSync(xyzPath).size;
console.log(`wrote ${xyzPath}: ${N} points, ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- model in feet, Y up, origin at room corner -------------------------------------------
const FT = 1 / 0.3048;
const t = 0.5; // wall thickness, ft (outside the scanned faces)
const group = new THREE.Group();
group.name = 'Room model';
const mat = new THREE.MeshStandardMaterial({ color: 0x9db4d0, name: 'Walls' });
const box = (name, sx, sy, sz, cx, cy, cz) => {
  // args in scan frame (x east, y north, z up) in feet -> three.js Y-up: (x, z, -y)
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sz, sy), mat);
  m.name = name;
  m.position.set(cx, cz, -cy);
  group.add(m);
};
const w = W * FT, d = D * FT, h = H * FT;
box('Wall S', w + 2 * t, t, h, w / 2, -t / 2, h / 2);
box('Wall N', w + 2 * t, t, h, w / 2, d + t / 2, h / 2);
box('Wall W', t, d, h, -t / 2, d / 2, h / 2);
box('Wall E', t, d, h, w + t / 2, d / 2, h / 2);
box('Floor', w + 2 * t, d + 2 * t, t, w / 2, d / 2, -t / 2);
box('Column', 0.6 * FT, 0.6 * FT, h, 4.3 * FT, 3.3 * FT, h / 2);
group.updateMatrixWorld(true);
const jsonPath = path.join(outDir, 'room-model-ft.json');
fs.writeFileSync(jsonPath, JSON.stringify(group.toJSON()));
console.log(`wrote ${jsonPath} (feet, Y up; place origin at ${O.join(', ')})`);
