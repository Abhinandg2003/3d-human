"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, ContactShadows, useAnimations } from "@react-three/drei";
import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  DepthTexture,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LoopOnce,
  Matrix3,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  Ray,
  ShaderMaterial,
  SkinnedMesh,
  Texture,
  Triangle,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderTarget,
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
const MODEL_PATH = "/female-rigged-nomeshsculpt3-meshedited.glb";

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
  head2: "default",
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
// female-rigged-nomeshsculpt3-meshedited.glb's material list). "reset" has no highlighted region
// at all -- clicking it turns every highlight off.
const HIGHLIGHT_REGION_NAMES: Record<ViewKey, string | null> = {
  reset: null,
  head2: "femalebrainfinal",
  heart: "femaleheart",
  arms: "femalearms",
  kidney: "femalekidney",
  thyroid:"femalethyroid",
  liver: "femaleliver",
  lungs:"femalelungs",
  
};

// ---------------------------------------------------------------------
// Dotted look. The body itself is invisible -- only dots pinned to its
// skin are drawn, each one a flat round dot facing the screen, with the
// page background showing between them. See placeSurfaceDots and
// DOT_VERTEX_SHADER for how it works.
// ---------------------------------------------------------------------

// Resting dot color: a soft, low-saturation cyan that sits well on the
// white page.
const DOT_COLOR = "#7acaeb";
// Dot color inside whichever region is currently highlighted. The dots
// in that region fade from DOT_COLOR to this (and grow slightly, see
// DOT_HIGHLIGHT_GROW); switching regions fades the old one back to
// DOT_COLOR at the same time. The skin itself is never tinted.
const HIGHLIGHT_COLOR = "#f29450";

// Distance between neighboring dots (rows and columns), in the GLB's own
// unscaled units -- the female model is ~4.43 units tall, so 0.018 is
// ~6.5mm on the rendered body (~250 rows head to toe). Smaller = finer.
const DOT_SPACING = 0.018;
// Dot radius as a fraction of DOT_SPACING (0.5 = neighbors touch), for
// fully lit skin (MIN) and for skin in shadow / inside crevices (MAX).
// Halftone: the darker a spot is lit, the bigger its dot. Dots always
// face the screen, so this is their on-screen size wherever they sit.
const DOT_MIN_RADIUS = 0.17;
const DOT_MAX_RADIUS = 0.36;
// Dot opacity for fully lit (MIN) and fully shadowed (MAX) skin.
const DOT_MIN_OPACITY = 0.6;
const DOT_MAX_OPACITY = 1;
// Which lit brightness counts as "in shadow" (at or below DOT_LIGHT_DARK:
// MAX radius/opacity) and "fully lit" (at or above DOT_LIGHT_BRIGHT: MIN
// radius/opacity), smoothly in between. Brightness is the luminance of
// the diffuse light a white surface would get there (all lights, times
// the crevice darkening). Raise both to make dots bigger overall, lower
// both for smaller; pull them apart for a gentler size range.
const DOT_LIGHT_DARK = 0.25;
const DOT_LIGHT_BRIGHT = 1.15;
// Inside the highlighted region, dots grow by this factor and are at
// least this opaque.
const DOT_HIGHLIGHT_GROW = 1;
const DOT_HIGHLIGHT_OPACITY = 0.75;
// How far behind the body's visible surface (as a fraction of
// DOT_SPACING) a dot may sit and still show. Dots sit ON the surface, so
// this only absorbs depth precision; dots hidden behind another part of
// the body (an arm across the chest) are far beyond it.
const DOT_OCCLUSION_TOLERANCE = 1.5;
// Fade-in speed once the dots have been placed on load, same
// exponential-decay idiom as HIGHLIGHT_FADE_SPEED.
const DOT_REVEAL_SPEED = 3;

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
  femalebrainfinal: 0.25,
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
  const meshes: Mesh[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || mesh.userData.isDotCloud) return;
    if (mesh.geometry?.attributes?.position) meshes.push(mesh);
  });
  // Positions go into the body's geometry space (see meshToReferenceMatrix)
  // so a cap parented to the head sits next to the head's vertices, not
  // at its own local origin.
  scene.updateWorldMatrix(true, true);
  const reference = meshes.find((mesh) => (mesh as SkinnedMesh).isSkinnedMesh) ?? meshes[0];
  const toReference = new Matrix4();
  const v = new Vector3();
  return meshes.map((mesh) => {
    const posAttr = mesh.geometry.attributes.position;
    const positions = new Float32Array(posAttr.count * 3);
    meshToReferenceMatrix(mesh, reference, toReference);
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(toReference).toArray(positions, i * 3);
    }
    return { mesh, positions, regionName: getRegionName(mesh) };
  });
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
 * The body's own (source) meshes: every mesh in the GLB scene, but never
 * the dot clouds PosableModel adds next to them.
 */
function collectBodyMeshes(scene: Group): Mesh[] {
  const meshes: Mesh[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || mesh.userData.isDotCloud) return;
    const { position, normal } = mesh.geometry.attributes;
    if (position && normal) meshes.push(mesh);
  });
  return meshes;
}

