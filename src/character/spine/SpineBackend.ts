/* Spine 4.2.43 character backend.
 *
 * Ported from `js/avatar.js` (RyzaChat 1.2.15). The render path follows the
 * official spine-ts 4.2 webgl example: ManagedWebGLRenderingContext, an
 * explicit Matrix4 MVP, PolygonBatcher and SkeletonRenderer. SceneRenderer's
 * OrthoCamera is not used.
 *
 * SCOPE. This is the render core: mount, the camera solve, idle playback from
 * EmotionProfilesV4, face/blink, the multiply-blend handling and the rim pass.
 * The additive limb/torso layer system, gaze and finger drivers, hit-testing
 * and scene parallax constraints are NOT ported yet — they are listed at the
 * bottom of this file so the omission is explicit rather than accidental.
 *
 * Track layout follows the original:
 *   0  idle            (looping base motion)
 *   2  eyes            (blink / eyes-closed)
 *   4  mouth           (idle mouth shape; lip sync drives this later)
 *   6  one-shots       (reactions; unused until the additive work lands)
 */

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
import { fitToBounds, type Bounds, type ViewWindow } from './camera';

/* ------------------------------------------------------------------ shaders */

const RIM_VS = [
  'attribute vec2 a_pos;',
  'attribute vec2 a_uv;',
  'varying vec2 v_uv;',
  'void main(){ v_uv=a_uv; gl_Position=vec4(a_pos,0.0,1.0); }',
].join('\n');

/* Six taps along the light direction, accumulating how much *transparent*
   neighbourhood each pixel has. That is the rim: bright where the silhouette
   faces away from the light. */
const RIM_FS = [
  '#ifdef GL_ES',
  'precision mediump float;',
  '#endif',
  'varying vec2 v_uv;',
  'uniform sampler2D u_texture;',
  'uniform vec2 u_texel;',
  'uniform vec2 u_light;',
  'uniform vec3 u_rimColor;',
  'uniform float u_rimOpacity;',
  'uniform float u_glowPower;',
  'void main(){',
  '  vec4 c=texture2D(u_texture,v_uv);',
  '  if(c.a<0.02){ gl_FragColor=vec4(0.0); return; }',
  '  float acc=0.0;',
  '  for(int i=1;i<=6;i++){',
  '    float t=float(i)/6.0;',
  '    float a2=texture2D(u_texture, v_uv + u_light*t*u_texel).a;',
  '    acc += (1.0-a2)*pow(1.0-t, u_glowPower);',
  '  }',
  '  acc/=6.0;',
  '  gl_FragColor=vec4(u_rimColor*acc*u_rimOpacity, acc*u_rimOpacity);',
  '}',
].join('\n');

/* ------------------------------------------------------------------- types */

const IDLE_TRACK = 0;
const EYE_TRACK = 2;
const MOUTH_TRACK = 4;

const FALLBACK_LIP = 'facial_mouth_002_scrub_02';
const FALLBACK_IDLE = [
  'motion_A_001_idle',
  'motion_A_002_idle',
  'motion_A_005_idle',
  'motion_A_006_idle',
  'motion_A_024_idle',
  'motion_A_025_idle',
];

const DEFAULT_IDLE_GAP = 6;

interface Host {
  canvas: HTMLCanvasElement;
  ctx: spine.ManagedWebGLRenderingContext;
  gl: WebGLRenderingContext;
  shader: spine.Shader;
  batcher: spine.PolygonBatcher;
  sr: spine.SkeletonRenderer;
  mvp: spine.Matrix4;
}

interface Layer {
  assets: spine.AssetManager;
  skeleton: spine.Skeleton | null;
  state: spine.AnimationState | null;
  data: spine.SkeletonData | null;
  ready: boolean;
  cssW: number;
  cssH: number;
  dpr: number;
  /** Generation token: a newer load orphans this layer's poll chain. */
  loadGen: number;
  loadTimer: number | null;
}

/** Only the parts of gesture.json this backend reads. The file is 2.3 MB of
 *  authored data; modelling it fully would be a liability, not a safety net. */
interface GestureData {
  projectConfig?: {
    armInOutPartConfig?: { idleGroupIds?: { byPosture?: Record<string, string>; default?: string } };
    tensionConfig?: { decayRates?: Record<string, number> };
  };
  emotionalGesture?: {
    EmotionProfilesV4?: Record<string, EmotionProfileData>;
    PoseTypeSets?: { previousId: string; newId: string; weight?: number }[];
  };
}

interface BasePose {
  id: string;
  weight?: number;
  poseTypeIds?: string[];
  applicableSittingIds?: string[];
}

