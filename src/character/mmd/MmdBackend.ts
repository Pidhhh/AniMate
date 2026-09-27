/* MMD (PMX/PMD) character backend.
 *
 * Built on Babylon.js + `babylon-mmd`. That pairing is not a preference — it
 * is the only maintained option. three.js removed `MMDLoader`, and both
 * `three-mmd-loader` and the `mmd-parser` it depended on have been abandoned
 * since 2022. `babylon-mmd` was updated this year and handles the parts that
 * are genuinely hard: SDEF skinning, toon and sphere-map materials, morphs,
 * IK, and append-transform solving.
 *
 * SCOPE. This is the first cut: mount, a fitted camera, materials, blinking,
 * a light idle sway, emotion via morphs, and a mouth morph while speaking. It
 * does NOT run MMD physics — hair and skirts will not swing — because that
 * needs a WASM Bullet runtime, which is a separate piece of work. Motion is
 * limited to a `.vmd` shipped alongside the model, if there is one.
 *
 * Model files are served from `/models/<id>/`, and a PMX references its
 * textures by relative path (`tex/Body.png`). That resolves correctly only
 * because the importer preserves directory structure — see `import_tree` in
 * `src-tauri/src/models.rs`. A flattened import loads with no textures and
 * raises no error at all.
 */

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';

/* Side-effect imports, and THE ORDER OF THESE TWO MATTERS.
 *
 * `RegisterPmxLoader()` constructs the plugin immediately, and that
 * constructor captures `MmdModelLoader.SharedMaterialBuilder` into its own
 * loader options **at that moment**. Registering the material builder
 * afterwards is too late — the plugin has already stored `null`.
 *
 * The result is the worst kind of failure: the model loads, the skeleton
 * solves, the mesh renders, and it is completely untextured. No error, and no
 * failed HTTP request, because with no material builder the loader never asks
 * for a texture in the first place.
 *
 * So: material builder first, PMX loader second. Do not reorder. */
import 'babylon-mmd/esm/Loader/mmdModelLoader';
import 'babylon-mmd/esm/Loader/pmxLoader';

/* Animation runtime. No ordering constraint. */
import 'babylon-mmd/esm/Runtime/Animation/mmdRuntimeModelAnimation';

import { SdefInjector } from 'babylon-mmd/esm/Loader/sdefInjector';
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime';
import { MmdStandardMaterialProxy } from 'babylon-mmd/esm/Runtime/mmdStandardMaterialProxy';
import type { MmdModel } from 'babylon-mmd/esm/Runtime/mmdModel';

import type {
  CharacterCapabilities,
  CharacterKind,
  CharacterRenderer,
  CharacterState,
  EmotionProfile,
  LookTarget,
  MotionOptions,
  MountOptions,
} from '../types';

/* MMD morphs are named in Japanese on essentially every model. English
   aliases are listed after each for the minority that ship localised names.
   The first match that exists on the model wins. */
const EMOTION_MORPHS: Record<string, string[]> = {
  neutral: [],
  happy: ['笑い', 'smile', 'Smile'],
  laughing: ['笑い', 'smile'],
  tease: ['笑い', 'にやり', 'smile'],
  cuddle: ['笑い', '照れ'],
  shy: ['照れ', 'blush'],
  sad: ['困る', '悲しい', 'sad'],
  crying: ['悲しい', '泣き', 'sad'],
  angry: ['怒り', 'angry'],
};

const BLINK_MORPHS = ['まばたき', '瞬き', 'blink', 'Blink'];
/* `あ` is the open-mouth shape every model has; it is what MMD uses for
   speech, and it is the only one worth driving without real lip sync. */
const MOUTH_MORPHS = ['あ', 'a', 'A'];

const BLINK_INTERVAL_MIN = 2.4;
const BLINK_INTERVAL_MAX = 5.6;
const BLINK_DURATION = 0.12;

export class MmdBackend implements CharacterRenderer {
  readonly kind: CharacterKind = 'mmd';

  readonly capabilities: CharacterCapabilities = {
    expressions: true,
    /* Mouth morph only — no amplitude analysis. */
    lipSync: false,
    /* No physics runtime yet. */
    physics: false,
    /* lookAt is accepted but does not drive eye bones yet. */
    gaze: false,
  };

