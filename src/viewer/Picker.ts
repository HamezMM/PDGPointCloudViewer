import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Viewer } from './Viewer';
import { PICK_CHUNK } from './PointLayer';
import { formatLength, type DisplayUnit } from '../io/units';

const PICK_RADIUS = 4; // px around the cursor
const PICK_SIZE = PICK_RADIUS * 2 + 1;

/**
 * GPU depth picking: renders a small window around the cursor with depth packed into RGBA, then
 * unprojects the nearest hit. Works for 10M+ points and meshes alike and respects the section box.
 */
export class Picker {
  private target = new THREE.WebGLRenderTarget(PICK_SIZE, PICK_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
  });
  private pixels = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  private depthMaterial = new THREE.ShaderMaterial({
    clipping: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_fragment>
      ${PICK_CHUNK}
      void main() {
        #include <clipping_planes_fragment>
        gl_FragColor = pdgPackDepth(gl_FragCoord.z);
      }`,
  });

  /** Hooks that switch point layers in/out of pick mode. */
  readonly setPointPickMode: Array<(on: boolean) => void> = [];

  constructor(private viewer: Viewer) {}

  /** Returns the world-space point under the cursor, or null. */
  pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const { renderer, camera, scene } = this.viewer;
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const pr = renderer.getPixelRatio();
    const fullW = Math.floor(rect.width * pr), fullH = Math.floor(rect.height * pr);
    const px = (clientX - rect.left) * pr, py = (clientY - rect.top) * pr;

    // Swap mesh materials to the depth material, hide non-mesh/non-scan objects.
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        swapped.push([m, m.material]);
        m.material = this.depthMaterial;
      } else if (((o as THREE.Line).isLine || (o as any).isSprite || ((o as THREE.Points).isPoints && (o as THREE.Points).material instanceof THREE.PointsMaterial)) && o.visible) {
        hidden.push(o);
        o.visible = false;
      }
    });
    this.setPointPickMode.forEach((f) => f(true));

    const prevBg = scene.background;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearColor(0xffffff, 1);
    camera.setViewOffset(fullW, fullH, px - PICK_RADIUS, py - PICK_RADIUS, PICK_SIZE, PICK_SIZE);
    renderer.setRenderTarget(this.target);
    renderer.clippingPlanes = this.viewer.clipPlanes;
    // Point size uniforms are in device pixels; the 1:1 pixel mapping is preserved by setViewOffset.
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(this.target, 0, 0, PICK_SIZE, PICK_SIZE, this.pixels);
    renderer.setRenderTarget(null);
    camera.clearViewOffset();

    renderer.setClearColor(prevClear, prevAlpha);
    scene.background = prevBg;
    this.setPointPickMode.forEach((f) => f(false));
    for (const [m, mat] of swapped) m.material = mat;
    for (const o of hidden) o.visible = true;
    this.viewer.requestRender();

    // Nearest hit to the centre, preferring smaller depth on ties.
    let best = -1, bestScore = Infinity, bestDepth = 1, bestX = 0, bestY = 0;
    for (let y = 0; y < PICK_SIZE; y++) {
      for (let x = 0; x < PICK_SIZE; x++) {
        const i = (y * PICK_SIZE + x) * 4;
        const d = this.pixels[i] / 255 + this.pixels[i + 1] / 65025 + this.pixels[i + 2] / 16581375 + this.pixels[i + 3] / 4228250625;
        if (d >= 0.999999) continue;
        const dx = x - PICK_RADIUS, dy = y - PICK_RADIUS;
        const score = dx * dx + dy * dy + d * 1e-3;
        if (score < bestScore) { bestScore = score; best = i; bestDepth = d; bestX = x; bestY = y; }
      }
    }
    if (best < 0) return null;
    // Render target rows are bottom-up.
    const sx = px - PICK_RADIUS + bestX + 0.5;
    const sy = py + PICK_RADIUS - bestY - 0.5;
    const ndc = new THREE.Vector3((sx / fullW) * 2 - 1, -(sy / fullH) * 2 + 1, bestDepth * 2 - 1);
    return ndc.unproject(camera);
  }
}

/** Two-point distance measurements drawn as lines with labels. */
export class Measurements {
  unit: DisplayUnit = 'ft-in';
  private group = new THREE.Group();
  private items: Array<{ a: THREE.Vector3; b: THREE.Vector3; line: THREE.Line; label: CSS2DObject; el: HTMLDivElement; markers: THREE.Points }> = [];
  private pendingStart: THREE.Vector3 | null = null;
  private pendingMarker: THREE.Points | null = null;
  private markerMat = new THREE.PointsMaterial({ color: 0xffd84a, size: 8, sizeAttenuation: false, depthTest: false });
  private lineMat = new THREE.LineBasicMaterial({ color: 0xffd84a, depthTest: false });

  constructor(private viewer: Viewer) {
    viewer.helpers.add(this.group);
  }

  get pending(): boolean { return !!this.pendingStart; }
  get count(): number { return this.items.length; }

  /** Feed a picked point. Returns the finished distance in metres when a pair completes. */
  addPoint(p: THREE.Vector3): number | null {
    if (!this.pendingStart) {
      this.pendingStart = p.clone();
      this.pendingMarker = this.marker([p]);
      this.group.add(this.pendingMarker);
      this.viewer.requestRender();
      return null;
    }
    const a = this.pendingStart, b = p.clone();
    if (this.pendingMarker) { this.group.remove(this.pendingMarker); this.pendingMarker.geometry.dispose(); }
    this.pendingStart = null; this.pendingMarker = null;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), this.lineMat);
    line.renderOrder = 20;
    const markers = this.marker([a, b]);
    const el = document.createElement('div');
    el.className = 'measure-label';
    const label = new CSS2DObject(el);
    label.position.copy(a).add(b).multiplyScalar(0.5);
    this.group.add(line, markers, label);
    this.items.push({ a, b, line, label, el, markers });
    this.refreshLabels();
    this.viewer.requestRender();
    return a.distanceTo(b);
  }

  private marker(pts: THREE.Vector3[]) {
    const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), this.markerMat);
    m.renderOrder = 21;
    return m;
  }

  setUnit(u: DisplayUnit) { this.unit = u; this.refreshLabels(); }

  refreshLabels() {
    for (const it of this.items) {
      const d = it.a.distanceTo(it.b);
      const dv = it.b.clone().sub(it.a);
      it.el.textContent = `${formatLength(d, this.unit)}  (Δh ${formatLength(Math.abs(Math.hypot(dv.x, dv.z)), this.unit)}, Δv ${formatLength(Math.abs(dv.y), this.unit)})`;
    }
    this.viewer.requestRender();
  }

  cancelPending() {
    if (this.pendingMarker) { this.group.remove(this.pendingMarker); this.pendingMarker.geometry.dispose(); }
    this.pendingStart = null; this.pendingMarker = null;
    this.viewer.requestRender();
  }

  clear() {
    this.cancelPending();
    for (const it of this.items) {
      this.group.remove(it.line, it.markers, it.label);
      it.line.geometry.dispose();
      it.markers.geometry.dispose();
      it.el.remove();
    }
    this.items = [];
    this.viewer.requestRender();
  }

  /** Distances of all completed measurements, metres (for tests / readout). */
  distances(): number[] { return this.items.map((it) => it.a.distanceTo(it.b)); }
}
