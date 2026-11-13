import * as THREE from 'three';
import { Viewer } from './viewer/Viewer';
import { PointLayer, type ColourMode, type UpAxis } from './viewer/PointLayer';
import { ModelLayer } from './viewer/ModelLayer';
import { SectionBox } from './viewer/SectionBox';
import { Measurements, Picker } from './viewer/Picker';
import type { WorkerIn, WorkerOut, Vec3 } from './io/xyzTypes';
import type { Detection } from './io/xyzParse';
import { UNIT_TO_METRES, formatLength, type DisplayUnit, type Unit } from './io/units';
import { PlaneLayer } from './viewer/PlaneLayer';
import { PlanePanel } from './ui/PlanePanel';
import { DEFAULT_PARAMS, type PlaneParams, type PlaneWorkerIn, type PlaneWorkerOut, type Region } from './analysis/types';
import { exportPlanesJSON } from './analysis/exportPlanes';

const MAX_FIT_POINTS = 4_000_000;

export interface AppState {
  budgetM: number;
  columns: string;
  detected: string;
  scan: { visible: boolean; size: number; worldSize: boolean; colour: ColourMode; unit: Unit; up: UpAxis; round: boolean };
  model: {
    visible: boolean; opacity: number; wireframe: boolean; doubleSided: boolean; unit: Unit; up: UpAxis;
    rotation: number; placeX: number; placeY: number; placeZ: number;
  };
  view: { grid: boolean; bboxes: boolean };
  clip: { enabled: boolean; handles: boolean; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  measure: { mode: boolean; unit: DisplayUnit };
  planes: {
    show: boolean; opacity: number; deviation: boolean; rotationFound: string; rotationOverride: string;
    toleranceIn: number; voxelCm: number; angleDeg: number; bandIn: number; minArea: number; minHole: number;
    cellCm: number; minPoints: number;
  };
}

type ClickMode = 'inspect' | 'measure' | 'placeModel';

export class App {
  readonly viewer: Viewer;
  readonly scan = new PointLayer();
  readonly model = new ModelLayer();
  readonly section: SectionBox;
  readonly picker: Picker;
  readonly measurements: Measurements;
  readonly state: AppState = {
    budgetM: 10,
    columns: '',
    detected: '—',
    scan: { visible: true, size: 2, worldSize: false, colour: 'rgb', unit: 'm', up: 'Z', round: false },
    model: { visible: true, opacity: 0.6, wireframe: false, doubleSided: true, unit: 'ft', up: 'Y', rotation: 0, placeX: 0, placeY: 0, placeZ: 0 },
    view: { grid: true, bboxes: false },
    clip: { enabled: false, handles: true, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
    measure: { mode: false, unit: 'ft-in' },
    planes: {
      show: true, opacity: 0.55, deviation: false, rotationFound: '—', rotationOverride: '',
      toleranceIn: 1, voxelCm: 5, angleDeg: 10, bandIn: 3, minArea: 0.25, minHole: 0.1, cellCm: 5, minPoints: 200,
    },
  };
  readonly planes = new PlaneLayer();
  readonly planePanel: PlanePanel;
  private planeWorker: Worker | null = null;
  private raycaster = new THREE.Raycaster();

  /** Called when state changes outside the panel (load finished, etc.). */
  onStateChanged: (() => void) | null = null;

  scanFile: File | null = null;
  scanInfo: { totalPoints: number; detection: Detection | null; preview: string[]; seconds: number } = {
    totalPoints: 0, detection: null, preview: [], seconds: 0,
  };
  private worker: Worker | null = null;
  private clickMode: ClickMode = 'inspect';
  private placementEdited = false;
  private scanBoxHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x40c0ff));
  private modelBoxHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xff60c0));
  private firstFitDone = false;

  constructor(container: HTMLElement) {
    this.viewer = new Viewer(container);
    this.viewer.content.add(this.scan.group, this.model.group);
    this.section = new SectionBox(this.viewer);
    this.section.onChange = () => this.syncClipState();
    this.picker = new Picker(this.viewer);
    this.picker.setPointPickMode.push((on) => this.scan.setPickMode(on));
    this.measurements = new Measurements(this.viewer);
    this.measurements.unit = this.state.measure.unit;
    this.scanBoxHelper.visible = this.modelBoxHelper.visible = false;
    this.viewer.helpers.add(this.scanBoxHelper, this.modelBoxHelper);
    this.model.sourceToWorld = (p) => this.scanSourceToWorld(p);
    this.viewer.content.add(this.planes.group);
    this.planePanel = new PlanePanel((id) => this.selectRegion(id), (id) => this.deleteRegion(id));

    this.viewer.beforeRender.push(() => {
      const pr = this.viewer.renderer.getPixelRatio();
      const h = this.viewer.renderer.domElement.height;
      const cam = this.viewer.camera;
      if (this.state.scan.worldSize) {
        // size given in centimetres in world space
        this.scan.material.uniforms.uSize.value = this.state.scan.size / 100;
        this.scan.material.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
      } else {
        this.scan.material.uniforms.uSize.value = this.state.scan.size * pr;
      }
      this.planes.setPointSize(Math.max(this.state.scan.size, 2) * pr);
    });

    this.installPointerHandling();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.measurements.cancelPending();
        this.section.deselect();
        if (this.clickMode === 'placeModel') this.setClickMode(this.state.measure.mode ? 'measure' : 'inspect');
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if ((e.key === 'Delete' || e.key === 'Backspace') && tag !== 'INPUT' && tag !== 'TEXTAREA' && this.planes.selected >= 0) {
        this.deleteRegion(this.planes.selected);
      }
    });
  }

  // ------------------------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------------------------

  loadScan(file: File) {
    this.scanFile = file;
    this.worker?.terminate();
    const worker = new Worker(new URL('./io/xyzWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.status(`Reading ${file.name} (${(file.size / 1e6).toFixed(0)} MB)…`, 0);
    let hadPreview = false;
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (worker !== this.worker) return;
      switch (m.type) {
        case 'detected':
          this.state.detected = m.detection.tokens + (m.detection.guessed ? '  (guessed)' : '');
          if (!this.state.columns) this.state.columns = '';
          this.scanInfo.detection = m.detection;
          this.onStateChanged?.();
          this.status(`Columns: ${m.detection.tokens}${m.detection.guessed ? ' (guessed, check it)' : ''} · ~${fmtCount(m.estimatedPoints)} points estimated · keeping up to ${fmtCount(m.capacity)}`, 0);
          break;
        case 'progress': {
          const f = m.bytesRead / m.total;
          this.status(`Reading ${file.name}: ${(f * 100).toFixed(0)}% · ${fmtCount(m.pointsSeen)} points`, f);
          break;
        }
        case 'preview':
          this.scan.setData(m.buffers, m.origin, m.bounds, m.intensityRange);
          if (!hadPreview) { hadPreview = true; this.afterScanGeometry(); } else this.viewer.requestRender();
          break;
        case 'done':
          this.scan.setData(m.buffers, m.origin, m.bounds, m.intensityRange);
          this.scanInfo = { totalPoints: m.totalPoints, detection: m.detection, preview: m.preview, seconds: m.seconds };
          this.state.detected = m.detection.tokens + (m.detection.guessed ? '  (guessed)' : '');
          if (!this.scan.hasRgb && this.state.scan.colour === 'rgb') this.state.scan.colour = this.scan.hasIntensity ? 'intensity' : 'height';
          if (this.scan.hasRgb && this.state.scan.colour !== 'rgb' && !hadPreview) this.state.scan.colour = 'rgb';
          this.applyScanStyle();
          this.afterScanGeometry();
          worker.terminate();
          this.worker = null;
          {
            const kept = m.buffers.count;
            const notes = m.detection.notes.length ? ` · ${m.detection.notes.join('; ')}` : '';
            const skipped = m.skippedLines + m.rejectedLines;
            this.status(
              `${file.name}: ${fmtCount(m.totalPoints)} points read, ${fmtCount(kept)} displayed` +
                `${kept < m.totalPoints ? ` (${((kept / m.totalPoints) * 100).toFixed(1)}% sample)` : ''}` +
                ` · ${m.seconds.toFixed(1)} s · columns: ${m.detection.tokens}${skipped ? ` · ${skipped} lines skipped` : ''}${notes}`,
              1,
              true,
            );
          }
          this.onStateChanged?.();
          break;
        case 'error':
          this.status(`Error loading ${file.name}: ${m.message}`, 0, true);
          worker.terminate();
          this.worker = null;
          break;
      }
    };
    worker.onerror = (e) => this.status(`Worker error: ${e.message}`, 0, true);
    const msg: WorkerIn = { type: 'load', file, budget: Math.round(this.state.budgetM * 1e6), tokens: this.state.columns || undefined };
    worker.postMessage(msg);
  }

  reloadScan() {
    if (this.scanFile) this.loadScan(this.scanFile);
  }

  private afterScanGeometry() {
    this.applyScanStyle();
    if (!this.placementEdited && this.model.loaded) this.defaultPlacement();
    this.model.applyTransform();
    this.updateBounds();
    if (!this.firstFitDone) {
      this.firstFitDone = true;
      this.fit(false);
      this.section.fitTo(this.viewer.contentBox());
    }
    hideHint();
    this.viewer.requestRender();
  }

  async loadModel(file: File) {
    try {
      this.status(`Reading ${file.name}…`, 0);
      const text = await file.text();
      const json = JSON.parse(text);
      this.model.load(json, file.name);
      this.placementEdited = false;
      this.defaultPlacement();
      const ud = json?.object?.userData;
      if (ud?.pdgPlanes) {
        // Exported planes carry real-world coordinates in the scan's frame: put them straight back.
        Object.assign(this.state.model, { unit: ud.units, up: ud.upAxis, rotation: 0, placeX: 0, placeY: 0, placeZ: 0 });
        this.placementEdited = true;
      }
      this.applyModelStyle();
      this.applyModelTransform();
      if (!this.scan.loaded || !this.firstFitDone) { this.firstFitDone = true; this.fit(false); this.section.fitTo(this.viewer.contentBox()); }
      const b = this.model.modelBox;
      const size = b.getSize(new THREE.Vector3());
      this.status(`${file.name}: model loaded · size ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} ${this.state.model.unit}`, 1, true);
      hideHint();
      this.onStateChanged?.();
    } catch (err) {
      this.status(`Could not load ${file.name}: ${err instanceof Error ? err.message : err}`, 0, true);
    }
  }

  /**
   * Default model placement: if the model's coordinates are already huge (real-world / survey
   * coordinates), put its origin at the scan's (0,0,0); otherwise put it at the scan origin.
   */
  private defaultPlacement() {
    const b = this.model.modelBox;
    const c = b.getCenter(new THREE.Vector3()).multiplyScalar(UNIT_TO_METRES[this.state.model.unit]);
    const realWorld = c.length() > 20_000;
    const o: Vec3 = realWorld || !this.scan.loaded ? [0, 0, 0] : this.scan.origin;
    this.state.model.placeX = o[0];
    this.state.model.placeY = o[1];
    this.state.model.placeZ = o[2];
    this.model.placeAt = o;
  }

  // ------------------------------------------------------------------------------------------
  // Styling / transforms
  // ------------------------------------------------------------------------------------------

  applyScanStyle() {
    const s = this.state.scan;
    this.scan.group.visible = s.visible && !(this.state.planes.deviation && this.planes.hasResult);
    this.scan.setColourMode(s.colour);
    this.scan.setAttenuate(s.worldSize);
    this.scan.setRound(s.round);
    this.viewer.requestRender();
  }

  applyScanTransform() {
    this.scan.unit = this.state.scan.unit;
    this.scan.up = this.state.scan.up;
    this.scan.applyTransform();
    this.model.applyTransform(); // placement depends on the scan transform
    this.updateBounds();
    this.viewer.requestRender();
  }

  applyModelStyle() {
    const s = this.state.model;
    this.model.group.visible = s.visible;
    this.model.setOpacity(s.opacity);
    this.model.setWireframe(s.wireframe);
    this.model.setDoubleSided(s.doubleSided);
    this.viewer.requestRender();
  }

  applyModelTransform(fromUser = false) {
    const s = this.state.model;
    if (fromUser) this.placementEdited = true;
    this.model.unit = s.unit;
    this.model.up = s.up;
    this.model.rotationDeg = s.rotation;
    this.model.placeAt = [s.placeX, s.placeY, s.placeZ];
    this.model.applyTransform();
    this.updateBounds();
    this.viewer.requestRender();
  }

  /** Scan file coordinates -> world. Without a scan there is no reference, so the model sits at the world origin. */
  scanSourceToWorld(p: Vec3): THREE.Vector3 {
    return this.scan.loaded ? this.scan.sourceToWorld(p) : new THREE.Vector3();
  }

  updateBounds() {
    const sb = this.scan.getWorldBox();
    const mb = this.model.loaded ? this.model.getWorldBox() : null;
    if (sb) this.scanBoxHelper.box.copy(sb);
    if (mb) this.modelBoxHelper.box.copy(mb);
    this.scanBoxHelper.visible = this.state.view.bboxes && !!sb;
    this.modelBoxHelper.visible = this.state.view.bboxes && !!mb;
    const all = this.viewer.contentBox();
    if (!all.isEmpty()) {
      this.viewer.setSceneRadius(all.getBoundingSphere(new THREE.Sphere()).radius);
      this.viewer.setGridY(sb ? sb.min.y : all.min.y);
    }
    const grid = this.viewer.helpers.getObjectByName('grid');
    if (grid) grid.visible = this.state.view.grid;
    this.viewer.requestRender();
  }

  fit(keepDirection = true) {
    const box = this.section.enabled ? this.section.box.clone().intersect(this.viewer.contentBox()) : this.viewer.contentBox();
    this.viewer.fitTo(box.isEmpty() ? this.viewer.contentBox() : box, keepDirection);
  }

  // ------------------------------------------------------------------------------------------
  // Section box
  // ------------------------------------------------------------------------------------------

  syncClipState() {
    const b = this.section.box, c = this.state.clip;
    c.minX = b.min.x; c.maxX = b.max.x; c.minY = b.min.y; c.maxY = b.max.y; c.minZ = b.min.z; c.maxZ = b.max.z;
  }

  setSectionEnabled(on: boolean) {
    this.state.clip.enabled = on;
    if (on && this.section.box.isEmpty()) this.section.fitTo(this.viewer.contentBox());
    this.section.setEnabled(on);
  }

  resetSection() {
    this.section.fitTo(this.viewer.contentBox());
  }

  // ------------------------------------------------------------------------------------------
  // Clicking: inspect / measure / place model
  // ------------------------------------------------------------------------------------------

  setClickMode(mode: ClickMode) {
    this.clickMode = mode;
    if (mode !== 'measure') this.measurements.cancelPending();
    document.body.classList.toggle('measuring', mode !== 'inspect');
  }

  startPlaceModel() {
    if (!this.model.loaded) { this.status('Load a model first.', 0, true); return; }
    if (!this.scan.loaded) { this.status('Load a scan first; the model origin is placed on a scan point.', 0, true); return; }
    this.setClickMode('placeModel');
    this.status('Click a scan point to put the model origin (0,0,0) there. Esc to cancel.', 0, true);
  }

  private installPointerHandling() {
    const canvas = this.viewer.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      if (this.section.hitHandle(e.clientX, e.clientY) >= 0) return;
      this.handleClick(e.clientX, e.clientY);
    });
  }

  handleClick(clientX: number, clientY: number): THREE.Vector3 | null {
    if (this.clickMode === 'inspect' && this.planes.hasResult && this.state.planes.show) {
      const rect = this.viewer.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.viewer.camera);
      const id = this.planes.hit(this.raycaster);
      // only take plane hits that are not hidden by the section box
      const hitPoint = id >= 0 ? this.raycaster.intersectObject(this.planes.meshes.get(id)!, false)[0]?.point : null;
      if (id >= 0 && hitPoint && (!this.section.enabled || this.section.box.containsPoint(hitPoint))) {
        this.selectRegion(id);
        return hitPoint;
      }
    }
    const p = this.picker.pick(clientX, clientY);
    if (!p) {
      if (this.clickMode === 'inspect') this.section.deselect();
      this.readout(null);
      return null;
    }
    if (this.clickMode === 'measure') {
      const d = this.measurements.addPoint(p);
      this.readout(p, d);
    } else if (this.clickMode === 'placeModel') {
      const src = this.scan.worldToSource(p);
      this.state.model.placeX = src[0];
      this.state.model.placeY = src[1];
      this.state.model.placeZ = src[2];
      this.applyModelTransform(true);
      this.setClickMode(this.state.measure.mode ? 'measure' : 'inspect');
      this.status(`Model origin placed at ${src.map((v) => v.toFixed(3)).join(', ')} (scan coordinates).`, 1, true);
      this.onStateChanged?.();
    } else {
      this.readout(p);
    }
    return p;
  }

  // ------------------------------------------------------------------------------------------
  // Plane fitting
  // ------------------------------------------------------------------------------------------

  planeParams(): PlaneParams {
    const s = this.state.planes;
    const ov = s.rotationOverride.trim();
    const rot = ov === '' || ov.toLowerCase() === 'auto' ? null : Number(ov);
    return {
      ...DEFAULT_PARAMS,
      tolerance: s.toleranceIn * 0.0254,
      voxel: s.voxelCm / 100,
      angleDeg: s.angleDeg,
      band: Math.max(s.bandIn, s.toleranceIn) * 0.0254,
      minArea: s.minArea,
      minHole: s.minHole,
      cell: s.cellCm / 100,
      minPoints: s.minPoints,
      rotationDeg: rot != null && Number.isFinite(rot) ? rot : null,
    };
  }

  /** Collect displayed points (inside the section box when enabled) in world metres. */
  private collectFitPoints(): Float32Array | null {
    const src = this.scan.getPositions();
    if (!src) return null;
    const m = this.scan.group.matrixWorld.elements;
    const box = this.section.enabled ? this.section.box : null;
    const n = src.length / 3;
    const inside = (k: number, out: number[]) => {
      const x = src[k * 3], y = src[k * 3 + 1], z = src[k * 3 + 2];
      out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      return !box || (out[0] >= box.min.x && out[0] <= box.max.x && out[1] >= box.min.y && out[1] <= box.max.y && out[2] >= box.min.z && out[2] <= box.max.z);
    };
    const tmp = [0, 0, 0];
    let count = 0;
    for (let k = 0; k < n; k++) if (inside(k, tmp)) count++;
    if (count === 0) return new Float32Array(0);
    const stride = Math.max(1, Math.ceil(count / MAX_FIT_POINTS));
    const out = new Float32Array(Math.ceil(count / stride) * 3);
    let seen = 0, w = 0;
    for (let k = 0; k < n; k++) {
      if (!inside(k, tmp)) continue;
      if (seen++ % stride !== 0) continue;
      out[w++] = tmp[0]; out[w++] = tmp[1]; out[w++] = tmp[2];
    }
    return out.subarray(0, w).slice();
  }

  fitPlanes(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.scan.loaded) { this.status('Load a scan first.', 0, true); resolve(); return; }
      const positions = this.collectFitPoints();
      if (!positions || positions.length < 30) {
        this.status('No points inside the section box.', 0, true); resolve(); return;
      }
      const params = this.planeParams();
      this.planeWorker?.terminate();
      const worker = new Worker(new URL('./analysis/planeWorker.ts', import.meta.url), { type: 'module' });
      this.planeWorker = worker;
      const scope = this.section.enabled ? 'inside the section box' : 'in the whole scan';
      const t0 = performance.now();
      this.status(`Fitting planes to ${fmtCount(positions.length / 3)} points ${scope}…`, 0.05);
      worker.onmessage = (e: MessageEvent<PlaneWorkerOut>) => {
        const m = e.data;
        if (worker !== this.planeWorker) return;
        if (m.type === 'progress') { this.status(`Fitting planes: ${m.stage}…`, 0.5); return; }
        worker.terminate();
        this.planeWorker = null;
        if (m.type === 'error') { this.status(`Plane fitting failed: ${m.message}`, 0, true); resolve(); return; }
        const r = m.result;
        this.planes.setResult(r, m.positions, params.tolerance);
        this.state.planes.rotationFound = `${r.rotationDeg.toFixed(3)}°${r.rotationAuto ? ' (auto)' : ' (manual)'}`;
        this.applyPlaneDisplay();
        this.refreshPlanePanel();
        this.planePanel.show();
        const over = r.regions.filter((g) => g.pctOver > 0).length;
        this.status(
          `${r.planes.length} planes, ${r.regions.length} regions from ${fmtCount(r.stats.points)} points ${scope} · ` +
            `rotation ${r.rotationDeg.toFixed(2)}° · ${over} region${over === 1 ? '' : 's'} with points over ${formatLength(params.tolerance, this.state.measure.unit)} · ` +
            `${((performance.now() - t0) / 1000).toFixed(1)} s`,
          1,
          true,
        );
        this.onStateChanged?.();
        resolve();
      };
      worker.onerror = (e) => { this.status(`Plane worker error: ${e.message}`, 0, true); resolve(); };
      const msg: PlaneWorkerIn = { type: 'fit', positions, params };
      worker.postMessage(msg, [positions.buffer]);
    });
  }

  applyPlaneDisplay() {
    const s = this.state.planes;
    this.planes.setShowPlanes(s.show);
    this.planes.setOpacity(s.opacity);
    this.planes.setShowDeviation(s.deviation);
    // the deviation view replaces the scan display
    this.scan.group.visible = this.state.scan.visible && !(s.deviation && this.planes.hasResult);
    this.viewer.requestRender();
  }

  /**
   * Position text for the list: elevation for horizontal planes (scan units); for walls, the
   * spacing from the first wall on the same axis (so wall-to-wall distances read directly).
   */
  private regionPosition(r: Region): string {
    const u = this.state.scan.unit;
    const toUnits = (m: number) => (m / UNIT_TO_METRES[this.scan.unit]).toFixed(3);
    if (r.axis === 1) {
      if (!this.scan.loaded) return `elev ${r.offset.toFixed(3)} m`;
      const p = this.scan.worldToSource(new THREE.Vector3(...r.normal).multiplyScalar(r.offset));
      const up = this.state.scan.up === 'Z' ? 2 : 1;
      return `elev ${p[up].toFixed(3)} ${u}`;
    }
    const first = Math.min(...this.planes.regions.filter((g) => g.axis === r.axis).map((g) => g.offset));
    return `${r.axis === 0 ? 'A1' : 'A3'} +${toUnits(r.offset - first)} ${u}`;
  }

  refreshPlanePanel() {
    this.planePanel.render(
      this.planes.regions,
      this.planes.selected,
      (v) => formatLength(v, this.state.measure.unit),
      (r) => this.regionPosition(r),
      this.planeParams().tolerance,
    );
  }

  selectRegion(id: number) {
    this.planes.select(id);
    this.refreshPlanePanel();
    const r = this.planes.regions.find((g) => g.id === id);
    if (r) {
      const f = (v: number) => formatLength(v, this.state.measure.unit);
      const el = document.getElementById('pick-readout')!;
      el.textContent = [
        `Region ${r.id} · ${r.axis === 1 ? 'horizontal' : 'vertical'} · ${this.regionPosition(r)}`,
        `Area ${r.area.toFixed(2)} m² · ${r.holes.length} opening${r.holes.length === 1 ? '' : 's'}`,
        `RMS ${f(r.rms)} · max ${f(r.maxDev)} · ${r.pctOver.toFixed(1)}% over tolerance`,
      ].join('\n');
      el.classList.add('visible');
    }
    this.viewer.requestRender();
  }

  deleteRegion(id: number) {
    this.planes.remove(id);
    this.refreshPlanePanel();
    document.getElementById('pick-readout')?.classList.remove('visible');
    this.viewer.requestRender();
  }

  exportPlanes(): string | null {
    if (!this.planes.hasResult || !this.planes.regions.length) { this.status('Nothing to export: fit planes first.', 0, true); return null; }
    const json = exportPlanesJSON(this.planes.regions, this.scan, {
      source: this.scanFile?.name ?? 'scan',
      tolerance: this.planeParams().tolerance,
      rotationDeg: this.planes.result!.rotationDeg,
    });
    const text = JSON.stringify(json);
    const base = (this.scanFile?.name ?? 'scan').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `${base}-planes.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    this.status(`Exported ${this.planes.regions.length} regions to ${a.download} (three.js JSON, ${this.state.scan.unit}, real-world coordinates).`, 1, true);
    return text;
  }

  private readout(p: THREE.Vector3 | null, distance: number | null = null) {
    const el = document.getElementById('pick-readout')!;
    if (!p) { el.classList.remove('visible'); return; }
    const lines: string[] = [];
    if (this.scan.loaded) {
      const s = this.scan.worldToSource(p);
      lines.push(`Scan  X ${s[0].toFixed(3)}  Y ${s[1].toFixed(3)}  Z ${s[2].toFixed(3)}  (${this.state.scan.unit})`);
    }
    if (this.model.loaded) {
      const inv = this.model.group.matrixWorld.clone().invert();
      const m = p.clone().applyMatrix4(inv);
      lines.push(`Model X ${m.x.toFixed(3)}  Y ${m.y.toFixed(3)}  Z ${m.z.toFixed(3)}  (${this.state.model.unit})`);
    }
    if (!lines.length) lines.push(`World ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)} m`);
    if (distance != null) lines.push(`Distance ${formatLength(distance, this.state.measure.unit)}`);
    else if (this.clickMode === 'measure' && this.measurements.pending) lines.push('Click the second point…');
    el.textContent = lines.join('\n');
    el.classList.add('visible');
  }

  status(text: string, progress: number, sticky = false) {
    const box = document.getElementById('status')!;
    document.getElementById('status-text')!.textContent = text;
    (document.getElementById('progress-bar') as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
    document.getElementById('progress')!.style.display = sticky ? 'none' : 'block';
    box.classList.add('visible');
  }
}

function hideHint() {
  document.getElementById('drop-hint')?.classList.add('hidden');
}

export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