/**
 * Every body mesh merged into one triangle soup with a BVH over it, in
 * one shared space -- used both to bake the crevice darkening and to
 * place the dots, so a ray can hit (or be blocked by) any material slot.
 *
 * The shared space is the FIRST mesh's own geometry space, NOT the
 * scene's: the body is skinned under an "Armature" node scaled ~0.026,
 * which the bones cancel out at render time -- so in scene space the
 * bind-pose geometry is ~38x too small and every AO_* / DOT_* distance
 * would be off by that much. In geometry space the body is ~4.43 units
 * tall (y up, facing +z), which is what those constants are tuned against.
 */
interface MergedSurface {
  meshes: Mesh[];
  // Where each mesh's vertices start in the merged arrays.
  vertOffsets: number[];
  // Index into `meshes` for every merged vertex.
  vertexMesh: Uint16Array;
  // Reference space -> each mesh's own geometry space, as a uniform
  // scale factor (distances only).
  referenceToMeshScale: number[];
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  vertTotal: number;
  indexTotal: number;
  geometry: BufferGeometry;
  bvh: MeshBVH;
}

/**
 * Where a skinned mesh's geometry is drawn when moved by bone `boneIndex`
 * alone (geometry -> world). A skinned mesh is placed by its bones, not
 * its node transform -- the bind matrices cancel that out (here: the
 * Armature's 0.026 scale) -- so this, not matrixWorld, is its real space.
 */
function boneSkinningMatrix(mesh: SkinnedMesh, boneIndex: number, target: Matrix4): Matrix4 {
  return target
    .copy(mesh.matrixWorld)
    .multiply(mesh.bindMatrixInverse)
    .multiply(mesh.skeleton.bones[boneIndex].matrixWorld)
    .multiply(mesh.skeleton.boneInverses[boneIndex])
    .multiply(mesh.bindMatrix);
}

/**
 * Maps `mesh`'s own geometry into `reference`'s geometry space (its
 * bind-pose shape), whatever pose the skeleton is in right now:
 * - another skinned mesh: through their shared skinning;
 * - a plain mesh hanging off one of the bones (e.g. a cap parented to the
 *   head): through THAT bone's skinning, so it lands on the skin it rides
 *   with even if a pose has already started blending in;
 * - anything else: through the root bone's skinning.
 */
function meshToReferenceMatrix(mesh: Mesh, reference: Mesh, target: Matrix4): Matrix4 {
  const ref = reference as SkinnedMesh;
  if (!ref.isSkinnedMesh || !ref.skeleton) {
    return target.copy(reference.matrixWorld).invert().multiply(mesh.matrixWorld);
  }
  const skinning = new Matrix4();
  const skinned = mesh as SkinnedMesh;
  if (skinned.isSkinnedMesh && skinned.skeleton) {
    boneSkinningMatrix(ref, 0, target).invert();
    return target.multiply(boneSkinningMatrix(skinned, 0, skinning));
  }
  let boneIndex = 0;
  for (let p = mesh.parent; p; p = p.parent) {
    const index = ref.skeleton.bones.indexOf(p as Bone);
    if (index >= 0) {
      boneIndex = index;
      break;
    }
  }
  return boneSkinningMatrix(ref, boneIndex, target).invert().multiply(mesh.matrixWorld);
}

function buildMergedSurface(meshes: Mesh[]): MergedSurface {
  for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
  for (const mesh of meshes) {
    (mesh as SkinnedMesh).skeleton?.bones.forEach((bone) => bone.updateWorldMatrix(true, false));
  }
  // The body (first skinned mesh) defines the shared space -- caps or
  // props parented to its bones can come first in the scene traversal.
  const reference = meshes.find((mesh) => (mesh as SkinnedMesh).isSkinnedMesh) ?? meshes[0];
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
  const vertexMesh = new Uint16Array(vertTotal);
  const vertOffsets: number[] = [];
  const referenceToMeshScale: number[] = [];
  const toReference = new Matrix4();
  const normalMatrix = new Matrix3();
  const scale = new Vector3();
  const v = new Vector3();
  let vertOffset = 0;
  let indexOffset = 0;
  meshes.forEach((mesh, meshIndex) => {
    const { position, normal } = mesh.geometry.attributes;
    meshToReferenceMatrix(mesh, reference, toReference);
    normalMatrix.getNormalMatrix(toReference);
    scale.setFromMatrixScale(toReference);
    referenceToMeshScale.push(3 / (scale.x + scale.y + scale.z));
    vertOffsets.push(vertOffset);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toReference);
      v.toArray(positions, (vertOffset + i) * 3);
      v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      v.toArray(normals, (vertOffset + i) * 3);
      vertexMesh[vertOffset + i] = meshIndex;
    }
    const srcIndex = mesh.geometry.index;
    const count = srcIndex?.count ?? position.count;
    for (let i = 0; i < count; i++) {
      index[indexOffset + i] = (srcIndex ? srcIndex.getX(i) : i) + vertOffset;
    }
    vertOffset += position.count;
    indexOffset += count;
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  // MeshBVH reorders this index's triangles in place -- fine, since every
  // user only needs "which triangles exist", never their original order.
  geometry.setIndex(new BufferAttribute(index, 1));
  const bvh = new MeshBVH(geometry);
  return {
    meshes,
    vertOffsets,
    vertexMesh,
    referenceToMeshScale,
    positions,
    normals,
    index,
    vertTotal,
    indexTotal,
    geometry,
    bvh,
  };
}

