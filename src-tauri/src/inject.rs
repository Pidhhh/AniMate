/* The shell bridge, injected into the page before any page script runs.
 *
 * Electron had a preload script and a contextBridge; Tauri has neither, so the
 * equivalent surface is installed here via WebviewWindowBuilder::
 * initialization_script.
 *
 * The install is *retried* rather than done once. Tauri's own IPC bootstrap is
 * also an initialization script, and which one lands first is not guaranteed —
 * installing eagerly and giving up silently meant the bridge was absent on
 * every load. Retrying over the first few seconds is cheap and removes the
 * ordering assumption entirely.
 *
 * The shape must match what the ported call sites expect — notably that
 * setTopmost resolves to the state the OS *applied*, not the state that was
 * requested, because the pin button toggles against that return value.
 *
 * The session token is delivered the same way, and this is the whole point of
 * using an initialization script for it: Tauri injects before any page script
 * runs, and an HTTP client fetching `/` receives the built `index.html`
 * *without* this injection. So a DNS-rebinding attacker sitting same-origin
 * with the server still cannot read the token.
 */

use crate::session::{SessionToken, TOKEN_HEADER};

/// Builds the initialization script, embedding this run's token.
///
/// The token is hex, so it needs no escaping to be embedded in a JS string
/// literal. That is not an accident — `session::generate` emits hex precisely
/// so this stays a simple interpolation with no injection surface of its own.
pub fn script(token: &SessionToken) -> String {
    format!(
        r#"
(function () {{
  'use strict';

  var RETRY_INTERVAL_MS = 30;
  var RETRY_LIMIT = 120;

  /* The loopback server requires this on every privileged route. Presenting
     it is what proves the caller is this page and not a rebound one. */
  var TOKEN = '{token}';
  var TOKEN_HEADER = '{header}';

  window.__animateSession = {{
    header: TOKEN_HEADER,
    token: TOKEN,
    /* Convenience for callers that only need to attach the header. */
    headers: function () {{
      var out = {{}};
      out[TOKEN_HEADER] = TOKEN;
      return out;
    }}
  }};

  function resolveInvoke() {{
    var g = window.__TAURI__;
    if (g) {{
      if (g.core && typeof g.core.invoke === 'function') return g.core.invoke.bind(g.core);
      if (typeof g.invoke === 'function') return g.invoke.bind(g);
    }}
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {{
      return internals.invoke.bind(internals);
    }}
    return null;
  }}

  function makeShell(invoke) {{
    function call(cmd, args) {{
      try {{
        return Promise.resolve(invoke(cmd, args || {{}})).catch(function (err) {{
          console.warn('[animate] ' + cmd + ' failed:', err);
          throw err;
        }});
      }} catch (err) {{
        return Promise.reject(err);
      }}
    }}

    return {{
      minimize: function () {{
        return call('shell_minimize').then(function () {{}});
      }},
      close: function () {{
        return call('shell_close').then(function () {{}});
      }},
      setTopmost: function (on) {{
        return call('shell_set_topmost', {{ on: !!on }});
      }},
      isTopmost: function () {{
        return call('shell_is_topmost');
      }},
      toggleFullscreen: function () {{
        return call('shell_toggle_fullscreen');
      }},
      setFullscreen: function (on) {{
        return call('shell_set_fullscreen', {{ on: !!on }});
      }},
      isFullscreen: function () {{
        return call('shell_is_fullscreen');
      }},
      appendLog: function (line) {{
        var text = line == null ? '' : String(line);
        if (text.length > 500) text = text.slice(0, 500);
        return call('shell_append_log', {{ line: text }}).then(function () {{}});
      }}
    }};
  }}

  function install() {{
    if (window.ryzaShell) return true;
    var invoke = resolveInvoke();
    if (!invoke) return false;
    window.ryzaShell = makeShell(invoke);
    return true;
  }}

  if (install()) return;

  var attempts = 0;
  function retry() {{
    if (install()) return;
    if (++attempts >= RETRY_LIMIT) {{
      console.warn('[animate] IPC never appeared; ryzaShell unavailable');
      return;
    }}
    setTimeout(retry, RETRY_INTERVAL_MS);
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', retry);
  }}
  retry();
}})();
"#,
        token = token.as_str(),
        header = TOKEN_HEADER,
    )
}
