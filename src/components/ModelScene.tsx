"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, ContactShadows, useAnimations } from "@react-three/drei";
import {
  BufferAttribute,
  Color,
  Group,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

export type ViewKey =
  | "reset"
  | "head"
  | "heart"
  | "arms"
  | "kidney"
  | "thyroid"
  | "liver"
  | "lungs";
type Vector3Tuple = [number, number, number];

// Male rigged/posable model. (Gender swap removed -- this is the only model
// the scene renders now.)
const MODEL_PATH = "/Man_Mesh_clean8.glb";

const VIEWS: Record<
  ViewKey,
  { label: string; camPos: Vector3Tuple; target: Vector3Tuple }
> = {
  reset: { label: "Full Body", camPos: [0, 1.4, 3.6], target: [0, 0.9, 0] },
  head: { label: "Head", camPos: [0.25, 1.75, 1.15], target: [0, 1.68, 0] },
  heart: { label: "Heart", camPos: [0.45, 1.45, 1.25], target: [0, 1.38, 0] },
  arms: { label: "Arms", camPos: [0.7, 1.35, 1.3], target: [0.5, 1.25, 0] },
    kidney: { label: "Kidney", camPos: [-0.45, 1.25, 1.3], target: [0, 1.18, 0] },
  thyroid: { label: "Thyroid",  camPos: [0.25, 1.45, 1.15], target: [0, 1.58, 0] },
  liver: { label: "Liver", camPos: [-0.45, 1.45, 1.25], target: [0, 1.38, 0] },
  lungs: { label: "Lungs", camPos: [-0, 1.45, 1.25], target: [0, 1.38, 0] },
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
  kidney: "default",
  thyroid:"head",
  liver: "default",
  lungs:"default"
};

// Maps each view/button to the name of the MATERIAL SLOT (assigned to a
// group of faces in Blender) that should light up when that pose is
// active. This is a separate mapping from POSE_ACTION_NAMES above on
// purpose -- the pose clip for the arms button is named "arm" (singular),
// but the material slot covering that same area is named "hands" (see
// Man_Mesh_clean8.glb's material list). "reset" has no highlighted region
// at all -- clicking it turns every highlight off.
const HIGHLIGHT_REGION_NAMES: Record<ViewKey, string | null> = {
  reset: null,
  head: "head3",
  heart: "heart3",
  arms: "hands5",
  kidney: "kidney4",
  thyroid:"thyroid2",
  liver: "liver3",
  lungs:"lungs3"
};

// Tint color for whichever region is currently highlighted. This blends
// directly into the surface's own (placeholder white, for now) albedo --
// no emissive glow -- so it still reads as a normally-lit surface, just
// tinted, and swapping in real textures later won't break this.
const HIGHLIGHT_COLOR = "#82ffa3";

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
  thyroid2: 0.15,
  kidney4: 0.25,
  liver3: 0.2,
  head3: 0.25
};

function getHighlightBlendRadius(regionName: string): number {
  return HIGHLIGHT_BLEND_RADIUS_OVERRIDES[regionName] ?? HIGHLIGHT_BLEND_RADIUS;
}

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

// Scene fog color (kept light/neutral so it blends cleanly with the CSS
// radial-gradient page background behind the transparent canvas).
const FOG_COLOR = "#E6F5F9";

// CSS radial gradient behind the canvas, centered at the bottom of the
// viewport and fading from the pale cyan tint out to white.
const PAGE_BACKGROUND =
  "#fbfbfb";

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

  // Man_Mesh_clean8.glb currently ships with no real texture on any of its
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
      getHighlightBlendRadius
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

// Three-point lighting setup. Positions here are mirrored 1:1 onto the real
// <directionalLight> objects in the JSX below.
//
// KEY: the main light. Mostly from the front, nudged slightly left.
const KEY_LIGHT_POS: Vector3Tuple = [-0, 50, 60];
const KEY_LIGHT2_POS: Vector3Tuple = [-0, -50, 60];
const KEY_LIGHT_INTENSITY = 2;
const KEY_LIGHT2_INTENSITY = .3;

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
}

export default function ModelScene({ view, onViewChange }: ModelSceneProps) {
  return (
    <div className="relative  h-dvh  w-[70vw]" style={{ background: PAGE_BACKGROUND }}>
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
          castShadow
          shadow-mapSize={[1024, 1024]}
        />

        <directionalLight
          position={KEY_LIGHT2_POS}
          intensity={KEY_LIGHT2_INTENSITY}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />

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
  <div className="w-full h-full bg-gradient-to-t from-[#fbfbfb] to-transparent" />
</div>

      <div className="absolute  top-1/2 -translate-y-1/2 left-2  flex flex-col items-start justify-center gap-3 px-4">
        {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
          <button
            key={key}
            onClick={() => onViewChange(key)}
            className={`rounded-full border px-5 py-2 text-sm font-medium backdrop-blur transition-colors ${
              view === key
                ? "border-blue-400/0 bg-blue-500/0 text-black shadow-md shadow-black/10  hover:text-black"
                : "border-slate-300/0 bg-white/0 text-black/50 hover:bg-slate-100/0 hover:text-black"
            }`}
          >
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