/* Typed access to the native shell.
 *
 * The `ryzaShell` object is injected by the Rust side before any page script
 * runs (src-tauri/src/inject.rs). In a plain browser — `npm run vite` with no
 * Tauri process — it is absent, so every call degrades to a no-op rather than
 * throwing. That keeps pure-UI work possible without the Rust build.
 */

import { invoke as ipcInvoke, hasIpc } from './ipc';
import { sessionHeaders } from './session';

/** The injected bridge, or null when running outside the native shell. */
export function shell(): RyzaShell | null {
  return window.ryzaShell ?? null;
}

/** True when the native shell is present. Drives UI that only makes sense
 *  inside the app (window controls, disk logging). */
export function hasNativeShell(): boolean {
  return shell() !== null;
}

export { hasIpc };

/* ---- Window controls ---------------------------------------------------- */

/* These fall back to raw IPC when the injected shim is missing. Failures are
   swallowed: they are fire-and-forget UI actions, and the controls are only
   rendered at all when the native shell is present. */

export async function minimize(): Promise<void> {
  const s = shell();
  if (s) return s.minimize();
  await ipcInvoke('shell_minimize').catch(() => undefined);
}

export async function close(): Promise<void> {
  const s = shell();
  if (s) return s.close();
  await ipcInvoke('shell_close').catch(() => undefined);
}

/** Toggles always-on-top and returns the state the OS actually applied. */
export async function setTopmost(on: boolean): Promise<boolean> {
  const s = shell();
  if (s) return s.setTopmost(on);
  return ipcInvoke<boolean>('shell_set_topmost', { on: Boolean(on) }).catch(() => false);
}

export async function isTopmost(): Promise<boolean> {
  const s = shell();
  if (s) return s.isTopmost();
  return ipcInvoke<boolean>('shell_is_topmost').catch(() => false);
}

/** Toggles fullscreen and returns the state the window manager actually
 *  applied, matching `setTopmost`. A window manager that refuses the change
 *  would otherwise desync the button from the window. */
export async function toggleFullscreen(): Promise<boolean> {
  const s = shell();
  if (s) return s.toggleFullscreen();
  return ipcInvoke<boolean>('shell_toggle_fullscreen').catch(() => false);
}

export async function setFullscreen(on: boolean): Promise<boolean> {
  const s = shell();
  if (s) return s.setFullscreen(on);
  return ipcInvoke<boolean>('shell_set_fullscreen', { on: Boolean(on) }).catch(() => false);
}

export async function isFullscreen(): Promise<boolean> {
  const s = shell();
  if (s) return s.isFullscreen();
  return ipcInvoke<boolean>('shell_is_fullscreen').catch(() => false);
}

/* ---- Logging ------------------------------------------------------------ */

/** Mirror a line to the on-disk log. Fire-and-forget: logging must never be
 *  able to break a turn, so failures are swallowed deliberately. */
export function appendLog(line: string): void {
  try {
    void shell()?.appendLog(line);
  } catch {
    /* deliberately ignored */
  }
}

/** Out-of-band diagnostic line, sent over plain HTTP rather than IPC.
 *
 *  This is the fallback for when the shell bridge itself is the problem —
 *  `appendLog` is exactly what is unavailable in that case, so it cannot be
 *  used to report its own absence. The page was served by the loopback server,
 *  so a fetch back to it always works. */
export function reportDiag(message: string): void {
  try {
    void fetch(`/_diag?m=${encodeURIComponent(message)}`, {
      cache: 'no-store',
      /* `/_diag` is token-gated: without this a website could write to the
         user's log through an origin-less GET. */
      headers: sessionHeaders(),
    }).catch(() => {
      /* diagnostics are best-effort */
    });
  } catch {
    /* deliberately ignored */
  }
}