interface ExpressionSet {
  weight?: number;
  eyeOpen?: string;
  eyeClosed?: string;
  eyebrow?: string;
  mouth?: string;
}

interface IntensityProfile {
  basePoses?: BasePose[];
  expressionSets?: ExpressionSet[];
  eyeBase?: string;
  eyebrowBase?: string;
  mouthBase?: string;
  poseRerollIntervalMin?: number;
  poseRerollIntervalMax?: number;
}

interface EmotionProfileData {
  intensityProfiles?: Record<string, IntensityProfile>;
}

/** Key light for the rim pass.
 *
 *  A model arrives with no scene, so there is nothing authored to read a light
 *  from. This neutral key stands in: warm, from the upper left, with the rim
 *  on. It is a deliberate default rather than a missing feature — a model with
 *  no lighting data still needs to read as lit. */
interface LightConfig {
  direction: number;
  color: number;
  rimEnabled: boolean;
  rimOpacity: number;
  rimGlowWidth: number;
  rimGlowPower: number;
}

const DEFAULT_LIGHT: LightConfig = {
  direction: 220,
  color: 0xffd9a8,
  rimEnabled: true,
  rimOpacity: 0.7,
  rimGlowWidth: 12,
  rimGlowPower: 2.4,
};

/** Weighted pick. Returns null for an empty or all-zero-weight list. */
function weighted<T>(items: T[], weightOf: (item: T) => number): T | null {
  let total = 0;
  for (const item of items) {
    const w = weightOf(item);
    if (w > 0) total += w;
  }
  if (!(total > 0)) return null;
  let roll = Math.random() * total;
  for (const item of items) {
    const w = weightOf(item);
    if (w <= 0) continue;
    roll -= w;
    if (roll <= 0) return item;
  }
  return items[items.length - 1] ?? null;
}

/**
 * Resolve a logical animation name to one that exists.
 *
 * The pack's names carry a posture/state suffix that callers do not always
 * know, so try the exact name, then `_idle`, then `_active`, then the stripped
 * form. Returns null when nothing matches — callers must handle that rather
 * than assume a shared vocabulary.
 */
function pickAnim(data: spine.SkeletonData | null, name: string | undefined | null): string | null {
  if (!name || !data) return null;
  if (data.findAnimation(name)) return name;
  if (!/_idle$/.test(name) && data.findAnimation(name + '_idle')) return name + '_idle';
  if (!/_active$/.test(name) && data.findAnimation(name + '_active')) return name + '_active';
  const stripped = name.replace(/_(idle|active)$/, '');
  if (stripped !== name && data.findAnimation(stripped)) return stripped;
  return null;
}

/* ----------------------------------------------------------------- backend */

export class SpineBackend implements CharacterRenderer {
  readonly kind: CharacterKind = 'spine';

  readonly capabilities: CharacterCapabilities = {
    expressions: true,
    lipSync: false,
    physics: true,
    gaze: false,
  };

  state: CharacterState = 'idle';
  error?: Error;

  private host: Host | null = null;
  private avatar: Layer | null = null;

  private gesture: GestureData | null = null;

  private view: ViewWindow = { left: 0, bottom: 0, worldW: 1, worldH: 1 };
  /** Measured extent of the loaded character, in its own world space.
   *  Drives the camera fit — see `measureBounds`. */
  private bounds: Bounds | null = null;

  private emotion = 'neutral';
  private talking = false;

  private raf = 0;
  private lastNow = 0;
  private disposed = false;

  private idleTimer = 0;
  private idleGap = DEFAULT_IDLE_GAP;
  private poseType = '';

  private blinkTimer = 3;
  private eyeOpenName: string | null = null;
  private eyeClosedName: string | null = null;
  private mouthIdleName: string | null = null;

  /* resize debounce: five identical readings (~80 ms) before committing, so
     DPR/zoom oscillation stops thrashing backing-store reallocs */
  private rzW = 0;
  private rzH = 0;
  private rzDpr = 0;
  private rzN = 0;

  /* rim pass */
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboW = 0;
  private fboH = 0;
  private rimShader: spine.Shader | null = null;
  private quadBuf: WebGLBuffer | null = null;

  private lookTarget: LookTarget | null = null;

  /** Frames drawn. Zero after a mount means the loop never ticked. */
  private frames = 0;

  /* -------------------------------------------------------------- lifecycle */

