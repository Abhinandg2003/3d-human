// The heavy, one-time work behind the dot look: placing the dots on the
// skin and baking the crevice darkening. Pure number crunching on plain
// typed arrays (no scene objects), so it runs inside a Web Worker -- off
// the main thread, at full speed -- see dotBake.worker.ts and runDotBake
// below. ModelScene.tsx owns all the tuning knobs and passes them in.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

type Vector3Tuple = [number, number, number];

// Bump whenever the algorithms below change in a way that changes their
// output, so results saved in the browser (see dotBakeCache.ts) from the
// old version are recomputed instead of reused.
export const DOT_BAKE_VERSION = 1;

/** Every body mesh merged into one triangle soup, in one shared space. */
export interface BakeSurface {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  // Which source mesh each merged vertex came from, and where each mesh's
  // vertices start in the merged arrays.
  vertexMesh: Uint16Array;
  vertOffsets: number[];
}

export interface DotPlacementParams {
  spacing: number;
  seamOverlap: number;
  minGap: number;
  seamBand: number;
  spreadMax: number;
  escapeRayCount: number;
  escapeRaysNeeded: number;
  rayBias: number;
}

export interface OcclusionParams {
  rayCount: number;
  rayDistance: number;
  rayBias: number;
}

/** The placed dots, in placement order. */
export interface PlacedDots {
  // Source mesh of each dot.
  meshIndex: Uint16Array;
  // Its triangle's 3 vertices, in that mesh's own vertex numbering, and
  // its barycentric weights on that triangle (3 per dot each).
  corners: Uint32Array;
  bary: Float32Array;
  // How spread out its neighbours are, in spacings (scales the dot size).
  spread: Float32Array;
}

function buildBvh(surface: BakeSurface): MeshBVH {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(surface.positions, 3));
  // MeshBVH reorders this index's triangles in place -- fine, since every
  // user only needs "which triangles exist", never their original order.
  geometry.setIndex(new BufferAttribute(surface.index, 1));
  return new MeshBVH(geometry);
}

// ---------------------------------------------------------------------
// Crevice darkening: per vertex, how open is it (1) vs. deep in a cavity (0).
// ---------------------------------------------------------------------

