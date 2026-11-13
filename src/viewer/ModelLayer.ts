import * as THREE from 'three';
import { UNIT_TO_METRES, type Unit } from '../io/units';
import type { Vec3 } from '../io/xyzTypes';
import { LAYER_CONTENT } from './Viewer';
import { upRotation, type UpAxis } from './PointLayer';

interface MatState { opacity: number; transparent: boolean; wireframe: boolean; side: THREE.Side; depthWrite: boolean; }

/**
 * three.js JSON geometry (Object3D.toJSON() / ObjectLoader format, or a bare BufferGeometry JSON).
 *
 * Placement: the model's own (0,0,0) is placed at `placeAt`, given in the scan's file coordinates.
 * World matrix = T(placeAt in world) * RotY(rotationDeg) * UpRotation * Scale(units).
 */
export class ModelLayer {
  readonly group = new THREE.Group();
  root: THREE.Object3D | null = null;
  name = '';
  unit: Unit = 'ft';
  up: UpAxis = 'Y';
  rotationDeg = 0;
  /** Model origin location, in scan file coordinates. */
  placeAt: Vec3 = [0, 0, 0];
  /** Converts scan file coordinates to world; set by the app when a scan is loaded. */
  sourceToWorld: ((p: Vec3) => THREE.Vector3) | null = null;

  private original = new Map<THREE.Material, MatState>();
  private localBox = new THREE.Box3();

  constructor() {
    this.group.name = 'model';
    this.group.matrixAutoUpdate = false;
    (this.group as any).getWorldBox = () => this.getWorldBox();
  }

  get loaded() { return !!this.root; }

  load(json: any, name: string) {
    this.clear();
    const type = json?.metadata?.type;
    let obj: THREE.Object3D;
    if (type === 'BufferGeometry' || (json?.data?.attributes && !json?.object)) {
      const geom = new THREE.BufferGeometryLoader().parse(json);
      if (!geom.getAttribute('normal')) geom.computeVertexNormals();
      obj = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0x9db4d0 }));
    } else if (json?.object) {
      obj = new THREE.ObjectLoader().parse(json);
    } else {
      throw new Error('Not a three.js JSON file (expected ObjectLoader or BufferGeometry format, metadata.type "Object" or "BufferGeometry").');
    }
    obj.traverse((o) => {
      o.layers.set(LAYER_CONTENT);
      const m = (o as THREE.Mesh).material;
      const mats = Array.isArray(m) ? m : m ? [m] : [];
      for (const mat of mats) {
        if (!this.original.has(mat)) {
          this.original.set(mat, {
            opacity: mat.opacity, transparent: mat.transparent, wireframe: (mat as any).wireframe ?? false,
            side: mat.side, depthWrite: mat.depthWrite,
          });
        }
      }
    });
    this.root = obj;
    this.name = name;
    // Box in the group's local frame (model units): compute before parenting, so the group's
    // placement/scale is not baked in.
    obj.updateMatrixWorld(true);
    this.localBox = new THREE.Box3().setFromObject(obj, true);
    this.group.add(obj);
    this.applyTransform();
  }

  /** Model-space bounding box, in model units. */
  get modelBox(): THREE.Box3 { return this.localBox.clone(); }

  applyTransform() {
    const s = UNIT_TO_METRES[this.unit];
    const q = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(this.rotationDeg))
      .multiply(upRotation(this.up));
    const t = this.sourceToWorld ? this.sourceToWorld(this.placeAt) : new THREE.Vector3();
    this.group.matrix.compose(t, q, new THREE.Vector3(s, s, s));
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
  }

  setOpacity(opacity: number) {
    for (const [mat, orig] of this.original) {
      mat.opacity = orig.opacity * opacity;
      mat.transparent = orig.transparent || opacity < 1;
      mat.depthWrite = opacity >= 1 ? orig.depthWrite : false;
      mat.needsUpdate = true;
    }
  }

  setWireframe(on: boolean) {
    for (const [mat, orig] of this.original) {
      if ('wireframe' in mat) (mat as any).wireframe = on || orig.wireframe;
      mat.needsUpdate = true;
    }
  }

  setDoubleSided(on: boolean) {
    for (const [mat, orig] of this.original) {
      mat.side = on ? THREE.DoubleSide : orig.side;
      mat.needsUpdate = true;
    }
  }

  getWorldBox(): THREE.Box3 | null {
    if (!this.root || this.localBox.isEmpty()) return null;
    return this.localBox.clone().applyMatrix4(this.group.matrixWorld);
  }

  clear() {
    if (this.root) {
      this.group.remove(this.root);
      this.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
      });
      for (const mat of this.original.keys()) mat.dispose();
    }
    this.original.clear();
    this.root = null;
  }
}
