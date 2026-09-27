/* Ambient types for the objects the Rust shell injects into the page.
   Kept in one file so nothing else has to re-declare `Window`. */

export {};

declare global {
  /** The calls the native shell exposes. Mirrors the Electron
   *  contextBridge surface, plus the window controls a frameless desktop
   *  window needs. */
  interface RyzaShell {
    minimize(): Promise<void>;
    close(): Promise<void>;
    /** Returns the *resulting* topmost state, not the requested one. */
    setTopmost(on: boolean): Promise<boolean>;
    isTopmost(): Promise<boolean>;
    /** Returns the *resulting* fullscreen state, not the requested one. */
    toggleFullscreen(): Promise<boolean>;
    setFullscreen(on: boolean): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    appendLog(line: string): Promise<void>;
  }

  interface TauriGlobal {
    core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    [key: string]: unknown;
  }

  /** The per-run loopback credential, injected alongside `ryzaShell`.
   *
   *  Every privileged route (`/_proxy`, `/_ws-proxy`, `/_diag`) requires it.
   *  It arrives via Tauri's initialization script, which runs before any page
   *  script and is absent from the HTML an HTTP client would fetch — so a page
   *  that rebinds DNS to reach the server still cannot read it. */
  interface AnimateSession {
    /** Header name the server expects. */
    header: string;
    token: string;
    /** Ready-made header object, for spreading into a `HeadersInit`. */
    headers(): Record<string, string>;
  }

  interface Window {
    /** Injected by src-tauri/src/inject.rs before any page script runs. */
    ryzaShell?: RyzaShell;
    /** Injected by the same script; see `AnimateSession`. */
    __animateSession?: AnimateSession;
    /** Present because tauri.conf.json sets withGlobalTauri: true. */
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: {
      invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}
