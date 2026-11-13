/// <reference lib="webworker" />
/**
 * Streaming .xyz loader. Runs in a Web Worker:
 *   File.stream() -> byte LineScanner -> column detection -> reservoir sample into a fixed budget.
 * The main thread never sees the file text, and memory is bounded by the point budget.
 */
import { LineScanner, Reservoir, detectColumns, tokensToMap, mapToTokens, type ColumnMap, type Detection } from './xyzParse';
import type { WorkerIn, WorkerOut, PointBuffers } from './xyzTypes';

declare const self: DedicatedWorkerGlobalScope;

const DETECT_ROWS = 2000;
const PREVIEW_MAX_POINTS = 500_000;

function post(msg: WorkerOut, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type !== 'load') return;
  try {
    await load(msg.file, msg.budget, msg.tokens);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function load(file: File, budget: number, tokens?: string) {
  const t0 = performance.now();
  const scanner = new LineScanner(5);
  const reader = file.stream().getReader();
  const total = file.size;

  let bytesRead = 0;
  let linesForEstimate = 0;

  // ---- phase 1: collect sample rows for detection --------------------------------------------
  const sampleRows: number[][] = [];
  let pending: Uint8Array | null = null;
  const collect = (f: Float64Array, n: number) => {
    linesForEstimate++;
    if (sampleRows.length < DETECT_ROWS) sampleRows.push(Array.from(f.subarray(0, Math.min(n, f.length))));
  };
  let streamDone = false;
  while (sampleRows.length < DETECT_ROWS) {
    const { value, done } = await reader.read();
    if (done) { streamDone = true; break; }
    bytesRead += value.length;
    // Only collect detection rows from this chunk; the whole chunk is re-scanned in phase 2
    // so processing stays strictly sequential and simple.
    pending = pending ? concat(pending, value) : value;
    const probe = new LineScanner(0);
    sampleRows.length = 0;
    linesForEstimate = 0;
    probe.feed(pending, collect);
    if (pending.length > 64 * 1024 * 1024) break; // pathological: huge lines or no numeric data
  }
  if (streamDone && pending) {
    const probe = new LineScanner(0);
    sampleRows.length = 0;
    linesForEstimate = 0;
    probe.feed(pending, collect);
    probe.flush(collect);
  }
  if (sampleRows.length === 0) throw new Error('No numeric x y z lines found in the first part of the file. Is this an ASCII .xyz?');

  let detection: Detection = detectColumns(sampleRows);
  let map: ColumnMap = detection.map;
  if (tokens && tokens.trim()) {
    map = tokensToMap(tokens, sampleRows);
    detection = { ...detection, map, tokens: mapToTokens(map, detection.columnCount), guessed: false, notes: ['manual column override'] };
  }

  // ---- allocate -------------------------------------------------------------------------------
  const bytesPerLine = pending && linesForEstimate > 0 ? pending.length / linesForEstimate : 40;
  const estimatedPoints = Math.ceil(total / bytesPerLine);
  const capacity = Math.max(1, Math.min(budget, Math.ceil(estimatedPoints * 1.15) + 1000));
  const hasRgb = map.r >= 0 && map.g >= 0 && map.b >= 0;
  const hasI = map.i >= 0;
  const positions = new Float32Array(capacity * 3);
  const colors = hasRgb ? new Uint8Array(capacity * 3) : null;
  const intensity = hasI ? new Float32Array(capacity) : null;
  const reservoir = new Reservoir(capacity);

  post({ type: 'detected', detection, preview: [], estimatedPoints, capacity });

  // ---- phase 2: stream + sample ----------------------------------------------------------------
  let ox = 0, oy = 0, oz = 0, haveOrigin = false;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let iMin = Infinity, iMax = -Infinity;
  let rejected = 0;
  const need = Math.max(map.x, map.y, map.z, map.r, map.g, map.b, map.i) + 1;
  const { x: cx, y: cy, z: cz, r: cr, g: cg, b: cb, i: ci, rgbScale } = map;

  const onLine = (f: Float64Array, n: number) => {
    if (n < need) { rejected++; return; }
    if (!haveOrigin) { ox = f[cx]; oy = f[cy]; oz = f[cz]; haveOrigin = true; }
    const x = f[cx] - ox, y = f[cy] - oy, z = f[cz] - oz;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    let iv = 0;
    if (ci >= 0) { iv = f[ci]; if (iv < iMin) iMin = iv; if (iv > iMax) iMax = iv; }
    const slot = reservoir.offer();
    if (slot < 0) return;
    const p = slot * 3;
    positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
    if (colors) {
      colors[p] = clamp255(f[cr] * rgbScale);
      colors[p + 1] = clamp255(f[cg] * rgbScale);
      colors[p + 2] = clamp255(f[cb] * rgbScale);
    }
    if (intensity) intensity[slot] = iv;
  };

  const main = scanner;
  if (pending) main.feed(pending, onLine);
  pending = null;

  let lastProgress = 0;
  let nextPreviewAt = total * 0.1;
  while (!streamDone) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.length;
    main.feed(value, onLine);
    const now = performance.now();
    if (now - lastProgress > 200) {
      lastProgress = now;
      post({ type: 'progress', bytesRead, total, pointsSeen: reservoir.seen });
    }
    if (bytesRead >= nextPreviewAt && bytesRead < total) {
      nextPreviewAt += total * 0.1;
      postPreview();
    }
  }
  main.flush(onLine);

  if (reservoir.seen === 0) throw new Error('File contained no usable points for the chosen columns.');

  const count = reservoir.size;
  const buffers: PointBuffers = {
    positions: count === capacity ? positions : positions.slice(0, count * 3),
    colors: colors ? (count === capacity ? colors : colors.slice(0, count * 3)) : null,
    intensity: intensity ? (count === capacity ? intensity : intensity.slice(0, count)) : null,
    count,
  };
  const transfer: Transferable[] = [buffers.positions.buffer];
  if (buffers.colors) transfer.push(buffers.colors.buffer);
  if (buffers.intensity) transfer.push(buffers.intensity.buffer);
  post(
    {
      type: 'done',
      buffers,
      detection,
      preview: scanner.preview,
      totalPoints: reservoir.seen,
      skippedLines: scanner.skipped,
      rejectedLines: rejected,
      origin: [ox, oy, oz],
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      intensityRange: hasI ? [iMin, iMax] : null,
      seconds: (performance.now() - t0) / 1000,
    },
    transfer,
  );

  function postPreview() {
    const size = reservoir.size;
    const stride = Math.max(1, Math.ceil(size / PREVIEW_MAX_POINTS));
    const n = Math.floor(size / stride);
    const pp = new Float32Array(n * 3);
    const pc = colors ? new Uint8Array(n * 3) : null;
    const pi = intensity ? new Float32Array(n) : null;
    for (let k = 0, s = 0; k < n; k++, s += stride) {
      pp[k * 3] = positions[s * 3]; pp[k * 3 + 1] = positions[s * 3 + 1]; pp[k * 3 + 2] = positions[s * 3 + 2];
      if (pc && colors) { pc[k * 3] = colors[s * 3]; pc[k * 3 + 1] = colors[s * 3 + 1]; pc[k * 3 + 2] = colors[s * 3 + 2]; }
      if (pi && intensity) pi[k] = intensity[s];
    }
    const t: Transferable[] = [pp.buffer];
    if (pc) t.push(pc.buffer);
    if (pi) t.push(pi.buffer);
    post(
      {
        type: 'preview',
        buffers: { positions: pp, colors: pc, intensity: pi, count: n },
        origin: [ox, oy, oz],
        bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
        intensityRange: hasI ? [iMin, iMax] : null,
      },
      t,
    );
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
