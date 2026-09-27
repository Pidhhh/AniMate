/* The character runtime contract.
 *
 * Two backends implement this: a Spine backend for the 2D skinned-mesh
 * pipeline, and an MMD backend for the 3D .pmx pipeline. CharacterHost picks
 * one at mount time and never branches on `kind` again — that is the whole
 * point of the abstraction, and it is what lets both runtimes coexist without
 * either being a second-class citizen.
 *
 * Nothing in here may reference a specific engine. If a backend needs to
 * expose something engine-specific, it does so through the optional
 * `capabilities` bag rather than by widening this interface.
 */

export type CharacterKind = 'spine' | 'mmd';

export type CharacterState = 'idle' | 'loading' | 'ready' | 'error';

/** A resolved emotional state, backend-agnostic.
 *
 *  The renderer decides *how* to express it: the Spine backend maps it onto
 *  its gesture profiles (base poses, expression sets, FX clips); the MMD
 *  backend maps it onto morphs and motion clips. Neither mapping belongs here.
 */
export interface EmotionProfile {
  /** Canonical label, e.g. 'neutral' | 'happy' | 'sad' | 'angry' | 'shy'. */
  emotion: string;
  /** Blend weight, 0..1. Backends clamp. */
  intensity: number;
  /** Optional expression-set name from the backend's own catalog. */
  expression?: string;
  /** Optional motion clip name from the backend's own catalog. */
  motion?: string;
}

export interface MountOptions {
  /** Character root, relative to the served asset root.
   *  Spine: a directory holding .skel/.atlas/.png.
   *  MMD:   a directory holding a .pmx. */
  assetPath: string;
  /** A user-imported model to load. Backends read their own file set out of
   *  `files` — a Spine backend wants the .skel and .atlas, an MMD backend the
   *  .pmx — so this stays format-neutral and no backend owns the descriptor. */
  source?: ModelSource;
  /** Upper bound on devicePixelRatio, to keep fill rate sane on 4K displays. */
  maxDpr?: number;
}

/** A model the user brought with them, resolved to fetchable URLs.
 *
 *  Nothing ships with the app: the stage is empty until one of these exists. */
export interface ModelSource {
  id: string;
  kind: ModelKind;
  /** Base URL the model's files are served from. Always ends with '/'. */
  baseUrl: string;
  /** Entry file name, relative to `baseUrl`. */
  entry: string;
  /** Every file in the model, relative to `baseUrl`. */
  files: string[];
}

export type ModelKind = 'spine' | 'mmd' | 'gltf' | 'vrm' | 'unknown';

/** Formats a backend can actually load today. Anything else is accepted at
 *  import time but reported as unsupported, rather than silently ignored. */
export const LOADABLE_KINDS: readonly ModelKind[] = ['spine', 'mmd'];

export interface MotionOptions {
  loop?: boolean;
  /** Seconds. Backends that cannot cross-fade ignore this. */
  mixDuration?: number;
}

export interface LookTarget {
  /** Normalised screen space, -1..1 on both axes, origin at centre. */
  x: number;
  y: number;
}

/** Optional engine-specific extras. Consumers must feature-detect. */
export interface CharacterCapabilities {
  /** Backend can blend expressions independently of motion. */
  expressions?: boolean;
  /** Backend drives mouth shapes from audio amplitude. */
  lipSync?: boolean;
  /** Backend simulates cloth/hair. */
  physics?: boolean;
  /** Backend honours lookAt(). */
  gaze?: boolean;
}

export interface CharacterRenderer {
  readonly kind: CharacterKind;

  readonly state: CharacterState;

  readonly capabilities: CharacterCapabilities;

  /** Last error, when state === 'error'. */
  readonly error?: Error;

  /** Attach to a canvas and load assets. Rejects on failure and leaves
   *  `state` as 'error' — it must never throw asynchronously. */
  mount(canvas: HTMLCanvasElement, opts: MountOptions): Promise<void>;

  /** Release GPU resources and detach listeners. Idempotent: calling it on an
   *  already-unmounted renderer is a no-op, not an error. */
  unmount(): void;

  setEmotion(emotion: EmotionProfile): void;

  /** Drives the talk cycle. Backends without lip sync still use this to pick
   *  a talking motion rather than an idle one. */
  setSpeaking(active: boolean): void;

  /** Play a named clip from the backend's own catalog. Rejects if the clip
   *  does not exist — callers should not assume a shared vocabulary. */
  playMotion(name: string, opts?: MotionOptions): Promise<void>;

  lookAt(target: LookTarget): void;

  /** Called on canvas resize. Backends own their own camera fit logic. */
  resize(width: number, height: number, dpr: number): void;
}

/** Lifecycle observer, so React state can mirror the renderer's. */
export type CharacterListener = (state: CharacterState, error?: Error) => void;
