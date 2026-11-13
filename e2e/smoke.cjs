/**
 * End-to-end smoke test against a running server (default http://localhost:4173).
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/gen-sample.mjs --points 300000 --out samples
 *   node e2e/smoke.cjs [url] [samplesDir]
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const url = process.argv[2] || 'http://localhost:4173/';
const samples = path.resolve(process.argv[3] || 'samples');
const shots = path.resolve('e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('ok  -', msg);
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);

  // ---- scan --------------------------------------------------------------------------------
  await page.setInputFiles('#file-xyz', path.join(samples, 'room.xyz'));
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent?.includes('displayed'), null, { timeout: 120000 });
  const status = await page.textContent('#status-text');
  console.log('    status:', status);
  const info = await page.evaluate(() => ({
    count: app.scan.count, hasRgb: app.scan.hasRgb, hasI: app.scan.hasIntensity,
    origin: app.scan.origin, detected: app.state.detected, colour: app.state.scan.colour,
  }));
  assert(info.count > 100000, `scan loaded (${info.count} points)`);
  assert(info.detected.startsWith('x y z i r g b'), `columns detected as "${info.detected}"`);
  assert(info.hasRgb && info.hasI, 'rgb and intensity present');
  assert(Math.abs(info.origin[0] - 512000) < 20, 'origin kept at survey scale');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '1-scan.png') });

  // ---- model -------------------------------------------------------------------------------
  await page.setInputFiles('#file-json', path.join(samples, 'room-model-ft.json'));
  await page.waitForFunction(() => app.model.loaded);
  await page.evaluate(() => {
    Object.assign(app.state.model, { placeX: 512000, placeY: 5650000, placeZ: 1040, unit: 'ft', up: 'Y' });
    app.applyModelTransform(true);
    app.state.view.bboxes = true;
    app.updateBounds();
    app.fit();
  });
  const align = await page.evaluate(() => {
    const s = app.scan.getWorldBox(), m = app.model.getWorldBox();
    return { s: [s.min.toArray(), s.max.toArray()], m: [m.min.toArray(), m.max.toArray()] };
  });
  console.log('    scan box ', JSON.stringify(align.s.map((v) => v.map((n) => +n.toFixed(3)))));
  console.log('    model box', JSON.stringify(align.m.map((v) => v.map((n) => +n.toFixed(3)))));
  // Scan's inner faces sit inside the model's walls (0.5 ft thick = 0.1524 m).
  const t = 0.1524;
  const close = (a, b, tol = 0.02) => Math.abs(a - b) < tol;
  assert(close(align.m[0][0], align.s[0][0] - t) && close(align.m[1][0], align.s[1][0] + t), 'model X extents align with scan (feet -> metres)');
  assert(close(align.m[1][1], align.s[1][1]), 'model top aligns with scan ceiling');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '2-scan-and-model.png') });

  // ---- section box -------------------------------------------------------------------------
  await page.evaluate(() => {
    app.setSectionEnabled(true);
    const b = app.scan.getWorldBox();
    app.section.setValue('y', 'max', b.min.y + 1.5); // cut at 1.5 m above floor
    app.onStateChanged();
  });
  const planes = await page.evaluate(() => app.viewer.clipPlanes.length);
  assert(planes === 6, 'section box applies 6 clipping planes');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '3-section.png') });

  // ---- measure (top-down view so floor points are visible) ---------------------------------
  const measured = await page.evaluate(async () => {
    app.state.model.visible = false; app.applyModelStyle();
    const v = app.viewer;
    const c = app.scan.getWorldBox().getCenter(new (v.camera.position.constructor)());
    v.controls.target.copy(c);
    v.camera.position.set(c.x, c.y + 12, c.z + 0.001);
    v.controls.update();
    v.requestRender();
    await new Promise((r) => setTimeout(r, 300));
    app.setClickMode('measure');
    const rect = v.renderer.domElement.getBoundingClientRect();
    const toScreen = (src) => {
      const p = app.scan.sourceToWorld(src).project(v.camera);
      return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
    };
    const a = toScreen([512001, 5650001, 1040]);
    const b = toScreen([512009, 5650001, 1040]);
    const pa = app.handleClick(a[0], a[1]);
    const pb = app.handleClick(b[0], b[1]);
    return { pa: !!pa, pb: !!pb, d: app.measurements.distances()[0] ?? null };
  });
  console.log('    measured', measured);
  assert(measured.pa && measured.pb, 'picked both points on the floor');
  assert(measured.d != null && Math.abs(measured.d - 8) < 0.1, `floor distance ≈ 8 m (got ${measured.d?.toFixed(3)})`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '4-measure.png') });

  assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch(async (e) => { console.error(e); process.exitCode = 1; process.exit(1); });
