/* IPC access, in one place.
 *
 * Tauri exposes its invoke function in several shapes depending on version and
 * whether `withGlobalTauri` is on, so the resolution lives here rather than
 * being duplicated by every caller.
 */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Find an invoke function, tolerating the shapes Tauri exposes it in. */
export function resolveInvoke(): InvokeFn | null {
  const g = window.__TAURI__;
  if (g) {
    if (typeof g.core?.invoke === 'function') return g.core.invoke.bind(g.core) as InvokeFn;
    if (typeof g.invoke === 'function') return g.invoke.bind(g) as InvokeFn;
  }
  const internals = window.__TAURI_INTERNALS__;
  if (typeof internals?.invoke === 'function') return internals.invoke.bind(internals) as InvokeFn;
  return null;
}

/** True when *any* IPC path is usable. */
export function hasIpc(): boolean {
  return resolveInvoke() !== null;
}

/** Invoke a native command, rejecting with a readable error when unavailable. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = resolveInvoke();
  if (!fn) {
    return Promise.reject(
      new Error(`${cmd} unavailable: not running under the native shell`),
    );
  }
  return fn<T>(cmd, args);
}
