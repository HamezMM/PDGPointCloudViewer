/// <reference lib="webworker" />
import { fitPlanes } from './planeFit';
import type { PlaneWorkerIn, PlaneWorkerOut } from './types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<PlaneWorkerIn>) => {
  const msg = e.data;
  if (msg.type !== 'fit') return;
  try {
    const result = fitPlanes(msg.positions, msg.params, (stage) => self.postMessage({ type: 'progress', stage } satisfies PlaneWorkerOut));
    const out: PlaneWorkerOut = { type: 'done', result, positions: msg.positions };
    self.postMessage(out, [result.deviation.buffer, msg.positions.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies PlaneWorkerOut);
  }
};
