import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Viewer } from './Viewer';

type Face = { axis: 'x' | 'y' | 'z'; side: 'min' | 'max' };
const FACES: Face[] = [
  { axis: 'x', side: 'min' }, { axis: 'x', side: 'max' },
  { axis: 'y', side: 'min' }, { axis: 'y', side: 'max' },
  { axis: 'z', side: 'min' }, { axis: 'z', side: 'max' },
];

/**
 * Axis-aligned section box. Clips scan and model via the content pass clipping planes.
 * Click a face handle (sphere) to select it, then drag the arrow to move that face.
 */
export class SectionBox {
  readonly box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  enabled = false;
  showHandles = true;
  onChange: (() => void) | null = null;

  private planes = FACES.map(() => new THREE.Plane());
  private group = new THREE.Group();
  private helper: THREE.Box3Helper;
  private handles: THREE.Mesh[] = [];
  private tc: TransformControls;
  private active: number = -1;
  private raycaster = new THREE.Raycaster();

  constructor(private viewer: Viewer) {
    this.helper = new THREE.Box3Helper(this.box, new THREE.Color(0xffb020));
    this.group.add(this.helper);
    const geom = new THREE.SphereGeometry(1, 16, 12);
    FACES.forEach((f, i) => {
      const color = f.axis === 'x' ? 0xff5050 : f.axis === 'y' ? 0x50d050 : 0x5090ff;
      const m = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 10;
      m.userData.face = i;
      this.handles.push(m);
      this.group.add(m);
    });
    this.group.visible = false;
    viewer.helpers.add(this.group);

    this.tc = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tc.setSize(0.8);
    const tcHelper = this.tc.getHelper();
    viewer.helpers.add(tcHelper);
    this.tc.addEventListener('dragging-changed', (e: any) => { viewer.controls.enabled = !e.value; });
    this.tc.addEventListener('change', () => viewer.requestRender());
    this.tc.addEventListener('objectChange', () => this.onHandleMoved());

    viewer.renderer.domElement.addEventListener('pointerdown', this.onPointerDown, true);
  }

  /** Returns true if the event hit a handle (so other click tools should ignore it). */
  hitHandle(clientX: number, clientY: number): number {
    if (!this.enabled || !this.showHandles) return -1;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = this.raycaster.intersectObjects(this.handles, false);
    return hits.length ? (hits[0].object.userData.face as number) : -1;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const face = this.hitHandle(e.clientX, e.clientY);
    if (face >= 0) this.select(face);
  };

  private select(face: number) {
    this.active = face;
    const f = FACES[face];
    this.tc.attach(this.handles[face]);
    this.tc.showX = f.axis === 'x';
    this.tc.showY = f.axis === 'y';
    this.tc.showZ = f.axis === 'z';
    this.viewer.requestRender();
  }

  deselect() {
    this.tc.detach();
    this.active = -1;
    this.viewer.requestRender();
  }

  private onHandleMoved() {
    if (this.active < 0) return;
    const f = FACES[this.active];
    const v = this.handles[this.active].position[f.axis];
    const eps = 1e-3;
    if (f.side === 'min') this.box.min[f.axis] = Math.min(v, this.box.max[f.axis] - eps);
    else this.box.max[f.axis] = Math.max(v, this.box.min[f.axis] + eps);
    this.update();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.deselect();
    this.update();
  }

  setShowHandles(on: boolean) {
    this.showHandles = on;
    if (!on) this.deselect();
    this.update();
  }

  fitTo(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const pad = box.getSize(new THREE.Vector3()).multiplyScalar(0.01);
    this.box.min.copy(box.min).sub(pad);
    this.box.max.copy(box.max).add(pad);
    this.update();
  }

  /** Set one coordinate of the box (used by the numeric fields). */
  setValue(axis: 'x' | 'y' | 'z', side: 'min' | 'max', v: number) {
    this.box[side][axis] = v;
    this.update();
  }

  update() {
    const b = this.box;
    // Plane keeps points where normal·p + constant >= 0
    this.planes[0].set(new THREE.Vector3(1, 0, 0), -b.min.x);
    this.planes[1].set(new THREE.Vector3(-1, 0, 0), b.max.x);
    this.planes[2].set(new THREE.Vector3(0, 1, 0), -b.min.y);
    this.planes[3].set(new THREE.Vector3(0, -1, 0), b.max.y);
    this.planes[4].set(new THREE.Vector3(0, 0, 1), -b.min.z);
    this.planes[5].set(new THREE.Vector3(0, 0, -1), b.max.z);
    this.viewer.clipPlanes = this.enabled ? this.planes : [];

    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const r = Math.max(Math.max(size.x, size.y, size.z) * 0.012, 0.02);
    FACES.forEach((f, i) => {
      const h = this.handles[i];
      if (i !== this.active || !this.tc.dragging) {
        h.position.copy(c);
        h.position[f.axis] = b[f.side][f.axis];
      }
      h.scale.setScalar(r);
      h.visible = this.showHandles;
    });
    this.group.visible = this.enabled;
    this.tc.enabled = this.enabled && this.showHandles;
    this.onChange?.();
    this.viewer.requestRender();
  }
}
