/**
 * End-to-end test of orthogonal plane fitting.
 *   node scripts/gen-sample.mjs --points 1500000 --out samples-planes --rotate 17 --window --step --offset-half --bulge
 *   npm run build && npx vite preview --port 4173 &
 *   node e2e/planes.cjs [url] [samplesDir]
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const url = process.argv[2] || 'http://localhost:4173/';
const samples = path.resolve(process.argv[3] || 'samples-planes');
const shots = path.resolve('e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('ok  -', msg);
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);

  await page.setInputFiles('#file-xyz', path.join(samples, 'room.xyz'));
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('displayed'), null, { timeout: 120000 });

  // Section box around everything, then fit.
  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    app.setSectionEnabled(true);
    app.resetSection();
    await app.fitPlanes();
    const r = app.planes.result;
    return {
      rotation: r.rotationDeg,
      planes: r.planes.map((p) => [p.axis, p.offset]),
      regions: r.regions.map((g) => ({ id: g.id, axis: g.axis, area: g.area, holes: g.holes.length, pctOver: g.pctOver, maxDev: g.maxDev })),
      status: document.getElementById('status-text').textContent,
      points: r.stats.points,
    };
  });
  console.log('    ' + res.status);
  console.log(`    fit wall time ${((Date.now() - t0) / 1000).toFixed(1)} s for ${res.points} points`);
  assert(Math.abs(Math.abs(res.rotation) - 17) < 0.2, `building rotation ≈ 17° (got ${res.rotation.toFixed(3)})`);
  assert(res.planes.length === 11, `11 planes: floor, ceiling, merged west wall, 2-plane stepped east wall, south, north, 4 column faces (got ${res.planes.length})`);
  const windowRegion = res.regions.find((g) => g.axis !== 1 && g.holes === 1 && g.area > 20);
  assert(!!windowRegion, 'south wall region keeps the window as one hole');
  const bulged = res.regions.filter((g) => g.pctOver > 0);
  assert(bulged.length >= 1 && bulged.some((g) => g.maxDev > 0.03 && g.maxDev < 0.043), `bulge flagged (max dev ${bulged.map((g) => (g.maxDev * 1000).toFixed(1) + ' mm').join(', ')})`);
  const rows = await page.$$eval('#plane-panel tbody tr', (trs) => trs.length);
  assert(rows === res.regions.length, `plane list shows ${rows} rows`);

  await page.evaluate(() => { app.setSectionEnabled(false); app.fit(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '5-planes.png') });

  // Deviation view
  await page.evaluate(() => { app.state.planes.deviation = true; app.applyPlaneDisplay(); app.state.planes.show = false; app.applyPlaneDisplay(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '6-deviation.png') });
  await page.evaluate(() => { app.state.planes.deviation = false; app.state.planes.show = true; app.applyPlaneDisplay(); });

  // Select by clicking the centre of the ceiling region on screen, then delete it.
  const clicked = await page.evaluate(() => {
    const v = app.viewer;
    const ceiling = app.planes.regions.filter((r) => r.axis === 1).sort((a, b) => b.offset - a.offset)[0];
    const mesh = app.planes.meshes.get(ceiling.id);
    const box = new (v.contentBox().constructor)().setFromObject(mesh);
    const c = box.getCenter(new (v.camera.position.constructor)());
    const p = c.clone().project(v.camera);
    const rect = v.renderer.domElement.getBoundingClientRect();
    app.handleClick(rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height);
    return { selected: app.planes.selected, expected: ceiling.id };
  });
  assert(clicked.selected === clicked.expected, `clicking the ceiling selects region ${clicked.expected}`);
  await page.keyboard.press('Delete');
  const left = await page.evaluate(() => app.planes.regions.length);
  assert(left === res.regions.length - 1, 'Delete key removes the selected region');

  // Export and reload as a model
  const exported = await page.evaluate(() => app.exportPlanes());
  const json = JSON.parse(exported);
  assert(json.object.userData.pdgPlanes === 1 && json.object.children.length === left, `export has ${json.object.children.length} meshes with metadata`);
  const m = json.object.matrix;
  assert(Math.abs(m[12] - 512000) < 50 && Math.abs(m[13] - 5650000) < 50, 'export carries real-world origin in the group matrix');
  const tmp = path.join(os.tmpdir(), 'room-planes.json');
  fs.writeFileSync(tmp, exported);
  await page.setInputFiles('#file-json', tmp);
  await page.waitForFunction(() => app.model.loaded);
  const cmp = await page.evaluate(() => {
    const B = app.viewer.contentBox().constructor;
    const pb = new B();
    for (const mesh of app.planes.meshes.values()) pb.expandByObject(mesh, true);
    const mb = app.model.getWorldBox();
    return { d: Math.max(pb.min.distanceTo(mb.min), pb.max.distanceTo(mb.max)), unit: app.state.model.unit, up: app.state.model.up };
  });
  assert(cmp.d < 0.01, `reloaded export overlays the fitted planes (max corner error ${(cmp.d * 1000).toFixed(2)} mm, ${cmp.unit}, ${cmp.up}-up)`);
  await page.evaluate(() => { app.state.planes.show = false; app.applyPlaneDisplay(); app.state.model.opacity = 0.8; app.applyModelStyle(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '7-export-reloaded.png') });

  assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
