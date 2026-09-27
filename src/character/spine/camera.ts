/* Camera solve for the Spine stage.
 *
 * Ported from `js/avatar.js` (`_camParams`, `_applyCamera`, `_placeCharacter`).
 * The comments explaining the calibration constants are carried over verbatim
 * in substance — they are the only record of why those numbers are what they
 * are, and they were derived against the shipped screenshots.
 *
 * Two windows are in play at all times:
 *   `auth`  — the authored window the posture table asks for
 *   `view`  — that window after being clamped to the scene plate's painted box
 * The character is mapped through `view`, which is what keeps her authored
 * on-screen framing regardless of what the plate forced on the camera.
 */

/** posture_camera.json is relative: zoom 1.93 (sitting) is the reference the
 *  table's world units were authored against, and it frames 1720 world units
 *  of height on the reference viewport. Everything else scales from that, so
 *  the stage never resizes when the costume or the posture changes. */
export const REF_ZOOM = 1.93;
export const REF_H = 1720;

/** Below this the derived world height would explode; clamp instead. */
const MIN_TIGHT = 0.45;

export interface PostureCameraBase {
  offsetX: number;
  offsetY: number;
  scale: number;
  cameraZoom: number;
  cameraPanX: number;
  cameraPanY: number;
}

export interface PostureCameraAsmr {
  cameraZoom: number;
  cameraPanX?: number;
  cameraPanY?: number;
}

export interface PostureCameraPack {
  base?: Partial<PostureCameraBase>;
  asmr?: PostureCameraAsmr;
}

export type PostureCameraTable = Record<string, PostureCameraPack>;

export interface CameraParams {
  offsetX: number;
  offsetY: number;
  scale: number;
  zoom: number;
  panX: number;
  panY: number;
  worldW: number;
  worldH: number;
  left: number;
  bottom: number;
}

/** The painted-plate box of a scene, as the largest quad it draws. */
export interface CoverBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  w: number;
  h: number;
}

/** Authored window for one posture, plus the ASMR close-up when enabled. */
export function camParams(
  table: PostureCameraTable | null,
  postureKey: string,
  asmr: boolean,
  aspect: number,
): CameraParams {
  const pack = (table && table[postureKey]) || (table && table.posture_sitting) || {};
  const base: PostureCameraBase = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    cameraZoom: REF_ZOOM,
    cameraPanX: 0,
    cameraPanY: 900,
    ...(pack.base ?? {}),
  };

  let zoom = Number(base.cameraZoom);
  if (!(zoom > 0.2)) zoom = REF_ZOOM;
  let panX = Number(base.cameraPanX) || 0;
  let panY = Number(base.cameraPanY) || 0;

  const asmrEntry = asmr ? pack.asmr : undefined;
  if (asmrEntry) {
    const az = Number(asmrEntry.cameraZoom);
    /* ASMR zoom is the authored table value (sitting 3.5 / standing 2.5).
       Do not invent a smaller zoom — the original close-up is that tight.
       The table's asmr.cameraPanY is in a different space and would aim at
       empty sky, so lift toward the face instead. */
    if (az > 0.2) {
      panY += (az / zoom - 1) * 280;
      zoom = az;
    }
    if (asmrEntry.cameraPanX != null) panX = Number(asmrEntry.cameraPanX) || 0;
  }

  const tight = zoom / REF_ZOOM;
  if (tight > 1.05) panY = panY + (tight - 1) * 140;
  let worldH = REF_H / Math.max(MIN_TIGHT, tight);

  /* Normal-mode framing corrections, calibrated locally against the shipped
     screenshots — the official zoom→world-height mapping is not in the
     package. Standing must fit headwear→knees with margin; sitting rides
     slightly tighter so she does not fill the frame head→chest next to the
     standing shot. ASMR close-ups keep the authored table values. */
  if (!asmrEntry) {
    if (postureKey === 'posture_standing') worldH *= 1.53;
    else if (postureKey === 'posture_sitting') worldH *= 1.45;
  }

  const worldW = worldH * aspect;
  return {
    offsetX: Number(base.offsetX) || 0,
    offsetY: Number(base.offsetY) || 0,
    scale: Number(base.scale) || 1,
    zoom,
    panX,
    panY,
    worldW,
    worldH,
    left: panX - worldW / 2,
    bottom: panY - worldH / 2,
  };
}

export interface ViewWindow {
  left: number;
  bottom: number;
  worldW: number;
  worldH: number;
}

/** Axis-aligned bounds in world units. */
export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  w: number;
  h: number;
}

/** Extra breathing room around the subject, as a multiple of its height.
 *  1.3 leaves roughly 15% padding above the head and below the feet. */
const FIT_MARGIN = 1.3;

/**
 * Derive a camera window from the subject's own measured bounds.
 *
 * This is the path used for user-imported models, and it is not a nicety. The
 * authored table in `posture_camera.json` is calibrated for one specific set
 * of characters and cannot frame an arbitrary skeleton — models differ in
 * scale by orders of magnitude, and a window tuned for one puts another
 * entirely off-screen. Fitting to measured bounds means any model that loads
 * is framed, with no per-model configuration.
 */
