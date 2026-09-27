import { useCallback, useState } from 'react';
import { appendLog, hasIpc, hasNativeShell, isTopmost, setTopmost, shell } from '../bridge/shell';
import { listCharacterBackends } from '../character/CharacterHost';

type CheckState = 'pending' | 'pass' | 'fail' | 'skip';

interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

/* Loopback gate, mirroring the test the ported network client uses to decide
   whether to route a call through the local proxy. If this says false, every
   LLM and TTS call would go direct and hit CORS. */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

function originCheck(): Check {
  const origin = String(window.location.origin || '');
  const ok = LOOPBACK_ORIGIN.test(origin);
  return {
    name: 'Loopback origin',
    state: ok ? 'pass' : 'fail',
    detail: ok
      ? `${origin} — proxy gate will engage`
      : `${origin} — proxy gate will NOT engage; LLM/TTS calls will hit CORS`,
  };
}

function shimCheck(): Check {
  const ok = hasNativeShell();
  return {
    name: 'ryzaShell shim',
    state: ok ? 'pass' : 'fail',
    detail: ok ? 'injected by the Rust shell' : 'absent — not running under Tauri',
  };
}

function ipcCheck(): Check {
  const ok = hasIpc();
  return {
    name: 'IPC reachable',
    state: ok ? 'pass' : 'fail',
    detail: ok ? 'invoke() available' : 'no IPC path found',
  };
}

function backendCheck(): Check {
  const kinds = listCharacterBackends();
  return {
    name: 'Character backends',
    state: kinds.length > 0 ? 'pass' : 'skip',
    detail: kinds.length > 0 ? kinds.join(', ') : 'none registered yet (expected pre-Phase 2)',
  };
}

async function proxyRouteCheck(): Promise<Check> {
  /* A deliberately invalid target. Our own server should reject it with 400,
     which proves the route is mounted without touching the network. */
  try {
    const res = await fetch('/_proxy?u=not-a-valid-url', { method: 'GET' });
    if (res.status === 400) {
      return { name: '/_proxy route', state: 'pass', detail: 'mounted, rejects bad targets (400)' };
    }
    if (res.status === 404) {
      return { name: '/_proxy route', state: 'fail', detail: 'not mounted (404)' };
    }
    return {
      name: '/_proxy route',
      state: 'pass',
      detail: `mounted, responded ${res.status}`,
    };
  } catch (err) {
    return {
      name: '/_proxy route',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function proxyFetchCheck(): Promise<Check> {
  /* Real round trip through the proxy, to prove body forwarding works. */
  try {
    const res = await fetch('/_proxy?u=' + encodeURIComponent('https://example.com/'));
    if (!res.ok) {
      return { name: '/_proxy upstream', state: 'fail', detail: `upstream responded ${res.status}` };
    }
    const body = await res.text();
    const ok = body.includes('<html') || body.includes('<!doctype');
    return {
      name: '/_proxy upstream',
      state: ok ? 'pass' : 'fail',
      detail: ok ? `forwarded ${body.length} bytes` : 'reached upstream but body looks wrong',
    };
  } catch (err) {
    return {
      name: '/_proxy upstream',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function windowCheck(): Promise<Check> {
  if (!hasNativeShell()) {
    return { name: 'Window commands', state: 'skip', detail: 'no native shell' };
  }
  try {
    const before = await isTopmost();
    const on = await setTopmost(true);
    const off = await setTopmost(false);
    const ok = on === true && off === false;
    void before;
    return {
      name: 'Window commands',
      state: ok ? 'pass' : 'fail',
      detail: ok
        ? 'setTopmost round-tripped true→false'
        : `unexpected states: on=${on} off=${off}`,
    };
  } catch (err) {
    return {
      name: 'Window commands',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function logCheck(): Check {
  if (!shell()) {
    return { name: 'Disk log', state: 'skip', detail: 'no native shell' };
  }
  appendLog('diagnostics: bridge probe run');
  return { name: 'Disk log', state: 'pass', detail: 'wrote a probe line to the app log' };
}

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    /* Static checks land immediately so the panel is useful while the async
       ones are still in flight. */
    setChecks([originCheck(), shimCheck(), ipcCheck(), backendCheck()]);

    const asyncChecks = await Promise.all([
      proxyRouteCheck(),
      proxyFetchCheck(),
      windowCheck(),
    ]);
    setChecks([
      originCheck(),
      shimCheck(),
      ipcCheck(),
      backendCheck(),
      ...asyncChecks,
      logCheck(),
    ]);
    setRunning(false);
  }, []);

  const passed = checks.filter((c) => c.state === 'pass').length;
  const failed = checks.filter((c) => c.state === 'fail').length;

  return (
    <aside className="flex h-full flex-col border-l border-edge-soft bg-stage-soft">
      <div className="no-select flex h-9 shrink-0 items-center gap-2 border-b border-edge-soft px-3">
        <span className="text-[11px] font-medium text-ink-dim">Diagnostics</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="rounded bg-edge px-2 py-1 text-[10px] text-ink hover:bg-edge-soft disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run checks'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-[10px] text-ink-faint hover:bg-edge hover:text-ink"
        >
          Hide
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {checks.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Run the checks to verify the loopback server, the shell bridge, and the proxy
            routes are wired correctly.
          </p>
        ) : (
          <ul className="space-y-2">
            {checks.map((c) => (
              <li key={c.name} className="flex gap-2">
                <StatusDot state={c.state} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-ink">{c.name}</div>
                  <div className="mt-0.5 break-words font-mono text-[10px] leading-snug text-ink-faint">
                    {c.detail}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {checks.length > 0 && (
          <p className="mt-4 border-t border-edge-soft pt-3 font-mono text-[10px] text-ink-faint">
            {passed} passed · {failed} failed
          </p>
        )}
      </div>
    </aside>
  );
}

function StatusDot({ state }: { state: CheckState }) {
  const color =
    state === 'pass'
      ? 'bg-ok'
      : state === 'fail'
        ? 'bg-err'
        : state === 'skip'
          ? 'bg-ink-faint'
          : 'bg-warn';

  return <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}