/** One 0..1 openness value per merged vertex. */
export function bakeOcclusion(surface: BakeSurface, params: OcclusionParams): Float32Array {
  const { positions, normals, index } = surface;
  const { rayCount, rayDistance, rayBias } = params;
  const vertTotal = positions.length / 3;
  const bvh = buildBvh(surface);
  const indexTotal = index.length;

  // Cosine-weighted directions over the +Z hemisphere (golden-angle
  // spiral), so every hit counts equally and grazing rays matter least --
  // the same weighting diffuse light itself has.
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const samples: Vector3Tuple[] = [];
  for (let s = 0; s < rayCount; s++) {
    const u = (s + 0.5) / rayCount;
    const r = Math.sqrt(u);
    samples.push([r * Math.cos(s * goldenAngle), r * Math.sin(s * goldenAngle), Math.sqrt(1 - u)]);
  }

  const ray = new Ray();
  const openness = new Float32Array(vertTotal);
  for (let i = 0; i < vertTotal; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];

    // Tangent (t) / bitangent (b) around the normal, branch-free
    // (Duff et al. 2017) -- turns the +Z samples into this vertex's
    // hemisphere.
    const sign = nz >= 0 ? 1 : -1;
    const a = -1 / (sign + nz);
    const b = nx * ny * a;
    const tx = 1 + sign * nx * nx * a, ty = sign * b, tz = -sign * nx;
    const bx = b, by = sign + ny * ny * a, bz = -ny;

    // Spin the sample pattern per vertex to avoid banding. Hashed from
    // the POSITION (not the index) so the duplicate vertices Blender
    // splits along UV/material seams get identical results -- otherwise
    // the seams would show as faint lines.
    const h = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719) * 43758.5453;
    const spin = (h - Math.floor(h)) * Math.PI * 2;
    const cos = Math.cos(spin);
    const sin = Math.sin(spin);

    let occluded = 0;
    for (const [sx0, sy0, sz] of samples) {
      const sx = sx0 * cos - sy0 * sin;
      const sy = sx0 * sin + sy0 * cos;
      ray.origin.set(px + nx * rayBias, py + ny * rayBias, pz + nz * rayBias);
      ray.direction.set(
        tx * sx + bx * sy + nx * sz,
        ty * sx + by * sy + ny * sz,
        tz * sx + bz * sy + nz * sz
      );
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, rayDistance);
      // Closer blockers occlude more -- softens the edge of each cavity.
      if (hit) occluded += 1 - hit.distance / rayDistance;
    }
    openness[i] = 1 - occluded / rayCount;
  }

  // One smoothing pass over the triangle mesh to wash out sampling noise,
  // done on welded vertices (same quantized position = same vertex) so
  // seam duplicates stay identical.
  const weldIds = new Int32Array(vertTotal);
  const weldKeys = new Map<string, number>();
  for (let i = 0; i < vertTotal; i++) {
    const key = `${Math.round(positions[i * 3] * 1e4)},${Math.round(positions[i * 3 + 1] * 1e4)},${Math.round(positions[i * 3 + 2] * 1e4)}`;
    let id = weldKeys.get(key);
    if (id === undefined) {
      id = weldKeys.size;
      weldKeys.set(key, id);
    }
    weldIds[i] = id;
  }
  const weldCount = weldKeys.size;
  const own = new Float32Array(weldCount);
  const ownCount = new Float32Array(weldCount);
  for (let i = 0; i < vertTotal; i++) {
    own[weldIds[i]] += openness[i];
    ownCount[weldIds[i]] += 1;
  }
  for (let w = 0; w < weldCount; w++) own[w] /= ownCount[w];

  const neighborSum = new Float32Array(weldCount);
  const neighborCount = new Float32Array(weldCount);
  for (let t = 0; t < indexTotal; t += 3) {
    const ia = weldIds[index[t]];
    const ib = weldIds[index[t + 1]];
    const ic = weldIds[index[t + 2]];
    neighborSum[ia] += own[ib] + own[ic];
    neighborSum[ib] += own[ia] + own[ic];
    neighborSum[ic] += own[ia] + own[ib];
    neighborCount[ia] += 2;
    neighborCount[ib] += 2;
    neighborCount[ic] += 2;
  }
  // Each vertex keeps a bit more of its own value than any one neighbor.
  const SELF_WEIGHT = 4;
  const result = new Float32Array(vertTotal);
  for (let i = 0; i < vertTotal; i++) {
    const w = weldIds[i];
    result[i] = (own[w] * SELF_WEIGHT + neighborSum[w]) / (SELF_WEIGHT + neighborCount[w]);
  }
  return result;
}

// ---------------------------------------------------------------------
// Dot placement (see the DOT_* knobs in ModelScene.tsx for the why).
// ---------------------------------------------------------------------

// For each projection axis (X = sides, Y = top/bottom, Z = front/back):
// the two axes its grid runs along, rows (second) always being the
// vertical one where possible.
const DOT_GRID_AXES: [number, number][] = [
  [2, 1],
  [0, 2],
  [0, 1],
];

// Uniform directions over the +Z hemisphere, the most upright first, so
// open skin escapes on the first couple of tries.
function escapeSamples(count: number): Vector3Tuple[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const samples: Vector3Tuple[] = [];
  for (let s = 0; s < count; s++) {
    const z = 1 - (s + 0.5) / count;
    const r = Math.sqrt(1 - z * z);
    samples.push([r * Math.cos(s * goldenAngle), r * Math.sin(s * goldenAngle), z]);
  }
  return samples;
}

/**
 * Can the surface point p (normal n, unit length) see out of the model?
 * Rays fan out over the side n faces, then the other side (in case a
 * normal is flipped); true once `needed` of them leave without a hit.
 */
