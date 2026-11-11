"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, ContactShadows, useAnimations } from "@react-three/drei";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LoopOnce,
  Matrix3,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Ray,
  Vector3,
} from "three";
import { MeshBVH } from "three-mesh-bvh";

export type ViewKey =
  | "reset"
  | "head2"
  | "heart"
  | "arms"
  | "kidney"
  | "thyroid"
  | "liver"
  | "lungs";
type Vector3Tuple = [number, number, number];

// Male rigged/posable model. (Gender swap removed -- this is the only model
// the scene renders now.)
const MODEL_PATH = "/female-rigged-nomeshsculpt3-best.glb";

const VIEWS: Record<
  ViewKey,
  { label: string; camPos: Vector3Tuple; target: Vector3Tuple }
> = {
  reset: { label: "Full Body", camPos: [-0.25, 1.45, 1.35], target: [-0.1, 1.38, 0]  },
  head2: { label: "Brain", camPos: [-0.75, 1.75, 0.85], target: [0, 1.40, 0] },
  heart: { label: "Heart", camPos: [0.45, 1.45, 1.25], target: [0, 1.38, 0] },
  arms: { label: "Arms", camPos: [0.7, 1.35, 1.3], target: [0.5, 1.25, 0] },
    kidney: { label: "Kidney", camPos: [0, 1.25, 0.85], target: [0, 1.17, 0] },
  thyroid: { label: "Thyroid",  camPos: [0.25, 1.15, 0.7], target: [0, 1.40, 0] },
  liver: { label: "Liver", camPos: [-0.45, 1.25, 0.6], target: [0, 1.18, 0] },
  lungs: { label: "Lungs", camPos: [-0, 1.35, 0.9], target: [0, 1.28, 0] },

};

// Maps each camera-view button to the name of the animation Action/clip it
// should trigger on the rigged model. "reset" now points at your own
// "default" pose clip -- change the string below if you named it
// differently in Blender. "arms" maps to the clip name "arm" (singular)
// to match how the poses are named inside Man_Mesh clean3.glb.
const POSE_ACTION_NAMES: Record<ViewKey, string | null> = {
  reset: "default",
  head2: "head2",
  heart: "heart",
  arms: "arm",
  kidney: "default",
  thyroid:"head2",
  liver: "default",
  lungs:"default",

  
};

// Maps each view/button to the name of the MATERIAL SLOT (assigned to a
// group of faces in Blender) that should light up when that pose is
// active. This is a separate mapping from POSE_ACTION_NAMES above on
// purpose -- the pose clip for the arms button is named "arm" (singular),
// but the material slot covering that same area is named "hands" (see
// female-rigged-nomeshsculpt3-best.glb's material list). "reset" has no highlighted region
// at all -- clicking it turns every highlight off.
const HIGHLIGHT_REGION_NAMES: Record<ViewKey, string | null> = {
  reset: null,
  head2: "femalebrain",
  heart: "femaleheart",
  arms: "femalearms",
  kidney: "femalekidney",
  thyroid:"femalethyroid",
  liver: "femaleliver",
  lungs:"femalelungs",
  
};

// ---------------------------------------------------------------------
// Dotted look. The body itself is invisible -- only a regular grid of
// dots printed on the skin is drawn, with the page background showing
// between them. See patchDotMaterial for how it works.
// ---------------------------------------------------------------------

// Resting dot color: a soft, low-saturation cyan that sits well on the
// white page.
const DOT_COLOR = "#7cc3cc";
// Dot color inside whichever region is currently highlighted. The dots
// in that region fade from DOT_COLOR to this (and grow slightly, see
// DOT_HIGHLIGHT_GROW); switching regions fades the old one back to
// DOT_COLOR at the same time. The skin itself is never tinted.
const HIGHLIGHT_COLOR = "#22b585";

// Distance between neighboring dots (rows and columns), in the GLB's own
// unscaled units -- the female model is ~4.43 units tall, so 0.018 is
// ~6.5mm on the rendered body (~250 rows head to toe). Smaller = finer.
const DOT_SPACING = 0.018;
// Dot radius as a fraction of DOT_SPACING (0.5 = neighbors touch), for
// fully lit skin (MIN) and for skin in shadow / inside crevices (MAX).
// Halftone: the darker a spot is lit, the bigger its dot.
const DOT_MIN_RADIUS = 0.17;
const DOT_MAX_RADIUS = 0.36;
// Dot opacity for fully lit (MIN) and fully shadowed (MAX) skin.
const DOT_MIN_OPACITY = 0.6;
const DOT_MAX_OPACITY = 1;
// Which lit brightness counts as "in shadow" (at or below DOT_LIGHT_DARK:
// MAX radius/opacity) and "fully lit" (at or above DOT_LIGHT_BRIGHT: MIN
// radius/opacity), smoothly in between. Brightness is the luminance of
// the skin's final lit color (all lights + crevice darkening), before
// tone mapping. Raise both to make dots bigger overall, lower both for
// smaller; pull them apart for a gentler size range.
const DOT_LIGHT_DARK = 0.25;
const DOT_LIGHT_BRIGHT = 1.15;
// Inside the highlighted region, dots grow by this factor and are at
// least this opaque.
const DOT_HIGHLIGHT_GROW = 1.25;
const DOT_HIGHLIGHT_OPACITY = 0.95;
// The grid is projected onto the body from the front/back, the sides and
// above/below -- whichever the skin faces most -- with rows always
// horizontal. Where the skin turns from facing one way to another (e.g.
// the side of the torso, the top of the chest) each grid's dots shrink
// away toward the switch; higher = narrower band of shrunken dots.
const DOT_PROJECTION_SHARPNESS = 8;

// How far (in the model's own unscaled local units -- the same space
// MAN_MESH_SCALE is later applied to) a highlighted region's color bleeds
// past its original Blender material-slot boundary before fading to
// nothing. This is what turns the old hard per-material-slot cutoff into
// a smooth gradient: every vertex on the WHOLE mesh (not just the ones in
// the active material slot) gets a 0..1 weight based on its distance to
// the nearest vertex that belongs to the active region, eased with a
// smoothstep, and that weight is what actually drives the color blend.
// Bigger = softer/wider halo around the region, smaller = tighter to the
// original slot's edge.
const HIGHLIGHT_BLEND_RADIUS = 0.35;

// Per-region overrides for the radius above -- keyed by the same material
// slot name used in HIGHLIGHT_REGION_NAMES (e.g. "head3", "kidney4"), NOT
// the view key. Any region left out of this map just uses
// HIGHLIGHT_BLEND_RADIUS. Handy for small/deep organs (kidney, thyroid)
// that want a tighter halo, or a big one (liver) that wants more spread.
const HIGHLIGHT_BLEND_RADIUS_OVERRIDES: Record<string, number> = {
  femalethyroid: 0.1,
  femaleheart: 0.2,
  femalekidney: 0.2,
  femaleliver: 0.15,
  femalebrain: 0.25,
  femalelungs: 0.15,

};

function getHighlightBlendRadius(regionName: string): number {
  return HIGHLIGHT_BLEND_RADIUS_OVERRIDES[regionName] ?? HIGHLIGHT_BLEND_RADIUS;
}

