import * as THREE from 'three';
import type { Region } from './types';
import { regionGeometry } from '../viewer/PlaneLayer';
import type { PointLayer } from '../viewer/PointLayer';

export interface ExportInfo {
  source: string;
  tolerance: number;
  rotationDeg: number;
}

/**
 * Export regions as three.js JSON (ObjectLoader format) in the scan's own frame: file units, the
 * scan's up axis, real-world coordinates. Vertices are stored relative to the scan origin (small
 * values, safe in Float32); the group matrix carries the origin translation as full doubles.
 */
export function exportPlanesJSON(regions: Region[], scan: PointLayer, info: ExportInfo): object {
  const worldToLocal = scan.group.matrixWorld.clone().invert(); // world metres -> file units relative to origin
  const scale = new THREE.Vector3().setFromMatrixScale(scan.group.matrixWorld).x; // metres per file unit
  const group = new THREE.Group();
  group.name = 'PDG fitted planes';
  group.position.set(scan.origin[0], scan.origin[1], scan.origin[2]);
  group.updateMatrix();
  group.userData = {
    pdgPlanes: 1,
    units: scan.unit,
    upAxis: scan.up,
    origin: [...scan.origin],
    buildingRotationDeg: info.rotationDeg,
    toleranceMm: info.tolerance * 1000,
    source: info.source,
    created: new Date().toISOString(),
  };
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xe8665a, name: 'Vertical A1', side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x8a9bb0, name: 'Horizontal', side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x5aa0e8, name: 'Vertical A3', side: THREE.DoubleSide }),
  ];
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldToLocal);
  for (const r of regions) {
    const { geometry, matrix } = regionGeometry(r);
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(worldToLocal, matrix));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials[r.axis]);
    const n = new THREE.Vector3(...r.normal).applyMatrix3(normalMatrix).normalize();
    // plane offset in real-world file coordinates: n · p for a point p on the plane
    const pWorld = new THREE.Vector3(...r.normal).multiplyScalar(r.offset);
    const pSrc = scan.worldToSource(pWorld);
    const offset = n.x * pSrc[0] + n.y * pSrc[1] + n.z * pSrc[2];
    const orientation = r.axis === 1 ? 'horizontal' : 'vertical';
    mesh.name = `${orientation === 'horizontal' ? 'Horizontal' : 'Vertical'} ${r.id}`;
    mesh.userData = {
      regionId: r.id,
      axis: ['A1', 'V', 'A3'][r.axis],
      orientation,
      normal: n.toArray().map((v) => +v.toFixed(6)),
      offset: +offset.toFixed(6),
      areaM2: +r.area.toFixed(4),
      areaFileUnits2: +(r.area / (scale * scale)).toFixed(4),
      points: r.points,
      rmsMm: +(r.rms * 1000).toFixed(2),
      maxDevMm: +(r.maxDev * 1000).toFixed(2),
      pctOverTol: +r.pctOver.toFixed(2),
      toleranceMm: info.tolerance * 1000,
    };
    group.add(mesh);
  }
  return group.toJSON();
}