function surfaceEscapes(
  bvh: MeshBVH,
  ray: Ray,
  samples: Vector3Tuple[],
  needed: number,
  bias: number,
  px: number,
  py: number,
  pz: number,
  nx0: number,
  ny0: number,
  nz0: number
): boolean {
  let escaped = 0;
  for (const side of [1, -1]) {
    const nx = nx0 * side;
    const ny = ny0 * side;
    const nz = nz0 * side;
    // Tangent frame around n, as in bakeOcclusion.
    const sign = nz >= 0 ? 1 : -1;
    const a = -1 / (sign + nz);
    const b = nx * ny * a;
    const tx = 1 + sign * nx * nx * a, ty = sign * b, tz = -sign * nx;
    const bx = b, by = sign + ny * ny * a, bz = -ny;
    for (const [sx, sy, sz] of samples) {
      ray.origin.set(px + nx * bias, py + ny * bias, pz + nz * bias);
      ray.direction.set(
        tx * sx + bx * sy + nx * sz,
        ty * sx + by * sy + ny * sz,
        tz * sx + bz * sy + nz * sz
      );
      if (!bvh.raycastFirst(ray, DoubleSide) && ++escaped >= needed) return true;
    }
  }
  return false;
}

/** A dot found by the grid rays, before seam de-duplication. */
interface DotCandidate {
  // Position and unit normal, reference space.
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  // How head-on its grid hits the skin (1 = straight on).
  priority: number;
  // Close enough to another grid's region to need seam handling.
  nearSeam: boolean;
  // Its grid's dot spacing on this slanted skin, in spacings.
  stretch: number;
  // Merged-surface triangle corners and barycentric weights.
  a: number;
  b: number;
  c: number;
  ba: number;
  bb: number;
  bc: number;
}

/** Uniform spatial hash over dots, for "anything close by?" queries. */
class DotHash {
  private cells = new Map<number, DotCandidate[]>();
  constructor(private cellSize: number) {}

  private key(ix: number, iy: number, iz: number): number {
    // Hash collisions only merge buckets -- every query still checks the
    // real distance -- so a cheap integer hash is fine.
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  }

  add(dot: DotCandidate) {
    const s = this.cellSize;
    const k = this.key(Math.floor(dot.x / s), Math.floor(dot.y / s), Math.floor(dot.z / s));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(dot);
    else this.cells.set(k, [dot]);
  }

  private bucketsAround(dot: DotCandidate): DotCandidate[][] {
    const s = this.cellSize;
    const cx = Math.floor(dot.x / s);
    const cy = Math.floor(dot.y / s);
    const cz = Math.floor(dot.z / s);
    const buckets: DotCandidate[][] = [];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const bucket = this.cells.get(this.key(cx + i, cy + j, cz + k));
          if (bucket && !buckets.includes(bucket)) buckets.push(bucket);
        }
      }
    }
    return buckets;
  }

  /** Any dot on the same side of the skin within `radius` (<= cell size)? */
  anyWithin(dot: DotCandidate, radius: number): boolean {
    const r2 = radius * radius;
    for (const bucket of this.bucketsAround(dot)) {
      for (const other of bucket) {
        if (other === dot) continue;
        const dx = other.x - dot.x, dy = other.y - dot.y, dz = other.z - dot.z;
        if (dx * dx + dy * dy + dz * dz >= r2) continue;
        if (dot.nx * other.nx + dot.ny * other.ny + dot.nz * other.nz >= 0.5) return true;
      }
    }
    return false;
  }

  /** Mean distance to the 4 nearest same-side dots within `radius` (<= cell size), 0 if none. */
  meanNearest4(dot: DotCandidate, radius: number): number {
    let d0 = radius * radius, d1 = d0, d2 = d0, d3 = d0;
    let found = 0;
    for (const bucket of this.bucketsAround(dot)) {
      for (const other of bucket) {
        if (other === dot) continue;
        const dx = other.x - dot.x, dy = other.y - dot.y, dz = other.z - dot.z;
        const q = dx * dx + dy * dy + dz * dz;
        if (q >= d3) continue;
        if (dot.nx * other.nx + dot.ny * other.ny + dot.nz * other.nz < 0.5) continue;
        found++;
        if (q < d0) { d3 = d2; d2 = d1; d1 = d0; d0 = q; }
        else if (q < d1) { d3 = d2; d2 = d1; d1 = q; }
        else if (q < d2) { d3 = d2; d2 = q; }
        else d3 = q;
      }
    }
    const used = Math.min(found, 4);
    if (used === 0) return 0;
    const sum = [d0, d1, d2, d3].slice(0, used).reduce((total, q) => total + Math.sqrt(q), 0);
    return sum / used;
  }
}