  async mount(canvas: HTMLCanvasElement, opts: MountOptions): Promise<void> {
    try {
      this.state = 'loading';

      const source = opts.source;
      if (!source) {
        throw new Error('No character imported yet. Add one in Settings.');
      }
      if (source.kind !== 'spine') {
        throw new Error(
          `This backend loads Spine models; the active model is ${source.kind}.`,
        );
      }

      /* A Spine model is a set, not a file. Both parts are required and the
         error says so, because "nothing happened" is the alternative. */
      const skelFile = source.files.find((f) => f.toLowerCase().endsWith('.skel'));
      const atlasFile = source.files.find((f) => f.toLowerCase().endsWith('.atlas'));
      if (!skelFile || !atlasFile) {
        throw new Error(
          'A Spine model needs a .skel and a .atlas. Import them together.',
        );
      }

      this.host = this.makeHost(canvas);
      if (!this.host) throw new Error('WebGL is unavailable in this webview');

      this.avatar = this.makeLayer(this.host);

      /* The gesture profile is optional. Without it there is no emotion table,
         so idle selection falls back to the built-in list rather than
         failing — a model with no gesture data is still a valid model. */
      const gestureFile = source.files.find((f) =>
        f.toLowerCase().endsWith('_gesture.json'),
      );
      this.gesture = gestureFile
        ? await this.fetchJson<GestureData>(`${source.baseUrl}${gestureFile}`)
        : null;

      await this.loadSpine(
        this.avatar,
        `${source.baseUrl}${skelFile}`,
        `${source.baseUrl}${atlasFile}`,
      );

      this.measureBounds();
      this.refreshFace();
      /* Establish the base motion immediately. `rerollIdle` is otherwise only
         reached from the loop after `idleGap` (~6 s), so without this call the
         character holds the setup pose on arrival — which reads as a frozen
         model rather than a slow start. */
      this.rerollIdle();

      this.resize(canvas.clientWidth, canvas.clientHeight, this.effectiveDpr());
      this.startLoop();
      this.state = 'ready';
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err : new Error(String(err));
      throw this.error;
    }
  }

  unmount(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();

    const gl = this.host?.gl;
    if (gl) {
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    }
    this.fbo = null;
    this.fboTex = null;
    this.quadBuf = null;
    this.rimShader = null;

    const layer = this.avatar;
    if (layer?.loadTimer != null) window.clearTimeout(layer.loadTimer);
    try {
      layer?.assets.dispose();
    } catch {
      /* disposal must never throw out of teardown */
    }

    /* The WebGL context belongs to the canvas, not to us — dropping the
       reference is the most we can do without destroying a canvas React
       still owns. */
    this.host = null;
    this.avatar = null;
    this.state = 'idle';
  }

  resize(width: number, height: number, dpr: number): void {
    const host = this.host;
    if (!host) return;

    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const scale = Math.max(1, dpr || 1);
    const bw = Math.max(1, Math.floor(w * scale));
    const bh = Math.max(1, Math.floor(h * scale));

    if (host.canvas.width !== bw || host.canvas.height !== bh) {
      host.canvas.width = bw;
      host.canvas.height = bh;
    }
    host.gl.viewport(0, 0, bw, bh);

    const layer = this.avatar;
    if (layer) {
      layer.cssW = w;
      layer.cssH = h;
      layer.dpr = scale;
    }

    /* One pass: the camera solve also places the character. */
    this.applyCamera();
  }

  /* ------------------------------------------------------------------ input */

  setEmotion(emotion: EmotionProfile): void {
    const next = emotion?.emotion || 'neutral';
    const changed = next !== this.emotion;
    this.emotion = next;
    this.refreshFace();
    if (changed) {
      /* A new emotion re-rolls the idle immediately rather than waiting out
         the current gap, so a reaction reads as a reaction. */
      this.idleTimer = this.idleGap;
    }
  }

  setSpeaking(active: boolean): void {
    this.talking = Boolean(active);
    if (!this.talking) this.restoreMouth();
  }

  async playMotion(name: string, _opts?: MotionOptions): Promise<void> {
    const layer = this.avatar;
    if (!layer?.state || !layer.data) throw new Error('character not loaded');
    const resolved = pickAnim(layer.data, name);
    if (!resolved) throw new Error(`no such motion: ${name}`);
    const entry = layer.state.setAnimation(IDLE_TRACK, resolved, false);
    entry.mixDuration = _opts?.mixDuration ?? 0.2;
  }

  lookAt(target: LookTarget): void {
    /* Stored but not yet applied — the gaze driver rig is part of the
       additive work. Kept so callers can be written against the final
       contract now, and readable via `gazeTarget` to confirm delivery. */
    this.lookTarget = target;
  }

