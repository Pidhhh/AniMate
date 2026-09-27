/* Window chrome: fullscreen state and the shortcuts that drive it.
 *
 * The state lives here rather than in the title bar because two things need
 * it — the button that shows whether fullscreen is on, and the layout that
 * hides the title bar while it is. Reading it in both places would be two
 * sources of truth.
 *
 * Outside the native shell everything degrades to a no-op, so the UI still
 * works in a plain browser (`npm run vite`).
 */

import { useCallback, useEffect, useState } from 'react';
import { hasNativeShell, isFullscreen, setFullscreen, toggleFullscreen } from './shell';

export interface WindowChrome {
  /** True while the window is fullscreen. */
  fullscreen: boolean;
  toggle: () => void;
  /** Set explicitly. Used by Esc, which only ever exits. */
  set: (on: boolean) => void;
}

export function useWindowChrome(onOpenSettings?: () => void): WindowChrome {
  const [fullscreen, setFullscreenState] = useState(false);

  /* Reflect what the window manager already has, rather than assuming false.
     The window can start fullscreen — the geometry from the last session is
     restored before the page loads. */
  useEffect(() => {
    if (!hasNativeShell()) return;
    void isFullscreen()
      .then(setFullscreenState)
      .catch(() => setFullscreenState(false));
  }, []);

  const toggle = useCallback(() => {
    void toggleFullscreen()
      .then(setFullscreenState)
      .catch(() => undefined);
  }, []);

  const set = useCallback((on: boolean) => {
    void setFullscreen(on)
      .then(setFullscreenState)
      .catch(() => undefined);
  }, []);

  /* Keyboard shortcuts.
   *
   * Bound on the window rather than on a focused element, because the point is
   * that they work wherever the focus happens to be. The input field is the
   * one exception — F11 and Esc are not text, but a future shortcut might be,
   * so the guard is here before that becomes a bug.
   */
  useEffect(() => {
    if (!hasNativeShell()) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      /* F11 toggles fullscreen — the Windows convention, and the one people
         try first. Not a text key, so it fires while typing too. */
      if (event.key === 'F11') {
        event.preventDefault();
        toggle();
        return;
      }

      /* Esc leaves fullscreen. It does NOT enter it: Esc means "get me out",
         and a window that goes fullscreen on Esc is startling. */
      if (event.key === 'Escape' && !typing) {
        void isFullscreen().then((on) => {
          if (on) set(false);
        });
        return;
      }

      /* Ctrl+, for settings, matching the convention most apps use. */
      if (event.ctrlKey && event.key === ',') {
        event.preventDefault();
        onOpenSettings?.();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle, set, onOpenSettings]);

  return { fullscreen, toggle, set };
}
