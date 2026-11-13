import * as THREE from 'three';
import type { Bounds, PointBuffers, Vec3 } from '../io/xyzTypes';
import { UNIT_TO_METRES, type Unit } from '../io/units';
import { LAYER_CONTENT } from './Viewer';

export type ColourMode = 'rgb' | 'height' | 'intensity' | 'single';
export type UpAxis = 'Z' | 'Y';

export const PICK_CHUNK = /* glsl */ `
vec4 pdgPackDepth(float v) {
  v = clamp(v, 0.0, 0.9999999);
  vec4 r = fract(v * vec4(1.0, 255.0, 65025.0, 16581375.0));
  r -= r.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return r;
}
`;

const vertexShader = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 rgb;
attribute float intensity;
uniform float uSize;
uniform float uAttenuate;
uniform float uScale;
uniform int uMode;
uniform vec2 uHeightRange;
uniform vec2 uIntensityRange;
uniform vec3 uColor;
varying vec3 vColor;

// Compact turbo-like ramp
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.1140, 0.0620, 0.2265);
  const vec3 c1 = vec3(6.7160, 3.1823, 7.5711);
  const vec3 c2 = vec3(-66.0940, -4.9327, -10.0943);
  const vec3 c3 = vec3(228.7660, 25.0499, -91.5410);
  const vec3 c4 = vec3(-334.8351, -69.3175, 288.5859);
  const vec3 c5 = vec3(218.7637, 67.5215, -305.2045);
  const vec3 c6 = vec3(-52.8890, -21.5453, 110.5174);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  float s = uSize;
  if (uAttenuate > 0.5) s = uSize * uScale / max(-mvPosition.z, 1e-4);
  gl_PointSize = clamp(s, 1.0, 64.0);

  if (uMode == 0) {
    vColor = rgb;
  } else if (uMode == 1) {
    vColor = ramp((worldPos.y - uHeightRange.x) / max(uHeightRange.y - uHeightRange.x, 1e-6));
  } else if (uMode == 2) {
    float t = (intensity - uIntensityRange.x) / max(uIntensityRange.y - uIntensityRange.x, 1e-6);
    vColor = vec3(clamp(t, 0.0, 1.0));
  } else {
    vColor = uColor;
  }
  #include <clipping_planes_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uPickMode;
uniform float uRound;
varying vec3 vColor;
${PICK_CHUNK}
void main() {
  #include <clipping_planes_fragment>
  if (uRound > 0.5) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }
  if (uPickMode > 0.5) { gl_FragColor = pdgPackDepth(gl_FragCoord.z); return; }
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const MODE_INDEX: Record<ColourMode, number> = { rgb: 0, height: 1, intensity: 2, single: 3 };

/** Rotation that maps a source frame with the given up axis to the three.js Y-up world. */
export function upRotation(up: UpAxis): THREE.Quaternion {
  return up === 'Z'
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    : new THREE.Quaternion();
}

/**
 * The scan layer. Positions are stored relative to `origin` (first point in the file) so Float32
 * keeps sub-millimetre precision even for survey coordinates. The wrapper group applies the unit
 * scale and up-axis rotation, so the world is always metres, Y-up.
 */
