"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, ContactShadows, useAnimations } from "@react-three/drei";
import {
  BufferAttribute,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LoopOnce,
  Material,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from "three";

type ViewKey = "reset" | "head" | "heart" | "arms";
type Mode = "solid" | "dots";
type Gender = "male" | "female";
type Vector3Tuple = [number, number, number];

// Swap this to whatever your actual female model file is named/located at.
// Male now points at the new rigged/posable model -- make sure
// Man_Mesh_clean5.glb is copied into /public (same place male_7.glb used
// to live) so this path resolves.
const MODEL_PATHS: Record<Gender, string> = {
  male: "/Man_Mesh_clean5.glb",
  female: "/female_7.glb",
};

const VIEWS: Record<
  ViewKey,
  { label: string; camPos: Vector3Tuple; target: Vector3Tuple }
> = {
  reset: { label: "Full Body", camPos: [0, 1.4, 3.6], target: [0, 0.9, 0] },
  head: { label: "Head", camPos: [0.25, 1.75, 1.15], target: [0, 1.68, 0] },
  heart: { label: "Heart", camPos: [0.45, 1.45, 1.25], target: [0, 1.38, 0] },
  arms: { label: "Arms", camPos: [1.7, 1.35, 1.3], target: [0.5, 1.25, 0] },
};

// Maps each camera-view button to the name of the animation Action/clip it
// should trigger on the rigged model. "reset" now points at your own
// "default" pose clip -- change the string below if you named it
// differently in Blender. "arms" maps to the clip name "arm" (singular)
// to match how the poses are named inside Man_Mesh clean3.glb.
const POSE_ACTION_NAMES: Record<ViewKey, string | null> = {
  reset: "default",
  head: "head",
  heart: "heart",
  arms: "arm",
};

// Maps each view/button to the name of the MATERIAL SLOT (assigned to a
// group of faces in Blender) that should light up when that pose is
// active. This is a separate mapping from POSE_ACTION_NAMES above on
// purpose -- the pose clip for the arms button is named "arm" (singular),
// but the material slot covering that same area is named "hands" (see
// Man_Mesh_clean5.glb's material list). "reset" has no highlighted region
// at all -- clicking it turns every highlight off.
const HIGHLIGHT_REGION_NAMES: Record<ViewKey, string | null> = {
  reset: null,
  head: "head2",
  heart: "heart2",
  arms: "hands2",
};

// Tint color for whichever region is currently highlighted. This blends
// directly into the surface's own (placeholder white, for now) albedo --
// no emissive glow -- so it still reads as a normally-lit surface, just
// tinted, and swapping in real textures later won't break this.
const HIGHLIGHT_COLOR = "#78ffa8";

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

// How fast the color transition eases in when switching views, in
// roughly 1/seconds -- same exponential-decay idiom as POSE_BLEND_SPEED
// above, just driving a single blend scalar instead of animation weights.
// Higher = snappier.
const HIGHLIGHT_FADE_SPEED = 6;

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

// Target world-space distance (meters) between dots. These are separate on
// purpose: VERTICAL controls the gap row-to-row (up the body), HORIZONTAL
// controls the gap column-to-column (around the body). Not exposed in the
// UI -- edit these two numbers directly to change dot density per axis.
const DOT_SPACING_VERTICAL = 0.006;
const DOT_SPACING_HORIZONTAL = 0.007;

// World-space dot radius scale. Not exposed in the UI -- edit directly.
const DOT_SIZE = 0.003;

// How far each dot sits off the surface along its normal, to avoid
// z-fighting against the invisible occluder mesh. Pushed out a bit further
// than the bare minimum since concave areas (armpits, under the chin,
// inner elbows, waist creases) are prone to a dot's flat billboard quad
// getting self-occluded by neighboring geometry at grazing angles.
const SURFACE_OFFSET = 0.003;

// Scene fog color (kept light/neutral so it blends cleanly with the CSS
// radial-gradient page background behind the transparent canvas), and the
// model's own "bare skin" color in dots mode (the parts not covered by a
// colored dot).
const FOG_COLOR = "#E6F5F9";
const DOT_COLOR = {
  r: 0x01 / 255,
  g: 0xa8 / 255,
  b: 0xc9 / 255,
}; // #019DC9

// CSS radial gradient behind the canvas, centered at the bottom of the
// viewport and fading from the pale cyan tint out to white.
const PAGE_BACKGROUND =
  "radial-gradient(circle at 50% 100%, #fff 0%, #fff 50%)";

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

function collectMeshVertexData(scene: Group): MeshVertexData[] {
  const result: MeshVertexData[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const posAttr = mesh.geometry?.attributes?.position;
    if (!posAttr) return;
    const mat = mesh.material as MeshStandardMaterial | undefined;
    result.push({
      mesh,
      positions: new Float32Array(posAttr.array as ArrayLike<number>),
      regionName: mat?.name ?? "",
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
 */
function buildVertexHighlightFields(
  scene: Group,
  regionNames: string[],
  radius: number
): Map<string, Record<string, Float32Array>> {
  const meshData = collectMeshVertexData(scene);
  const result = new Map<string, Record<string, Float32Array>>();

  for (const region of regionNames) {
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

/**
 * Patches a MeshStandardMaterial (via onBeforeCompile, the standard
 * three.js hook for this) so it blends in `uHighlightColor` based on a
 * per-vertex weight -- itself the mix of two per-vertex attributes,
 * aHighlightFrom/aHighlightTo, driven by the shared uBlend uniform. Pure
 * albedo blend, no emissive -- the surface stays normally lit, just
 * tinted, so there's no glow.
 *
 * uniforms is a plain object (not per-material state) shared by every
 * submesh's material, so animating uBlend.value once in useFrame updates
 * every submesh at once without needing a material reference per mesh.
 */
function patchHighlightMaterial(
  material: MeshStandardMaterial,
  uniforms: { uBlend: { value: number }; uHighlightColor: { value: Color } }
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBlend = uniforms.uBlend;
    shader.uniforms.uHighlightColor = uniforms.uHighlightColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aHighlightFrom;
        attribute float aHighlightTo;
        uniform float uBlend;
        varying float vHighlight;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vHighlight = mix(aHighlightFrom, aHighlightTo, uBlend);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uHighlightColor;
        varying float vHighlight;`
      )
      .replace(
        "vec4 diffuseColor = vec4( diffuse, opacity );",
        `vec4 diffuseColor = vec4( mix( diffuse, uHighlightColor, vHighlight ), opacity );`
      );
  };
  // Materials with different onBeforeCompile closures can end up sharing
  // a cached program if three thinks they're equivalent; keying by name
  // (which differs per Blender material slot) keeps each submesh's
  // program distinct and avoids stale-uniform cross-talk between slots.
  material.customProgramCacheKey = () => `highlight-${material.name}`;
}

function SolidModel({ modelPath }: { modelPath: string }) {
  const { scene } = useGLTF(modelPath);
  return <primitive object={scene} />;
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

  // Shared by every submesh's patched material (see patchHighlightMaterial)
  // so animating uBlend once in useFrame updates the whole model at once.
  const [highlightUniforms] = useState(() => ({
    uBlend: { value: 0 },
    uHighlightColor: { value: new Color(HIGHLIGHT_COLOR) },
  }));

  // Man_Mesh_clean5.glb currently ships with no real texture on any of its
  // material slots (verified when inspecting the file), which would
  // otherwise render as flat default gray. This replaces every sub-mesh's
  // material with the same placeholder white -- but keeps each material's
  // ORIGINAL NAME (the Blender slot name, e.g. "heart"/"head"/"hands") so
  // the highlight system can still find the right region by name even
  // after the material object itself has been swapped out. Remove this
  // block (or make it conditional per-region) once real materials/textures
  // are baked into the GLB in Blender.
  //
  // This same effect also computes the smooth per-vertex highlight fields
  // (buildVertexHighlightFields) and attaches the aHighlightFrom/
  // aHighlightTo attributes every submesh's patched material reads from --
  // both are one-time, geometry-driven setup, so they belong together and
  // both key off [scene] only (not [view]).
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
      HIGHLIGHT_BLEND_RADIUS
    );
    highlightFieldsRef.current = fields;

    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;

      const mat = mesh.material as MeshStandardMaterial | undefined;
      const regionName = mat?.name ?? "";
      // Only fall back to the flat placeholder color if this mesh truly
      // has no material or no texture map baked in. If the GLB already
      // ships a textured material, leave it alone.
      const hasTexture = !!mat && "map" in mat && !!mat.map;

      let finalMat = mat;
      if (!mat || !hasTexture) {
        finalMat = new MeshStandardMaterial({
          color: "#fff",
          roughness: 0.75,
          metalness: 0,
        });
        finalMat.name = regionName;
        mesh.material = finalMat;
      }

      if (finalMat) {
        patchHighlightMaterial(finalMat, highlightUniforms);
      }

      const vertCount = mesh.geometry.attributes.position.count;
      mesh.geometry.setAttribute(
        "aHighlightFrom",
        new BufferAttribute(new Float32Array(vertCount), 1)
      );
      mesh.geometry.setAttribute(
        "aHighlightTo",
        new BufferAttribute(new Float32Array(vertCount), 1)
      );
    });
  }, [scene, highlightUniforms]);

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

  // Re-target the color gradient toward whichever region matches the
  // active view. Rather than snapping instantly, this freezes wherever
  // the PREVIOUS blend had actually gotten to (in case a rapid click
  // interrupted an in-progress fade) as the new starting point, then lets
  // useFrame below ease uBlend from 0 back to 1 -- same "no stuck
  // mid-transition" reasoning as the pose blending above, just for color.
  useEffect(() => {
    const activeRegion = HIGHLIGHT_REGION_NAMES[view];
    const fieldsByMesh = highlightFieldsRef.current;
    const blendSoFar = highlightUniforms.uBlend.value;

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

    highlightUniforms.uBlend.value = 0;
  }, [view, scene, modelPath, highlightUniforms]);

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

    // Ease the color gradient's blend scalar from 0 toward 1 every frame.
    // Updating this one uniform is all it takes to animate every
    // submesh's color at once, since they all share the same uniforms
    // object (see highlightUniforms / patchHighlightMaterial).
    const hk = 1 - Math.exp(-delta * HIGHLIGHT_FADE_SPEED);
    highlightUniforms.uBlend.value += (1 - highlightUniforms.uBlend.value) * hk;
  });

  return (
    <group ref={groupRef} scale={MAN_MESH_SCALE}>
      <primitive object={scene} />
    </group>
  );
}
interface DotInstance {
  position: Vector3;
  normal: Vector3;
}

// Flat, allocation-free triangle record used by the grid raycaster below.
interface TriData {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  nax: number; nay: number; naz: number;
  nbx: number; nby: number; nbz: number;
  ncx: number; ncy: number; ncz: number;
  minY: number; maxY: number;
}

/**
 * Möller–Trumbore ray/triangle intersection using plain numbers (no Vector3
 * allocation on the hot path — this runs rows*cols*candidates times).
 * Writes the hit into `out` and returns true only if it's closer than
 * out.t was going in, so callers can fold this into a "keep closest" loop.
 */
function raycastTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tri: TriData,
  out: { t: number; w0: number; w1: number; w2: number }
): boolean {
  const e1x = tri.bx - tri.ax, e1y = tri.by - tri.ay, e1z = tri.bz - tri.az;
  const e2x = tri.cx - tri.ax, e2y = tri.cy - tri.ay, e2z = tri.cz - tri.az;

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;

  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-9) return false;
  const f = 1 / a;

  const sx = ox - tri.ax, sy = oy - tri.ay, sz = oz - tri.az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < -1e-6 || u > 1 + 1e-6) return false;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;

  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < -1e-6 || u + v > 1 + 1e-6) return false;

  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  if (t <= 1e-6 || t >= out.t) return false;

  out.t = t;
  out.w0 = 1 - u - v;
  out.w1 = u;
  out.w2 = v;
  return true;
}

/**
 * Same Möller–Trumbore math as raycastTriangle above, but returns every
 * hit rather than only the closest -- used by the final per-column dot
 * placement pass so a single ray can surface more than one dot when it
 * crosses more than one surface (see the comment in the row/col loop
 * below for why that matters for creases and folds).
 */
function intersectRayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tri: TriData
): { t: number; w0: number; w1: number; w2: number } | null {
  const e1x = tri.bx - tri.ax, e1y = tri.by - tri.ay, e1z = tri.bz - tri.az;
  const e2x = tri.cx - tri.ax, e2y = tri.cy - tri.ay, e2z = tri.cz - tri.az;

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;

  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-9) return null;
  const f = 1 / a;

  const sx = ox - tri.ax, sy = oy - tri.ay, sz = oz - tri.az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;

  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  if (t <= 1e-6) return null;

  return { t, w0: 1 - u - v, w1: u, w2: v };
}

/**
 * Builds one entry per dot on a clean row/column grid, instead of scattering
 * samples in proportion to triangle area.
 *
 * The model stands upright along Y, so it's parameterized like a globe:
 * "rows" are height bands and "columns" are angle steps around the vertical
 * axis. For every (row, column) a ray is fired from outside the model,
 * horizontally inward toward the central axis at that height and angle.
 * Rather than keeping only the first surface it hits, the ray keeps every
 * outward-facing surface it crosses -- see the per-column loop below for
 * why: a fold tucked just behind the outer silhouette (an armpit, an inner
 * elbow, a waist crease) often sits further along that very same ray, and
 * a closest-hit-only raycast would otherwise drop it. Sweeping full 360°
 * columns at evenly spaced heights still produces a genuinely ordered
 * lattice wrapped onto the body, with `spacing` directly controlling the
 * world-space distance between rows and between columns -- unlike
 * area-proportional sampling, this doesn't drift with the mesh's own
 * triangulation density, and a (row, column) cell simply contributes more
 * than one dot when the geometry actually has more than one surface there.
 */
function buildDotInstances(
  scene: Group,
  verticalSpacing: number,
  horizontalSpacing: number
): DotInstance[] {
  scene.updateMatrixWorld(true);

  const meshes: Mesh[] = [];
  scene.traverse((obj) => {
    const m = obj as Mesh;
    if (m.isMesh && m.geometry?.attributes?.position) meshes.push(m);
  });

  const tris: TriData[] = [];
  let minY = Infinity, maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const faceNormal = new Vector3();
  const na = new Vector3();
  const nb = new Vector3();
  const nc = new Vector3();

  for (const mesh of meshes) {
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const nrm = geom.attributes.normal;
    const index = geom.index;
    const matrixWorld = mesh.matrixWorld;
    const normalMatrix = new Matrix3().getNormalMatrix(matrixWorld);
    const triCount = index ? index.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      a.fromBufferAttribute(pos, i0).applyMatrix4(matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(matrixWorld);

      ab.subVectors(b, a);
      ac.subVectors(c, a);
      if (ab.clone().cross(ac).lengthSq() <= 0) continue;

      if (nrm) {
        na.fromBufferAttribute(nrm, i0).applyMatrix3(normalMatrix).normalize();
        nb.fromBufferAttribute(nrm, i1).applyMatrix3(normalMatrix).normalize();
        nc.fromBufferAttribute(nrm, i2).applyMatrix3(normalMatrix).normalize();
      } else {
        faceNormal.crossVectors(ab, ac).normalize();
        na.copy(faceNormal); nb.copy(faceNormal); nc.copy(faceNormal);
      }

      const triMinY = Math.min(a.y, b.y, c.y);
      const triMaxY = Math.max(a.y, b.y, c.y);
      tris.push({
        ax: a.x, ay: a.y, az: a.z,
        bx: b.x, by: b.y, bz: b.z,
        cx: c.x, cy: c.y, cz: c.z,
        nax: na.x, nay: na.y, naz: na.z,
        nbx: nb.x, nby: nb.y, nbz: nb.z,
        ncx: nc.x, ncy: nc.y, ncz: nc.z,
        minY: triMinY, maxY: triMaxY,
      });

      minY = Math.min(minY, triMinY); maxY = Math.max(maxY, triMaxY);
      minX = Math.min(minX, a.x, b.x, c.x); maxX = Math.max(maxX, a.x, b.x, c.x);
      minZ = Math.min(minZ, a.z, b.z, c.z); maxZ = Math.max(maxZ, a.z, b.z, c.z);
    }
  }

  if (tris.length === 0 || !Number.isFinite(minY)) return [];

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const height = Math.max(maxY - minY, 1e-4);
  // Distance from the axis to the farthest corner of the bounding box,
  // used as a safe starting point (well outside the mesh) for every ray.
  const rayStart =
    Math.sqrt(
      Math.max(
        (minX - centerX) ** 2 + (minZ - centerZ) ** 2,
        (maxX - centerX) ** 2 + (maxZ - centerZ) ** 2
      )
    ) * 1.5 + 0.5;

  const rows = Math.min(400, Math.max(2, Math.round(height / verticalSpacing)));
  // Number of coarse probe rays used to estimate each row's own silhouette
  // radius before the real column sweep -- see the per-row loop below.
  const RADIUS_PROBE_COUNT = 48;

  // Bucket triangles into horizontal slabs so each ray only tests the
  // handful of triangles that actually overlap its height, instead of
  // every triangle in the mesh.
  const slabCount = Math.max(1, Math.min(256, rows));
  const slabHeight = height / slabCount;
  const buckets: number[][] = Array.from({ length: slabCount }, () => []);
  for (let i = 0; i < tris.length; i++) {
    const tri = tris[i];
    let s0 = Math.floor((tri.minY - minY) / slabHeight);
    let s1 = Math.floor((tri.maxY - minY) / slabHeight);
    s0 = Math.max(0, Math.min(slabCount - 1, s0));
    s1 = Math.max(0, Math.min(slabCount - 1, s1));
    for (let s = s0; s <= s1; s++) buckets[s].push(i);
  }

  const out: DotInstance[] = [];
  const hit = { t: 0, w0: 0, w1: 0, w2: 0 };

  for (let row = 0; row < rows; row++) {
    const y = minY + ((row + 0.5) / rows) * height;
    const slab = Math.max(0, Math.min(slabCount - 1, Math.floor((y - minY) / slabHeight)));
    const candidates = buckets[slab];
    if (candidates.length === 0) continue;

    // Estimate THIS row's own silhouette radius with a coarse probe pass,
    // instead of reusing one global average radius for the whole body.
    // A wrist and a hip are wildly different circumferences; sizing every
    // row's column count off a single body-wide average is exactly what
    // made the grid look inconsistent -- thin parts (neck, wrists, ankles)
    // got the same column count as the torso, so their dots bunched up
    // tightly, while wide parts (hips, shoulders) got dots stretched too
    // far apart. Deriving `cols` per row keeps the world-space distance
    // between adjacent columns roughly equal to `spacing` everywhere.
    let radiusSum = 0;
    let radiusHits = 0;
    for (let p = 0; p < RADIUS_PROBE_COUNT; p++) {
      const theta = (p / RADIUS_PROBE_COUNT) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const ox = centerX + rayStart * cosT;
      const oz = centerZ + rayStart * sinT;
      const dx = -cosT;
      const dz = -sinT;

      hit.t = Infinity;
      for (let ci = 0; ci < candidates.length; ci++) {
        raycastTriangle(ox, y, oz, dx, 0, dz, tris[candidates[ci]], hit);
      }
      if (Number.isFinite(hit.t)) {
        // Direction (dx, dz) is unit length and points straight at the
        // axis, so the hit's distance from the axis is simply how much
        // radius the ray covered before striking a surface.
        radiusSum += rayStart - hit.t;
        radiusHits++;
      }
    }
    if (radiusHits === 0) continue;
    const localRadius = Math.max(radiusSum / radiusHits, horizontalSpacing / 4);
    const cols = Math.min(
      1200,
      Math.max(8, Math.round((2 * Math.PI * localRadius) / horizontalSpacing))
    );

    // Minimum world-space gap between two kept hits on the same ray, so
    // numerical noise at a silhouette edge (two adjacent triangles both
    // registering an intersection a hair's-width apart) doesn't produce a
    // pair of near-duplicate dots stacked on top of each other.
    const MIN_HIT_GAP = Math.max(horizontalSpacing, verticalSpacing) * 0.5;

    for (let col = 0; col < cols; col++) {
      const theta = (col / cols) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const ox = centerX + rayStart * cosT;
      const oz = centerZ + rayStart * sinT;
      const dx = -cosT;
      const dz = -sinT;

      // Collect every surface this ray crosses, not just the nearest one.
      // A single closest-hit raycast only ever finds the outer silhouette,
      // so a crease tucked just behind it -- an armpit, an inner elbow,
      // a waist fold -- gets silently dropped even though it sits on the
      // very same ray, just a bit further along. Keeping every hit lets
      // those folds get a dot too, without touching the row/column grid
      // at all: each (row, col) can just produce more than one dot when
      // the geometry calls for it.
      type ColHit = { t: number; tri: TriData; w0: number; w1: number; w2: number };
      const hits: ColHit[] = [];
      for (let ci = 0; ci < candidates.length; ci++) {
        const tri = tris[candidates[ci]];
        const res = intersectRayTriangle(ox, y, oz, dx, 0, dz, tri);
        if (res) hits.push({ t: res.t, tri, w0: res.w0, w1: res.w1, w2: res.w2 });
      }
      if (hits.length === 0) continue;
      hits.sort((h1, h2) => h1.t - h2.t);

      let lastT = -Infinity;
      for (const h of hits) {
        const { tri, w0, w1, w2, t } = h;
        const nx = tri.nax * w0 + tri.nbx * w1 + tri.ncx * w2;
        const ny = tri.nay * w0 + tri.nby * w1 + tri.ncy * w2;
        const nz = tri.naz * w0 + tri.nbz * w1 + tri.ncz * w2;

        // Only keep genuinely outward-facing surfaces -- i.e. the wall the
        // ray is entering, not the far/inside wall it's about to exit
        // through. That's what a viewer would actually see as a surface
        // from this direction; the inside of a limb isn't a real dot.
        const facing = nx * -dx + nz * -dz;
        if (facing <= 0) continue;
        if (t - lastT < MIN_HIT_GAP) continue;
        lastT = t;

        const normal = new Vector3(nx, ny, nz).normalize();
        const px = ox + dx * t;
        const pz = oz + dz * t;
        const position = new Vector3(px, y, pz).addScaledVector(normal, SURFACE_OFFSET);
        out.push({ position, normal });
      }
    }
  }

  return out;
}

// Three-point lighting setup. Positions here are mirrored 1:1 onto the real
// <directionalLight> objects in the JSX below, and doubled as fixed light
// directions fed into the dots shader -- keep both in sync when tweaking.
//
// KEY: the main light. Mostly from the front, nudged slightly left.
// FILL: secondary light that softens the shadow side, front-right.
// RIM: intense light from the left (and slightly behind) that grazes the
//      left edge of the model to create a bright rim/edge highlight.
const KEY_LIGHT_POS: Vector3Tuple = [-60, 50, 60];
const FILL_LIGHT_POS: Vector3Tuple = [3, 2, 3];
const RIM_LIGHT_POS: Vector3Tuple = [-10, 0, -10];
const FILL_LIGHT_INTENSITY = 0.8;
const KEY_LIGHT_INTENSITY = 1;
const RIM_LIGHT_INTENSITY = 18; // "intense", per request -- tune freely.

const KEY_LIGHT_DIR = new Vector3(...KEY_LIGHT_POS).normalize();
const FILL_LIGHT_DIR = new Vector3(...FILL_LIGHT_POS).normalize();
const RIM_LIGHT_DIR = new Vector3(...RIM_LIGHT_POS).normalize();

// Unit quad, oriented so its face normal is +Z. Instances are billboarded
// (rotated to always face the camera) every frame in DotsModel below, so
// the quad always reads as a flat dot facing the viewer regardless of the
// model's local surface angle. Since the instance transform's rotation no
// longer carries the true surface normal, the real normal travels
// separately via the `instanceNormal` buffer attribute set in DotsModel,
// and is what the shader actually uses for lighting. The fragment shader
// clips each quad to a circle, so despite the quad geometry these render
// as round dots, not squares.
const DOT_GEOMETRY = new PlaneGeometry(1, 1);

function DotsModel({ modelPath }: { modelPath: string }) {
  const { scene } = useGLTF(modelPath);
  // const groupRef = useRef<Group>(null);
  const meshRef = useRef<InstancedMesh>(null);

  const instances = useMemo(
    () => buildDotInstances(scene, DOT_SPACING_VERTICAL, DOT_SPACING_HORIZONTAL),
    [scene]
  );

  // Held via useState's lazy initializer (not useMemo/useRef) so the
  // object is created exactly once, but is still treated as a normal
  // mutable value we're allowed to reach into later -- the React Compiler
  // flags mutating useMemo/useRef output but not useState output.
  // Size and lighting are fixed, code-defined constants (DOT_SIZE,
  // KEY_LIGHT_INTENSITY, etc.) -- no sliders drive these anymore, so the
  // uniforms never need to be patched after creation.
  const [material] = useState(
    () =>
      new ShaderMaterial({
        uniforms: {
          uSize: { value: DOT_SIZE },
          uIntensity: { value: KEY_LIGHT_INTENSITY },
          uLightDir: { value: KEY_LIGHT_DIR },
          uFillDir: { value: FILL_LIGHT_DIR },
          uFillIntensity: { value: FILL_LIGHT_INTENSITY },
          uRimDir: { value: RIM_LIGHT_DIR },
          uRimIntensity: { value: RIM_LIGHT_INTENSITY },
          uColor: { value: [DOT_COLOR.r, DOT_COLOR.g, DOT_COLOR.b] },
        },
        vertexShader: /* glsl */ `
          uniform float uSize;
          uniform float uIntensity;
          uniform vec3 uLightDir;
          uniform vec3 uFillDir;
          uniform float uFillIntensity;
          uniform vec3 uRimDir;
          uniform float uRimIntensity;

          // True surface normal, per instance -- the instance transform's
          // own rotation is now a camera-facing billboard (see DotsModel),
          // so it can no longer double as the normal like it used to.
          attribute vec3 instanceNormal;

          // Quad-local position (-0.5..0.5 on each axis), passed through so
          // the fragment shader can clip the quad to a circle.
          varying vec2 vLocalPos;

          void main() {
            vec3 worldNormal = normalize(instanceNormal);

            float keyLit = max(dot(worldNormal, uLightDir), 0.0) * uIntensity;
            float fillLit = max(dot(worldNormal, uFillDir), 0.0) * uFillIntensity;
            float rimLit = max(dot(worldNormal, uRimDir), 0.0) * uRimIntensity;

            float lit = keyLit + fillLit + rimLit;
            float raw = lit * 1.2;
            float t = clamp(pow(raw, 0.5), 0.0, 1.0);
            float sizeMul = mix(2.4, 0.0, t);

            vLocalPos = position.xy;

            if (sizeMul < 0.01) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }

            // True world-space size: perspective foreshortening comes for
            // free from the projection matrix, unlike gl_PointSize which
            // needed a manual 1/-z hack and is capped by the GPU/driver.
            vec4 localPos = vec4(position.xy * uSize * sizeMul, position.z * uSize * sizeMul, 1.0);
            vec4 worldPos = instanceMatrix * localPos;
            vec4 mvPosition = modelViewMatrix * worldPos;
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying vec2 vLocalPos;
          void main() {
            // Clip the quad to a circle so each instance reads as a round
            // dot instead of a square. A hard discard (rather than alpha
            // blending) keeps the material fully opaque, which matters
            // here since the 100k instances in one InstancedMesh aren't
            // depth-sorted -- blended edges would show through each other
            // incorrectly.
            if (length(vLocalPos) > 0.5) discard;
            gl_FragColor = vec4(uColor, 1.0);
          }
        `,
      })
  );

  // Positions stay embedded on the model surface, and the true surface
  // normal travels to the shader via its own buffer attribute now that the
  // instance transform's rotation is used for camera-facing (below) rather
  // than for carrying the normal.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const normalArray = new Float32Array(instances.length * 3);
    for (let i = 0; i < instances.length; i++) {
      const { normal } = instances[i];
      normalArray[i * 3] = normal.x;
      normalArray[i * 3 + 1] = normal.y;
      normalArray[i * 3 + 2] = normal.z;
    }
    mesh.geometry.setAttribute("instanceNormal", new InstancedBufferAttribute(normalArray, 3));
    mesh.frustumCulled = false;
  }, [instances]);

  // Billboard every dot to face the camera, every frame -- this is what
  // makes the dots always face us instead of tilting with the local
  // surface plane the way a "stamped" orientation would. Skipped once the
  // camera's orientation stops changing meaningfully (the common case
  // once a view transition settles) so we're not recomposing tens of
  // thousands of matrices every frame for no visual change.
  const dummy = useMemo(() => new Object3D(), []);
  const lastCamQuat = useRef(new Quaternion(NaN, NaN, NaN, NaN));

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh || instances.length === 0) return;

    const { camera } = state;
    const last = lastCamQuat.current;
    const sameOrientation =
      Math.abs(
        camera.quaternion.x * last.x +
          camera.quaternion.y * last.y +
          camera.quaternion.z * last.z +
          camera.quaternion.w * last.w
      ) > 0.999999;
    if (sameOrientation) return;
    last.copy(camera.quaternion);

    for (let i = 0; i < instances.length; i++) {
      dummy.position.copy(instances[i].position);
      dummy.quaternion.copy(camera.quaternion);
      // A little deterministic spin around the view axis keeps billboarded
      // squares from all sharing one axis-aligned edge orientation.
      dummy.rotateZ((i * 0.6180339887) % (Math.PI * 2));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  // The "bare skin" mesh underneath the dots. It used to be an invisible
  // depth-only occluder (colorWrite disabled) so the background showed
  // through the gaps; now it's rendered as flat, unlit pure white so the
  // parts of the model not covered by a dot read as true #fff -- not
  // affected by the scene's lights (MeshBasicMaterial ignores them
  // entirely) and, crucially, `fog: false` so the scene's fog doesn't mix
  // the background tint into it (that mixing was what made it read as
  // gray instead of pure white).
  const bareBody = useMemo(() => {
    const clone = scene.clone();
    clone.traverse((obj) => {
      const m = obj as Mesh;
      if (m.isMesh) {
        m.material = new MeshBasicMaterial({
          color: 0xffffff,
          fog: false,
          toneMapped: false,
        }) as Material;
      }
    });
    return clone;
  }, [scene]);

  // useFrame((state) => {
  //   if (!groupRef.current) return;
  //   groupRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.8) * 0.02;
  // });

  return (
    <group >
      <primitive object={bareBody} />
      <instancedMesh
        ref={meshRef}
        args={[DOT_GEOMETRY, material, instances.length]}
        renderOrder={0}
      />
    </group>
  );
}

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

export default function ModelScene() {
  const [view, setView] = useState<ViewKey>("reset");
  const [mode, setMode] = useState<Mode>("solid");
  const [gender, setGender] = useState<Gender>("male");
  const modelPath = MODEL_PATHS[gender];

  return (
    <div className="relative h-dvh w-full" style={{ background: PAGE_BACKGROUND }}>
      <Canvas
        shadows
        gl={{ alpha: true }}
        camera={{ position: VIEWS.reset.camPos, fov: 40 }}
        className="h-full w-full"
      >
        <fog attach="fog" args={[FOG_COLOR, 6, 16]} />

        <ambientLight intensity={1} />
        {/* Key light: front, nudged slightly left. */}
        <directionalLight
          position={KEY_LIGHT_POS}
          intensity={KEY_LIGHT_INTENSITY}
          castShadow={mode === "solid"}
          shadow-mapSize={[1024, 1024]}
        />
        {/* Fill light: secondary, softens the shadow side from front-right. */}
        {/* <directionalLight position={FILL_LIGHT_POS} intensity={FILL_LIGHT_INTENSITY} /> */}
        {/* Rim light: intense, from the left (and slightly behind) to
            create a bright edge highlight on the model's left side. */}
        {/* <directionalLight position={RIM_LIGHT_POS} intensity={RIM_LIGHT_INTENSITY} /> */}

        {mode === "solid" ? (
          gender === "male" ? (
            // Man_Mesh clean3.glb is the rigged/posable model -- its pose reacts
            // to the button row via `view`. DotsModel below still uses the
            // plain SolidModel-style static scene for male too, since the
            // dot grid is baked once from rest pose and doesn't re-sample
            // per pose change.
            <PosableModel key={modelPath} modelPath={modelPath} view={view} />
          ) : (
            <SolidModel key={modelPath} modelPath={modelPath} />
          )
        ) : (
          <DotsModel key={modelPath} modelPath={modelPath} />
        )}
        <CameraRig view={view} />

        <ContactShadows
          position={[0, 0.001, 0]}
          opacity={mode === "solid" ? 0.55 : 0}
          scale={10}
          blur={2.5}
          far={4}
        />
      </Canvas>

      <div className="pointer-events-none absolute inset-x-0 top-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          3D Human
        </h1>
      </div>

      <div className="absolute inset-x-0 bottom-8 flex flex-wrap items-center justify-center gap-3 px-4">
        <button
          onClick={() => setGender(gender === "male" ? "female" : "male")}
          className={`rounded-full border px-5 py-2 text-sm font-medium backdrop-blur transition-colors ${
            gender === "female"
              ? "border-pink-400 bg-pink-500/80 text-white"
              : "border-slate-300 bg-white/70 text-slate-700 hover:bg-slate-100"
          }`}
        >
          {gender === "male" ? "Male" : "Female"}
        </button>

        <button
          onClick={() => setMode(mode === "solid" ? "dots" : "solid")}
          className={`rounded-full border px-5 py-2 text-sm font-medium backdrop-blur transition-colors ${
            mode === "dots"
              ? "border-cyan-500 bg-cyan-500 text-white"
              : "border-slate-300 bg-white/70 text-slate-700 hover:bg-slate-100"
          }`}
        >
          {mode === "solid" ? "Dots" : "Solid"}
        </button>

        {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`rounded-full border px-5 py-2 text-sm font-medium backdrop-blur transition-colors ${
              view === key
                ? "border-blue-400 bg-blue-500/80 text-white"
                : "border-slate-300 bg-white/70 text-slate-700 hover:bg-slate-100"
            }`}
          >
            {VIEWS[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}

useGLTF.preload(MODEL_PATHS.male);
useGLTF.preload(MODEL_PATHS.female);

// (Man_Mesh clean3.glb ships with no built-in animation clips named "arm"/"head"/
// "heart" yet -- see chat for details. PosableModel above will still run
// fine, it just won't visibly repose until the GLB has those 3 clips.)