  /** Last gaze target requested. Exposed so callers and diagnostics can
   *  confirm delivery while the gaze rig itself is still unported. */
  get gazeTarget(): LookTarget | null {
    return this.lookTarget;
  }

  /** Live pipeline state, for diagnostics and for asserting that the loop is
   *  actually running rather than merely having loaded successfully.
   *  `frames === 0` after a mount means the render loop never ticked. */
  get stats(): {
    frames: number;
    idle: string;
    animations: number;
    bones: number;
    poseType: string;
    width: number;
    height: number;
    measured: boolean;
    hasRim: boolean;
  } {
    const layer = this.avatar;
    const idleEntry = layer?.state?.getCurrent(IDLE_TRACK) ?? null;
    return {
      frames: this.frames,
      idle: idleEntry?.animation?.name ?? '',
      animations: layer?.data
        ? ((layer.data as unknown as { animations?: unknown[] }).animations?.length ?? 0)
        : 0,
      bones: layer?.skeleton?.bones.length ?? 0,
      poseType: this.poseType,
      width: Math.round(this.view.worldW),
      height: Math.round(this.view.worldH),
      measured: this.bounds !== null,
      hasRim: this.rimShader !== null,
    };
  }

  /* --------------------------------------------------------------- internals */

  private makeHost(canvas: HTMLCanvasElement): Host | null {
    let ctx: spine.ManagedWebGLRenderingContext;
    try {
      /* One WebGL context for the whole app: two stacked WebGL canvases
         flicker on Windows. */
      ctx = new window.spine.ManagedWebGLRenderingContext(canvas, {
        alpha: false,
        premultipliedAlpha: false,
        antialias: false,
      });
    } catch {
      return null;
    }
    if (!ctx?.gl) return null;

    return {
      canvas,
      ctx,
      gl: ctx.gl,
      shader: window.spine.Shader.newTwoColoredTextured(ctx),
      batcher: new window.spine.PolygonBatcher(ctx),
      sr: new window.spine.SkeletonRenderer(ctx),
      mvp: new window.spine.Matrix4(),
    };
  }

  private makeLayer(host: Host): Layer {
    return {
      assets: new window.spine.AssetManager(host.ctx),
      skeleton: null,
      state: null,
      data: null,
      ready: false,
      cssW: 0,
      cssH: 0,
      dpr: 1,
      loadGen: 0,
      loadTimer: null,
    };
  }