// How fast the color transition eases in when switching views, in
// roughly 1/seconds -- same exponential-decay idiom as POSE_BLEND_SPEED
// above, just driving a single blend scalar instead of animation weights.
// Higher = snappier. 4 -> the dot colors are ~95% faded after ~0.75s.
const HIGHLIGHT_FADE_SPEED = 4;

// Man_Mesh clean3.glb's own mesh is ~4.96 units tall, but every camera target/
// distance above (e.g. head target y=1.68) was tuned assuming a roughly
// 1.8-unit-tall human, matching the old male_7.glb. Rather than re-tune
// every camera number, we shrink the model itself on import. Cleanest
// long-term fix is applying scale in Blender before export instead
// (Object > Apply > Scale) -- then this constant can go back to 1.
const MAN_MESH_SCALE = 1.8 / 4.96;

// How fast each pose's blend weight converges toward its target (1 if
// it's the active pose, 0 otherwise), in roughly 1/seconds. Lower = 
// slower/dreamier transitions, higher = snappier. This is exponential
// decay (see PosableModel's useFrame), so there's no fixed "done" time --
// as a rule of thumb a pose is ~95% settled after about 3/POSE_BLEND_SPEED
// seconds. 2.2 -> ~1.4s to mostly settle (slower than the previous fixed
// 0.4s linear fade); try 1.5 for even slower, or 4+ for snappier.
const POSE_BLEND_SPEED = 2.2;

// Scene fog color (kept light/neutral so it blends cleanly with the CSS
// radial-gradient page background behind the transparent canvas).
const FOG_COLOR = "#E6F5F9";

// CSS radial gradient behind the canvas, centered at the bottom of the
// viewport and fading from the pale cyan tint out to white.
const PAGE_BACKGROUND =
  "#f9f9f9";

// ---------------------------------------------------------------------
// Per-button grade ring. Mirrors the same S/A/B/C/D/E/F -> segments/color
// mapping used for the big score ring on the main page, just drawn small
// and placed next to each sidebar button's label. Kept self-contained
// here (rather than imported from the page) since this component only
// needs the score number, passed in via the `scores` prop below.
// ---------------------------------------------------------------------
type StatusColor = "green" | "yellow" | "red";

const BUTTON_RING_RADIUS = 27;
const BUTTON_RING_CIRCUMFERENCE = 2 * Math.PI * BUTTON_RING_RADIUS;
const BUTTON_RING_SEGMENT_COUNT = 6;
const BUTTON_RING_SEGMENT_GAP = 4;
const BUTTON_RING_SEGMENT_LENGTH =
  (BUTTON_RING_CIRCUMFERENCE - BUTTON_RING_SEGMENT_COUNT * BUTTON_RING_SEGMENT_GAP) /
  BUTTON_RING_SEGMENT_COUNT;
const BUTTON_RING_TRACK_COLOR = "#e5e7eb";

// Same thresholds as the main page's getGradeLetter.
function getGradeLetter(score: number): string {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 40) return "C";
  if (score >= 25) return "D";
  if (score >= 10) return "E";
  return "F";
}

const BUTTON_RING_SCORE_HEX: Record<StatusColor, string> = {
  green: "#24bd89",
  yellow: "#eab308",
  red: "#ef4444",
};

// Same grade -> {segments, color} mapping as the main page's
// GRADE_RING_CONFIG: S = all 6 segments green, A = 5 segments green,
// B = 4 segments yellow, C = 3 segments yellow, D = 2 segments red,
// E = 1 segment red, F = 0 segments (all gray/incomplete).
const BUTTON_GRADE_RING_CONFIG: Record<string, { segments: number; color: StatusColor }> = {
  S: { segments: 6, color: "green" },
  A: { segments: 5, color: "green" },
  B: { segments: 4, color: "yellow" },
  C: { segments: 3, color: "yellow" },
  D: { segments: 2, color: "red" },
  E: { segments: 1, color: "red" },
  F: { segments: 0, color: "red" },
};