/**
 * Pins dots to the skin on a regular grid: rays are cast straight through
 * the body along each axis, one per grid cell (spacing apart), and every
 * surface a ray crosses gets a dot -- if that surface faces the ray's axis
 * (nearly) the most, it can see out of the body, and it isn't too close
 * to a better-placed dot along a seam between grids.
 */
export function placeDots(surface: BakeSurface, params: DotPlacementParams): PlacedDots {
  const { positions, normals, vertexMesh, vertOffsets } = surface;
  const spacing = params.spacing;
  const vertTotal = positions.length / 3;
  const bvh = buildBvh(surface);
  const samples = escapeSamples(params.escapeRayCount);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertTotal; i++) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }

  const candidates: DotCandidate[] = [];
  const ray = new Ray();
  const triangle = new Triangle();
  const va = new Vector3();
  const vb = new Vector3();
  const vc = new Vector3();
  const bary = new Vector3();
  const origin = [0, 0, 0];
  const direction = [0, 0, 0];
  const escapeRay = new Ray();

  for (let axis = 0; axis < 3; axis++) {
    const [u, w] = DOT_GRID_AXES[axis];
    const uFirst = Math.floor(min[u] / spacing);
    const uLast = Math.ceil(max[u] / spacing);
    const wFirst = Math.floor(min[w] / spacing);
    const wLast = Math.ceil(max[w] / spacing);
    direction[0] = direction[1] = direction[2] = 0;
    direction[axis] = -1;
    ray.direction.fromArray(direction);

    for (let iu = uFirst; iu <= uLast; iu++) {
      for (let iw = wFirst; iw <= wLast; iw++) {
        origin[axis] = max[axis] + spacing;
        origin[u] = (iu + 0.5) * spacing;
        origin[w] = (iw + 0.5) * spacing;
        ray.origin.fromArray(origin);

        const hits = bvh.raycast(ray, DoubleSide);
        hits.sort((p, q) => p.distance - q.distance);
        let lastDistance = -Infinity;
        for (const hit of hits) {
          // A ray through a shared edge reports both triangles -- one dot.
          if (hit.distance - lastDistance < 1e-6) continue;
          lastDistance = hit.distance;
          const face = hit.face;
          if (!face) continue;

          va.fromArray(positions, face.a * 3);
          vb.fromArray(positions, face.b * 3);
          vc.fromArray(positions, face.c * 3);
          if (!triangle.set(va, vb, vc).getBarycoord(hit.point, bary)) continue;
          // Snap tiny numerical overshoots back onto the triangle.
          bary.set(Math.max(bary.x, 0), Math.max(bary.y, 0), Math.max(bary.z, 0));
          const barySum = bary.x + bary.y + bary.z;
          if (barySum <= 0) continue;
          bary.divideScalar(barySum);

          // Does this spot face this grid's axis (nearly) the most?
          let facing = 0;
          let other = 0;
          for (let k = 0; k < 3; k++) {
            const n = Math.abs(
              normals[face.a * 3 + k] * bary.x +
                normals[face.b * 3 + k] * bary.y +
                normals[face.c * 3 + k] * bary.z
            );
            if (k === axis) facing = n;
            else other = Math.max(other, n);
          }
          if (facing < params.seamOverlap * other) continue;

          // Skip surfaces sealed inside the body.
          let nx = 0, ny = 0, nz = 0;
          for (let k = 0; k < 3; k++) {
            const n =
              normals[face.a * 3 + k] * bary.x +
              normals[face.b * 3 + k] * bary.y +
              normals[face.c * 3 + k] * bary.z;
            if (k === 0) nx = n;
            else if (k === 1) ny = n;
            else nz = n;
          }
          const nLength = Math.hypot(nx, ny, nz);
          if (nLength < 1e-8) continue;
          const escapes = surfaceEscapes(
            bvh,
            escapeRay,
            samples,
            params.escapeRaysNeeded,
            params.rayBias,
            hit.point.x,
            hit.point.y,
            hit.point.z,
            nx / nLength,
            ny / nLength,
            nz / nLength
          );
          if (!escapes) continue;

          // Grid spacing as laid on this slanted skin: one grid step along
          // each of the grid's two directions becomes S * sqrt(1 + (n_dir /
          // n_axis)^2) on the surface. The 4 nearest neighbours are 2 steps
          // of each, so their mean distance, in spacings, is the average.
          const nAxis = Math.max(facing, 1e-3);
          const nU = Math.abs([nx, ny, nz][u]);
          const nW = Math.abs([nx, ny, nz][w]);
          const stretch =
            (Math.sqrt(1 + (nU / nAxis) ** 2) + Math.sqrt(1 + (nW / nAxis) ** 2)) / 2;
          candidates.push({
            x: hit.point.x,
            y: hit.point.y,
            z: hit.point.z,
            nx: nx / nLength,
            ny: ny / nLength,
            nz: nz / nLength,
            priority: facing / nLength,
            nearSeam: facing < params.seamBand * other,
            stretch,
            a: face.a,
            b: face.b,
            c: face.c,
            ba: bary.x,
            bb: bary.y,
            bc: bary.z,
          });
        }
      }
    }
  }

  // Seams: keep the most head-on dots first, drop any later one that lands
  // too close to a kept one on the same side of the skin (the normal check
  // keeps both sides of thin parts -- fingers, ears -- dotted). Only dots
  // near a seam can collide with another grid's dots, so only those are
  // checked -- but every kept dot goes into the lookup.
  candidates.sort((p, q) => q.priority - p.priority);
  const minGap = params.minGap * spacing;
  const nearby = new DotHash(minGap);
  const kept: DotCandidate[] = [];
  for (const dot of candidates) {
    if (!dot.nearSeam || !nearby.anyWithin(dot, minGap)) {
      nearby.add(dot);
      kept.push(dot);
    }
  }

  // Spread, in spacings: measured (mean distance to the 4 nearest dots)
  // along seams, where two grids mix; elsewhere it's exactly the slant
  // stretch worked out when the dot was found.
  const neighbours = new DotHash(2 * spacing);
  for (const dot of kept) neighbours.add(dot);

  const count = kept.length;
  const placed: PlacedDots = {
    meshIndex: new Uint16Array(count),
    corners: new Uint32Array(count * 3),
    bary: new Float32Array(count * 3),
    spread: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const dot = kept[i];
    const spread = dot.nearSeam
      ? neighbours.meanNearest4(dot, 2 * spacing) / spacing
      : dot.stretch;
    placed.spread[i] = spread > 0 ? Math.min(Math.max(spread, 1), params.spreadMax) : 1;
    const meshIndex = vertexMesh[dot.a];
    const offset = vertOffsets[meshIndex];
    placed.meshIndex[i] = meshIndex;
    placed.corners[i * 3] = dot.a - offset;
    placed.corners[i * 3 + 1] = dot.b - offset;
    placed.corners[i * 3 + 2] = dot.c - offset;
    placed.bary[i * 3] = dot.ba;
    placed.bary[i * 3 + 1] = dot.bb;
    placed.bary[i * 3 + 2] = dot.bc;
  }
  return placed;
}

