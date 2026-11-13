import * as THREE from 'three';
import { Viewer } from './viewer/Viewer';
import { PointLayer, type ColourMode, type UpAxis } from './viewer/PointLayer';
import { ModelLayer } from './viewer/ModelLayer';
import { SectionBox } from './viewer/SectionBox';
import { Measurements, Picker } from './viewer/Picker';
import type { WorkerIn, WorkerOut, Vec3 } from './io/xyzTypes';
import type { Detection } from './io/xyzParse';
import { UNIT_TO_METRES, formatLength, type DisplayUnit, type Unit } from './io/units';

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
  };

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
    });

    this.installPointerHandling();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.measurements.cancelPending();
        this.section.deselect();
        if (this.clickMode === 'placeModel') this.setClickMode(this.state.measure.mode ? 'measure' : 'inspect');
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
    this.scan.group.visible = s.visible;
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
