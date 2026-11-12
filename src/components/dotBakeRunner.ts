// Starts dot-bake jobs (see dotBake.ts) in Web Workers.
//
// Kept apart from dotBake.ts on purpose: the worker file imports
// dotBake.ts, so if dotBake.ts also contained the `new Worker(...)` call,
// the bundler would build the worker into the worker into the worker...
// which hangs production builds ("Creating an optimized production build"
// never finishes).

import {
  runDotBakeJob,
  type BakeSurface,
  type DotBakeJob,
  type DotPlacementParams,
  type OcclusionParams,
  type PlacedDots,
} from "./dotBake";

/** A running bake: its result, and a way to stop it early. */
export interface DotBakeTask<T> {
  result: Promise<T>;
  cancel: () => void;
}

/**
 * Runs one bake job in its own Web Worker (so two jobs run in parallel,
 * and the page never stalls). Falls back to running on the main thread
 * if workers aren't available.
 */
export function runDotBake(request: { job: "dots"; surface: BakeSurface; params: DotPlacementParams }): DotBakeTask<PlacedDots>;
export function runDotBake(request: { job: "occlusion"; surface: BakeSurface; params: OcclusionParams }): DotBakeTask<Float32Array>;
export function runDotBake(request: DotBakeJob): DotBakeTask<PlacedDots | Float32Array> {
  let worker: Worker | null = null;
  let cancelled = false;
  const runHere = () =>
    new Promise<PlacedDots | Float32Array>((resolve, reject) => {
      // Let the current frame finish first.
      setTimeout(() => {
        if (cancelled) return;
        try {
          resolve(runDotBakeJob(request));
        } catch (error) {
          reject(error);
        }
      }, 0);
    });

  const result = new Promise<PlacedDots | Float32Array>((resolve, reject) => {
    try {
      worker = new Worker(new URL("./dotBake.worker.ts", import.meta.url), { type: "module" });
    } catch {
      runHere().then(resolve, reject);
      return;
    }
    worker.onmessage = (event: MessageEvent<{ result?: PlacedDots | Float32Array; error?: string }>) => {
      worker?.terminate();
      worker = null;
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "dot bake failed"));
    };
    worker.onerror = () => {
      // The worker couldn't load or crashed -- do it here instead.
      worker?.terminate();
      worker = null;
      runHere().then(resolve, reject);
    };
    worker.postMessage(request);
  });

  return {
    result,
    cancel: () => {
      cancelled = true;
      worker?.terminate();
      worker = null;
    },
  };
}