/**
 * Generator so the caller can run it a slice at a time (it yields every
 * few dozen vertices). Returns a Map from mesh.uuid to one 0..1 openness
 * value per vertex, in that mesh's own vertex order -- same shape as the
 * highlight fields.
 */
function* bakeVertexOcclusion(
  surface: MergedSurface
): Generator<void, Map<string, Float32Array>, void> {
  const { meshes, positions, normals, index, vertTotal, indexTotal, bvh } = surface;

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

// ---------------------------------------------------------------------
// Dot cloud. The body itself is never drawn in color. Instead, thousands
// of points are pinned to its skin (placed once, on a regular grid, see
// placeSurfaceDots), and each point is drawn as a flat round dot that
// always faces the screen -- never tilted with the skin -- sized by how
// brightly that spot is lit. Dots at the silhouette simply overhang it.
// ---------------------------------------------------------------------

// For each projection axis (X = sides, Y = top/bottom, Z = front/back):
// the two axes its grid runs along, rows (second) always being the
// vertical one where possible.
const DOT_GRID_AXES: [number, number][] = [
  [2, 1],
  [0, 2],
  [0, 1],
];

// Sealed-cavity culling. Patching a hole (mouth, nostrils, eyes) with a
// cap mesh leaves the old inner surfaces behind it, and the grid rays
// would dot those too -- they then show through the cap, since they sit
// within the occlusion tolerance behind it. So every candidate dot first
// checks it can see out of the body: rays fan out over the side its
// normal faces, then the other side (in case a normal is flipped), and the
// dot is kept once DOT_ESCAPE_RAYS_NEEDED of them leave the model without
// hitting anything. Open skin passes on its first rays; only dots sealed
// inside a cavity hit on every ray and are dropped.
const DOT_ESCAPE_RAY_COUNT = 16; // per side
// Needing more than one escape keeps a hairline gap between a cap and the
// skin from rescuing the cavity behind it.
const DOT_ESCAPE_RAYS_NEEDED = 2;

// Uniform directions over the +Z hemisphere, the most upright first, so
// open skin escapes on the first couple of tries.
const DOT_ESCAPE_SAMPLES: Vector3Tuple[] = (() => {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const samples: Vector3Tuple[] = [];
  for (let s = 0; s < DOT_ESCAPE_RAY_COUNT; s++) {
    const z = 1 - (s + 0.5) / DOT_ESCAPE_RAY_COUNT;
    const r = Math.sqrt(1 - z * z);
    samples.push([r * Math.cos(s * goldenAngle), r * Math.sin(s * goldenAngle), z]);
  }
  return samples;
})();

/**
 * Can the surface point p (normal n, unit length) see out of the model?
 * Returns how many rays it took (negative when it can't), so the caller
 * can account for the work when time-slicing.
 */
function surfaceEscapes(
  bvh: MeshBVH,
  ray: Ray,
  px: number,
  py: number,
  pz: number,
  nx0: number,
  ny0: number,
  nz0: number
): number {
  let escaped = 0;
  let fired = 0;
  for (const side of [1, -1]) {
    const nx = nx0 * side;
    const ny = ny0 * side;
    const nz = nz0 * side;
    // Tangent frame around n, as in bakeVertexOcclusion.
    const sign = nz >= 0 ? 1 : -1;
    const a = -1 / (sign + nz);
    const b = nx * ny * a;
    const tx = 1 + sign * nx * nx * a, ty = sign * b, tz = -sign * nx;
    const bx = b, by = sign + ny * ny * a, bz = -ny;
    for (const [sx, sy, sz] of DOT_ESCAPE_SAMPLES) {
      ray.origin.set(px + nx * AO_RAY_BIAS, py + ny * AO_RAY_BIAS, pz + nz * AO_RAY_BIAS);
      ray.direction.set(
        tx * sx + bx * sy + nx * sz,
        ty * sx + by * sy + ny * sz,
        tz * sx + bz * sy + nz * sz
      );
      fired++;
      if (!bvh.raycastFirst(ray, DoubleSide) && ++escaped >= DOT_ESCAPE_RAYS_NEEDED) {
        return fired;
      }
    }
  }
  return -fired;
}

/** The dots pinned to one body mesh, all in that mesh's own geometry space. */
interface DotCloudData {
  source: Mesh;
  count: number;
  // Rest-pose position (3 per dot) and normal (3 per dot) on the skin.
  anchors: Float32Array;
  normals: Float32Array;
  // Up to 4 bones per dot (4 per dot), blended from the 3 vertices of the
  // triangle the dot sits on -- so it moves exactly with the skin there.
  skinIndex: Float32Array | null;
  skinWeight: Float32Array | null;
  // The 3 source vertices of each dot's triangle (3 per dot) and the
  // dot's barycentric weights on it (3 per dot), to carry any per-vertex
  // value (highlight fields, crevice darkening) over to the dots.
  corners: Uint32Array;
  bary: Float32Array;
  // Multiplies DOT_SPACING (reference-space units) into this mesh's own
  // geometry units.
  referenceToMeshScale: number;
}

/**
 * Pins dots to the skin on a regular grid: rays are cast straight through
 * the body along each axis, one per grid cell (DOT_SPACING apart), and
 * every surface a ray crosses gets a dot -- but only if that surface faces
 * the ray's axis more than the other two, so each patch of skin is dotted
 * by exactly one grid. Front/back and sides give horizontal rows.
 *
 * Generator so the caller can run it a slice at a time.
 */
function* placeSurfaceDots(
  surface: MergedSurface
): Generator<void, DotCloudData[], void> {
  const { meshes, positions, normals, vertexMesh, vertOffsets, vertTotal, bvh } =
    surface;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertTotal; i++) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }

  const corners: number[][] = meshes.map(() => []);
  const barys: number[][] = meshes.map(() => []);
  const ray = new Ray();
  const triangle = new Triangle();
  const va = new Vector3();
  const vb = new Vector3();
  const vc = new Vector3();
  const bary = new Vector3();
  const origin = [0, 0, 0];
  const direction = [0, 0, 0];
  const escapeRay = new Ray();
  let work = 0;

  for (let axis = 0; axis < 3; axis++) {
    const [u, w] = DOT_GRID_AXES[axis];
    const uFirst = Math.floor(min[u] / DOT_SPACING);
    const uLast = Math.ceil(max[u] / DOT_SPACING);
    const wFirst = Math.floor(min[w] / DOT_SPACING);
    const wLast = Math.ceil(max[w] / DOT_SPACING);
    direction[0] = direction[1] = direction[2] = 0;
    direction[axis] = -1;
    ray.direction.fromArray(direction);

    for (let iu = uFirst; iu <= uLast; iu++) {
      for (let iw = wFirst; iw <= wLast; iw++) {
        origin[axis] = max[axis] + DOT_SPACING;
        origin[u] = (iu + 0.5) * DOT_SPACING;
        origin[w] = (iw + 0.5) * DOT_SPACING;
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

          // Does this spot face this grid's axis more than the others?
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
          if (facing < other) continue;

          // Skip surfaces sealed inside the body (see surfaceEscapes).
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
          const escapeRays = surfaceEscapes(
            bvh,
            escapeRay,
            hit.point.x,
            hit.point.y,
            hit.point.z,
            nx / nLength,
            ny / nLength,
            nz / nLength
          );
          work += Math.abs(escapeRays);
          if (escapeRays < 0) continue;

          const meshIndex = vertexMesh[face.a];
          const offset = vertOffsets[meshIndex];
          corners[meshIndex].push(face.a - offset, face.b - offset, face.c - offset);
          barys[meshIndex].push(bary.x, bary.y, bary.z);
        }

        // Yield every ~128 grid rays' worth of raycasts (escape tests
        // included -- sealed dots cost a full fan of rays each).
        work += 1;
        if (work >= 128) {
          work = 0;
          yield;
        }
      }
    }
  }

  return meshes.map((mesh, meshIndex) =>
    buildDotCloudData(
      mesh,
      new Uint32Array(corners[meshIndex]),
      new Float32Array(barys[meshIndex]),
      surface.referenceToMeshScale[meshIndex]
    )
  );
}