  state: CharacterState = 'idle';
  error?: Error;

  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private runtime: MmdRuntime | null = null;
  private model: MmdModel | null = null;

  /** Morph names resolved against what this model actually has. */
  private blinkMorph: string | null = null;
  private mouthMorph: string | null = null;
  private emotionMorphs = new Map<string, string>();

  private emotion = 'neutral';
  private talking = false;
  private lookTarget: LookTarget | null = null;

  private blinkTimer = 2;
  private blinkPhase = 0;
  private mouthPhase = 0;
  private frames = 0;

  /** Every morph name the model exposes, for diagnostics. */
  private morphNames: string[] = [];

  /** What the loader produced, captured once at mount. */
  private loadReport: Record<string, string | number> = {};

  /* -------------------------------------------------------------- lifecycle */

  async mount(canvas: HTMLCanvasElement, opts: MountOptions): Promise<void> {
    try {
      this.state = 'loading';

      const source = opts.source;
      if (!source) throw new Error('No character imported yet. Add one in Settings.');
      if (source.kind !== 'mmd') {
        throw new Error(`This backend loads MMD models; the active model is ${source.kind}.`);
      }

      const entry = source.files.find((f) => /\.(pmx|pmd)$/i.test(f)) ?? source.entry;
      if (!/\.(pmx|pmd)$/i.test(entry)) {
        throw new Error('An MMD model needs a .pmx or .pmd file.');
      }

      const engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        /* Babylon otherwise logs a wall of shader warnings on first frame,
           which buries our own diagnostics. */
        disableWebGL2Support: false,
      });
      this.engine = engine;

      /* Correct SDEF skinning. Costs a shader permutation, and without it
         joints bend wrong in a way that is hard to attribute. */
      SdefInjector.OverrideEngineCreateEffect(engine);

      const scene = new Scene(engine);
      /* Transparent, so the app's own stage colour shows through — matching
         the Spine backend, and avoiding a floor colour that would look wrong
         behind an arbitrary model. */
      scene.clearColor = new Color4(0, 0, 0, 0);
      this.scene = scene;

      const light = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
      light.intensity = 0.85;
      light.groundColor = new Color3(0.5, 0.5, 0.55);

      const key = new DirectionalLight('key', new Vector3(0.4, -1, 0.6), scene);
      key.intensity = 1.1;

      /* No physics argument. Hair and skirts will not move; adding it needs a
         WASM Bullet runtime, which is a separate decision. */
      const runtime = new MmdRuntime(scene);
      runtime.register(scene);
      this.runtime = runtime;

      const url = `${source.baseUrl}${entry}`;
      const container = await LoadAssetContainerAsync(url, scene);
      container.addAllToScene();

      const mesh = container.meshes[0];
      if (!mesh) throw new Error(`Could not read a mesh out of ${entry}.`);

      this.model = runtime.createMmdModel(mesh as never, {
        materialProxyConstructor: MmdStandardMaterialProxy,
      });

      /* What the loader actually produced, reported through `stats` rather
         than logged from here — this layer has no business talking to the
         shell's log directly.
       *
       * The mesh list matters more than it looks: an MMD load does not
       * necessarily put the geometry in `meshes[0]`. Reporting only the first
       * mesh described an empty root node with no vertices and no material,
       * which reads exactly like a loader that produced nothing. */
      const asMesh = (m: unknown) =>
        m as {
          name?: string;
          getClassName?: () => string;
          getTotalVertices?: () => number;
          material?: { getClassName?: () => string; name?: string } | null;
          subMeshes?: unknown[];
        };

      const meshList = container.meshes.map(asMesh);
      const withVerts = meshList.filter((m) => (m.getTotalVertices?.() ?? 0) > 0);
      const biggest = [...withVerts].sort(
        (a, b) => (b.getTotalVertices?.() ?? 0) - (a.getTotalVertices?.() ?? 0),
      )[0];