// Small segmented ring shown to the left of each sidebar button's label,
// filled in according to that body part's grade (complete ring for a
// top grade, fewer colored segments -- and more gray -- for a lower one),
// with the grade letter itself centered inside the ring.
function ButtonGradeRing({ score }: { score: number }) {
  const gradeLetter = getGradeLetter(score);
  const config = BUTTON_GRADE_RING_CONFIG[gradeLetter];
  const hex = BUTTON_RING_SCORE_HEX[config.color];

  return (
    <span className="relative inline-flex h-5 w-5 sm:h-6 sm:w-6 shrink-0 items-center justify-center">
      <svg
        className="absolute inset-0 h-full w-full -rotate-90"
        viewBox="0 0 60 60"
      >
        {Array.from({ length: BUTTON_RING_SEGMENT_COUNT }).map((_, i) => {
          const isFilled = i < config.segments;
          return (
            <circle
              key={i}
              cx="30"
              cy="30"
              r={BUTTON_RING_RADIUS}
              fill="none"
              stroke={isFilled ? hex : BUTTON_RING_TRACK_COLOR}
              strokeWidth="6"
              strokeDasharray={`${BUTTON_RING_SEGMENT_LENGTH} ${
                BUTTON_RING_CIRCUMFERENCE - BUTTON_RING_SEGMENT_LENGTH
              }`}
              strokeDashoffset={-(i * (BUTTON_RING_SEGMENT_LENGTH + BUTTON_RING_SEGMENT_GAP))}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <span
        className="relative text-sm sm:text-[12px] font-semibold leading-none"
        style={{ color: hex }}
      >
        {gradeLetter}
      </span>
    </span>
  );
}

interface MeshVertexData {
  mesh: Mesh;
  // Bind-pose / local-space positions (NOT world space, and NOT affected
  // by skinning -- a SkinnedMesh's geometry.attributes.position always
  // stays in rest pose; the bone transforms happen in the vertex shader
  // at render time). Using this space means the gradient only needs to be
  // computed once, and stays correct no matter what pose is playing.
  positions: Float32Array;
  // The original Blender material-slot name this submesh was assigned
  // (e.g. "head", "hands", "heart", "default").
  regionName: string;
}

/**
 * The Blender material-slot name a mesh was exported with. Read from the
 * GLB's original material the first time, then remembered in userData --
 * PosableModel swaps every mesh's material for an [occluder, dots] pair,
 * so after that the original material (and its name) is gone. Remembering
 * it keeps the highlight regions working if the setup effect runs again
 * on the same cached scene (React StrictMode, hot reload, remount).
 */
function getRegionName(mesh: Mesh): string {
  if (typeof mesh.userData.regionName !== "string") {
    const original = mesh.material as Material | Material[] | undefined;
    const first = Array.isArray(original) ? original[0] : original;
    mesh.userData.regionName = first?.name ?? "";
  }
  return mesh.userData.regionName as string;
}

function collectMeshVertexData(scene: Group): MeshVertexData[] {
  const result: MeshVertexData[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const posAttr = mesh.geometry?.attributes?.position;
    if (!posAttr) return;
    result.push({
      mesh,
      positions: new Float32Array(posAttr.array as ArrayLike<number>),
      regionName: getRegionName(mesh),
    });
  });
  return result;
}

/**
 * Uniform spatial hash over a point cloud, sized so cell width == the
 * query radius -- meaning any point within `radius` of a query position
 * is guaranteed to be in one of the 3x3x3 neighboring cells. Lets
 * buildVertexHighlightFields below find "nearest seed point, if any
 * within radius" in roughly constant time per query instead of checking
 * every seed vertex against every mesh vertex (which, at tens of
 * thousands of vertices per side, would be far too slow to run in-browser
 * on load).
 */
class PointGrid {
  private cellSize: number;
  private cells = new Map<string, number[]>();

  constructor(private points: Float32Array, radius: number) {
    this.cellSize = radius;
    const count = points.length / 3;
    for (let i = 0; i < count; i++) {
      const key = this.keyFor(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private keyFor(x: number, y: number, z: number) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cy},${cz}`;
  }

  /** Squared distance to the nearest point within `radius`, or Infinity. */
  nearestDistSq(x: number, y: number, z: number, radius: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const radiusSq = radius * radius;
    let best = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const px = this.points[i * 3];
            const py = this.points[i * 3 + 1];
            const pz = this.points[i * 3 + 2];
            const ddx = px - x, ddy = py - y, ddz = pz - z;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq < best) best = distSq;
          }
        }
      }
    }

    return best <= radiusSq ? best : Infinity;
  }
}

/**
 * For each named region (e.g. "head"), and for every vertex on the WHOLE
 * model (every submesh, not just the one wearing that material slot),
 * computes a 0..1 weight: 1 right at the region, smoothly easing down to
 * 0 at `radius` units away, 0 beyond that. This is the piece that
 * replaces the old "swap this submesh's material" approach -- because the
 * weight is computed per-vertex from real geometric distance rather than
 * per-submesh, color can now bleed smoothly across a seam between two
 * material slots instead of cutting off exactly at it.
 *
 * Returns a Map from mesh.uuid to { [regionName]: Float32Array }, one
 * weight per vertex of that mesh, aligned to that mesh's own vertex order
 * so it can be dropped straight into a BufferAttribute.
 *
 * `getRadius(region)` is called once per region so different regions can
 * use different blend radii (e.g. a tight halo for the thyroid, a wider
 * one for the liver) -- see HIGHLIGHT_BLEND_RADIUS_OVERRIDES.
 */
function buildVertexHighlightFields(
  scene: Group,
  regionNames: string[],
  getRadius: (region: string) => number
): Map<string, Record<string, Float32Array>> {
  const meshData = collectMeshVertexData(scene);
  const result = new Map<string, Record<string, Float32Array>>();

  for (const region of regionNames) {
    const radius = getRadius(region);
    const seedChunks = meshData
      .filter((m) => m.regionName === region)
      .map((m) => m.positions);
    const seedCount = seedChunks.reduce((n, c) => n + c.length / 3, 0);
    if (seedCount === 0) continue;

    const seedPositions = new Float32Array(seedCount * 3);
    let offset = 0;
    for (const chunk of seedChunks) {
      seedPositions.set(chunk, offset);
      offset += chunk.length;
    }
    const grid = new PointGrid(seedPositions, radius);

    for (const { mesh, positions } of meshData) {
      const vertCount = positions.length / 3;
      const weights = new Float32Array(vertCount);
      for (let i = 0; i < vertCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        const distSq = grid.nearestDistSq(x, y, z, radius);
        if (distSq === Infinity) continue; // stays 0
        const t = Math.min(1, Math.sqrt(distSq) / radius);
        weights[i] = 1 - t * t * (3 - 2 * t); // smoothstep falloff
      }
      const entry = result.get(mesh.uuid) ?? {};
      entry[region] = weights;
      result.set(mesh.uuid, entry);
    }
  }

  return result;
}

// ---------------------------------------------------------------------
// Crevice darkening (per-vertex ambient occlusion, baked in-browser).
//
// Real-time lights only look at which way a surface faces, never at
// whether the body itself is in the way -- so the inside walls of the
// nostrils (and ears, eye sockets, between fingers) get lit by every
// light they face, often brighter than the skin around them. To fix
// that, every vertex gets a 0..1 "how open is this point" value: 1 out
// in the open, near 0 deep inside a cavity. The patched material then
// multiplies ALL of the final light (every directional light + the
// hemisphere fill, diffuse and specular) by it, so adding more soft fill
// lights can never brighten the crevices again.
//
// Computed once on load by casting short rays from each vertex out over
// the hemisphere around its normal (through a BVH so it stays fast), in
// the GLB's rest pose -- like the highlight fields, it doesn't need
// recomputing per pose. Measured at ~1.2s total for the ~17k-vertex
// female model at 16 rays, so it's spread across frames (see
// AO_BAKE_BUDGET_MS) instead of freezing the page, and fades in when done.
// ---------------------------------------------------------------------

// Rays per vertex. 16 + the smoothing pass below gave the same darkness
// distribution as 32 at half the cost. More = smoother, slower load.
const AO_RAY_COUNT = 16;
// How far a ray looks for blocking geometry, in the GLB's own unscaled
// units (the female model is ~4.43 units tall, so 0.1 is a few cm on the
// rendered body). Big enough to catch nostrils, ears and eye sockets;
// raise it to also darken broader areas like armpits / between the legs.
const AO_RAY_DISTANCE = 0.08;
// Nudges each ray's start off the surface so it doesn't hit its own
// triangle. Same units as AO_RAY_DISTANCE.
const AO_RAY_BIAS = 0.002;
// How dark the darkest crevices get: 0 = off, 1 = pure black. Clamped to
// 0..1 in the shader -- above 1 the blend overshoots into negative light
// and whole recessed areas (e.g. the eyes) turn solid black.
const AO_STRENGTH = 0.6;
// Which baked values count as a crevice. Measured on the female model at
// AO_RAY_DISTANCE 0.08: nostrils ~0.15-0.25, lip line ~0.25-0.5, eyes
// (recessed behind the lids) ~0.6-0.7, open skin 1. Anything at or below
// AO_DARK_BELOW gets the full AO_STRENGTH darkening, anything at or above
// AO_LIGHT_ABOVE gets none, smoothly in between -- so the nostrils always
// go dark while the eyes stay as bright as the rest of the face. Raise
// AO_LIGHT_ABOVE past ~0.7 to let the eye sockets darken too.
const AO_DARK_BELOW = 0.02;
const AO_LIGHT_ABOVE = 1.3;
// Fade-in speed once the bake finishes, same exponential-decay idiom as
// HIGHLIGHT_FADE_SPEED.
const AO_FADE_SPEED = 3;
// Max milliseconds of bake work per animation frame.
const AO_BAKE_BUDGET_MS = 8;

/**
 * Generator so the caller can run it a slice at a time (it yields every
 * few dozen vertices). Returns a Map from mesh.uuid to one 0..1 openness
 * value per vertex, in that mesh's own vertex order -- same shape as the
 * highlight fields, so it drops straight into a BufferAttribute.
 */
function* bakeVertexOcclusion(
  scene: Group
): Generator<void, Map<string, Float32Array>, void> {
  scene.updateMatrixWorld(true);

  const meshes: Mesh[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const { position, normal } = mesh.geometry.attributes;
    if (position && normal) meshes.push(mesh);
  });
  if (meshes.length === 0) return new Map();

  // Merge every submesh (material slot) into one triangle soup, so a ray
  // from the body can be blocked by any slot -- e.g. a nostril vertex in
  // "Scene_-_Root" by the "femalebrain" faces.
  //
  // The shared space is the FIRST mesh's own geometry space, NOT the
  // scene's: the body is skinned under an "Armature" node scaled ~0.026,
  // which the bones cancel out at render time -- so in scene space the
  // bind-pose geometry is ~38x too small and every AO_* distance below
  // would be off by that much (rays started outside the nostrils and
  // never registered them). In geometry space the body is ~4.43 units
  // tall, which is what AO_RAY_DISTANCE / AO_RAY_BIAS are tuned against.
  const referenceInverse = new Matrix4().copy(meshes[0].matrixWorld).invert();
  let vertTotal = 0;
  let indexTotal = 0;
  for (const mesh of meshes) {
    const count = mesh.geometry.attributes.position.count;
    vertTotal += count;
    indexTotal += mesh.geometry.index?.count ?? count;
  }
  const positions = new Float32Array(vertTotal * 3);
  const normals = new Float32Array(vertTotal * 3);
  const index = new Uint32Array(indexTotal);
  const toReference = new Matrix4();
  const normalMatrix = new Matrix3();
  const v = new Vector3();
  let vertOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    const { position, normal } = mesh.geometry.attributes;
    toReference.multiplyMatrices(referenceInverse, mesh.matrixWorld);
    normalMatrix.getNormalMatrix(toReference);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toReference);
      v.toArray(positions, (vertOffset + i) * 3);
      v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      v.toArray(normals, (vertOffset + i) * 3);
    }
    const srcIndex = mesh.geometry.index;
    const count = srcIndex?.count ?? position.count;
    for (let i = 0; i < count; i++) {
      index[indexOffset + i] = (srcIndex ? srcIndex.getX(i) : i) + vertOffset;
    }
    vertOffset += position.count;
    indexOffset += count;
  }

  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setIndex(new BufferAttribute(index, 1));
  const bvh = new MeshBVH(merged);
  yield;

  // Cosine-weighted directions over the +Z hemisphere (golden-angle
  // spiral), so every hit counts equally and grazing rays matter least --
  // the same weighting diffuse light itself has.
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const samples: Vector3Tuple[] = [];
  for (let s = 0; s < AO_RAY_COUNT; s++) {
    const u = (s + 0.5) / AO_RAY_COUNT;
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
      ray.origin.set(px + nx * AO_RAY_BIAS, py + ny * AO_RAY_BIAS, pz + nz * AO_RAY_BIAS);
      ray.direction.set(
        tx * sx + bx * sy + nx * sz,
        ty * sx + by * sy + ny * sz,
        tz * sx + bz * sy + nz * sz
      );
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, AO_RAY_DISTANCE);
      // Closer blockers occlude more -- softens the edge of each cavity.
      if (hit) occluded += 1 - hit.distance / AO_RAY_DISTANCE;
    }
    openness[i] = 1 - occluded / AO_RAY_COUNT;

    if ((i & 31) === 31) yield;
  }
  merged.dispose();

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
  const smoothed = new Float32Array(weldCount);
  for (let w = 0; w < weldCount; w++) {
    smoothed[w] =
      (own[w] * SELF_WEIGHT + neighborSum[w]) / (SELF_WEIGHT + neighborCount[w]);
  }

  const result = new Map<string, Float32Array>();
  let offset = 0;
  for (const mesh of meshes) {
    const count = mesh.geometry.attributes.position.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) values[i] = smoothed[weldIds[offset + i]];
    result.set(mesh.uuid, values);
    offset += count;
  }
  return result;
}

// Uniforms shared by every mesh's dot material, so changing a value once
// (e.g. easing uBlend in useFrame) updates the whole body at once.
interface DotUniforms {
  [name: string]: { value: unknown };
  uBlend: { value: number };
  uAOStrength: { value: number };
  uAODarkBelow: { value: number };
  uAOLightAbove: { value: number };
  uDotColor: { value: Color };
  uHighlightColor: { value: Color };
  uDotSpacing: { value: number };
  uDotMinRadius: { value: number };
  uDotMaxRadius: { value: number };
  uDotMinOpacity: { value: number };
  uDotMaxOpacity: { value: number };
  uDotLightDark: { value: number };
  uDotLightBright: { value: number };
  uDotHighlightGrow: { value: number };
  uDotHighlightOpacity: { value: number };
  uDotProjectionSharpness: { value: number };
}

function createDotUniforms(): DotUniforms {
  return {
    uBlend: { value: 0 },
    // Starts at 0 (no crevice darkening) and eases up to AO_STRENGTH in
    // useFrame once the occlusion bake has finished.
    uAOStrength: { value: 0 },
    uAODarkBelow: { value: AO_DARK_BELOW },
    uAOLightAbove: { value: AO_LIGHT_ABOVE },
    uDotColor: { value: new Color(DOT_COLOR) },
    uHighlightColor: { value: new Color(HIGHLIGHT_COLOR) },
    uDotSpacing: { value: DOT_SPACING },
    uDotMinRadius: { value: DOT_MIN_RADIUS },
    uDotMaxRadius: { value: DOT_MAX_RADIUS },
    uDotMinOpacity: { value: DOT_MIN_OPACITY },
    uDotMaxOpacity: { value: DOT_MAX_OPACITY },
    uDotLightDark: { value: DOT_LIGHT_DARK },
    uDotLightBright: { value: DOT_LIGHT_BRIGHT },
    uDotHighlightGrow: { value: DOT_HIGHLIGHT_GROW },
    uDotHighlightOpacity: { value: DOT_HIGHLIGHT_OPACITY },
    uDotProjectionSharpness: { value: DOT_PROJECTION_SHARPNESS },
  };
}

/**
 * The invisible half of the dotted look. Drawn first (it's opaque, the
 * dots are transparent, and three always draws opaque before
 * transparent), it writes the body's depth but no color -- so the page
 * background stays visible, yet anything behind the body's front surface
 * (the back of the torso, the far arm, dots on the other side) fails the
 * depth test and is hidden. That's what stops the dots looking x-rayed.
 *
 * The polygon offset pushes its depth a hair further away, so the dots --
 * drawn on the exact same triangles by a different shader program, which
 * the GPU isn't required to rasterize to bit-identical depth -- always
 * pass the depth test on top of it instead of flickering in and out.
 */
function createOccluderMaterial(regionName: string): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  material.name = `${regionName}-occluder`;
  material.userData.dotLook = true;
  return material;
}

/**
 * The visible half of the dotted look: a MeshStandardMaterial patched
 * (via onBeforeCompile, the standard three.js hook) to throw away every
 * pixel that isn't inside a dot.
 *
 * - The dot grid is laid out in the mesh's REST-POSE geometry (the raw
 *   `position` attribute, before skinning), not on screen or in world
 *   space -- so the dots are printed on the skin like a tattoo and move,
 *   bend and stretch with it in every pose instead of sliding over it.
 *   `dotSpace` maps this mesh's geometry into one shared reference space
 *   (the first mesh's), so the grid lines up across material-slot seams.
 * - The grid is projected from whichever axis the skin faces most (see
 *   DOT_PROJECTION_SHARPNESS), with rows always horizontal.
 * - The full lighting (every light, shadows, and the baked crevice
 *   darkening, see bakeVertexOcclusion) is still computed, but only used
 *   to size the dots: the darker the spot, the bigger and more opaque
 *   its dot. The dots themselves are flat DOT_COLOR.
 * - Inside the highlighted region (per-vertex weight, the mix of
 *   aHighlightFrom/aHighlightTo driven by uBlend) the dots fade to
 *   HIGHLIGHT_COLOR and grow a little.
 * - Dot edges are anti-aliased from screen-space derivatives, and dots
 *   squashed too small to draw cleanly (skin turning edge-on to the
 *   camera) fade out instead of shimmering (moire).
 */
function createDotMaterial(
  regionName: string,
  uniforms: DotUniforms,
  dotSpace: Matrix4
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    // Only feeds the lighting that sizes the dots; never shown.
    color: "#fff",
    roughness: 0.75,
    metalness: 0,
    transparent: true,
    // The occluder already wrote the body's depth.
    depthWrite: false,
  });
  material.name = regionName;
  material.userData.dotLook = true;
  const dotNormalSpace = new Matrix3().getNormalMatrix(dotSpace);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uDotSpace: { value: dotSpace },
      uDotNormalSpace: { value: dotNormalSpace },
    });

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aHighlightFrom;
        attribute float aHighlightTo;
        attribute float aOcclusion;
        uniform float uBlend;
        uniform mat4 uDotSpace;
        uniform mat3 uDotNormalSpace;
        varying float vHighlight;
        varying float vOcclusion;
        varying vec3 vDotPos;
        varying vec3 vDotNormal;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vHighlight = mix( aHighlightFrom, aHighlightTo, uBlend );
        vOcclusion = aOcclusion;
        vDotPos = ( uDotSpace * vec4( position, 1.0 ) ).xyz;
        vDotNormal = uDotNormalSpace * normal;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uAOStrength;
        uniform float uAODarkBelow;
        uniform float uAOLightAbove;
        uniform vec3 uDotColor;
        uniform vec3 uHighlightColor;
        uniform float uDotSpacing;
        uniform float uDotMinRadius;
        uniform float uDotMaxRadius;
        uniform float uDotMinOpacity;
        uniform float uDotMaxOpacity;
        uniform float uDotLightDark;
        uniform float uDotLightBright;
        uniform float uDotHighlightGrow;
        uniform float uDotHighlightOpacity;
        uniform float uDotProjectionSharpness;
        varying float vHighlight;
        varying float vOcclusion;
        varying vec3 vDotPos;
        varying vec3 vDotNormal;

        // Coverage (0..1) of one projected dot grid at p (the 2 projected
        // coordinates, in geometry units). normalAB / normalK are the
        // skin normal's components along those 2 axes / along the
        // projection axis. radius is a fraction of the spacing.
        float dotGridCoverage( vec2 p, vec2 normalAB, float normalK, float radius ) {
          vec2 cell = p / uDotSpacing;
          // How far one screen pixel moves in cell units, along screen x
          // and y. Taken from the continuous cell coordinate -- never from
          // the distance to the dot center, which jumps at every cell
          // border and would draw faint grid lines between the dots.
          vec2 cellPerPxX = dFdx( cell );
          vec2 cellPerPxY = dFdy( cell );
          // Distance to the dot center measured ON THE SKIN (its tangent
          // plane), not in the flat projection: a projected grid stretches
          // dots into dashes wherever the skin slopes away from the
          // projection axis; adding back the depth the slope implies keeps
          // every dot round.
          vec2 slope = normalAB / max( abs( normalK ), 0.2 );
          vec2 offset = fract( cell ) - 0.5;
          vec3 onSkin = vec3( offset, dot( slope, offset ) );
          float dist = length( onSkin );
          // Exact width of one pixel across this dot's edge, in the same
          // units -- also right for dots squashed into ellipses where the
          // skin turns away from the camera, so edges stay crisp.
          vec3 pxX = vec3( cellPerPxX, dot( slope, cellPerPxX ) );
          vec3 pxY = vec3( cellPerPxY, dot( slope, cellPerPxY ) );
          vec3 outward = onSkin / max( dist, 1e-6 );
          float edge = 0.5 * max( length( vec2( dot( outward, pxX ), dot( outward, pxY ) ) ), 1e-6 );
          float coverage = 1.0 - smoothstep( radius - edge, radius + edge, dist );
          // Where dots get squashed under ~2-3 pixels apart (skin turning
          // edge-on to the camera) they can't be drawn without shimmering:
          // fade them out -- never into a solid tint, which would read as
          // see-through skin.
          float squash = max( length( pxX ), length( pxY ) );
          coverage *= 1.0 - smoothstep( 0.3, 0.5, squash );
          // A zero-radius dot must vanish completely (the anti-aliased
          // edge would otherwise leave a faint speck at its center).
          return coverage * smoothstep( 0.0, 0.04, radius );
        }`
      )
      .replace(
        "#include <opaque_fragment>",
        `float creviceOpen = smoothstep( uAODarkBelow, uAOLightAbove, vOcclusion );
        outgoingLight *= mix( 1.0, creviceOpen, clamp( uAOStrength, 0.0, 1.0 ) );

        // 1 = in shadow (biggest dots), 0 = fully lit (smallest).
        float lightLevel = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
        float shade = 1.0 - smoothstep( uDotLightDark, uDotLightBright, lightLevel );
        float highlight = clamp( vHighlight, 0.0, 1.0 );

        float dotRadius = mix( uDotMinRadius, uDotMaxRadius, shade );
        dotRadius *= mix( 1.0, uDotHighlightGrow, highlight );
        // Past 0.5 a dot would be clipped square by its cell border.
        dotRadius = clamp( dotRadius, 0.0, 0.48 );
        float dotOpacity = mix( uDotMinOpacity, uDotMaxOpacity, shade );
        dotOpacity = mix( dotOpacity, max( dotOpacity, uDotHighlightOpacity ), highlight );

        // Front/back faces use (x, y), sides (z, y), top/bottom (x, z):
        // rows stay horizontal everywhere but the top/bottom. Where the
        // skin turns from one to another, each grid's dots shrink away
        // toward the switch (instead of the two grids cross-fading into
        // overlapping ghost dots), leaving one tidy crease of small dots.
        vec3 skinNormal = normalize( vDotNormal );
        vec3 facing = pow( abs( skinNormal ), vec3( uDotProjectionSharpness ) );
        facing /= max( facing.x + facing.y + facing.z, 1e-6 );
        vec3 gridRadius = dotRadius * smoothstep( vec3( 0.4 ), vec3( 0.75 ), facing );
        float coverX = dotGridCoverage( vDotPos.zy, skinNormal.zy, skinNormal.x, gridRadius.x );
        float coverY = dotGridCoverage( vDotPos.xz, skinNormal.xz, skinNormal.y, gridRadius.y );
        float coverZ = dotGridCoverage( vDotPos.xy, skinNormal.xy, skinNormal.z, gridRadius.z );
        float coverage = 1.0 - ( 1.0 - coverX ) * ( 1.0 - coverY ) * ( 1.0 - coverZ );

        float dotAlpha = clamp( coverage * clamp( dotOpacity, 0.0, 1.0 ), 0.0, 1.0 );
        // Everything between the dots: let the page show through.
        if ( dotAlpha < 0.004 ) discard;
        gl_FragColor = vec4( mix( uDotColor, uHighlightColor, highlight ), dotAlpha );`
      );
  };
  // Every dot material compiles to identical shader source (all the
  // tunables are uniforms), so they can share one GPU program; each
  // material still gets its own uniforms (uDotSpace) from its own
  // onBeforeCompile. Bump the suffix if the shader code above changes.
  material.customProgramCacheKey = () => "dots-v3";
  return material;
}

/**
 * Rigged, posable model driven by view/button state. Looks up an
 * AnimationAction by name (via POSE_ACTION_NAMES) for the active view and
 * blends into it, holding as a still pose rather than looping. If the GLB
 * doesn't contain a clip with that name (see POSE_ACTION_NAMES), it just
 * logs a warning and leaves the model in whatever pose it was already in
 * -- it won't crash.
 *
 * Every named pose's weight is driven independently, every frame, toward
 * 1 (if it's the current target) or 0 (otherwise) -- see the useFrame
 * loop below. This is deliberately NOT a single "from/to" pair: pairing
 * up just two actions per click is what caused the earlier "stuck
 * mid-transition" bug -- if you clicked a third pose before the first
 * fade-out finished, that first pose's weight had nowhere left to go and
 * froze mid-fade, forever blended into everything after it. Recomputing
 * every action's weight independently every frame means there's no
 * "abandoned" state to get stuck in, no matter how fast or in what order
 * you click.
 *
 * The convergence itself is exponential decay toward the target weight
 * (the same `1 - Math.exp(-delta * k)` idiom CameraRig below uses for
 * camera easing) -- which is inherently an ease-out curve: fast initial
 * movement that tapers off as it approaches the target. POSE_BLEND_SPEED
 * controls how slow/fast that taper is.
 *
 * The camera itself is untouched here; CameraRig (unchanged, rendered
 * alongside this in ModelScene) keeps handling all camera movement.
 */
function PosableModel({
  modelPath,
  view,
}: {
  modelPath: string;
  view: ViewKey;
}) {
  // Three.js's AnimationAction API (`.play()`, `.setEffectiveWeight()`,
  // etc.) is inherently mutation-based -- that's just how it works, not a
  // bug -- so this component opts out of the React Compiler's memoization,
  // which otherwise flags those mutations as unsafe.
  "use no memo";

  const groupRef = useRef<Group>(null);
  const { scene, animations } = useGLTF(modelPath);
  const { actions, names } = useAnimations(animations, groupRef);
  // Name of whichever pose should currently be weighted toward 1. Every
  // OTHER named action is weighted toward 0. Read fresh each frame in
  // useFrame below -- this ref is the single source of truth for "which
  // pose are we in," nothing else needs to track transition state.
  const activeActionName = useRef<string | null>(null);

  // Per-vertex 0..1 weight fields for every highlightable region, keyed
  // by mesh.uuid then region name -- see buildVertexHighlightFields.
  // Computed once when the scene loads (not per view change), since the
  // fields only depend on the model's own geometry.
  const highlightFieldsRef = useRef<Map<string, Record<string, Float32Array>>>(
    new Map()
  );

  // Shared by every mesh's dot material (see createDotMaterial) so
  // animating uBlend / uAOStrength once in useFrame updates the whole
  // model at once.
  const [dotUniforms] = useState(createDotUniforms);
  // Target for uAOStrength -- flipped to AO_STRENGTH when the bake lands.
  const aoTargetStrength = useRef(0);

  // Swaps every mesh's material for the dotted look: an invisible
  // depth-only occluder plus the dot material on top (see
  // createOccluderMaterial / createDotMaterial). Both draw the same
  // triangles of the same skinned mesh -- via two geometry groups covering
  // the whole mesh, one per material -- so they share one skeleton and
  // can never drift apart in any pose. Each dot material keeps the
  // ORIGINAL Blender slot name (e.g. "femaleheart") as its name.
  //
  // This same effect also computes the smooth per-vertex highlight fields
  // (buildVertexHighlightFields) and attaches the aHighlightFrom/
  // aHighlightTo attributes every dot material reads from -- both are
  // one-time, geometry-driven setup, so they belong together and both key
  // off [scene] only (not [view]).
  useEffect(() => {
    const regionNames = Array.from(
      new Set(
        Object.values(HIGHLIGHT_REGION_NAMES).filter(
          (name): name is string => !!name
        )
      )
    );
    const fields = buildVertexHighlightFields(
      scene,
      regionNames,
      getHighlightBlendRadius
    );
    highlightFieldsRef.current = fields;

    const meshes: Mesh[] = [];
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    // One shared space for the dot grid, so it lines up across every
    // mesh: the first mesh's own geometry space (same reasoning as in
    // bakeVertexOcclusion -- y is up, ~4.43 units tall, which is what
    // DOT_SPACING is measured in).
    scene.updateMatrixWorld(true);
    const referenceInverse = meshes.length
      ? new Matrix4().copy(meshes[0].matrixWorld).invert()
      : new Matrix4();

    for (const mesh of meshes) {
      const { geometry } = mesh;
      const regionName = getRegionName(mesh);

      // Re-running on the same cached scene (StrictMode, hot reload,
      // remount): free the pair a previous run created. The GLB's own
      // original materials are left alone.
      const previous = mesh.material;
      for (const old of Array.isArray(previous) ? previous : [previous]) {
        if (old?.userData.dotLook) old.dispose();
      }

      const dotSpace = new Matrix4().multiplyMatrices(
        referenceInverse,
        mesh.matrixWorld
      );
      // Group 0 = occluder, group 1 = dots, each covering every triangle.
      const drawCount = geometry.index
        ? geometry.index.count
        : geometry.attributes.position.count;
      geometry.clearGroups();
      geometry.addGroup(0, drawCount, 0);
      geometry.addGroup(0, drawCount, 1);
      mesh.material = [
        createOccluderMaterial(regionName),
        createDotMaterial(regionName, dotUniforms, dotSpace),
      ];

      // castShadow: the body still shadows itself (nose onto upper lip,
      // chin onto neck, arms onto torso), which makes those dots bigger.
      // receiveShadow: the dot material's lighting includes those shadows.
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const vertCount = geometry.attributes.position.count;
      mesh.geometry.setAttribute(
        "aHighlightFrom",
        new BufferAttribute(new Float32Array(vertCount), 1)
      );
      mesh.geometry.setAttribute(
        "aHighlightTo",
        new BufferAttribute(new Float32Array(vertCount), 1)
      );
      // Fully open (1) until the occlusion bake below fills in real values.
      // Kept in place if a bake already filled it (e.g. a remount reusing
      // useGLTF's cached scene).
      if (!mesh.geometry.getAttribute("aOcclusion")) {
        mesh.geometry.setAttribute(
          "aOcclusion",
          new BufferAttribute(new Float32Array(vertCount).fill(1), 1)
        );
      }
    }
  }, [scene, dotUniforms]);

  // Bake the crevice darkening (see bakeVertexOcclusion) a few
  // milliseconds per frame so the page stays responsive while it runs,
  // then write the results into each mesh's aOcclusion attribute and let
  // useFrame fade the effect in. Cancelled cleanly if the model unmounts
  // mid-bake (or React's dev StrictMode double-runs this effect).
  useEffect(() => {
    const bake = bakeVertexOcclusion(scene);
    let frame = 0;

    const step = () => {
      const deadline = performance.now() + AO_BAKE_BUDGET_MS;
      while (performance.now() < deadline) {
        const next = bake.next();
        if (!next.done) continue;

        scene.traverse((obj) => {
          const mesh = obj as Mesh;
          if (!mesh.isMesh) return;
          const values = next.value.get(mesh.uuid);
          const attr = mesh.geometry.getAttribute("aOcclusion") as
            | BufferAttribute
            | undefined;
          if (!values || !attr) return;
          (attr.array as Float32Array).set(values);
          attr.needsUpdate = true;
        });
        aoTargetStrength.current = AO_STRENGTH;
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [scene]);

  // Button click (or initial mount) -- just record which pose SHOULD be
  // active. All the actual weight blending happens continuously in
  // useFrame below, driven off this ref, so this effect does no direct
  // animation work itself.
  useEffect(() => {
    const targetName = POSE_ACTION_NAMES[view];
    if (targetName && !actions[targetName]) {
      // eslint-disable-next-line no-console
      console.warn(
        `PosableModel: no action named "${targetName}" found in ${modelPath}. ` +
          `Available actions: ${names.length ? names.join(", ") : "(none)"}`
      );
    }
    activeActionName.current = targetName;
  }, [view, actions, names, modelPath]);

  // Re-target the dot color toward whichever region matches the active
  // view: that region's dots fade to HIGHLIGHT_COLOR while the previous
  // region's fade back to DOT_COLOR, at the same time. Rather than
  // snapping instantly, this freezes wherever the PREVIOUS blend had
  // actually gotten to (in case a rapid click interrupted an in-progress
  // fade) as the new starting point, then lets useFrame below ease uBlend
  // from 0 back to 1 -- same "no stuck mid-transition" reasoning as the
  // pose blending above, just for color.
  useEffect(() => {
    const activeRegion = HIGHLIGHT_REGION_NAMES[view];
    const fieldsByMesh = highlightFieldsRef.current;
    const blendSoFar = dotUniforms.uBlend.value;

    let warnedMissingRegion = false;

    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;

      const fromAttr = mesh.geometry.getAttribute("aHighlightFrom") as
        | BufferAttribute
        | undefined;
      const toAttr = mesh.geometry.getAttribute("aHighlightTo") as
        | BufferAttribute
        | undefined;
      if (!fromAttr || !toAttr) return;

      const fromArr = fromAttr.array as Float32Array;
      const toArr = toAttr.array as Float32Array;
      for (let i = 0; i < fromArr.length; i++) {
        fromArr[i] = fromArr[i] + (toArr[i] - fromArr[i]) * blendSoFar;
      }
      fromAttr.needsUpdate = true;

      const fields = fieldsByMesh.get(mesh.uuid);
      const target = activeRegion ? fields?.[activeRegion] : undefined;

      if (activeRegion && !target && !warnedMissingRegion) {
        warnedMissingRegion = true;
        // eslint-disable-next-line no-console
        console.warn(
          `PosableModel: no material slot named "${activeRegion}" found in ${modelPath}.`
        );
      }

      if (target) {
        toArr.set(target);
      } else {
        toArr.fill(0);
      }
      toAttr.needsUpdate = true;
    });

    dotUniforms.uBlend.value = 0;
  }, [view, scene, modelPath, dotUniforms]);

  useFrame((_state, delta) => {
    const activeName = activeActionName.current;
    const k = 1 - Math.exp(-delta * POSE_BLEND_SPEED);

    for (const name of names) {
      const action = actions[name];
      if (!action) continue;

      const isTarget = name === activeName;
      const targetWeight = isTarget ? 1 : 0;

      // Make sure a newly-targeted pose is actually playing -- weight
      // alone does nothing if the action was never started (or was fully
      // stopped after a previous fade-out).
      if (isTarget && !action.isRunning()) {
        action.reset();
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.enabled = true;
        action.play();
      }

      const current = action.getEffectiveWeight();
      // Skip the work entirely once an inactive pose has fully settled at
      // 0 -- otherwise every idle pose keeps computing a no-op every
      // frame forever.
      if (!isTarget && current <= 0.0001 && !action.isRunning()) continue;

      const next = current + (targetWeight - current) * k;
      action.setEffectiveWeight(next);

      // Fully faded out -- stop it so the mixer isn't still evaluating a
      // zero-weight action every frame, and so it's cleanly `!isRunning()`
      // next time it's picked as a target again.
      if (!isTarget && next <= 0.0001) {
        action.setEffectiveWeight(0);
        action.stop();
      }
    }

    // Ease the dot-color blend scalar from 0 toward 1 every frame.
    // Updating this one uniform is all it takes to fade every mesh's dots
    // at once, since they all share the same uniforms object (see
    // dotUniforms / createDotMaterial).
    const hk = 1 - Math.exp(-delta * HIGHLIGHT_FADE_SPEED);
    dotUniforms.uBlend.value += (1 - dotUniforms.uBlend.value) * hk;

    // Same easing for the crevice darkening, from 0 up to AO_STRENGTH
    // once the bake has landed (see aoTargetStrength).
    const ak = 1 - Math.exp(-delta * AO_FADE_SPEED);
    dotUniforms.uAOStrength.value +=
      (aoTargetStrength.current - dotUniforms.uAOStrength.value) * ak;
  });

  return (
    <group ref={groupRef} scale={MAN_MESH_SCALE}>
      <primitive object={scene} />
    </group>
  );
}

// Soft studio lighting: one shadow-casting light from the top, plus weak
// fills from below, left, right and behind to lift and soften what the
// top light leaves dark. The fills deliberately cast no shadows (cheaper,
// and their job is to soften) -- the crevice darkening above is what
// keeps nostrils/ears dark however many fills there are. Positions are
// mirrored 1:1 onto the <directionalLight>s in the JSX below; all aim at
// the origin (the model's feet).
//
// The overall look is high-key: bright, low-contrast fill so the white
// body melts into the white page background, with only the crevices
// (via the AO above) and soft partial shadows giving it shape.
//
// TOP (key): above and in front. ~45 degrees up rather than steeper, so
// the brow doesn't throw the eye sockets into deep shadow.
const TOP_LIGHT_POS: Vector3Tuple = [10, 45, 45];
const TOP_LIGHT_INTENSITY = 1.6;
// BOTTOM: weak, from below/front -- lifts under the chin and arms.
const BOTTOM_LIGHT_POS: Vector3Tuple = [0, -50, 40];
const BOTTOM_LIGHT_INTENSITY = 0.25;
// LEFT / RIGHT: side fills at roughly chest height, slightly in front.
const LEFT_LIGHT_POS: Vector3Tuple = [-60, 15, 20];
const LEFT_LIGHT_INTENSITY = 0.55;
const RIGHT_LIGHT_POS: Vector3Tuple = [60, 15, 20];
const RIGHT_LIGHT_INTENSITY = 0.55;
// BACK: rim light from behind and above, brightens the silhouette edge
// so it fades into the background instead of outlining it.
const BACK_LIGHT_POS: Vector3Tuple = [0, 40, -60];
const BACK_LIGHT_INTENSITY = 0.9;

// Sky/ground ambient (replaces the old flat ambientLight): surfaces
// facing up get the sky color, surfaces facing down the (only slightly
// darker) ground color. This is the main "softness" knob -- higher
// intensity / lighter ground = flatter, whiter, more washed into the bg.
const HEMI_SKY_COLOR = "#ffffff";
const HEMI_GROUND_COLOR = "#dcd9d5";
const HEMI_INTENSITY = 1.4;

// Top light's shadow. The default shadow camera covers 10x10 units -- at
// 2048px that's still ~5mm/texel; fitting it around the body (~1.6 tall
// after MAN_MESH_SCALE, at the origin) gives ~1mm. near/far bracket the
// light's ~64-unit distance for depth precision. radius blurs the edge
// (soft shadows with the "percentage" shadow type set on <Canvas>);
// intensity < 1 makes shadows only partially block the light, so they
// read as soft shading instead of dark patches; the biases suppress acne
// on the skinned mesh.
const TOP_LIGHT_SHADOW = {
  "shadow-mapSize": [2048, 2048] as [number, number],
  "shadow-camera-left": -1.2,
  "shadow-camera-right": 1.2,
  "shadow-camera-top": 1.2,
  "shadow-camera-bottom": -1.2,
  "shadow-camera-near": 55,
  "shadow-camera-far": 80,
  "shadow-radius": 8,
  "shadow-intensity": 0.1,
  "shadow-bias": -0.0005,
  "shadow-normalBias": 0.02,
};

function CameraRig({ view }: { view: ViewKey }) {
  const target = useRef(new Vector3(...VIEWS.reset.target));

  useFrame((state, dt) => {
    const { camera } = state;
    const k = 1 - Math.exp(-dt * 3.5);
    camera.position.lerp(new Vector3(...VIEWS[view].camPos), k);
    target.current.lerp(new Vector3(...VIEWS[view].target), k);
    camera.lookAt(target.current);
  });

  return null;
}

interface ModelSceneProps {
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
  // Each body part's 0-100 score, keyed by the same ViewKey used for the
  // camera/pose buttons -- drives the small grade ring drawn next to each
  // button's label. Passed down from the page, which already owns this
  // data in healthDataByView.
  scores: Record<ViewKey, number>;
}

export default function ModelScene({ view, onViewChange, scores }: ModelSceneProps) {
  return (
    <div
      className="relative w-full h-[60vh] sm:h-[60vh] lg:h-dvh lg:w-[70vw]"
      style={{ background: PAGE_BACKGROUND }}
    >
      <Canvas
        // "percentage" = PCFShadowMap. Plain `shadows` picks
        // PCFSoftShadowMap, which this three version has deprecated (it
        // warns and falls back anyway); softness comes from shadow-radius.
        shadows="percentage"
        gl={{ alpha: true }}
        // R3F defaults to ACES tone mapping, which pulls pure white down to
        // a light grey -- the model could never match the white page. The
        // Khronos "Neutral" curve keeps whites white, so brightly lit skin
        // blends into the background. (R3F only sets tone mapping once at
        // creation, so overriding it here sticks.)
        onCreated={({ gl }) => {
          gl.toneMapping = NeutralToneMapping;
        }}
        camera={{ position: VIEWS.reset.camPos, fov: 40 }}
        className="h-full w-full"
      >
        <fog attach="fog" args={[FOG_COLOR, 6, 16]} />

        <hemisphereLight
          args={[HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY]}
        />
        {/* Top (key) light -- the only one casting shadows. */}
        <directionalLight
          position={TOP_LIGHT_POS}
          intensity={TOP_LIGHT_INTENSITY}
          castShadow
          {...TOP_LIGHT_SHADOW}
        />
        {/* Soft fills: bottom, left, right, back. No shadows. */}
        <directionalLight position={BOTTOM_LIGHT_POS} intensity={BOTTOM_LIGHT_INTENSITY} />
        <directionalLight position={LEFT_LIGHT_POS} intensity={LEFT_LIGHT_INTENSITY} />
        <directionalLight position={RIGHT_LIGHT_POS} intensity={RIGHT_LIGHT_INTENSITY} />
        <directionalLight position={BACK_LIGHT_POS} intensity={BACK_LIGHT_INTENSITY} />

        <PosableModel key={MODEL_PATH} modelPath={MODEL_PATH} view={view} />
        <CameraRig view={view} />

        <ContactShadows
          position={[0, 0.001, 0]}
          opacity={0.55}
          scale={10}
          blur={2.5}
          far={4}
        />
      </Canvas>

      {/* <div className="pointer-events-none absolute inset-x-0 top-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          3D Human
        </h1>
      </div> */}

      <div className="absolute bottom-0 left-0 w-full h-[10vh] z-[999] pointer-events-none">
  <div className="w-full h-full bg-gradient-to-t from-[#f9f9f9] to-transparent" />
</div>

      <div className="absolute  top-1/2 -translate-y-1/2 left-1 sm:left-2  flex flex-col items-start justify-center gap-2 sm:gap-3 px-2 sm:px-4">
        {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
          <button
            key={key}
            onClick={() => onViewChange(key)}
            className={`flex items-center gap-1.5 sm:gap-2 rounded-full border pl-1 pr-3 py-1.5 text-sm sm:pl-1 sm:pr-3 sm:py-1 sm:text-sm font-medium  transition-colors ${
              view === key
                ? "border-blue-400/0 bg-white/50 text-black shadow-md shadow-black/5 backdrop-blur-2xl  hover:text-black"
                : "border-slate-300/0 bg-white/0 text-black/50 hover:bg-slate-100/0 hover:text-black"
            }`}
          >
            <ButtonGradeRing score={scores[key]} />
            {VIEWS[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}

useGLTF.preload(MODEL_PATH);

// (Man_Mesh clean3.glb ships with no built-in animation clips named "arm"/"head"/
// "heart" yet -- see chat for details. PosableModel above will still run
// fine, it just won't visibly repose until the GLB has those 3 clips.)