function buildDotCloudData(
  source: Mesh,
  corners: Uint32Array,
  bary: Float32Array,
  referenceToMeshScale: number
): DotCloudData {
  const count = bary.length / 3;
  const { position, normal } = source.geometry.attributes;
  const sourceSkinIndex = source.geometry.getAttribute("skinIndex");
  const sourceSkinWeight = source.geometry.getAttribute("skinWeight");
  const skinned = !!sourceSkinIndex && !!sourceSkinWeight;

  const anchors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const skinIndex = skinned ? new Float32Array(count * 4) : null;
  const skinWeight = skinned ? new Float32Array(count * 4) : null;
  const n = new Vector3();
  // Up to 3 vertices x 4 bones each.
  const bones = new Float32Array(12);
  const weights = new Float32Array(12);

  for (let d = 0; d < count; d++) {
    let px = 0, py = 0, pz = 0;
    n.set(0, 0, 0);
    let influences = 0;
    for (let k = 0; k < 3; k++) {
      const vertex = corners[d * 3 + k];
      const b = bary[d * 3 + k];
      px += position.getX(vertex) * b;
      py += position.getY(vertex) * b;
      pz += position.getZ(vertex) * b;
      n.x += normal.getX(vertex) * b;
      n.y += normal.getY(vertex) * b;
      n.z += normal.getZ(vertex) * b;

      if (!skinned) continue;
      for (let j = 0; j < 4; j++) {
        const weight = sourceSkinWeight.getComponent(vertex, j) * b;
        if (weight <= 0) continue;
        const bone = sourceSkinIndex.getComponent(vertex, j);
        let slot = 0;
        while (slot < influences && bones[slot] !== bone) slot++;
        if (slot === influences) {
          bones[slot] = bone;
          weights[slot] = 0;
          influences++;
        }
        weights[slot] += weight;
      }
    }
    anchors[d * 3] = px;
    anchors[d * 3 + 1] = py;
    anchors[d * 3 + 2] = pz;
    n.normalize();
    n.toArray(normals, d * 3);

    if (skinIndex && skinWeight) {
      // Keep the 4 strongest bones, renormalized to sum to 1.
      let total = 0;
      for (let j = 0; j < 4; j++) {
        let best = -1;
        for (let s = 0; s < influences; s++) {
          if (weights[s] > 0 && (best < 0 || weights[s] > weights[best])) best = s;
        }
        if (best < 0) break;
        skinIndex[d * 4 + j] = bones[best];
        skinWeight[d * 4 + j] = weights[best];
        total += weights[best];
        weights[best] = 0;
      }
      if (total > 0) {
        for (let j = 0; j < 4; j++) skinWeight[d * 4 + j] /= total;
      }
    }
  }

  return {
    source,
    count,
    anchors,
    normals,
    skinIndex,
    skinWeight,
    corners,
    bary,
    referenceToMeshScale,
  };
}