export class PointLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;

  origin: Vec3 = [0, 0, 0];
  bounds: Bounds | null = null;
  intensityRange: [number, number] | null = null;
  hasRgb = false;
  hasIntensity = false;
  count = 0;
  unit: Unit = 'm';
  up: UpAxis = 'Z';

  constructor() {
    this.group.name = 'scan';
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      clipping: true,
      uniforms: {
        uSize: { value: 2 },
        uAttenuate: { value: 0 },
        uScale: { value: 500 },
        uMode: { value: 0 },
        uHeightRange: { value: new THREE.Vector2(0, 1) },
        uIntensityRange: { value: new THREE.Vector2(0, 1) },
        uColor: { value: new THREE.Color(0xd0d4da) },
        uPickMode: { value: 0 },
        uRound: { value: 0 },
      },
    });
    (this.group as any).getWorldBox = () => this.getWorldBox();
  }

  setData(buffers: PointBuffers, origin: Vec3, bounds: Bounds, intensityRange: [number, number] | null) {
    this.disposeGeometry();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    this.hasRgb = !!buffers.colors;
    this.hasIntensity = !!buffers.intensity;
    if (buffers.colors) geom.setAttribute('rgb', new THREE.BufferAttribute(buffers.colors, 3, true));
    else geom.setAttribute('rgb', new THREE.Float32BufferAttribute(new Float32Array(buffers.count * 3).fill(0.8), 3));
    if (buffers.intensity) geom.setAttribute('intensity', new THREE.BufferAttribute(buffers.intensity, 1));
    else geom.setAttribute('intensity', new THREE.Float32BufferAttribute(new Float32Array(buffers.count), 1));
    // Bounding sphere from the known bounds (avoids a full pass over 10M points).
    const min = new THREE.Vector3(...bounds.min), max = new THREE.Vector3(...bounds.max);
    geom.boundingBox = new THREE.Box3(min, max);
    geom.boundingSphere = geom.boundingBox.getBoundingSphere(new THREE.Sphere());

    this.points = new THREE.Points(geom, this.material);
    this.points.layers.set(LAYER_CONTENT);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this.origin = origin;
    this.bounds = bounds;
    this.intensityRange = intensityRange;
    this.count = buffers.count;
    if (intensityRange) this.material.uniforms.uIntensityRange.value.set(intensityRange[0], intensityRange[1]);
    this.applyTransform();
  }

  get loaded(): boolean {
    return !!this.points;
  }

  setUnit(unit: Unit) { this.unit = unit; this.applyTransform(); }
  setUp(up: UpAxis) { this.up = up; this.applyTransform(); }

  applyTransform() {
    const s = UNIT_TO_METRES[this.unit];
    this.group.quaternion.copy(upRotation(this.up));
    this.group.scale.setScalar(s);
    this.group.updateMatrixWorld(true);
    this.updateHeightRange();
  }

  updateHeightRange() {
    const box = this.getWorldBox();
    if (box) this.material.uniforms.uHeightRange.value.set(box.min.y, box.max.y);
  }

  setColourMode(mode: ColourMode) { this.material.uniforms.uMode.value = MODE_INDEX[mode]; }
  setSize(px: number) { this.material.uniforms.uSize.value = px; }
  setAttenuate(on: boolean) { this.material.uniforms.uAttenuate.value = on ? 1 : 0; }
  setRound(on: boolean) { this.material.uniforms.uRound.value = on ? 1 : 0; }
  setIntensityRange(lo: number, hi: number) { this.material.uniforms.uIntensityRange.value.set(lo, hi); }

  getWorldBox(): THREE.Box3 | null {
    if (!this.bounds) return null;
    const box = new THREE.Box3(new THREE.Vector3(...this.bounds.min), new THREE.Vector3(...this.bounds.max));
    this.group.updateMatrixWorld(true);
    return box.applyMatrix4(this.group.matrixWorld);
  }

  /** World point (metres, Y-up) -> original file coordinates (file units, origin restored). */
  worldToSource(p: THREE.Vector3): Vec3 {
    const local = p.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
    return [local.x + this.origin[0], local.y + this.origin[1], local.z + this.origin[2]];
  }

  /** Original file coordinates -> world (metres, Y-up). Done in float64 on the CPU. */
  sourceToWorld(src: Vec3): THREE.Vector3 {
    const local = new THREE.Vector3(src[0] - this.origin[0], src[1] - this.origin[1], src[2] - this.origin[2]);
    return local.applyMatrix4(this.group.matrixWorld);
  }

  setPickMode(on: boolean) { this.material.uniforms.uPickMode.value = on ? 1 : 0; }

  private disposeGeometry() {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
  }

  clear() {
    this.disposeGeometry();
    this.bounds = null;
    this.count = 0;
  }
}