  private effectiveDpr(): number {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastNow = 0;
    this.raf = window.requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /* ---------------------------------------------------------- asset loading */

  private loadSpine(layer: Layer, skelUrl: string, atlasUrl: string): Promise<void> {
    const assets = layer.assets;
    assets.removeAll();

    assets.loadBinary(skelUrl);
    assets.loadTextureAtlas(atlasUrl);

    /* Generation token: a newer load on the same layer orphans this poll
       chain. Without it, a rapid scene→skin swap leaves two polls sharing one
       asset queue, both resolve on the newer data, and the completion fires
       twice with last-wins results. */
    if (layer.loadTimer != null) window.clearTimeout(layer.loadTimer);
    layer.loadGen += 1;
    const gen = layer.loadGen;

    return new Promise<void>((resolve, reject) => {
      let tries = 0;

      const poll = () => {
        layer.loadTimer = null;
        if (layer.loadGen !== gen) return;
        if (this.disposed) return;

        if (assets.isLoadingComplete()) {
          if (assets.hasErrors()) {
            reject(new Error(`asset load failed: ${skelUrl}`));
            return;
          }
          try {
            const atlas = assets.require(atlasUrl) as spine.TextureAtlas;
            const loader = new window.spine.AtlasAttachmentLoader(atlas);
            const bin = new window.spine.SkeletonBinary(loader);
            bin.scale = 1;
            const data = bin.readSkeletonData(assets.require(skelUrl) as Uint8Array);

            layer.data = data;
            layer.skeleton = new window.spine.Skeleton(data);
            layer.state = new window.spine.AnimationState(new window.spine.AnimationStateData(data));
            layer.state.data.defaultMix = 0.12;
            layer.ready = true;
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }

        if (++tries > 900) {
          reject(new Error(`asset load timed out: ${skelUrl}`));
          return;
        }
        layer.loadTimer = window.setTimeout(poll, 50);
      };

      poll();
    });
  }

  /* ------------------------------------------------------------------ camera */

  /**
   * The painted-plate box of the scene: the LARGEST quad it draws, not the
   * union. A far-away foreground strip would otherwise pretend the gap under
   * the backdrop is covered, and a missed cover means a missed clamp means
   * black bars.
   */
  /**
   * Measure the loaded character's extent in setup pose.
   *
   * This is what makes an arbitrary imported model frameable. A model arrives
   * with no camera configuration, and models differ in scale by orders of
   * magnitude, so any fixed window is wrong for most of them. Measuring the
   * subject and fitting to it needs no per-model setup.
   */
  private measureBounds(): void {
    const layer = this.avatar;
    this.bounds = null;
    if (!layer?.skeleton) return;

    const spine = window.spine;

    try {
      layer.skeleton.setToSetupPose();
      layer.skeleton.updateWorldTransform(spine.Physics.none);
    } catch {
      return;
    }

    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let found = false;

    for (const slot of layer.skeleton.slots) {
      if (!slot.bone.active || !slot.data.visible) continue;

      const att = slot.getAttachment();
      if (
        !att ||
        att instanceof spine.BoundingBoxAttachment ||
        att instanceof spine.ClippingAttachment ||
        att instanceof spine.PathAttachment ||
        att instanceof spine.PointAttachment
      ) {
        continue;
      }

      const verts: number[] = [];
      try {
        if (att instanceof spine.RegionAttachment) {
          att.computeWorldVertices(slot, verts, 0, 2);
        } else if (att.worldVerticesLength) {
          att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
        } else {
          continue;
        }
      } catch {
        continue;
      }

      for (let i = 0; i + 1 < verts.length; i += 2) {
        const vx = verts[i];
        const vy = verts[i + 1];
        if (vx === undefined || vy === undefined || !isFinite(vx) || !isFinite(vy)) continue;
        if (vx < x0) x0 = vx;
        if (vx > x1) x1 = vx;
        if (vy < y0) y0 = vy;
        if (vy > y1) y1 = vy;
        found = true;
      }
    }

    if (!found || !(x1 > x0) || !(y1 > y0)) return;
    this.bounds = { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
  }

  /** Solve the window, then place the character inside it. */
  private applyCamera(): void {
    const host = this.host;
    const ref = this.avatar;
    if (!host || !ref?.cssW || !ref.cssH) return;

    const aspect = ref.cssW / ref.cssH;
    const view = fitToBounds(this.bounds, aspect);
    this.view = view;

    host.mvp.ortho2d(view.left, view.bottom, view.worldW, view.worldH);
    host.gl.viewport(0, 0, host.canvas.width, host.canvas.height);

    /* The window is expressed in the model's own world space, so the skeleton
       sits at the origin untouched — no remapping, no scale correction. */
    const skeleton = this.avatar?.skeleton;
    if (skeleton) {
      skeleton.x = 0;
      skeleton.y = 0;
      skeleton.scaleX = 1;
      skeleton.scaleY = 1;
    }
  }

  /* ------------------------------------------------------- emotion and face */

  private profileFor(emotion: string): EmotionProfileData | null {
    const map = this.gesture?.emotionalGesture?.EmotionProfilesV4;
    if (!map) return null;
    return map[emotion] ?? map.neutral ?? null;
  }

  private intensityBand(): 'weak' | 'normal' | 'strong' {
    return this.talking ? 'strong' : 'normal';
  }

  private intensityFor(emotion: string): IntensityProfile | null {
    const profile = this.profileFor(emotion);
    const profiles = profile?.intensityProfiles;
    if (!profiles) return null;
    return profiles[this.intensityBand()] ?? profiles.normal ?? profiles.strong ?? profiles.weak ?? null;
  }

  private basePoses(): BasePose[] {
    return this.intensityFor(this.emotion)?.basePoses ?? [];
  }

  private poseTypeSets(): { previousId: string; newId: string; weight?: number }[] {
    return this.gesture?.emotionalGesture?.PoseTypeSets ?? [];
  }

  /** Type ids for a pose, falling back to the freehand default. */
  private poseTypesOf(poseId: string): string[] {
    const poses = this.basePoses();
    const own = poses.find((p) => p.id === poseId);
    if (own?.poseTypeIds?.length) return own.poseTypeIds;
    return ['posetype_01_freehand'];
  }

  private pickPoseType(previous: string): string {
    const candidates = this.poseTypeSets().filter((s) => s.previousId === previous);
    if (!candidates.length) return previous || 'posetype_01_freehand';
    const pick = weighted(candidates, (s) => Number(s.weight) || 0);
    return pick?.newId || previous || 'posetype_01_freehand';
  }

  private idlesForType(data: spine.SkeletonData, poseType: string): { name: string; w: number }[] {
    const poses = this.basePoses();

    const typed = poses
      .filter((p) => {
        if (!p?.id || !pickAnim(data, p.id)) return false;
        const ids = p.poseTypeIds ?? [];
        if (!poseType) return true;
        return ids.length > 0 && ids.includes(poseType);
      })
      .map((p) => {
        const w = Number(p.weight);
        return { name: pickAnim(data, p.id) as string, w: w > 0 ? w : 1 };
      })
      .filter((x) => Boolean(x.name));

    if (typed.length) return typed;

    if (poseType && poseType !== 'posetype_01_freehand') {
      return this.idlesForType(data, 'posetype_01_freehand');
    }

    return FALLBACK_IDLE.map((name) => {
      const hit = pickAnim(data, name);
      return hit ? { name: hit, w: 1 } : null;
    }).filter((x): x is { name: string; w: number } => x !== null);
  }

  /** Re-roll the face from the current emotion's expression sets.
   *
   *  `weight` is optional in the data (absent = 1) and an explicit 0 is the
   *  author switching a face off. Never fall back to a disabled set — with
   *  nothing live, the band's base clips apply. */
  private refreshFace(): void {
    const layer = this.avatar;
    if (!layer?.data) return;

    const intensity = this.intensityFor(this.emotion);
    this.eyeOpenName = pickAnim(layer.data, intensity?.eyeBase);
    this.eyeClosedName = null;
    this.mouthIdleName = pickAnim(layer.data, intensity?.mouthBase) ?? pickAnim(layer.data, FALLBACK_LIP);

    const sets = intensity?.expressionSets ?? [];
    const live = sets.filter((s) => s.weight == null || Number(s.weight) > 0);
    if (!live.length) return;

    const pick = weighted(live, (s) => (Number(s.weight) > 0 ? Number(s.weight) : 1));
    if (!pick) return;

    if (pick.eyeOpen) this.eyeOpenName = pickAnim(layer.data, pick.eyeOpen);
    if (pick.eyeClosed) this.eyeClosedName = pickAnim(layer.data, pick.eyeClosed);

    /* Eye and mouth are separate tracks so a blink cannot disturb a mouth
       shape, and vice versa. */
    if (this.eyeOpenName) {
      const tr = layer.state!.setAnimation(EYE_TRACK, this.eyeOpenName, true);
      tr.mixDuration = 0.15;
    }
    if (this.mouthIdleName && !this.talking) {
      const tr = layer.state!.setAnimation(MOUTH_TRACK, this.mouthIdleName, true);
      tr.mixDuration = 0.2;
    }
  }

  private restoreMouth(): void {
    const layer = this.avatar;
    if (!layer?.state || !this.mouthIdleName) return;
    layer.state.setAnimation(MOUTH_TRACK, this.mouthIdleName, true).mixDuration = 0.2;
  }

  /* ---------------------------------------------------------------- playback */

  private rerollIdle(): void {
    const layer = this.avatar;
    if (!layer?.ready || !layer.state || !layer.data) return;

    const current = layer.state.getCurrent(IDLE_TRACK);
    if (current?.mixingFrom) return;

    const fromName = current?.animation?.name;
    const previousType = this.poseType || (fromName ? this.poseTypesOf(fromName)[0] : '') || 'posetype_01_freehand';
    const nextType = this.pickPoseType(previousType);

    let idles = this.idlesForType(layer.data, nextType);
    if (!idles.length) {
      idles = this.idlesForType(layer.data, 'posetype_01_freehand');
    }
    if (!idles.length) {
      this.idleTimer = 0;
      return;
    }

    const pick = weighted(idles, (x) => x.w);
    if (!pick) {
      this.idleTimer = 0;
      return;
    }

    const intensity = this.intensityFor(this.emotion);
    const min = Number(intensity?.poseRerollIntervalMin) || 5;
    const max = Number(intensity?.poseRerollIntervalMax) || 8;
    this.idleGap = min + Math.random() * Math.max(0, max - min);
    this.idleTimer = 0;
    this.poseType = nextType;

    /* The shipped JSON leaves the expression-reroll intervals out, so the
       pose-reroll tick is the only cadence readable from the pack. Without
       it the face only ever changed on an emotion or band flip. Never
       mid-speech: that would cut a lip-synced line. */
    if (!this.talking) this.refreshFace();

    if (fromName === pick.name) return;

    const entry = layer.state.setAnimation(IDLE_TRACK, pick.name, true);
    entry.mixDuration = 0.25;
  }

  private nextBlinkGap(): number {
    return 2.4 + Math.random() * 3.2;
  }

  private tickBlink(dt: number): void {
    const layer = this.avatar;
    if (!layer?.ready || !layer.state || !this.eyeOpenName || !this.eyeClosedName) return;

    this.blinkTimer -= dt;
    if (this.blinkTimer > 0) return;

    this.blinkTimer = this.nextBlinkGap();
    const state = layer.state;
    const blink = state.setAnimation(EYE_TRACK, this.eyeClosedName, false);
    blink.mixDuration = 0.04;
    const back = state.addAnimation(EYE_TRACK, this.eyeOpenName, true, 0);
    back.mixDuration = 0.08;
  }

  /* ------------------------------------------------------------------ render */

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(this.loop);

    const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.05) : 0;
    this.lastNow = now;

    this.tickResize();

    const layer = this.avatar;
    if (layer?.ready && layer.skeleton) {
      layer.state!.update(dt);
      layer.state!.apply(layer.skeleton);
      layer.skeleton.update(dt);
      /* One physics pass, after state.apply. A second pass would discard the
         simulated pose every frame and make actions jitter. */
      layer.skeleton.updateWorldTransform(window.spine.Physics.update);
    }

    this.idleTimer += dt;
    if (this.idleTimer > this.idleGap && this.avatar?.ready) this.rerollIdle();
    this.tickBlink(dt);

    this.draw();
  };

  private tickResize(): void {
    const host = this.host;
    const layer = this.avatar;
    if (!host || !layer) return;

    const cw = Math.max(1, Math.floor(host.canvas.clientWidth));
    const ch = Math.max(1, Math.floor(host.canvas.clientHeight));
    const dpr = this.effectiveDpr();

    if (cw === layer.cssW && ch === layer.cssH && dpr === layer.dpr) {
      this.rzN = 0;
      return;
    }

    /* Only commit after five identical readings (~80 ms). */
    if (this.rzW !== cw || this.rzH !== ch || this.rzDpr !== dpr) {
      this.rzW = cw;
      this.rzH = ch;
      this.rzDpr = dpr;
      this.rzN = 0;
    } else if (++this.rzN >= 5) {
      this.rzN = 0;
      this.resize(cw, ch, dpr);
    }
  }

  private drawSkeleton(layer: Layer, premultiplied: boolean): void {
    const host = this.host;
    if (!host || !layer.skeleton) return;
    host.sr.premultipliedAlpha = premultiplied;
    host.batcher.begin(host.shader);
    host.sr.draw(host.batcher, layer.skeleton);
    host.batcher.end();
  }

  private isSetupMultiply(name: string): boolean {
    return /nose_hi|cheek_line/.test(name);
  }

  private isOverlayMultiply(name: string): boolean {
    return /face_cheek|face_pale|face_tear|face_sweat|mouth_drool/.test(name);
  }

  /**
   * Multiply maps (hair shadow) need a premultiplied-alpha second pass.
   *
   * Overlay FX (blush / pale / tear) is straight-alpha pink: drawn as Multiply
   * it computes dst*(rgb+1-a) and the blush itself blows out, so those are
   * switched to Normal instead. Every mutation is restored in `finally` — the
   * slot state is shared with the next frame.
   */
  private drawLayer(layer: Layer | null): void {
    if (!layer?.ready || !layer.skeleton) return;

    const skeleton = layer.skeleton;
    const savedBlend: { slot: spine.Slot; blend: number }[] = [];
    const savedMul: { slot: spine.Slot; att: spine.Attachment | null }[] = [];
    const savedAlpha: { slot: spine.Slot; a: number }[] = [];
    const savedSetup: { slot: spine.Slot; att: spine.Attachment | null }[] = [];

    for (const slot of skeleton.slots) {
      const name = slot.data?.name ?? '';

      if (this.isSetupMultiply(name)) {
        savedSetup.push({ slot, att: slot.getAttachment() });
        const att = slot.getAttachment();
        if (att) slot.setAttachment(null);
        continue;
      }

      if (slot.data.blendMode === 2 && this.isOverlayMultiply(name)) {
        savedBlend.push({ slot, blend: slot.data.blendMode });
        slot.data.blendMode = 0;
        continue;
      }

      if (slot.data.blendMode === 2) {
        savedMul.push({ slot, att: slot.getAttachment() });
        const att = slot.getAttachment();
        if (att) slot.setAttachment(null);
      }
    }

    try {
      this.drawSkeleton(layer, false);

      for (const entry of savedMul) {
        if (entry.att) entry.slot.setAttachment(entry.att);
      }

      if (savedMul.length) {
        for (const slot of skeleton.slots) {
          const name = slot.data?.name ?? '';
          if (slot.data.blendMode === 2 && !this.isSetupMultiply(name) && !this.isOverlayMultiply(name)) {
            continue;
          }
          savedAlpha.push({ slot, a: slot.color.a });
          slot.color.a = 0;
        }
        this.drawSkeleton(layer, true);
      }
    } finally {
      for (const entry of savedAlpha) entry.slot.color.a = entry.a;
      for (const entry of savedBlend) entry.slot.data.blendMode = entry.blend;
      for (const entry of savedSetup) {
        if (entry.att) entry.slot.setAttachment(entry.att);
      }
    }
  }

  private ensureFbo(): boolean {
    const host = this.host;
    const gl = host?.gl;
    if (!gl || !host) return false;

    const w = host.canvas.width;
    const h = host.canvas.height;
    if (this.fbo && this.fboW === w && this.fboH === h) return true;

    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      this.fbo = null;
      this.fboTex = null;
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!ok || !tex || !fbo) {
      if (fbo) gl.deleteFramebuffer(fbo);
      if (tex) gl.deleteTexture(tex);
      return false;
    }

    this.fbo = fbo;
    this.fboTex = tex;
    this.fboW = w;
    this.fboH = h;

    if (!this.rimShader) {
      try {
        this.rimShader = new window.spine.Shader(host.ctx, RIM_VS, RIM_FS);
      } catch {
        return false;
      }
    }

    if (!this.quadBuf) {
      this.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
    }

    return true;
  }