/** Carries one per-vertex value over to every dot (barycentric blend). */
function interpolateToDots(values: Float32Array, data: DotCloudData): Float32Array {
  const result = new Float32Array(data.count);
  for (let d = 0; d < data.count; d++) {
    result[d] =
      values[data.corners[d * 3]] * data.bary[d * 3] +
      values[data.corners[d * 3 + 1]] * data.bary[d * 3 + 1] +
      values[data.corners[d * 3 + 2]] * data.bary[d * 3 + 2];
  }
  return result;
}

// Uniforms shared by every dot cloud's material, so changing a value once
// (e.g. easing uBlend in useFrame) updates every dot at once.
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
  uDotOcclusionTolerance: { value: number };
  uReveal: { value: number };
  uBodyDepth: { value: Texture | null };
  uResolution: { value: Vector2 };
  uCameraNear: { value: number };
  uCameraFar: { value: number };
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
    uDotOcclusionTolerance: { value: DOT_OCCLUSION_TOLERANCE },
    // 0 -> 1 fade-in once the dots have been placed.
    uReveal: { value: 0 },
    // Filled in every frame by PosableModel's render pass.
    uBodyDepth: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 1000 },
  };
}

/**
 * The body's own material: invisible. It writes depth but no color, so
 * the page background shows through it. PosableModel renders the body
 * with it into a depth texture every frame, which each dot checks to know
 * whether the body hides it (the back of the torso, the far arm) -- that's
 * what stops the dots looking x-rayed.
 */
function createOccluderMaterial(regionName: string): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    colorWrite: false,
    // Never shown, so skip fog / tone mapping (they'd otherwise make three
    // swap shader programs between the depth pass and the screen pass).
    fog: false,
    toneMapped: false,
  });
  material.name = `${regionName}-occluder`;
  material.userData.dotLook = true;
  return material;
}

