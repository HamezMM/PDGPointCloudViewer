import * as THREE from 'three';
import type { PlaneFitResult, Region } from '../analysis/types';
import { LAYER_CONTENT } from './Viewer';

const AXIS_COLOURS = [0xe8665a, 0x8a9bb0, 0x5aa0e8]; // A1 walls, horizontal, A3 walls
const SELECT_COLOUR = 0xffd84a;

/** Build a mesh for one region: ShapeGeometry in (u, v), placed in the plane frame. */
export function regionGeometry(r: Region): { geometry: THREE.ShapeGeometry; matrix: THREE.Matrix4 } {
  const shape = new THREE.Shape();
  for (let k = 0; k < r.outer.length; k += 2) {
    if (k === 0) shape.moveTo(r.outer[0], r.outer[1]);
    else shape.lineTo(r.outer[k], r.outer[k + 1]);
  }
  shape.closePath();
  for (const h of r.holes) {
    const path = new THREE.Path();
    for (let k = 0; k < h.length; k += 2) {
      if (k === 0) path.moveTo(h[0], h[1]);
      else path.lineTo(h[k], h[k + 1]);
    }
    path.closePath();
    shape.holes.push(path);
  }
  const geometry = new THREE.ShapeGeometry(shape);
  const U = new THREE.Vector3(...r.U), V = new THREE.Vector3(...r.V), N = new THREE.Vector3(...r.normal);
  const matrix = new THREE.Matrix4().makeBasis(U, V, U.clone().cross(V)).setPosition(N.multiplyScalar(r.offset));
  return { geometry, matrix };
}

const devVertex = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float dev;
uniform float uSize;
uniform float uTol;
varying vec3 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize;
  if (dev != dev) { vColor = vec3(0.22); }               // NaN: unassigned
  else {
    float t = clamp(dev / uTol, -1.0, 1.0);
    vec3 grey = vec3(0.78);
    vColor = t < 0.0 ? mix(grey, vec3(0.15, 0.45, 1.0), -t) : mix(grey, vec3(1.0, 0.25, 0.15), t);
    if (abs(dev) > uTol) vColor = dev > 0.0 ? vec3(1.0, 0.0, 0.85) : vec3(0.0, 0.95, 1.0); // beyond tolerance
  }
  #include <clipping_planes_vertex>
}`;
const devFragment = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vColor;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(vColor, 1.0);
}`;

/** Fitted plane regions plus the deviation point overlay. Everything here is in world metres. */
export class PlaneLayer {
  readonly group = new THREE.Group();
  readonly meshes = new Map<number, THREE.Mesh>();
  result: PlaneFitResult | null = null;
  regions: Region[] = [];
  selected = -1;
  opacity = 0.55;
  private devPoints: THREE.Points | null = null;
  readonly devMaterial = new THREE.ShaderMaterial({
    vertexShader: devVertex,
    fragmentShader: devFragment,
    clipping: true,
    uniforms: { uSize: { value: 2 }, uTol: { value: 0.0254 } },
  });
  private outlineMat = new THREE.LineBasicMaterial({ color: 0x111111 });

  constructor() {
    this.group.name = 'planes';
    this.devMaterial.visible = true;
  }

  setResult(result: PlaneFitResult, positions: Float32Array, tolerance: number) {
    this.clear();
    this.result = result;
    this.regions = result.regions.slice();
    for (const r of this.regions) this.addMesh(r);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('dev', new THREE.BufferAttribute(result.deviation, 1));
    this.devPoints = new THREE.Points(g, this.devMaterial);
    this.devPoints.frustumCulled = false;
    this.devPoints.visible = false;
    this.devPoints.layers.set(LAYER_CONTENT);
    this.group.add(this.devPoints);
    this.devMaterial.uniforms.uTol.value = tolerance;
  }

  private addMesh(r: Region) {
    const { geometry, matrix } = regionGeometry(r);
    const mat = new THREE.MeshBasicMaterial({
      color: AXIS_COLOURS[r.axis], transparent: true, opacity: this.opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.userData.regionId = r.id;
    mesh.layers.set(LAYER_CONTENT);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), this.outlineMat);
    mesh.add(edges);
    this.group.add(mesh);
    this.meshes.set(r.id, mesh);
  }

  get hasResult() { return !!this.result; }

  setShowPlanes(on: boolean) { for (const m of this.meshes.values()) m.visible = on; }
  setShowDeviation(on: boolean) { if (this.devPoints) this.devPoints.visible = on; }
  setPointSize(px: number) { this.devMaterial.uniforms.uSize.value = px; }

  setOpacity(o: number) {
    this.opacity = o;
    for (const [id, m] of this.meshes) (m.material as THREE.MeshBasicMaterial).opacity = id === this.selected ? Math.max(o, 0.8) : o;
  }

  select(id: number) {
    const prev = this.meshes.get(this.selected);
    if (prev) {
      const r = this.regions.find((x) => x.id === this.selected);
      (prev.material as THREE.MeshBasicMaterial).color.set(AXIS_COLOURS[r?.axis ?? 0]);
      (prev.material as THREE.MeshBasicMaterial).opacity = this.opacity;
    }
    this.selected = id;
    const m = this.meshes.get(id);
    if (m) {
      (m.material as THREE.MeshBasicMaterial).color.set(SELECT_COLOUR);
      (m.material as THREE.MeshBasicMaterial).opacity = Math.max(this.opacity, 0.8);
    }
  }

  remove(id: number) {
    const m = this.meshes.get(id);
    if (!m) return;
    this.group.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    m.children.forEach((c) => (c as THREE.LineSegments).geometry.dispose());
    this.meshes.delete(id);
    this.regions = this.regions.filter((r) => r.id !== id);
    if (this.selected === id) this.selected = -1;
  }

  /** Ray-cast the region meshes (few objects, cheap). */
  hit(raycaster: THREE.Raycaster): number {
    const visible = [...this.meshes.values()].filter((m) => m.visible);
    const hits = raycaster.intersectObjects(visible, false);
    return hits.length ? (hits[0].object.userData.regionId as number) : -1;
  }

  clear() {
    for (const id of [...this.meshes.keys()]) this.remove(id);
    if (this.devPoints) {
      this.group.remove(this.devPoints);
      this.devPoints.geometry.dispose();
      this.devPoints = null;
    }
    this.result = null;
    this.regions = [];
    this.selected = -1;
  }
}