  private blitRim(): void {
    const host = this.host;
    if (!host) return;
    const gl = host.gl;
    const light = DEFAULT_LIGHT;
    const shader = this.rimShader;
    const program = shader?.getProgram();
    if (!shader || !program || !this.fboTex) return;

    const packed = Number(light.color) >>> 0;
    const cr = ((packed >>> 16) & 255) / 255;
    const cg = ((packed >>> 8) & 255) / 255;
    const cb = (packed & 255) / 255;

    const rad = (light.direction * Math.PI) / 180;

    const glow = light.rimGlowWidth;
    const power = light.rimGlowPower;
    const opacity = light.rimEnabled ? light.rimOpacity : 0;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    shader.setUniformi('u_texture', 0);
    shader.setUniform2f('u_texel', 1 / this.fboW, 1 / this.fboH);
    shader.setUniform2f('u_light', Math.cos(rad) * glow, Math.sin(rad) * glow);
    shader.setUniform3f('u_rimColor', cr, cg, cb);
    shader.setUniformf('u_rimOpacity', opacity);
    shader.setUniformf('u_glowPower', power);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const locPos = gl.getAttribLocation(program, 'a_pos');
    const locUv = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locUv);
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(locPos);
    gl.disableVertexAttribArray(locUv);
    shader.unbind();

