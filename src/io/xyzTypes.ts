import type { Detection } from './xyzParse';

export type Vec3 = [number, number, number];

export interface PointBuffers {
  /** xyz relative to `origin`, in file units. */
  positions: Float32Array;
  /** 0..255 rgb, or null when the file has no colour. */
  colors: Uint8Array | null;
  /** raw intensity values, or null. */
  intensity: Float32Array | null;
  count: number;
}

export interface Bounds { min: Vec3; max: Vec3; }

export type WorkerIn = { type: 'load'; file: File; budget: number; tokens?: string };

export type WorkerOut =
  | { type: 'detected'; detection: Detection; preview: string[]; estimatedPoints: number; capacity: number }
  | { type: 'progress'; bytesRead: number; total: number; pointsSeen: number }
  | { type: 'preview'; buffers: PointBuffers; origin: Vec3; bounds: Bounds; intensityRange: [number, number] | null }
  | {
      type: 'done';
      buffers: PointBuffers;
      detection: Detection;
      preview: string[];
      totalPoints: number;
      skippedLines: number;
      rejectedLines: number;
      origin: Vec3;
      bounds: Bounds;
      intensityRange: [number, number] | null;
      seconds: number;
    }
  | { type: 'error'; message: string };
