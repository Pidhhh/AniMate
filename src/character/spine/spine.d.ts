/* Type surface for the vendored Spine 4.2.43 runtime.
 *
 * The bundle is a classic script that assigns a global, so it cannot be
 * imported — it is declared here instead and loaded via a <script> tag in
 * index.html.
 *
 * These declarations cover what this project actually calls. The runtime is
 * far larger; members that are only touched indirectly are typed loosely on
 * purpose rather than being modelled in full, because an inaccurate
 * declaration is worse than a permissive one.
 *
 * VERSION LOCK: the runtime must match the `.skel` version trailer exactly.
 * A skew produces silently wrong or corrupt rendering with no error at all.
 * Read the trailer at byte offset 12 before changing either side:
 *
 *     xxd -l 16 <name>.skel
 *     # 00000000: e248 54da d57e 54cd 0734 2e32 2e34 33c4  .......4.2.43.
 */

declare namespace spine {
  /** Wrap a canvas and own the single WebGL context.
   *  One context for the whole app: two stacked WebGL canvases flicker on
   *  Windows. */
  class ManagedWebGLRenderingContext {
    constructor(canvas: HTMLCanvasElement | string, contextConfig?: WebGLContextAttributes);
    canvas: HTMLCanvasElement;
    gl: WebGLRenderingContext;
  }

  class Matrix4 {
    values: Float32Array;
    /** Sets an orthographic window: (x, y, width, height). */
    ortho2d(x: number, y: number, width: number, height: number): void;
  }

  /** Physics policy for `Skeleton.updateWorldTransform`. */
  enum Physics {
    none = 0,
    pose = 1,
    update = 2,
  }

  class Shader {
    constructor(context: ManagedWebGLRenderingContext, vertexShader: string, fragmentShader: string);
    static newTwoColoredTextured(context: ManagedWebGLRenderingContext): Shader;
    static readonly SAMPLER: string;
    static readonly MVP_MATRIX: string;
    getProgram(): WebGLProgram | null;
    bind(): void;
    unbind(): void;
    setUniformi(uniform: string, value: number): void;
    setUniformf(uniform: string, value: number): void;
    setUniform2f(uniform: string, value: number, value2: number): void;
    setUniform3f(uniform: string, value: number, value2: number, value3: number): void;
    setUniform4x4f(uniform: string, values: Float32Array | number[]): void;
  }

  class PolygonBatcher {
    constructor(context: ManagedWebGLRenderingContext, twoColorTint?: boolean);
    begin(shader: Shader): void;
    end(): void;
  }

  class SkeletonRenderer {
    constructor(context: ManagedWebGLRenderingContext);
    premultipliedAlpha: boolean;
    draw(batcher: PolygonBatcher, skeleton: Skeleton, slotRangeStart?: number, slotRangeEnd?: number): void;
  }

  class TextureAtlas {
    constructor(atlasText: string, textureLoader: (path: string) => Texture | null);
    dispose(): void;
    getRegions(): AtlasRegion[];
  }

  class Texture {
    constructor(image: HTMLImageElement | ImageBitmap);
    dispose(): void;
  }

  class AtlasRegion {
    name: string;
    width: number;
    height: number;
  }

  class AssetManager {
    constructor(context: ManagedWebGLRenderingContext, pathPrefix?: string);
    loadTextureAtlas(path: string, success?: (path: string, atlas: TextureAtlas) => void): void;
    loadBinary(path: string, success?: (path: string, data: Uint8Array) => void): void;
    loadText(path: string, success?: (path: string, text: string) => void): void;
    get(path: string): unknown;
    require(path: string): unknown;
    removeAll(): void;
    hasErrors(): boolean;
    isLoadingComplete(): boolean;
    update(): boolean;
    dispose(): void;
  }

  /** Resolves attachment names in a skeleton binary against an atlas. */
  class AtlasAttachmentLoader {
    constructor(atlas: TextureAtlas);
  }

  /** Reads `.skel` binaries. Must match the version trailer in the file. */
  class SkeletonBinary {
    constructor(attachmentLoader: AtlasAttachmentLoader);
    scale: number;
    readSkeletonData(data: Uint8Array): SkeletonData;
  }

  class SkeletonData {
    findAnimation(name: string): Animation | null;
    findSkin(name: string): unknown;
  }

  class Animation {
    name: string;
    duration: number;
  }

  class Bone {
    active: boolean;
    a: number;
    b: number;
    c: number;
    d: number;
    worldX: number;
    worldY: number;
    x: number;
    y: number;
  }

  class SlotData {
    name: string;
    /** 0 = Normal, 1 = Additive, 2 = Multiply, 3 = Screen. */
    blendMode: number;
    visible: boolean;
  }

  class Slot {
    data: SlotData;
    bone: Bone;
    color: { a: number };
    getAttachment(): Attachment | null;
    setAttachment(attachment: Attachment | null): void;
  }

  class Attachment {
    name: string;
    worldVerticesLength: number;
    computeWorldVertices(
      slot: Slot,
      start: number,
      count: number,
      worldVertices: number[] | Float32Array,
      offset: number,
      stride: number,
    ): void;
  }

  class RegionAttachment extends Attachment {
    width: number;
    height: number;
    computeWorldVertices(
      slot: Slot,
      worldVertices: number[] | Float32Array,
      offset: number,
      stride: number,
    ): void;
  }

  class BoundingBoxAttachment extends Attachment {}
  class ClippingAttachment extends Attachment {}
  class PathAttachment extends Attachment {}
  class PointAttachment extends Attachment {}

  class Skeleton {
    constructor(data: SkeletonData);
    slots: Slot[];
    bones: Bone[];
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    setToSetupPose(): void;
    update(delta: number): void;
    updateWorldTransform(physics: Physics): void;
    findBone(name: string): Bone | null;
    findSlot(name: string): Slot | null;
  }

  class TrackEntry {
    animation: Animation | null;
    mixDuration: number;
    mixTime: number;
    mixingFrom: TrackEntry | null;
    alpha: number;
  }

  class AnimationState {
    constructor(data: AnimationStateData);
    /** Mix table. `defaultMix` is the cross-fade used when no pair is set. */
    data: AnimationStateData;
    update(delta: number): void;
    apply(skeleton: Skeleton): void;
    setAnimation(trackIndex: number, animationName: string, loop: boolean): TrackEntry;
    addAnimation(trackIndex: number, animationName: string, loop: boolean, delay: number): TrackEntry;
    setEmptyAnimation(trackIndex: number, mixDuration: number): TrackEntry;
    getCurrent(trackIndex: number): TrackEntry | null;
  }

  class AnimationStateData {
    constructor(skeletonData: SkeletonData);
    defaultMix: number;
    setMix(from: string, to: string, duration: number): void;
  }

  /** Decoded skeleton, atlas and animation state for one loaded character. */
  class SkeletonJson {
    constructor(atlas: TextureAtlas);
    scale: number;
    readSkeletonData(data: Uint8Array): SkeletonData;
  }
}

interface Window {
  /** Provided by public/vendor/spine-webgl.js. */
  spine: typeof spine;
}