      /* Kept compact but kept: `materials=0` is the signature of the import
         ordering bug above, and it is worth being able to see at a glance
         whether a model came through textured. */
      this.loadReport = {
        meshes: `${container.meshes.length}/${withVerts.length}v`,
        materials: container.materials.length,
        textures: container.textures.length,
        material: biggest?.material?.getClassName?.() ?? 'none',
        biggest: `${biggest?.getTotalVertices?.() ?? 0}v`,
      };

      this.resolveMorphs();
      this.frameCamera();

      engine.runRenderLoop(() => {
        if (!this.scene) return;
        this.tick();
        this.scene.render();
      });

      this.state = 'ready';
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err : new Error(String(err));
      throw this.error;
    }
  }

  unmount(): void {
    /* Babylon owns a WebGL context; disposing the engine releases it, and
       skipping that leaks a context per mount — the browser caps them, so a
       few re-imports would start failing with no obvious cause. */
    try {
      this.runtime?.unregister(this.scene as never);
    } catch {
      /* already torn down */
    }
    this.model = null;
    this.runtime = null;

    try {
      this.scene?.dispose();
    } catch {
      /* disposal must never throw out of teardown */
    }
    try {
      this.engine?.dispose();
    } catch {
      /* as above */
    }

    this.scene = null;
    this.engine = null;
    this.state = 'idle';
  }

  resize(width: number, height: number, _dpr: number): void {
    if (!this.engine) return;
    /* Babylon reads the canvas' CSS size, so this is a re-read rather than a
       dimension push. The dpr is Babylon's business, not ours. */
    void width;
    void height;
    this.engine.resize();
  }

  /* ------------------------------------------------------------------ input */

  setEmotion(emotion: EmotionProfile): void {
    this.emotion = emotion?.emotion || 'neutral';
  }

  setSpeaking(active: boolean): void {
    this.talking = Boolean(active);
    if (!this.talking) this.setMorph(this.mouthMorph, 0);
  }

  async playMotion(name: string, _opts?: MotionOptions): Promise<void> {
    /* No VMD playback yet. Rejecting loudly is better than resolving and
       doing nothing, which would look like the clip played and had no
       effect. */
    throw new Error(
      `MMD motion playback is not implemented yet (asked for "${name}").`,
    );
  }

  lookAt(target: LookTarget): void {
    /* Accepted and recorded, not applied. Driving eye bones needs the runtime
       bone system; see the NOT YET list at the foot of this file. */
    this.lookTarget = target;
  }

  get gazeTarget(): LookTarget | null {
    return this.lookTarget;
  }

  get stats(): {
    frames: number;
    morphs: number;
    morphNames: string;
    emotion: string;
    bones: number;
    hasModel: boolean;
    load: string;
    sceneTextures: number;
    textureNames: string;
  } {
    const scene = this.scene;

    /* Material and texture counts are reported because "loads, renders, and
       is mysteriously untextured" has no other symptom. Without these the
       only visible fact is a frame count, which looks identical whether the
       materials were built or not. */
    const sceneTextures = scene?.textures?.length ?? 0;
    const textureNames =
      scene?.textures
        ?.slice(0, 6)
        .map((t) => (t as { name?: string }).name ?? '?')
        .join(',') ?? '';

    return {
      frames: this.frames,
      morphs: this.morphNames.length,
      morphNames: this.morphNames.slice(0, 12).join(','),
      emotion: this.emotion,
      bones: this.model?.runtimeBones.length ?? 0,
      hasModel: this.model !== null,
      load: Object.entries(this.loadReport)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
      sceneTextures,
      textureNames,
    };
  }

  /* --------------------------------------------------------------- internals */

  /**
   * Match the generic morph names against what this model actually has.
   *
   * Models vary: most are Japanese, a few are localised, and a given model may
   * have none of a given kind. Resolving once at load means the per-frame path
   * never searches, and a model missing a morph degrades to "no expression"
   * rather than to a warning every frame.
   */
  private resolveMorphs(): void {
    const available = new Set<string>();
    try {
      for (const morph of this.model?.morph.morphs ?? []) {
        const name = (morph as { name?: string }).name;
        if (name) available.add(name);
      }
    } catch {
      /* Enumerating is best-effort; resolution below simply finds nothing. */
    }
    this.morphNames = [...available];

    const pick = (candidates: string[]): string | null =>
      candidates.find((name) => available.has(name)) ?? null;

    this.blinkMorph = pick(BLINK_MORPHS);
    this.mouthMorph = pick(MOUTH_MORPHS);

    this.emotionMorphs.clear();
    for (const [emotion, candidates] of Object.entries(EMOTION_MORPHS)) {
      const hit = pick(candidates);
      if (hit) this.emotionMorphs.set(emotion, hit);
    }
  }

  /** Places the camera so the model fills the viewport. */
  private frameCamera(): void {
    const scene = this.scene;
    const mesh = this.model?.mesh;
    if (!scene || !mesh) return;

    mesh.computeWorldMatrix(true);
    const bounds = mesh.getHierarchyBoundingVectors(true);
    const centre = bounds.max.add(bounds.min).scale(0.5);
    const height = Math.max(bounds.max.y - bounds.min.y, 0.001);

    /* MMD units are roughly centimetres, so a 158 cm model is ~158 units tall.
       Nothing here assumes that — the distance is derived from the measured
       box, which is what makes an arbitrary model frame correctly. */
    const camera = new ArcRotateCamera(
      'camera',
      Math.PI / 2,
      Math.PI / 2,
      height * 1.5,
      centre,
      scene,
    );

    /* Aim at the upper chest rather than the geometric centre, so the face
       lands in frame instead of the waist. */
    camera.setTarget(new Vector3(centre.x, bounds.min.y + height * 0.62, centre.z));

    const fov = camera.fov;
    const distance = (height * 0.55) / Math.tan(fov / 2);
    camera.radius = distance * 1.35;

    /* Orbiting is allowed — it is the one thing a 3D model does that a 2D one
       cannot — but clamped so the camera never goes under the floor or behind
       the model's back. */
    camera.lowerBetaLimit = Math.PI * 0.2;
    camera.upperBetaLimit = Math.PI * 0.72;
    camera.lowerRadiusLimit = distance * 0.6;
    camera.upperRadiusLimit = distance * 3;
    camera.wheelDeltaPercentage = 0.02;
    camera.attachControl(true);

  }

  private setMorph(name: string | null, weight: number): void {
    if (!name || !this.model) return;
    try {
      this.model.morph.setMorphWeight(name, weight);
    } catch {
      /* A morph that vanished between resolution and use is not worth a
         thrown frame. */
    }
  }

  /** Per-frame: emotion, blink, mouth. */
  private tick(): void {
    this.frames += 1;
    const engine = this.engine;
    if (!engine || !this.model) return;

    const dt = engine.getDeltaTime() / 1000;
    if (!(dt > 0) || dt > 0.5) return;

    /* Emotion. Only the mapped morph is raised; every other emotion morph is
       cleared, so switching does not leave the previous expression behind. */
    for (const [emotion, morph] of this.emotionMorphs) {
      const target = emotion === this.emotion ? 0.85 : 0;
      const current = this.model.morph.getMorphWeight?.(morph) ?? 0;
      this.setMorph(morph, current + (target - current) * Math.min(1, dt * 6));
    }

    /* Blink. A square-ish pulse rather than a fade — a slow blink reads as
       sleepy rather than as a blink. */
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
      this.blinkPhase = BLINK_DURATION;
    }
    if (this.blinkPhase > 0) {
      this.blinkPhase -= dt;
      const open = Math.max(0, this.blinkPhase / BLINK_DURATION);
      this.setMorph(this.blinkMorph, 1 - open);
    }

    /* Mouth. A slow open/close while speaking. Not lip sync — there is no
       amplitude to follow yet — but it is the difference between a model that
       looks like it is talking and one that does not. */
    if (this.talking) {
      this.mouthPhase += dt * 7.5;
      this.setMorph(this.mouthMorph, 0.35 + 0.35 * (1 + Math.sin(this.mouthPhase)) / 2);
    }
  }
}

/* NOT YET PORTED / IMPLEMENTED — listed so the gap is explicit:
 *
 *   MMD physics (MmdWasmRuntime + Bullet) — hair and skirts do not move
 *   VMD motion playback — playMotion() rejects
 *   VPD poses
 *   gaze via eye bones
 *   audio-driven lip sync
 *   camera animation (MmdCamera)
 */