// Each dot is one screen-facing quad (4 corners of aCorner, -1..1),
// instanced once per dot. All the per-dot data -- anchor (position),
// normal, bones, crevice darkening, highlight weights -- is per instance.
const DOT_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <skinning_pars_vertex>

  attribute vec2 aCorner;
  attribute float aOcclusion;
  attribute float aHighlightFrom;
  attribute float aHighlightTo;

  uniform float uBlend;
  uniform float uAOStrength;
  uniform float uAODarkBelow;
  uniform float uAOLightAbove;
  uniform vec3 uDotColor;
  uniform vec3 uHighlightColor;
  uniform float uDotSpacing;
  uniform float uReferenceToMeshScale;
  uniform float uDotMinRadius;
  uniform float uDotMaxRadius;
  uniform float uDotMinOpacity;
  uniform float uDotMaxOpacity;
  uniform float uDotLightDark;
  uniform float uDotLightBright;
  uniform float uDotHighlightGrow;
  uniform float uDotHighlightOpacity;
  uniform float uDotOcclusionTolerance;
  uniform float uReveal;
  uniform sampler2D uBodyDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2 vCorner;
  varying float vRadiusPx;
  varying float vQuadPx;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vCorner = aCorner;
    vRadiusPx = 0.0;
    vQuadPx = 1.0;
    vAlpha = 0.0;
    vColor = uDotColor;

    // Skin the dot's anchor and normal exactly like the body's own
    // vertices, so it stays pinned to the same spot in every pose.
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>

    vec4 anchor = modelViewMatrix * vec4( transformed, 1.0 );
    vec3 viewNormal = normalize( transformedNormal );

    // Size of one geometry unit in view space (bones and the model's
    // scale included), to turn DOT_SPACING into on-screen size.
    mat3 toView = mat3( modelViewMatrix );
    #ifdef USE_SKINNING
      toView = toView * mat3( skinMatrix );
    #endif
    float viewPerUnit = ( length( toView[ 0 ] ) + length( toView[ 1 ] ) + length( toView[ 2 ] ) ) / 3.0;
    float spacingView = uDotSpacing * uReferenceToMeshScale * viewPerUnit;

    // How brightly this spot of skin is lit: the same lights the scene
    // has (hemisphere + every directional light), diffuse only, times
    // the baked crevice darkening.
    vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
    #if NUM_HEMI_LIGHTS > 0
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
        irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], viewNormal );
      }
      #pragma unroll_loop_end
    #endif
    #if NUM_DIR_LIGHTS > 0
      IncidentLight directLight;
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
        getDirectionalLightInfo( directionalLights[ i ], directLight );
        irradiance += saturate( dot( viewNormal, directLight.direction ) ) * directLight.color;
      }
      #pragma unroll_loop_end
    #endif
    float creviceOpen = smoothstep( uAODarkBelow, uAOLightAbove, aOcclusion );
    float lightLevel = dot( irradiance * RECIPROCAL_PI, vec3( 0.2126, 0.7152, 0.0722 ) );
    lightLevel *= mix( 1.0, creviceOpen, clamp( uAOStrength, 0.0, 1.0 ) );

    // 1 = in shadow (biggest, strongest dot), 0 = fully lit (smallest).
    float shade = 1.0 - smoothstep( uDotLightDark, uDotLightBright, lightLevel );
    float highlight = clamp( mix( aHighlightFrom, aHighlightTo, uBlend ), 0.0, 1.0 );
    float radius = mix( uDotMinRadius, uDotMaxRadius, shade );
    radius = max( radius * mix( 1.0, uDotHighlightGrow, highlight ), 0.0 );
    float opacity = mix( uDotMinOpacity, uDotMaxOpacity, shade );
    opacity = clamp( mix( opacity, max( opacity, uDotHighlightOpacity ), highlight ), 0.0, 1.0 );

    // Dots on skin facing away from the camera are on the far side of
    // the body -- hide them (softly, so nothing pops at the silhouette).
    float facing = dot( viewNormal, normalize( -anchor.xyz ) );
    float frontFacing = smoothstep( -0.15, 0.0, facing );

    // Is the body itself in front of this dot (an arm across the chest,
    // the torso in front of the far arm)? Compare the dot's depth with
    // the body's depth at the same pixel, from this frame's depth pass.
    float pxPerView = projectionMatrix[ 1 ][ 1 ] * 0.5 * uResolution.y / max( -anchor.z, 1e-5 );
    vec4 anchorClip = projectionMatrix * anchor;
    vec2 anchorUv = anchorClip.xy / anchorClip.w * 0.5 + 0.5;
    ivec2 texel = ivec2( clamp( floor( anchorUv * uResolution ), vec2( 0.0 ), uResolution - 1.0 ) );
    float bodyDepth = texelFetch( uBodyDepth, texel, 0 ).r;
    float bodyViewZ = perspectiveDepthToViewZ( bodyDepth, uCameraNear, uCameraFar );
    float bodyInFront = bodyViewZ - anchor.z;
    // The dot sits ON the body's surface, so allow a little slack -- more
    // where the skin turns edge-on and one pixel spans a lot of depth.
    float tolerance = uDotOcclusionTolerance * spacingView + 2.0 / ( pxPerView * max( facing, 0.1 ) );
    float unoccluded = 1.0 - smoothstep( tolerance, 2.0 * tolerance, bodyInFront );

    // On-screen radius in pixels. Dots too small to draw cleanly are drawn
    // at 0.6px and made fainter instead, so they never flicker.
    float radiusPx = radius * spacingView * pxPerView;
    float drawPx = max( radiusPx, 0.6 );
    float alpha = opacity * frontFacing * unoccluded * clamp( uReveal, 0.0, 1.0 );
    alpha *= min( 1.0, ( radiusPx * radiusPx ) / ( drawPx * drawPx ) );

    if ( alpha < 0.004 ) {
      // Hidden: push the quad outside the clip volume so nothing is drawn.
      gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
      return;
    }

    // A flat quad facing the screen (offset in view space, parallel to
    // the image plane), 1px larger than the dot for its anti-aliased edge.
    float quadPx = drawPx + 1.0;
    vec4 corner = anchor;
    corner.xy += aCorner * ( quadPx / pxPerView );
    gl_Position = projectionMatrix * corner;

    vRadiusPx = drawPx;
    vQuadPx = quadPx;
    vAlpha = alpha;
    vColor = mix( uDotColor, uHighlightColor, highlight );
  }