export function fitToBounds(bounds: Bounds | null, aspect: number): ViewWindow {
  if (!bounds || !(bounds.h > 0)) {
    /* Nothing measurable — fall back to the reference window rather than
       producing a degenerate one. */
    const worldH = REF_H;
    const worldW = worldH * aspect;
    return { left: -worldW / 2, bottom: -worldH / 2, worldW, worldH };
  }

  const worldH = Math.max(bounds.h * FIT_MARGIN, 1);
  const worldW = worldH * aspect;
  const centreX = (bounds.x0 + bounds.x1) / 2;
  const centreY = (bounds.y0 + bounds.y1) / 2;

  return {
    left: centreX - worldW / 2,
    bottom: centreY - worldH / 2,
    worldW,
    worldH,
  };
}

/* -------------------------------------------------------------------------
 * The helpers below implement the authored-camera path from the original
 * stage pipeline: an authored window per posture, clamped to the scene plate's
 * painted box, with the character mapped through the clamped window.
 *
 * They are retained because scene plates return in Phase 4, at which point
 * `fitToCover` and `placeCharacter` are needed again. Nothing calls them
 * today — imported models have no scene and no posture table.
 * ---------------------------------------------------------------------- */

/**
 * Clamp the authored window so it never shows unpainted art.
 *
 * `panelFrac` is the share of the viewport covered by an opaque panel at the
 * bottom. The window may extend below the painted plate by exactly that much,
 * because the panel hides the gap — this is what lets a sitting window keep
 * its authored bottom edge when the sofa is drawn below the plate.
 */
export function fitToCover(
  win: CameraParams,
  cover: CoverBox | null,
  aspect: number,
  panelFrac: number,
): ViewWindow {
  if (!cover || !(cover.w > 0) || !(cover.h > 0)) {
    return { left: win.left, bottom: win.bottom, worldW: win.worldW, worldH: win.worldH };
  }

  const frac = panelFrac;
  /* The `h <= cover.h / (1 - frac)` bound below makes top and floor
     simultaneously satisfiable, so the top clamp can be unconditional. */
  const h = Math.min(win.worldH, Math.min(cover.h / Math.max(0.4, 1 - frac), cover.w / aspect));
  const w = h * aspect;

  let bottom = win.bottom;
  const floorY = cover.y0 - h * frac;
  if (bottom < floorY) bottom = floorY;
  if (bottom > cover.y1 - h) bottom = cover.y1 - h;

  let left = win.left + (win.worldW - w) / 2;
  if (left < cover.x0) left = cover.x0;
  if (cover.w >= w && left > cover.x1 - w) left = cover.x1 - w;

  return { left, bottom, worldW: w, worldH: h };
}

export interface PlacementInput {
  /** Camera params for the posture actually on screen. */
  cam: CameraParams;
  /** The authored window (`auth`). */
  auth: CameraParams;
  /** The clamped window (`view`). */
  view: ViewWindow;
  /** Scene-space offset contributed by the scene's `chara_root` bone. */
  sceneX: number;
  sceneY: number;
  /** Head bone local Y in setup pose, for eyeline alignment. Null to skip. */
  headLocal: number | null;
  postureKey: string;
  asmr: boolean;
  /** When seated on midground furniture, world X/Y are kept verbatim. */
  furnitureLocked: boolean;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

/**
 * Place the character so her on-screen framing is what the table asks for,
 * whatever the plate did to the camera. Called every frame: `chara_root` rides
 * the scene's parallax.
 */
export function placeCharacter(input: PlacementInput): Placement {
  const { cam, auth, view, sceneX, sceneY, headLocal, postureKey, asmr, furnitureLocked } = input;

  const x = cam.offsetX + sceneX;
  const y = cam.offsetY + sceneY;

  const k = view.worldH && auth.worldH ? view.worldH / auth.worldH : 1;
  const scale = cam.scale * k;

  if (furnitureLocked) {
    /* Furniture-locked: she sits ON the sofa, no lift. Remapping Y through the
       camera here is what used to float her off the seat. */
    return { x, y, scale };
  }

  let sx = view.left + (x - auth.left) * k;
  let sy = view.bottom + (y - auth.bottom) * k;

  /* Eyeline alignment. Target is the head-bone fraction of the window:
     standing 0.70, sitting 0.71, ASMR 0.50. The ±0.10 dead band stops the
     correction fighting the idle motion. */
  if (headLocal != null && view.worldH > 0) {
    const target = asmr ? 0.5 : postureKey === 'posture_standing' ? 0.7 : 0.71;
    const frac = (sy + headLocal * scale - view.bottom) / view.worldH;
    if (Math.abs(frac - target) > 0.1) sy += (target - frac) * view.worldH;
  }

  return { x: sx, y: sy, scale };
}
