/* The loopback session credential.
 *
 * The server requires a per-run token on every privileged route. It arrives
 * through Tauri's initialization script, which runs before any page script and
 * is *not* part of the HTML an HTTP client fetches — so a page that rebinds
 * DNS to become same-origin with the server still cannot read it.
 *
 * See `src-tauri/src/session.rs` for the two attacks this closes.
 *
 * Everything here degrades to "no token" outside the native shell. That is
 * deliberate: running `npm run vite` in a plain browser should still render the
 * UI, it just cannot reach the proxy. A missing token produces a 403 from the
 * server with a log line saying why, which is a better failure than a crash.
 */

/** The injected session, or null when running outside the shell. */
export function session(): AnimateSession | null {
  return window.__animateSession ?? null;
}

/** True when a token is available, i.e. privileged calls can succeed. */
export function hasSession(): boolean {
  const s = session();
  return Boolean(s?.token && s?.header);
}

/**
 * Headers to attach to any privileged loopback request.
 *
 * Returns an empty object outside the shell so callers can spread it
 * unconditionally rather than branching at every call site.
 */
export function sessionHeaders(): Record<string, string> {
  const s = session();
  if (!s?.token || !s?.header) return {};
  return { [s.header]: s.token };
}

/**
 * Appends the token to a same-origin URL, for callers that cannot set headers.
 *
 * Only the WebSocket handshake needs this — a browser cannot attach headers to
 * `new WebSocket(...)`. Everything else should use `sessionHeaders`.
 */
export function withSessionParam(url: string): string {
  const s = session();
  if (!s?.token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${encodeURIComponent(s.token)}`;
}
