/** All lengths in metres (world frame: Y up). */
export interface PlaneParams {
  /** Merge/split and deviation tolerance (default 1" = 0.0254 m). */
  tolerance: number;
  /** Voxel size for local normal estimation. */
  voxel: number;
  /** Max angle between a voxel normal and a building axis, degrees. */
  angleDeg: number;
  /** Points within this distance of a plane are assigned to it (deviation band). */
  band: number;
  /** Minimum region area, m². */
  minArea: number;
  /** Enclosed gaps smaller than this are filled (occlusion speckle), m². */
  minHole: number;
  /** Occupancy grid cell size for outlines. */
  cell: number;
  /** Minimum supporting points for a plane. */
  minPoints: number;
  /** Max smallest/middle eigenvalue ratio for a voxel to count as planar. */
  planarity: number;
  /** Building rotation about vertical in degrees (world frame), or null for automatic. */
  rotationDeg: number | null;
}

export const DEFAULT_PARAMS: PlaneParams = {
  tolerance: 0.0254,
  voxel: 0.05,
  angleDeg: 10,
  band: 0.0762,
  minArea: 0.25,
  minHole: 0.1,
  cell: 0.05,
  minPoints: 200,
  planarity: 0.08,
  rotationDeg: null,
};

export type V3 = [number, number, number];

export interface Region {
  id: number;
  planeIndex: number;
  /** Building axis index: 0 = A1 (horizontal), 1 = vertical (Y), 2 = A3 (horizontal). */
  axis: 0 | 1 | 2;
  normal: V3;
  /** Plane: dot(p, normal) = offset (world metres). */
  offset: number;
  /** In-plane basis; outline coordinates are (u, v) in metres: p = normal*offset + u*U + v*V. */
  U: V3;
  V: V3;
  outer: number[];
  holes: number[][];
  area: number;
  points: number;
  rms: number;
  maxDev: number;
  pctOver: number;
}

export interface PlaneFitResult {
  /** Building rotation about vertical, degrees in (-45, 45]. */
  rotationDeg: number;
  rotationAuto: boolean;
  axes: [V3, V3, V3];
  planes: { axis: 0 | 1 | 2; offset: number; points: number }[];
  regions: Region[];
  /** Per input point signed deviation (m) from its plane, NaN when unassigned. */
  deviation: Float32Array;
  stats: { points: number; planarVoxels: number; voxels: number; seconds: number };
}

export type PlaneWorkerIn = { type: 'fit'; positions: Float32Array; params: PlaneParams };
export type PlaneWorkerOut =
  | { type: 'progress'; stage: string }
  | { type: 'done'; result: PlaneFitResult; positions: Float32Array }
  | { type: 'error'; message: string };
