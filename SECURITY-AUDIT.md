# Security audit — AniMate

**Date:** 2026-09-23
**Scope:** the Tauri shell, the loopback server, the model library, settings
storage, and the renderer.
**Method:** manual review of every network-reachable path, plus unit tests for
each guard and an end-to-end harness that exercises them over real HTTP.

---

## Threat model

AniMate runs a loopback HTTP server so the renderer can make cross-origin API
calls and set headers a browser cannot. That server is the entire attack
surface, and the relevant adversary is:

> **A web page the user visits while AniMate is running.**

That page cannot read the app's files or memory, but it can make requests to
`127.0.0.1:8933` — via `<img>`, `<script>`, forms, `fetch`, or by rebinding DNS
so its own origin *is* `127.0.0.1:8933`. Everything below is about how far such
a page can get.

Not in scope: a local attacker who can already read the user's files (they need
no vulnerability), and physical access.

---

## Findings, fixed

### S1 — Arbitrary file disclosure through the model importer · **High**

`models_import` accepted `paths: Vec<String>` from the renderer and copied
whatever it was given into `<app_data>/models/<id>/`, a directory the loopback
server serves over HTTP.

Any bug that let a renderer-supplied value reach that call — a future XSS, a
compromised dependency, a careless refactor — became **arbitrary file read**:
import `~/.ssh/id_rsa`, then fetch the copy from `/models/<id>/id_rsa`.

The code comment claimed paths "always go through the native picker". They did
not: the dialog was opened on the JS side and the resulting paths were passed
across IPC. The comment described the intent, not the implementation.

**Fixed** by moving the file dialog into Rust (`pick_model_files`). The command
now takes no arguments at all, so there is no path for the renderer to
influence. The primitive is removed rather than guarded.

### S2 — DNS rebinding: no `Host` validation · **Medium**

The server accepted any `Host` header. A page at `evil.com` that re-resolves to
`127.0.0.1` becomes same-origin with the server and can **read** every response
— including the user's imported character models.

The API key was not exposed: `settings.json` lives outside both served roots.
The proxy was not reachable either, because the page's `Origin` is
`http://evil.com:8933`, which the origin check rejects. So this was confined to
reading static files and the model library.

**Fixed** by `host_allowed`, applied to every route. Only `127.0.0.1`,
`localhost` and `::1` are accepted, with or without a port.

### S3 — Origin-less requests bypassed the proxy guard · **Medium**

`origin_allowed` returns true when `Origin` is absent, because same-origin GETs
legitimately omit it. But browsers also omit `Origin` on `<img>` and `<script>`
loads, so any website could reach `/_proxy` with
`<img src="http://127.0.0.1:8933/_proxy?u=http://127.0.0.1:5432/">`.

Impact was bounded — the response is unreadable cross-origin — but it is a
localhost port scan, and a way to originate requests from the user's IP. The
same hole let any page write to the user's log through `/_diag`.

**Fixed** with a per-run session token (`src-tauri/src/session.rs`), required on
every privileged route. It is delivered through Tauri's initialization script,
which runs before any page script and is absent from the HTML an HTTP client
fetches — so a rebinding attacker cannot read it either. This closes S2's
remaining gap as well.

### S4 — Auth ran after the WebSocket extractor · **Medium**

Found while testing S3's fix. `/_ws-proxy` takes a `WebSocketUpgrade`
extractor, and **extractors run before the handler body**. An auth check at the
top of that handler therefore sat *behind* the upgrade validation: an
unauthenticated request was rejected with 400 by the extractor without the auth
check ever executing.

Not exploitable as written — the request still failed — but the guard was not
where it appeared to be, and a future extractor could have made it reachable.

**Fixed** by moving authentication into a `require_session` middleware layer,
which wraps the whole route and runs before any extractor. The per-handler
checks were then deleted rather than left as dead duplicates.

### S5 — Redirects followed, bypassing the target allowlist · **Medium**

`reqwest` follows up to 10 redirects by default. The target allowlist validates
the URL it is handed and nothing else, so a permitted `https://` target could
redirect the request to a plain-`http` host — the exact case the allowlist
exists to prevent, with the caller's `Authorization` header riding along.

