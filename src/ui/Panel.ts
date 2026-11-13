import GUI from 'lil-gui';
import type { App } from '../app';
import type { DisplayUnit, Unit } from '../io/units';

const UNITS: Record<string, Unit> = { metres: 'm', millimetres: 'mm', centimetres: 'cm', feet: 'ft', inches: 'in' };
const DISPLAY_UNITS: Record<string, DisplayUnit> = {
  "feet-inches (1/16\")": 'ft-in', feet: 'ft', inches: 'in', metres: 'm', millimetres: 'mm',
};

export function buildPanel(app: App, pickXyz: () => void, pickJson: () => void): GUI {
  const s = app.state;
  const gui = new GUI({ title: 'PDG Point Cloud Viewer', width: 320 });

  // ---- Files ------------------------------------------------------------------------------
  const files = gui.addFolder('Files');
  files.add({ load: pickXyz }, 'load').name('Load scan (.xyz)…');
  files.add({ load: pickJson }, 'load').name('Load model (three.js .json)…');
  files.add(s, 'budgetM', 1, 30, 1).name('Point budget (M)');
  files.add(s, 'detected').name('Detected columns').disable().listen();
  files.add(s, 'columns').name('Column override')
    .onFinishChange(() => { /* applied on reload */ });
  files.add({ reload: () => app.reloadScan() }, 'reload').name('Re-read scan (budget / columns)');
  const help = document.createElement('div');
  help.style.cssText = 'padding:4px 8px 8px;color:#999;font-size:11px;line-height:1.35';
  help.innerHTML = 'Override tokens, one per column: <b>x y z r g b i</b> (i = intensity), <b>_</b> = ignore. ' +
    'Example: <code>x y z i r g b</code>. Leave empty for auto-detect.';
  files.domElement.querySelector('.children')?.appendChild(help);

  // ---- Scan -------------------------------------------------------------------------------
  const scan = gui.addFolder('Scan');
  scan.add(s.scan, 'visible').name('Visible').onChange(() => app.applyScanStyle());
  const colourCtl = scan.add(s.scan, 'colour', { RGB: 'rgb', 'Height ramp': 'height', Intensity: 'intensity', 'Single colour': 'single' })
    .name('Colour').onChange(() => app.applyScanStyle()).listen();
  scan.add(s.scan, 'size', 1, 12, 0.5).name('Point size').onChange(() => app.viewer.requestRender());
  scan.add(s.scan, 'worldSize').name('Size in world (cm)').onChange(() => app.applyScanStyle());
  scan.add(s.scan, 'round').name('Round points').onChange(() => app.applyScanStyle());
  scan.add(s.scan, 'unit', UNITS).name('File units').onChange(() => app.applyScanTransform());
  scan.add(s.scan, 'up', { 'Z up (scanners)': 'Z', 'Y up': 'Y' }).name('Up axis').onChange(() => app.applyScanTransform());

  // ---- Model ------------------------------------------------------------------------------
  const model = gui.addFolder('Model');
  model.add(s.model, 'visible').name('Visible').onChange(() => app.applyModelStyle());
  model.add(s.model, 'opacity', 0.05, 1, 0.05).name('Opacity').onChange(() => app.applyModelStyle());
  model.add(s.model, 'wireframe').name('Wireframe').onChange(() => app.applyModelStyle());
  model.add(s.model, 'doubleSided').name('Double sided').onChange(() => app.applyModelStyle());
  model.add(s.model, 'unit', UNITS).name('Model units').onChange(() => app.applyModelTransform());
  model.add(s.model, 'up', { 'Y up (three.js)': 'Y', 'Z up (Revit/CAD)': 'Z' }).name('Up axis').onChange(() => app.applyModelTransform());
  model.add(s.model, 'rotation', -180, 180, 0.1).name('Rotation about up (°)').onChange(() => app.applyModelTransform(true)).listen();
  const place = model.addFolder('Model origin at scan coordinate');
  place.add(s.model, 'placeX').name('X').onFinishChange(() => app.applyModelTransform(true)).listen();
  place.add(s.model, 'placeY').name('Y').onFinishChange(() => app.applyModelTransform(true)).listen();
  place.add(s.model, 'placeZ').name('Z').onFinishChange(() => app.applyModelTransform(true)).listen();
  place.add({ pick: () => app.startPlaceModel() }, 'pick').name('Pick point in view…');
  place.close();

  // ---- View -------------------------------------------------------------------------------
  const view = gui.addFolder('View');
  view.add({ fit: () => app.fit() }, 'fit').name('Fit to content');
  view.add(s.view, 'grid').name('Grid').onChange(() => app.updateBounds());
  view.add(s.view, 'bboxes').name('Bounding boxes').onChange(() => app.updateBounds());

  // ---- Section box ------------------------------------------------------------------------
  const clip = gui.addFolder('Section box');
  clip.add(s.clip, 'enabled').name('Enabled').onChange((v: boolean) => app.setSectionEnabled(v)).listen();
  clip.add(s.clip, 'handles').name('Drag handles').onChange((v: boolean) => app.section.setShowHandles(v));
  clip.add({ reset: () => app.resetSection() }, 'reset').name('Reset to content');
  const nums = clip.addFolder('Limits (world metres, Y up)');
  (['X', 'Y', 'Z'] as const).forEach((A) => {
    const a = A.toLowerCase() as 'x' | 'y' | 'z';
    nums.add(s.clip, `min${A}` as any).name(`min ${A}`).decimals(3).listen()
      .onFinishChange((v: number) => app.section.setValue(a, 'min', v));
    nums.add(s.clip, `max${A}` as any).name(`max ${A}`).decimals(3).listen()
      .onFinishChange((v: number) => app.section.setValue(a, 'max', v));
  });
  nums.close();

  // ---- Measure ----------------------------------------------------------------------------
  const meas = gui.addFolder('Measure');
  meas.add(s.measure, 'mode').name('Measure mode (click 2 pts)').onChange((v: boolean) => app.setClickMode(v ? 'measure' : 'inspect')).listen();
  meas.add(s.measure, 'unit', DISPLAY_UNITS).name('Display units').onChange((u: DisplayUnit) => { app.measurements.setUnit(u); app.refreshPlanePanel(); });
  meas.add({ clear: () => app.measurements.clear() }, 'clear').name('Clear measurements');

  // ---- Planes -----------------------------------------------------------------------------
  const pl = gui.addFolder('Planes (orthogonal fit)');
  pl.add({ fit: () => app.fitPlanes() }, 'fit').name('Fit planes in section box');
  pl.add(s.planes, 'toleranceIn', 0.125, 4, 0.125).name('Tolerance (in)');
  pl.add(s.planes, 'rotationFound').name('Building rotation').disable().listen();
  pl.add(s.planes, 'rotationOverride').name('Rotation override (°)');
  pl.add(s.planes, 'show').name('Show planes').onChange(() => app.applyPlaneDisplay());
  pl.add(s.planes, 'opacity', 0.05, 1, 0.05).name('Plane opacity').onChange(() => app.applyPlaneDisplay());
  pl.add(s.planes, 'deviation').name('Deviation view').onChange(() => app.applyPlaneDisplay()).listen();
  pl.add({ exp: () => app.exportPlanes() }, 'exp').name('Export planes (three.js JSON)');
  const plHelp = document.createElement('div');
  plHelp.style.cssText = 'padding:4px 8px 8px;color:#999;font-size:11px;line-height:1.35';
  plHelp.innerHTML = 'Uses the section box when it is enabled, otherwise the whole scan. Deviation view: grey = on plane, ' +
    'blue/red = in/out up to the tolerance, <span style="color:#0ff">cyan</span>/<span style="color:#f0d">magenta</span> = beyond it, dark = not on any plane. ' +
    'Leave override empty for automatic rotation.';
  pl.domElement.querySelector('.children')?.appendChild(plHelp);
  const adv = pl.addFolder('Advanced');
  adv.add(s.planes, 'voxelCm', 2, 20, 1).name('Normal voxel (cm)');
  adv.add(s.planes, 'angleDeg', 2, 30, 1).name('Axis angle tol (°)');
  adv.add(s.planes, 'bandIn', 1, 12, 0.5).name('Assign band (in)');
  adv.add(s.planes, 'minArea', 0.01, 5, 0.01).name('Min region (m²)');
  adv.add(s.planes, 'minHole', 0, 2, 0.01).name('Fill holes under (m²)');
  adv.add(s.planes, 'cellCm', 1, 20, 0.5).name('Outline cell (cm)');
  adv.add(s.planes, 'minPoints', 20, 5000, 10).name('Min points / plane');
  adv.close();

  app.onStateChanged = () => {
    colourCtl.updateDisplay();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  };
  return gui;
}