    /* The rim pass needs additive blending, but leaving it set washed out
       everything drawn after it. */
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private draw(): void {
    const host = this.host;
    if (!host?.gl) return;

    this.frames += 1;

    const gl = host.gl;
    const rimOn = DEFAULT_LIGHT.rimEnabled;

    /* Transparent, so the app's own background shows through. A model is not a
       stage: painting a floor colour behind an arbitrary character would look
       wrong for most of them. */
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    host.shader.bind();
    host.shader.setUniformi(window.spine.Shader.SAMPLER, 0);
    host.shader.setUniform4x4f(window.spine.Shader.MVP_MATRIX, host.mvp.values);
    this.drawLayer(this.avatar);

    if (rimOn && this.ensureFbo()) {
      host.shader.unbind();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.fboW, this.fboH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      host.shader.bind();
      host.shader.setUniformi(window.spine.Shader.SAMPLER, 0);
      host.shader.setUniform4x4f(window.spine.Shader.MVP_MATRIX, host.mvp.values);
      this.drawLayer(this.avatar);
      host.shader.unbind();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, host.canvas.width, host.canvas.height);
      this.blitRim();
    } else {
      host.shader.unbind();
    }
  }
}

/* NOT YET PORTED from js/avatar.js — listed so the gap is explicit:
 *
 *   additive limb/torso layer system (_syncAdditives, _applyLayer, _queueAddTrack)
 *   gaze and finger drivers (_updateLook, _applyLook, _bindPointer, DriverDefs)
 *   hit testing (_onCharacter, hitPartAt, screenToWorld)
 *   scene parallax constraints (_applySceneConstraints)
 *   scene fade and the curtain transition
 *   FX slot handling (_syncFx, _hideFxSlots)
 *   skin/atlas variants (nsfw page swap)
 *   ASMR camera mode
 *   lip sync (_applyLip) — setSpeaking currently only gates the mouth track
 */