**Fixed** with `redirect::Policy::none()`. The 3xx is returned to the client,
which follows it through this same proxy, so every hop is re-validated.

### S6 — Upstream `Set-Cookie` forwarded onto the app's origin · **Low**

Response headers were copied wholesale. Any upstream — including a hostile or
compromised API endpoint — could set cookies on `127.0.0.1:8933`, which the
app's own pages would then send on every request.

The app uses no cookies, so nothing was being preserved and something real was
being lost.

**Fixed**: `Set-Cookie` and `Set-Cookie2` are stripped from responses, and
`Cookie` from requests. The session token header is also stripped from requests
so it is never forwarded to a third party.

### S7 — Log injection · **Low**

`shell_append_log` truncated renderer-supplied lines to 500 characters but did
not strip newlines. A value containing `\n` forges what look like genuine log
entries — and this file is exactly what someone reads to work out what
happened. Model filenames reach the log the same way.

**Fixed**: newlines stripped, matching what `/_diag` already did.

### S8 — Webview navigation could expose the session token · **Medium**

The webview initialization script contains the per-run token and runs when a
new page loads. The navigation callback previously accepted every URL, so an
external page opened in that webview could read the token.

**Fixed**: top-level navigation is limited to the app document at AniMate's
loopback origins (`127.0.0.1:8933` in production and `127.0.0.1:5173` in
development), plus the initial `about:blank` page. Imported files served under
`/models/` cannot become a privileged page.

---

## Findings, accepted

### The API key is stored in plain text · **Accepted, documented**

`<app_data>/settings.json` holds the LLM and TTS keys unencrypted. Anything
with read access to the user's profile can read them.

Acceptable for a personal-use desktop app, and stated plainly in the README.
The right follow-up
is the OS credential store — Windows Credential Manager via the `keyring`
crate — and it is tracked in `MIGRATION-PLAN.md` §11.

### Symlinks in the model directory are followed · **Accepted**

`resolve` validates every path component but does not resolve symlinks, and
`fs::metadata` follows them. A symlink planted in `models/` would be served.

Requires write access to the user's app data directory, which already implies
the ability to read the target directly. Not worth the cost of `O_NOFOLLOW`
handling on Windows.

### Dependency warnings · **Accepted**

`cargo audit` reports 7 warnings, no vulnerabilities. Six are unmaintained
transitive crates: five `unic-*` crates and `proc-macro-error`.
`glib` (RUSTSEC-2024-0429) is unsound but belongs to Tauri's GTK stack and is
not compiled on Windows. `npm audit` reports zero.

---

## Verified

44 Rust unit tests, including the guards themselves — `host_allowed`,
`origin_allowed`, `token_allowed` and `check_target` are each tested against
the inputs an attacker would send, not just the happy path:

- loopback Hosts in every spelling accepted; `evil.com`,
  `127.0.0.1.attacker.net` and `127.0.0.2` refused
- tokens must match exactly — a prefix, a suffix, an empty string and a
  wrong header name all fail
- plain `http` allowed only to IP literals in private ranges; hostnames,
  IPv4-mapped IPv6, and non-HTTP schemes refused

End to end, over real HTTP:

```
proxy, no token        -> HTTP 403    ws-proxy, no token     -> HTTP 403
proxy, malformed url   -> HTTP 403    ws-proxy, bad token    -> HTTP 403
proxy, cross-origin    -> HTTP 403    diag, no token         -> HTTP 403
path traversal         -> HTTP 400    static, Host: evil.com -> HTTP 403
                                      static, Host: loopback -> HTTP 200
```

And the positive path, which is the check that the hardening did not simply
break everything: the renderer's own diagnostic lines are accepted (token
injection works end to end), and `verify-chat.sh` still completes a full
proxied LLM turn with `emotion=happy`, `failed=false`.

---

## What this does not cover

- **The MMD backend**, which does not exist yet.
- **The realtime TTS WebSocket path**, which has no client yet. The route is
  hardened and tested; the client is not written.
- **Anything the user imports.** A malicious Spine model is parsed by the
  vendored runtime in the renderer's process. That runtime is upstream code and
  was not audited here.
