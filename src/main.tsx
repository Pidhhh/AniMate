import { createRoot } from 'react-dom/client';
import App from './App';
import { appendLog, hasIpc, hasNativeShell, isTopmost, reportDiag } from './bridge/shell';
/* Side-effect import: registers the Spine backend with CharacterHost. */
import './character/spine';
import { runProtocolSelfTest } from './chat/protocol';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing #root');
}

/* Two channels on purpose. `reportDiag` goes over HTTP and works even when the
   shell bridge is missing, which is the case that needs diagnosing most;
   `appendLog` confirms the bridge itself is live. Between them, a missing
   log line tells you exactly which half failed. */
reportDiag(
  `boot origin=${window.location.origin} shell=${hasNativeShell()} ipc=${hasIpc()} ` +
    `dpr=${window.devicePixelRatio}`,
);

/* The reply parser is pure, branchy, and has no UI of its own, so a silent
   regression in it would surface only as the character reacting oddly. Running
   the cases at boot costs microseconds and puts the result in the log, where a
   regression is visible rather than inferred. */
{
  const { passed, failures } = runProtocolSelfTest();
  reportDiag(
    `protocol self-test: ${passed} passed, ${failures.length} failed` +
      (failures.length ? ` | ${failures.join(' | ')}` : ''),
  );
}

/* A read-only round trip proves the commands actually execute in Rust and
   return — not merely that `invoke` exists. `isTopmost` is used because it
   changes no window state, so a self-check on every boot is harmless. */
void isTopmost().then(
  (on) => reportDiag(`ipc round-trip ok: isTopmost=${on}`),
  (err: unknown) => reportDiag(`ipc round-trip FAILED: ${String(err)}`),
);

window.addEventListener('error', (event) => {
  reportDiag(`uncaught: ${event.message} @ ${event.filename}:${event.lineno}`);
});

window.addEventListener('unhandledrejection', (event) => {
  reportDiag(`unhandled rejection: ${String(event.reason)}`);
});

/* Mirror console errors and warnings into the log.
 *
 * Without this, anything a library reports through `console` is invisible: the
 * webview's devtools are not open during a harness run, and a third-party
 * engine that fails to load a texture complains there and nowhere else. The
 * symptom is a model that loads, renders, and is mysteriously untextured with
 * nothing in the log to explain it.
 *
 * Only error and warn — `console.log` from a library is chatter, and mirroring
 * it would bury the signal. */
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      const text = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return arg.message;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
      if (text) reportDiag(`console.${level}: ${text}`);
    } catch {
      /* never let diagnostics throw */
    }
  };
}

/* Deliberately not wrapped in <StrictMode>.
 *
 * StrictMode double-invokes effects in development, which would mount and
 * unmount the character backend twice against the *same* canvas element. A
 * WebGL context is bound to its canvas, so the second mount would inherit a
 * context the first unmount already tore down. Rather than make every backend
 * defensively handle that, the guard is simply not enabled. Revisit if the
 * backends ever get their own canvas allocation. */
/* The MMD backend is loaded dynamically, and awaited before the app renders.
 *
 * Two reasons, and both are load-bearing:
 *
 * 1. **A failure here must not take the whole app down.** It is a static
 *    import of a third-party 3D engine; if anything in that graph throws at
 *    module scope, a static import fails the entire bundle and the window
 *    comes up blank with nothing in the log — which is exactly what happened
 *    the first time this was wired up.
 * 2. **Awaiting it removes a race.** Backends register by side effect, and
 *    the registry is read when a model mounts. Registering asynchronously
 *    after `render` would mean a restored MMD model mounts before its backend
 *    exists and reports "no loader for this format" — intermittently, which
 *    is the worst way for it to fail.
 *
 * It also keeps Babylon in its own chunk instead of the entry bundle. */
try {
  await import('./character/mmd');
} catch (err) {
  reportDiag(`mmd backend unavailable: ${String(err)}`);
}

createRoot(container).render(<App />);

appendLog(`renderer mounted; shell=${hasNativeShell()}`);