// ---------------------------------------------------------------------
// Running it: in a Web Worker when possible, on the main thread if not.
// ---------------------------------------------------------------------

export type DotBakeJob =
  | { job: "dots"; surface: BakeSurface; params: DotPlacementParams }
  | { job: "occlusion"; surface: BakeSurface; params: OcclusionParams };

export function runDotBakeJob(request: DotBakeJob): PlacedDots | Float32Array {
  return request.job === "dots"
    ? placeDots(request.surface, request.params)
    : bakeOcclusion(request.surface, request.params);
}

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

// ---------------------------------------------------------------------
// Fingerprint of a bake's inputs, so saved results are only reused for
// exactly the same model and settings.
// ---------------------------------------------------------------------

export function dotBakeKey(
  surface: BakeSurface,
  dotParams: DotPlacementParams,
  occlusionParams: OcclusionParams
): string {
  // Two independent 32-bit FNV-1a style hashes over the raw bytes.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  const feed = (view: ArrayBufferView) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
      h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
    }
  };
  feed(surface.positions);
  feed(surface.normals);
  feed(surface.index);
  feed(surface.vertexMesh);
  const settings = JSON.stringify({
    version: DOT_BAKE_VERSION,
    offsets: surface.vertOffsets,
    dots: dotParams,
    occlusion: occlusionParams,
  });
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${settings}`;
}
