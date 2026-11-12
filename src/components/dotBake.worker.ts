// Web Worker entry: runs one dot-bake job (see dotBake.ts) off the main
// thread and posts the result back (its buffers transferred, not copied).

import { runDotBakeJob, type DotBakeJob } from "./dotBake";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DotBakeJob>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

scope.onmessage = (event) => {
  try {
    const result = runDotBakeJob(event.data);
    const transfer: Transferable[] =
      result instanceof Float32Array
        ? [result.buffer]
        : [result.meshIndex.buffer, result.corners.buffer, result.bary.buffer, result.spread.buffer];
    scope.postMessage({ result }, transfer);
  } catch (error) {
    scope.postMessage({ error: String(error) }, []);
  }
};
