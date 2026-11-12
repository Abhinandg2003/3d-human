// Keeps the last dot bake (placed dots + crevice darkening) in the
// browser's IndexedDB, so a return visit skips the whole computation.
// One record per model; it's only reused when its key -- a fingerprint
// of the model's geometry and every placement/darkening setting (see
// dotBakeKey) -- matches exactly, so changing a knob or the GLB just
// recomputes and replaces it. Every failure (private mode, storage full,
// blocked) quietly means "not cached".

import type { PlacedDots } from "./dotBake";

export interface SavedDotBake {
  key: string;
  dots: PlacedDots;
  occlusion: Float32Array;
}

const DB_NAME = "dot-bake-cache";
const STORE = "bakes";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadDotBake(model: string, key: string): Promise<SavedDotBake | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(model);
      request.onsuccess = () => {
        const saved = request.result as SavedDotBake | undefined;
        resolve(saved && saved.key === key ? saved : null);
        db.close();
      };
      request.onerror = () => {
        resolve(null);
        db.close();
      };
    } catch {
      resolve(null);
      db.close();
    }
  });
}

export async function saveDotBake(model: string, bake: SavedDotBake): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(bake, model);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
    transaction.onabort = () => db.close();
  } catch {
    db.close();
  }
}