`;

const DOT_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  varying vec2 vCorner;
  varying float vRadiusPx;
  varying float vQuadPx;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    // Distance from the dot's center in pixels -> a perfectly round dot
    // with a 1px anti-aliased edge.
    float distPx = length( vCorner ) * vQuadPx;
    float alpha = clamp( vRadiusPx + 0.5 - distPx, 0.0, 1.0 ) * vAlpha;
    if ( alpha < 0.004 ) discard;
    gl_FragColor = vec4( vColor, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createDotCloudMaterial(
  uniforms: DotUniforms,
  referenceToMeshScale: number
): ShaderMaterial {
  const material = new ShaderMaterial({
    uniforms: {
      // Fresh copies of three's light uniforms (filled in by the renderer)
      // plus the shared dot uniforms, by reference.
      ...UniformsUtils.clone(UniformsLib.lights),
      ...uniforms,
      uReferenceToMeshScale: { value: referenceToMeshScale },
    },
    vertexShader: DOT_VERTEX_SHADER,
    fragmentShader: DOT_FRAGMENT_SHADER,
    lights: true,
    transparent: true,
    // The quads are built facing the screen in view space, so they're
    // never really back-facing -- but three flips the winding test for
    // mirrored meshes (negative scale, e.g. a cap mirrored across the
    // face), which would cull every dot on them.
    side: DoubleSide,
    // Visibility comes from the body depth texture instead (see the
    // vertex shader), so a dot is never cut by the skin it sits on and
    // dots at the silhouette overhang it whole.
    depthTest: false,
    depthWrite: false,
  });
  material.userData.dotLook = true;
  return material;
}

/** Turns placed dots into a drawable cloud riding the same skeleton. */
function createDotCloud(data: DotCloudData, uniforms: DotUniforms): Mesh {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    "aCorner",
    new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2)
  );
  geometry.setAttribute("position", new InstancedBufferAttribute(data.anchors, 3));
  geometry.setAttribute("normal", new InstancedBufferAttribute(data.normals, 3));
  if (data.skinIndex && data.skinWeight) {
    geometry.setAttribute("skinIndex", new InstancedBufferAttribute(data.skinIndex, 4));
    geometry.setAttribute("skinWeight", new InstancedBufferAttribute(data.skinWeight, 4));
  }
  // Fully open until the crevice bake lands.
  geometry.setAttribute(
    "aOcclusion",
    new InstancedBufferAttribute(new Float32Array(data.count).fill(1), 1)
  );
  geometry.setAttribute(
    "aHighlightFrom",
    new InstancedBufferAttribute(new Float32Array(data.count), 1)
  );
  geometry.setAttribute(
    "aHighlightTo",
    new InstancedBufferAttribute(new Float32Array(data.count), 1)
  );
  geometry.instanceCount = data.count;

  const material = createDotCloudMaterial(uniforms, data.referenceToMeshScale);
  const source = data.source as SkinnedMesh;
  let dots: Mesh;
  if (source.isSkinnedMesh && data.skinIndex) {
    const skinnedDots = new SkinnedMesh(geometry, material);
    skinnedDots.bindMode = source.bindMode;
    skinnedDots.bind(source.skeleton, source.bindMatrix);
    dots = skinnedDots;
  } else {
    dots = new Mesh(geometry, material);
  }
  dots.name = `${source.name}-dots`;
  dots.userData.isDotCloud = true;
  // The anchors aren't where the quads end up, so bounds would be wrong.
  dots.frustumCulled = false;
  // Draw after everything else (e.g. the floor's contact shadow).
  dots.renderOrder = 10;
  // Same place in the hierarchy and same transform as the body mesh, so
  // the skinning math is identical.
  dots.position.copy(source.position);
  dots.quaternion.copy(source.quaternion);
  dots.scale.copy(source.scale);
  source.parent?.add(dots);
  return dots;
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

  // Shared by every dot cloud's material (see createDotCloudMaterial) so
  // animating uBlend / uAOStrength / uReveal once in useFrame updates
  // every dot at once.
  const [dotUniforms] = useState(createDotUniforms);
  // Target for uAOStrength -- flipped to AO_STRENGTH when the bake lands.
  const aoTargetStrength = useRef(0);
  // Target for uReveal -- flipped to 1 once the dots have been placed.
  const revealTarget = useRef(0);
  // The dot clouds currently in the scene (hidden during the depth pass).
  const dotCloudsRef = useRef<Mesh[]>([]);
  // Highlight region of the current view, so dot clouds created mid-way
  // start out with the right colors.
  const activeRegionRef = useRef<string | null>(null);

  // The body's depth, rendered every frame before the dots (see the
  // render pass at the bottom), which each dot checks to know whether the
  // body hides it.
  const [bodyDepthTarget] = useState(
    () => new WebGLRenderTarget(1, 1, { depthTexture: new DepthTexture(1, 1) })
  );
  const [drawingBufferSize] = useState(() => new Vector2());
  useEffect(() => {
    dotUniforms.uBodyDepth.value = bodyDepthTarget.depthTexture;
    return () => bodyDepthTarget.dispose();
  }, [bodyDepthTarget, dotUniforms]);

  // Makes the body itself invisible: every body mesh gets the depth-only
  // occluder material (see createOccluderMaterial), keeping the ORIGINAL
  // Blender slot name (e.g. "femaleheart") in its name. The dots are
  // added separately, once placed (next effect).
  //
  // This same effect also computes the smooth per-vertex highlight fields
  // (buildVertexHighlightFields), which the dots pick up when they're
  // placed -- both are one-time, geometry-driven setup, so they key off
  // [scene] only (not [view]).
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

    for (const mesh of collectBodyMeshes(scene)) {
      const { geometry } = mesh;
      const regionName = getRegionName(mesh);

      // Re-running on the same cached scene (StrictMode, hot reload,
      // remount): free the material(s) a previous run created, and undo
      // what older versions of this effect added to the geometry. The
      // GLB's own original materials are left alone.
      const previous = mesh.material;
      for (const old of Array.isArray(previous) ? previous : [previous]) {
        if (old?.userData.dotLook) old.dispose();
      }
      geometry.clearGroups();
      geometry.deleteAttribute("aHighlightFrom");
      geometry.deleteAttribute("aHighlightTo");
      geometry.deleteAttribute("aOcclusion");

      mesh.material = createOccluderMaterial(regionName);
      // Nothing is lit with shadow maps any more (the dots compute their
      // own lighting), so the body neither casts nor receives them.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  }, [scene]);

  // Places the dots on the skin (see placeSurfaceDots), adds them to the
  // scene and fades them in -- then bakes the crevice darkening (see
  // bakeVertexOcclusion) and fades that in too. Runs a few milliseconds
  // per frame so the page stays responsive. Cancelled cleanly, with the
  // dots removed again, if the model unmounts (or React's dev StrictMode
  // double-runs this effect).
  useEffect(() => {
    const clouds: { dots: Mesh; data: DotCloudData }[] = [];
    let surface: MergedSurface | null = null;
    let placing: Generator<void, DotCloudData[], void> | null = null;
    let baking: Generator<void, Map<string, Float32Array>, void> | null = null;
    let frame = 0;

    revealTarget.current = 0;
    dotUniforms.uReveal.value = 0;
    aoTargetStrength.current = 0;
    dotUniforms.uAOStrength.value = 0;

    const addDotClouds = (placed: DotCloudData[]) => {
      const activeRegion = activeRegionRef.current;
      for (const data of placed) {
        if (data.count === 0) continue;
        const dots = createDotCloud(data, dotUniforms);

        // Carry the per-vertex highlight fields over to the dots, and
        // start them on the current view's colors.
        const sourceFields = highlightFieldsRef.current.get(data.source.uuid) ?? {};
        const dotFields: Record<string, Float32Array> = {};
        for (const [region, values] of Object.entries(sourceFields)) {
          dotFields[region] = interpolateToDots(values, data);
        }
        highlightFieldsRef.current.set(dots.uuid, dotFields);
        const current = activeRegion ? dotFields[activeRegion] : undefined;
        if (current) {
          for (const name of ["aHighlightFrom", "aHighlightTo"]) {
            const attr = dots.geometry.getAttribute(name) as BufferAttribute;
            (attr.array as Float32Array).set(current);
            attr.needsUpdate = true;
          }
        }
        clouds.push({ dots, data });
      }
      dotCloudsRef.current = clouds.map((cloud) => cloud.dots);
      revealTarget.current = 1;
    };

    const applyOcclusion = (openness: Map<string, Float32Array>) => {
      for (const { dots, data } of clouds) {
        const values = openness.get(data.source.uuid);
        if (!values) continue;
        const attr = dots.geometry.getAttribute("aOcclusion") as BufferAttribute;
        (attr.array as Float32Array).set(interpolateToDots(values, data));
        attr.needsUpdate = true;
      }
      aoTargetStrength.current = AO_STRENGTH;
    };

    const step = () => {
      const deadline = performance.now() + AO_BAKE_BUDGET_MS;
      while (performance.now() < deadline) {
        if (!surface) {
          const meshes = collectBodyMeshes(scene);
          if (meshes.length === 0) return;
          surface = buildMergedSurface(meshes);
          placing = placeSurfaceDots(surface);
          continue;
        }
        if (placing) {
          const next = placing.next();
          if (next.done) {
            placing = null;
            addDotClouds(next.value);
            baking = bakeVertexOcclusion(surface);
          }
          continue;
        }
        if (baking) {
          const next = baking.next();
          if (next.done) {
            baking = null;
            applyOcclusion(next.value);
            surface.geometry.dispose();
            return;
          }
          continue;
        }
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      surface?.geometry.dispose();
      for (const { dots } of clouds) {
        dots.removeFromParent();
        dots.geometry.dispose();
        (dots.material as Material).dispose();
        highlightFieldsRef.current.delete(dots.uuid);
      }
      dotCloudsRef.current = [];
    };
  }, [scene, dotUniforms]);

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
    activeRegionRef.current = activeRegion;
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
    // Updating this one uniform is all it takes to fade every dot at
    // once, since they all share the same uniforms object (see
    // dotUniforms / createDotCloudMaterial).
    const hk = 1 - Math.exp(-delta * HIGHLIGHT_FADE_SPEED);
    dotUniforms.uBlend.value += (1 - dotUniforms.uBlend.value) * hk;

    // Same easing for the crevice darkening, from 0 up to AO_STRENGTH
    // once the bake has landed (see aoTargetStrength)...
    const ak = 1 - Math.exp(-delta * AO_FADE_SPEED);
    dotUniforms.uAOStrength.value +=
      (aoTargetStrength.current - dotUniforms.uAOStrength.value) * ak;

    // ...and for the dots fading in once they've been placed.
    const rk = 1 - Math.exp(-delta * DOT_REVEAL_SPEED);
    dotUniforms.uReveal.value += (revealTarget.current - dotUniforms.uReveal.value) * rk;
  });

  // Renders the frame. Priority 1 takes over R3F's own render call, and
  // also guarantees this runs AFTER every other useFrame this frame -- in
  // particular the animation mixer and the camera rig -- so the body depth
  // below always matches the exact pose and camera the dots are drawn
  // with (no one-frame lag during pose changes).
  //
  // First pass: just the (invisible) body, into bodyDepthTarget -- its
  // depth texture tells every dot whether the body is in front of it.
  // Second pass: the whole scene to the screen as usual.
  useFrame((state) => {
    const { gl, camera } = state;

    gl.getDrawingBufferSize(drawingBufferSize);
    if (
      bodyDepthTarget.width !== drawingBufferSize.x ||
      bodyDepthTarget.height !== drawingBufferSize.y
    ) {
      bodyDepthTarget.setSize(drawingBufferSize.x, drawingBufferSize.y);
    }
    dotUniforms.uResolution.value.copy(drawingBufferSize);
    const perspective = camera as PerspectiveCamera;
    dotUniforms.uCameraNear.value = perspective.near;
    dotUniforms.uCameraFar.value = perspective.far;

    const clouds = dotCloudsRef.current;
    for (const dots of clouds) dots.visible = false;
    const previousTarget = gl.getRenderTarget();
    gl.setRenderTarget(bodyDepthTarget);
    gl.render(scene, camera);
    gl.setRenderTarget(previousTarget);
    for (const dots of clouds) dots.visible = true;

    gl.render(state.scene, camera);
  }, 1);

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
