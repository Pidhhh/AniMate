# AniMate — Tauri Migration Plan

**Status:** draft, awaiting review
**Author:** Mate (with Peather)
**Date:** 2026-09-22
**Supersedes:** the Electron Forge scaffold currently at the repo root

---

## 1. What AniMate is

> AniMate is a cross-platform desktop app built with Tauri, React, and
> TypeScript. It lets users interact with an AI-powered character that can
> answer questions, speak, and move — producing smooth animation through a
> **pluggable character runtime** that supports both MMD (3D) and Spine (2D).

The pluggable runtime is the defining design decision. It is what lets this
project honor its original MMD spec while reusing the proven 2D pipeline from
RyzaChat. Neither is deprecated; they are two implementations of one contract.

### Prior art in scope

| Source | What it gives us | Verdict |
|---|---|---|
| `Atelier-electron/` (RyzaChat 1.2.15) | Spine render pipeline, LLM/TTS client, emotion model, shell bridge | **Ported selectively** — see §6 |
| `Atelier-electron/assets/` | 580 MB of Spine skeletons, audio, fonts, i18n | **Reused as-is** for the 2D runtime |
| `AniMate/` (current) | React chat shell, Gemini client | **Replaced** — no code survives |

### Non-goals

- Rebuilding the RyzaChat *game* layer (bond, quests, alarms, inventory,
  world rules, sessions). Out of scope for v1. See §9 for the post-v1 path.
- Shipping the character assets publicly. See §10, Licensing.
- Keeping Electron. Tauri is the target and the Forge scaffold is removed.

---

## 2. Target architecture

Two layers, one hard boundary.

```
┌─────────────────────────────────────────────────────────────┐
│  Rust — tauri shell process                                 │
│                                                             │
│   main.rs        window, lifecycle, single instance         │
│   commands.rs    #[tauri::command] handlers                 │
│   server/        axum: static + /_proxy + /_ws-proxy        │
│                                                             │
│              binds 127.0.0.1:8933                           │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
        injects │                             │ serves
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  WebView2 — http://127.0.0.1:8933                           │
│                                                             │
│   React 19 + TypeScript UI                                  │
│   CharacterHost → [SpineBackend │ MmdBackend]               │
│   ChatLayer → LLM client, TTS client, emotion mapping       │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Why the loopback server survives the rewrite

This is the single most important architectural carry-over, and it is
deliberate. RyzaChat's `js/api.js:462` routes every LLM and TTS call through a
same-origin `/_proxy` — but only when `location.origin` matches a loopback
pattern. The in-file comment states the reason plainly: a custom scheme
cannot do this reliably.

The proxy exists because **browsers cannot set an `Authorization` header on a
raw WebSocket**, and DashScope's realtime voice-clone TTS requires exactly
that. `/_ws-proxy` re-dials upstream from Rust, where the header can be set.

The consequence for us: if the renderer runs at `http://127.0.0.1:8933`,
then `location.origin` matches, the proxy branch activates, and
**`api.js` needs no modification at all.** The same holds for `shell.js`
(guards on `window.ryzaShell`) and `pwa.js` (returns early when `ryzaShell`
is present).

Serving from a custom scheme instead would break realtime TTS.

**Decision: keep loopback. The port is an implementation detail the user
never sees.**

### 2.2 Why WebView2 is not a risk

Verified on this machine: `C:\Program Files (x86)\Microsoft\EdgeWebView\`
`Application\153.0.4234.48`. WebView2 gives us IndexedDB, localStorage,
WebGL 2, WebAudio, and `-webkit-app-region` drag — every browser capability
both runtimes need. No capability gap.

---

## 3. Decision records

### DR-1 — Tauri over Electron
Portable output, ~15 MB shell instead of ~26 MB plus a 570 MB payload, native
Rust for the proxy server, and no `asar` unpacking of large binary assets.
Rust toolchain already present: cargo 1.91.1 / rustup 1.28.2.

### DR-2 — Pluggable character runtime
MMD and Spine are different asset pipelines with different renderers. Rather
than pick, we define `CharacterRenderer` as an interface and implement it
twice. Chosen by Peather. Cost: one abstraction layer built before either
backend is complete. Benefit: the MMD spec is honored without forfeiting the
2D reuse.

### DR-3 — Loopback server retained (see §2.1)
`/_ws-proxy` requires it. No viable alternative found that keeps realtime TTS
working.

### DR-4 — Selective port, not wholesale copy
RyzaChat's `js/` is ~800 KB across 24 files. We take the render pipeline, the
network client, and the emotion model. We leave the game systems. Rationale in
§6.

### DR-5 — TypeScript, not vanilla JS
AniMate's original spec says TypeScript and the existing scaffold already
leans React + TS types (`@types/react` present). Ported JS gets converted on
the way in, module by module — not `allowJs`.

---

## 4. Project layout

```
AniMate/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ build.rs
│  ├─ icons/
│  ├─ capabilities/
│  │  └─ default.json      window, permissions, remote origin urls
│  ├─ permissions/
│  │  └─ companion.toml    required — see §7b, the loopback origin is "remote"
│  └─ src/
│     ├─ main.rs           thin entry point
│     ├─ lib.rs            window, lifecycle, single instance, static root
│     ├─ commands.rs       the five ryza-shell command handlers
│     ├─ inject.rs         the ryzaShell shim, injected at document start
│     └─ server/
│        ├─ mod.rs         router, bind, shared guards
│        ├─ static_files.rs file serving, Range/206, traversal guard
│        ├─ proxy.rs       /_proxy — https, plus http for private hosts
│        ├─ ws.rs          /_ws-proxy — header injection, close propagation
│        └─ diag.rs        /_diag — out-of-band renderer logging
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ character/
│  │  ├─ types.ts          CharacterRenderer contract
│  │  ├─ CharacterHost.tsx owns the canvas, delegates to the active backend
│  │  ├─ spine/            SpineBackend.ts, camera.ts
│  │  └─ mmd/              MmdBackend.ts, loader.ts, solver.ts
│  ├─ chat/                useChat.ts, llm.ts, tts.ts
│  ├─ emotion/             profile.ts, detect.ts
│  ├─ bridge/
│  │  ├─ shell.ts          typed wrapper over the injected shim
│  │  └─ globals.d.ts      window.ryzaShell / window.__TAURI__ typings
│  ├─ components/          TitleBar, Diagnostics, ChatPanel
│  └─ styles/globals.css
├─ public/
│  └─ assets/              gitignored character assets (§10)
├─ vite.config.ts          dev proxy for /_proxy and /_ws-proxy
└─ package.json
```

`src-tauri/src/server/diag.rs` deserves a note. It is a `/_diag?m=` endpoint
that writes a line to the log over plain HTTP. It exists because **the bridge
cannot be used to diagnose the bridge** — when IPC is broken, `appendLog` is
exactly what is unavailable. Without it, a webview that loads the page but
fails to reach Rust is completely silent.


`src/character/types.ts` is the contract that makes DR-2 real:

```ts
export interface CharacterRenderer {
  mount(canvas: HTMLCanvasElement, opts: MountOptions): Promise<void>;
  unmount(): void;
  setEmotion(e: EmotionProfile): void;
  setSpeaking(active: boolean): void;
  playMotion(name: string, opts?: MotionOptions): Promise<void>;
  lookAt(target: { x: number; y: number }): void;
  resize(w: number, h: number, dpr: number): void;
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly kind: 'spine' | 'mmd';
}
```

Both backends implement this. `CharacterHost` never branches on `kind` except
to pick the backend at mount time.

---

## 5. Asset strategy

**Superseded. AniMate ships with no character assets at all.**

The original plan was to bundle a subset of the RyzaChat assets. That is now
reversed, for two reasons that arrived together:

1. **They are not redistributable.** Extracted game data. Bundling them meant
   the installer could never be published, and the app carried someone else's
   character as its only option.
2. **Users want their own models anyway.** A companion app whose character is
   fixed is a demo, not a product.

So the stage is empty on first run, and everything on it is imported by the
user. That removes the character-art redistribution problem. The vendored
Spine runtime has separate terms; see `THIRD-PARTY-NOTICES.md`.

### What ships

| Item | Size | Notes |
|---|---|---|
| Spine runtime (`public/vendor/spine-webgl.js`) | 540 KB | Needed to *load* imported Spine models |
| Frontend bundle | ~260 KB | React + the app |
| **Character assets** | **0** | None. Ever. |

`public/assets/` remains as an empty, documented directory. Its README explains
where imported models actually live and why nothing is bundled.

### Where imported models live

Outside the installed tree, in the app data directory:

```
<app_data>/models/index.json      registry: id, name, kind, entry, files
<app_data>/models/<id>/           that model's files, verbatim
<app_data>/settings.json          LLM endpoint, key, model name
```

The loopback server exposes `/models/<id>/...` from that directory, which is
what lets the renderer fetch a model by URL. `settings.json` sits one level
**up**, deliberately: `models/` is served over HTTP, and the API key must not
be inside the served subtree. The harness asserts this — a request for
`/models/../settings.json` returns 404.

### Consequences for the renderer

Because a model arrives with no camera configuration and models differ in
scale by orders of magnitude, the authored `posture_camera.json` window cannot
frame them. The backend now **measures the loaded character's extent in setup
pose and fits the window to it** (`fitToBounds` in `spine/camera.ts`). The
authored-camera helpers are retained for when scene plates return in Phase 4,
but nothing calls them today.

### Deferred

Scene plates, the full audio library, and fonts. All belonged to the game layer
and have no place in a bring-your-own-model app. If scene support returns it
should be per-model, imported alongside the character, not bundled.

---

## 6. Module mapping — RyzaChat → AniMate

### 6.1 Ported

| RyzaChat | Size | Destination | Work |
|---|---|---|---|
| `vendor/spine-webgl.js` | 540 KB | `src/character/spine/` | Vendor as-is. 4.2.43 matches the `.skel` binaries (verified from the version trailer) |
| `js/avatar.js` | 127 KB | `spine/SpineBackend.ts` | Largest port. Camera fit, rim-light shader, gaze/finger drivers, skin variants |
| `js/api.js` | 68 KB | `chat/llm.ts` + `tts.ts` | Split by concern. Key pools, model rotation, circuit breaker, tolerant JSON parsing all survive |
| `js/audio.js` | 12 KB | `chat/audio.ts` | Queue, unlock, volume fades |
| `js/config.js` | 16 KB | `config/store.ts` | Settings + providers, BYOK |
| `js/log.js` | 3 KB | `bridge/log.ts` | 300-line ring buffer, disk append |
| `js/shell.js` | 2 KB | `bridge/shell.ts` | Becomes a typed wrapper over the injected shim |
| `assets/data/posture_camera.json` | — | `spine/camera.ts` | Authored camera windows |
| `*_gesture.json` | 2.3 MB | `emotion/profile.ts` | `EmotionProfilesV4` |
| `css/app.css` | 37 KB | `styles/` | Converted to CSS modules, character layer extracted |

### 6.1b The MMD backend

The 3D runtime is **Babylon.js + `babylon-mmd`**, not three.js. Corrected after
reading `.references/MiKaPo_Project_Documentation.txt`:

| Piece | Version | Role |
|---|---|---|
| `@babylonjs/core` | 8.x | WebGL engine, scene, materials, shadows |
| `babylon-mmd` | 0.68.x | `.pmx` loading, MMD runtime, WASM physics |
| MediaPipe Tasks Vision | 0.10.x | Holistic Landmarker — pose, face, hands |
| `solver.ts` | — | Landmark vectors → bone quaternions, 53 bones |

Why Babylon over three.js: `babylon-mmd` ships a maintained MMD runtime with
the physics and material handling that MMD models actually need (toon ramps,
sphere maps, edge rendering). three.js's `MMDLoader` is thinner and the
supporting ecosystem is less current.

This also implies a **motion capture input path** that the Spine backend has no
equivalent for — webcam/video/image → landmarks → bone rotations. That is a
capability of the MMD backend only, and it is why `CharacterCapabilities`
exists as a feature-detection bag rather than a fixed interface.

### 6.2 Left behind (v1)

| RyzaChat | Why |
|---|---|
| `js/game.js`, `quests.js`, `daily.js`, `alarm.js`, `world.js` | Game layer — out of scope (§1) |
| `js/sessions.js`, `store.js` | Multi-save. v1 has one conversation in IndexedDB |
| `js/i18n.js` | 92 KB, JA/EN/ZH. Defer to v2; English-only in v1 |
| `js/onboarding.js`, `fx.js`, `layout.js`, `kbd.js` | Tutorial, effects, ESC-back, shortcuts — rebuild natively later |
| `js/nsfw.js` | Not a v1 concern |
| `js/pwa.js` | Service worker is meaningless under Tauri. Delete |
| `js/util.js` | Replaced by TypeScript utilities |

### 6.3 Rewritten in Rust

| RyzaChat | Lines | Destination |
|---|---|---|
| `electron/main.js` | 81 | `main.rs` — window, single instance, log file |
| `electron/preload.js` | 31 | `inject.rs` — see §7 |
| `electron/server.js` | ~250 | `server/*.rs` — same route contract |

`server.js` is the piece that most needs care. It implements Range/206
requests (audio seeking breaks without it) and `_ws-proxy` close propagation
in **both** directions. RyzaChat's own notes record what happens when that
propagation is missing: every finished TTS turn leaked its upstream DashScope
session for the three-minute backstop, and rapid turns got throttled into
failed synths. Port the behavior, not just the surface.

---

## 7. The shell bridge

Electron used `contextBridge` in a preload script. Tauri has no preload
script, so the shim is injected at document start.

Three of the five calls are satisfied in TypeScript without a round trip:

```ts
// inject.rs — injected before any page script runs
window.ryzaShell = {
  minimize: () => invoke('shell_minimize'),
  close:    () => invoke('shell_close'),
  setTopmost: (on) => invoke('shell_set_topmost', { on: !!on }),
  isTopmost:  () => invoke('shell_is_topmost'),
  appendLog:  (line) => invoke('shell_append_log', {
    line: String(line ?? '').slice(0, 500)
  }),
};
```

| Call | Rust side |
|---|---|
| `shell_minimize` | `window.minimize()` |
| `shell_close` | `window.close()` |
| `shell_set_topmost` | `window.set_always_on_top(on)` → returns actual state |
| `shell_is_topmost` | `window.is_always_on_top()` |
| `shell_append_log` | Append to `app_log_dir()/app-YYYYMMDD.log` |

Semantics must match Electron's exactly, because `shell.js` depends on them:
`setTopmost` returns the *resulting* state (not the requested one) and the pin
button toggles against that return value.

**Drag.** `css/app.css:127` sets `body.shell-electron #topbar{-webkit-app-region:drag}`.
WebView2 honors this. Keep the `shell-electron` class name verbatim.

**Window sizing.** RyzaChat opens frameless 1080×1920 content-size. The
AniMate spec describes a desktop companion, so default smaller — 480×854 is a
reasonable phone-ish companion window. Keep it resizable and frameless.

---

## 7b. What implementing Phase 0/1 actually taught us

Six findings that were not obvious and each cost real time. They are recorded
here because they will recur.

### The loopback origin is a *remote* origin to Tauri's ACL

This is the significant one. Tauri only enforces its access-control list on
application commands when:

```rust
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
```

Serving the page from `http://127.0.0.1:8933` means Tauri does not recognise
the origin as its own, so `!is_local` is true and **the ACL applies to commands
defined in this very crate**. With no manifest, every `invoke` is rejected:

```
shell_is_topmost not allowed. Plugin not found
```

The fix is `src-tauri/permissions/companion.toml`, declaring the commands, plus
listing those permissions in the capability. `tauri-build` then emits an
`__app-acl__` entry into `gen/schemas/acl-manifests.json`.

The tempting alternative — serve from Tauri's own protocol so `is_local` is
true and the ACL is skipped — is a trap. It changes `location.origin` away from
loopback, which silently disables the ported proxy gate and breaks realtime
voice. Declaring permissions is the cheaper trade.

### `initialization_script` ordering is not guaranteed

Tauri's own IPC bootstrap is also an initialization script. Installing the
`ryzaShell` shim eagerly and giving up meant the bridge was simply absent on
some loads. The shim now retries for ~3.6 s. Do not assume ordering.

### The webview will happily run a stale bundle

`Cache-Control: public, max-age=86400` on hashed assets is the conventional
choice and it is wrong here. WebView2 kept executing a previous build after a
rebuild, which presents as "my changes did nothing". Everything is served
`no-store` now. This is a loopback server — every byte is a local disk read, so
a cache saves nothing measurable and costs correctness.

### `taskkill //F //IM` fails silently under Git Bash

The `//F` form is not converted to `/F`; the command errors out. With stderr
redirected, the failure is invisible and **stale app instances accumulate,
holding port 8933**. New instances then fail to bind and exit while the *old
binary* keeps serving — which looks exactly like a flaky bug in new code. It
cost several rounds of debugging.

Use `MSYS_NO_PATHCONV=1 taskkill /F /IM animate.exe`.

### Crate versions must be aligned deliberately

`axum 0.8.9` pins `tokio-tungstenite 0.29` internally. Pinning 0.26 produced two
copies in the graph and the WebSocket message types would not unify. Worse,
axum defines its **own** `Message`/`Utf8Bytes`/`CloseFrame` rather than
re-exporting tungstenite's, and its `CloseCode` is a bare `u16` while
tungstenite's is an enum — so every variant has to be rebuilt by hand.

### Tauri 2 renamed the NSIS fields

`oneClick`, `allowToChangeInstallationDirectory` and `shortcutName` are Tauri 1
names and now fail the build. `installMode` replaces them.

### Found during Phase 2

**`_01` is the sitting costume and `_99` is standing — and standing is the
default.** Easy to get backwards, and the symptom is subtle: the character
renders, just in the wrong costume for the camera. `resolveSkel` falls back
through both suffixes, so shipping only one skin does not fail loudly, it
quietly renders the wrong one. Both are shipped.

**Vite's `assetsDir` defaults to `assets/`, which collides with the character
assets at `public/assets/`.** They merge without error — which is exactly what
makes it confusing to debug later. Set `build.assetsDir: '_vite'`.

**`spine-webgl.js` is a classic script, not an ES module.** It is
`var spine = (() => {...})()` and exposes itself as a global, so it cannot be
imported. It must load via a `<script>` tag from `public/` before the app
module, with a `.d.ts` alongside for the type surface.

**A corrupted Rust incremental cache produces an internal compiler error**, not
a normal build failure:

```
error: the compiler unexpectedly panicked. this is a bug.
```

The tell is a preceding `warning: error copying object file … Access is denied`
— usually caused by rebuilding while the app is still running and holding
handles. Fix: kill the app, `rm -rf src-tauri/target/debug/incremental`,
rebuild. Do not chase it as a code bug.

**The initial idle must be set explicitly.** `rerollIdle` is only reached from
the loop after `idleGap` (~6 s), so a mount that does not call it leaves her
holding the setup pose — which reads as a frozen model rather than a slow
start. This is exactly the class of bug the `frames`/`idle` stats exist to
catch: `state=ready` was true the whole time.

### Found during Phase 2c

**`Path::components()` treats `a/b` as two `Normal` components.** The first
version of the model-id sanitiser looped over components and rejected anything
that was not `Normal` — which accepted `a/b` happily, because both halves are
normal. The single-segment contract needs `next()` to yield one component and
then `None`. A unit test caught this; it would not have been visible in
ordinary use, since ids are generated, not typed.

**`app_data_dir()` on Windows is Roaming, not Local.** `%APPDATA%`, not
`%LOCALAPPDATA%`. Worth knowing before writing a path into documentation.

**The settings file must live outside the served subtree.** `models/` is
exposed over HTTP so the renderer can fetch imported models. Putting
`settings.json` beside it would have served the API key to anything that could
reach the port. It sits one level up, and the harness asserts that
`/models/../settings.json` returns 404 rather than trusting the arrangement.

**A hook called in two components is two states.** The settings panel and the
stage both need the model registry. Calling `useModelLibrary()` in each gave
them independent copies — an import made in the panel would not have reached
the stage until a reload. The hook is now called once, in `App`, and passed
down.

**A renderer with no model is not an error state.** With nothing bundled, the
stage is empty on first run by design. The three causes — nothing imported, no
loader for this format, load failure — each get their own wording, because
only one of them is a mistake.

### Found during Phase 3

**A tag-chain guard that was one iteration too low.** `parseReply` consumed at
most three leading machine tags, matching the original. A model emitting four
left `[attitude:deny]` sitting in the transcript — visible to the user, and
spoken aloud by TTS. The counter is only an infinite-loop backstop; the
machine-tag check is the real gate, so it is now generous. Found by writing
tests for logic that had only ever been exercised by hand.

**The proxy forwards request bodies chunked, with no `Content-Length`.** This
matters twice over.

First, for anyone writing a local endpoint to test against: a server that reads
only `Content-Length` sees an empty body, which looks *exactly* like the proxy
dropping the request.

Second, and worse, it made the existing chat harness lie. Its mock read only
`Content-Length`, so it never saw `stream: true`, so it always answered with a
single JSON object — and the client's documented fallback handled that
perfectly. Every run went green. **The SSE path was never exercised.** The
symptom was one log line reading `stream=None`, which is easy to skim past
because the turn itself succeeded.

Fixed by decoding chunked bodies in the mock. The harness now shows
`stream=True`, which is the only evidence that streaming is really being
tested. A test that passes for the wrong reason is worse than no test, because
it is trusted.

**Two implementations of the same parser nearly shipped.** The reply protocol
already existed in `protocol.ts` from an earlier session; a second version was
written before noticing. The duplicate was deleted and the effort redirected
into tests for the real one — which is what surfaced the tag-chain bug.

The same thing then happened again with the test harness: a second mock
endpoint and verification script were written before `verify-chat.sh` and
`mock-openai.py` were noticed. Those were the better tools — they drive the app
rather than curling the proxy directly, and cover speech as well — so the new
ones were deleted and the existing mock fixed instead. **Check what already
exists before writing a module that feels new.** Twice in one session is a
pattern, not bad luck.

**An in-app self-test and a test runner are not alternatives.** `protocol.ts`
carried `runProtocolSelfTest`, eleven cases run at boot and logged, precisely
because "wiring a test framework up for eleven assertions" seemed excessive.
That reasoning was wrong: the self-test only runs in a built app, only logs,
and cannot express an assertion that fails a build. Vitest now runs the same
eleven cases plus thirteen more, and the boot self-test is kept because it
still catches a broken bundle in the field.

### Found during the security audit

Full write-up in `SECURITY-AUDIT.md`. The two that changed the design rather
than just a line of code:

**A comment described an intent the code did not implement.** `models.rs`
claimed imports "always go through the native picker, so nothing here trusts a
path that arrived over IPC". The command took `paths: Vec<String>`. The dialog
ran in JavaScript and the resulting paths crossed the IPC boundary — so the
comment was a statement of what the author meant, sitting directly above code
that did the opposite. Anyone reading it would have concluded the surface was
closed.

It was an arbitrary-file-read primitive: hand it `~/.ssh/id_rsa`, then fetch
the copy from `/models/<id>/id_rsa`. Fixed by moving the dialog into Rust, so
the command takes no arguments and there is no path for the renderer to
influence.

**An auth check was behind an extractor.** `/_ws-proxy` opened with an auth
check that could never run for an unauthenticated caller, because
`WebSocketUpgrade` is an extractor and **extractors run before the handler
body**. The request still failed — with 400 from the extractor rather than 403
from the check — so nothing was exploitable, but the guard was not where it
appeared to be.

Found only because a test asserted 403 and got 400. The instinct is to relax
the test to match; the correct move is to ask why the number is wrong. Fixed by
moving authentication into a middleware layer that wraps the whole route, which
also removed the per-handler checks rather than leaving them as duplicates.

Both are the same shape of failure: **the code read as though it were safe.**
Neither would have been caught by reviewing the logic in isolation, because the
logic was fine. What was wrong was the distance between what it said and what
it did.

### Found during the MMD work

**A stale frontend bundle cost an hour.** `tauri.conf.json` maps
`"../dist": "dist"`, so Tauri stages a copy of the frontend into
`target/debug/dist` at build time. That copy is only refreshed when Tauri's
build script re-runs — so `npm run vite:build` followed by a *manual*
`./animate.exe` can silently exercise the previous frontend.

That is exactly what happened: an MMD backend that was working was diagnosed as
broken because the app was running a build from before the backend existed. The
harnesses were already setting `ANIMATE_STATIC_ROOT="$REPO/dist"`; the manual
runs were not. **When a change appears to have no effect, confirm the thing
being served is the thing just built.**

**Import order between two side-effect modules was load-bearing, and nothing
said so.** `RegisterPmxLoader()` constructs the plugin immediately, and that
constructor captures `MmdModelLoader.SharedMaterialBuilder` into its loader
options *at that moment*. Registering the material builder afterwards is too
late — the plugin already holds `null`.

The result is the worst class of failure: the model loads, the skeleton solves,
the mesh renders at 660 frames, and it is completely untextured. No error. No
failed HTTP request either, because with no material builder the loader never
asks for a texture. `materials=0` was the only evidence.

Fixed by importing `mmdModelLoader` before `pmxLoader`, with a comment saying
not to reorder it.

**Two diagnostic gaps made that hunt much longer than it needed to be.**

1. `static_files` returned 404 *before* its logging line, so a missing file —
   a missing texture, most of all — left no trace at all.
2. The renderer's `console` went nowhere. A library that fails to load a
   texture says so in the console, and the console was invisible during a
   harness run.

Both are fixed: misses are logged unconditionally, and `console.error`/`warn`
are mirrored into the log. The console mirror immediately surfaced a real bug —
`shell_is_fullscreen not allowed` — the ACL had not been updated for the new
window commands, so the fullscreen button would have failed in any packaged
build while working in every test that did not press it.

**Adding a Rust command is not enough; the ACL needs it too.** Tauri enforces
the ACL on the app's own commands because the renderer is a loopback origin,
which counts as remote. Four new commands went in without permissions. The
failure mode is a console warning and a silently dead button.

---

## 8. Milestones

Each phase ends at something runnable. No phase depends on a later one.

### Phase 0 — Shell scaffolding ✅ **done**
Tauri project builds and runs a blank window.

- [x] `src-tauri/` created, cargo 1.91.1 builds clean
- [x] Frameless window, correct default size, `#120d14` background
- [x] Single-instance plugin wired
- [x] React + TS + Vite renderer renders "AniMate" in the window
- [x] Electron artifacts deleted (`forge.config.js`, `vite.*.config.mjs`, Electron deps)

**Verified:** `animate.exe` opens a frameless dark window; the renderer mounts.

### Phase 1 — Loopback server ✅ **done**
The renderer is served over HTTP and the shell bridge works.

- [x] axum binds `127.0.0.1:8933`, serves `dist/`
- [x] Range/206 support, correct MIME types
- [x] `ryzaShell` shim injected and installed in the page
- [x] All five shell commands round-trip through Rust
- [x] Log file lands in the app log dir
- [x] `/_proxy` and `/_ws-proxy` routes mounted, with guard tests

**Verified:** three consecutive runs, each checking byte-exact content delivery,
Range/206, five proxy guards, a live upstream fetch through the proxy, and an
IPC round trip from inside the webview. Harness: `tools/verify.sh`.

### Phase 2 — Spine backend ✅ **core done**
The character renders, idles, and reacts.

- [x] `crf_chr_002` assets copied (~28 MB for both costumes, not the full 580)
- [x] `SpineBackend` mounts; the render loop runs (~660 frames in 4 s)
- [x] `posture_camera.json` fit logic ported (`cover=true` — the plate box is measured)
- [x] Rim-light shader compiles and runs (`rim=true`)
- [x] Idle motion plays from `EmotionProfilesV4.basePoses`
- [x] Expression sets resolve on the pose-reroll tick
- [x] Multiply-blend handling with full state restore in `finally`
- [ ] Window-resize survival verified by eye (the debounced path is ported; the
      harness confirms the loop keeps running across a resize, not the framing)

**Verified:** `idle=motion_A_029_idle` on one run and `motion_A_033_idle` on the
next, with `bones=298 animations=867 poseType=posetype_01_freehand`. The idle
name differing between runs is the proof that the weighted selection is live,
and the name only resolves if the whole chain works:
`gesture.json → EmotionProfilesV4 → intensity profile → basePoses → pickAnim`.

**Not ported, deliberately** (listed at the foot of `SpineBackend.ts` so the gap
is explicit rather than accidental): the additive limb/torso layer system, gaze
and finger drivers, hit testing, scene parallax constraints, FX slots, atlas
variants, ASMR camera, and lip sync. `setSpeaking` currently only gates the
mouth track.

### Phase 2b — Spine emotion depth
The parts of the original's expressiveness that are not yet in.

- [ ] Additive layer system (`_syncAdditives`, `_applyLayer`, `_queueAddTrack`)
- [ ] Gaze and finger drivers (`DriverDefs`, `lookAtBoneHierarchy`)
- [ ] Lip sync (`_applyLip`) driven by TTS amplitude
- [ ] Hit testing for tap reactions
- [ ] Scene plates and parallax constraints, per-model rather than bundled

### Phase 2c — Model library and settings ✅ **done**
Bring-your-own-model, and a place to put the API key.

- [x] Bundled character assets removed entirely (§5)
- [x] Native file picker, imported via `tauri-plugin-dialog`
- [x] Import copies files into `<app_data>/models/<id>/` and records them in a registry
- [x] Format detection for Spine / MMD / glTF / VRM, with unsupported formats
      accepted and listed rather than rejected
- [x] `/models/` served from the app data dir, with the same traversal and
      range handling as the bundled root
- [x] Settings panel: LLM endpoint, key, model name, persisted via Rust
- [x] Settings file deliberately outside the served subtree, asserted by the harness
- [x] Camera fitted to the model's measured bounds, so any scale frames correctly
- [x] Empty-stage states that distinguish "nothing imported" from "no loader
      for this format" from "failed to load"
- [x] Chat layout fixed: composer pinned, transcript scrolls

**Verified:** 16 Rust unit tests covering the import path (copy fidelity,
registry persistence, active-model promotion, duplicate names, rejection of
missing files and unsafe ids), plus an end-to-end run with a model staged in
the library:

```
character ready: kind=spine state=ready
spine stats: frames=658 idle=motion_A_031_idle bones=298 animations=867
             view=3904x4701 measured=true rim=true
```

`measured=true` and a non-default `view` are the proof that the camera fitted
to the model rather than to a hardcoded window.

### Phase 3 — Chat and voice ✅ **core done**
End to end: type, get a reply, hear it.

- [x] BYOK settings persist on both sides (`settings.rs` / `settings.ts`)
- [x] `/_proxy` routes LLM calls, with tolerant JSON and SSE recovery
- [x] Reply protocol: tag parsing, state-block stripping, heuristic fallback
- [x] Reply drives emotion → expression, and `setSpeaking` → the mouth track
- [x] Voice settings (endpoint, key, model, voice) with a dedicated tab
- [x] TTS over `/_proxy` via OpenAI-compatible `/audio/speech`
- [ ] Realtime TTS over `/_ws-proxy` — the HTTP path covers the common case;
      the WebSocket path is only needed for streaming synthesis
- [ ] Voice/text parity: the bubble should not render before audio resolves

**Verified:** 43 unit tests (24 protocol, 19 transport), plus
`tools/verify-chat.sh` — which points an isolated AniMate test profile at a
mock provider, boots the app with `?selftest=chat`, and lets it send one canned
turn. The whole chain is exercised in one pass, no API key and no human at the
keyboard:

```
[renderer] smoke result: busy=false error=- emotion=happy failed=false
           text="Oh, hello! I was hoping you would come by."
[mock] chat:   model=mock-chat stream=True auth=Bearer test-key
[mock] speech: model=mock-tts  voice=alloy auth=Bearer test-key
```

That last line is the one that matters. `stream=True` proves the SSE path is
actually being taken rather than the client quietly falling back to a single
JSON object — see the chunked-body finding in §7b, which is what this harness
was silently doing until the mock was fixed.

### Phase 3b — Desktop essentials ✅ **done**
The things that make a frameless window feel like a desktop app rather than a
web page in a box.

- [x] Fullscreen: button, `F11`, `Esc` to leave, and it never enters on `Esc`
- [x] Window geometry persisted across restarts
- [x] `Ctrl+,` opens settings
- [x] Title bar hides in fullscreen; a hover-reveal pill offers the way out
- [x] Off-screen guard: a position saved on a monitor since unplugged is
      discarded rather than restored somewhere unreachable
- [x] `models/` gitignored — local fixtures, never committed

`tauri-plugin-window-state` was tried first and rejected: it pulls a
`kuchikiki` version that conflicts with the one `wry` pins. The logic is ~80
lines and owning it also bought the off-screen guard, which the plugin does
not provide.

**Verified** by `verify-window.sh`, which runs repeated launch/close cycles and
asserts the geometry does not drift:

```
cycle 1: 480x854@(156,156)
cycle 2: 480x854@(156,156)
cycle 3: 480x854@(156,156)
OK    stable at 480x854@(156,156) across 3 launches
```

That repeated cycle is the whole point. The first version captured
`outer_size()` and restored via `set_size()`, which sets the *client* area —
so every launch added the window frame again, +16px on Windows. Any single
launch looked correct.

### Phase 4 — MMD backend ✅ **first cut done**

3D support, which the original spec called for and which was the last 0%.

- [x] `MmdBackend` on Babylon.js + `babylon-mmd`
- [x] PMX loading with materials and textures
- [x] Camera fitted to the model's measured bounds, with clamped orbit
- [x] Emotion via morphs (Japanese names, with English aliases)
- [x] Procedural blink and a mouth morph while speaking
- [x] Registered as a second `CharacterKind`; `LOADABLE_KINDS` now includes `mmd`
- [x] **Folder import** with structure preserved — required, see below

**Not done, and worth being explicit about:**

- **Physics.** No WASM Bullet runtime, so hair and skirts do not swing. That
  is a visible quality gap on most MMD models.
- **VMD motion playback.** `playMotion()` rejects rather than pretending.
- Gaze, VPD poses, audio-driven lip sync, camera animation.

### Why `babylon-mmd` and not three.js

three.js removed `MMDLoader`. Both `three-mmd-loader` and the `mmd-parser` it
depended on were last published in **2022**. `babylon-mmd` shipped a release
last month.

So MMD means Babylon — a second 3D engine, and ~1 MB of lazy-loaded bundle
(the entry chunk is unchanged at 260 KB; Babylon sits in its own chunk behind
a dynamic import). That is the price of the feature, and it is worth stating
plainly because it is not reversible without dropping MMD again.

### The importer had to change first

`import_files` flattens: `target_dir.join(file_name)`. A PMX references its
textures as `tex/Body.png`, so a flattened import produces a model that loads
with no textures and reports no error.

Added `import_tree`, which copies a directory preserving relative paths, with
caps on size (512 MB), file count (4000) and depth. Symlinks are skipped
rather than followed — following one would copy files the user never selected.
Exposed as a separate "Import folder" action; the multi-file picker cannot
express "this model and the `tex/` directory beside it".

### Phase 4b — Packaging

The Windows NSIS installer builds. Code signing, auto-update, and a first run
on a clean machine remain to do.
- [ ] Scene plates, full audio, fonts restored
- [x] `MmdBackend` implements `CharacterRenderer` via Babylon.js + `babylon-mmd`
- [ ] Backend switching works without a restart
- [x] NSIS installer builds
- [ ] First-boot asset integrity check

**Verify:** clean VM install → character loads → chat works offline except API calls.

---

## 9. Post-v1

Deferred deliberately, not forgotten. Each is additive against the interface
in §4.

- Multi-session saves, memory rollup
- i18n (JA/EN/ZH), reusing RyzaChat's 92 KB translation table
- Bond and affection system
- Quests, daily events, alarms
- World rules and persona configuration
- Global hotkeys, tray icon, ESC-back

---

## 10. Licensing

Both problems from the original plan are now resolved, not managed.

**Character assets — resolved by removal.** The plan used to say AniMate must
carry a notice matching RyzaChat's "fan port for personal use", and that the
installer could never be published. Since the app now ships **no** character
assets (§5) and the user brings their own, there is no character art in the
repository or installer. AniMate's source and the vendored Spine runtime have
their own licenses. What a user imports stays on their machine.

This removes the character-art obstacle and lets users choose their own
models. Spine runtime distribution remains subject to its separate license.

Note that the *test* assets used during development came from RyzaChat and were
never committed — `public/assets/*` is gitignored, and the directory now holds
only its README.

**API keys — resolved by not shipping any.** AniMate starts with empty
settings and prompts on first run. The key is written to
`<app_data>/settings.json`, which sits outside the directory the loopback
server exposes, so it is unreachable over HTTP — the harness asserts this.

The key is stored in **plain text**. That matches the reference implementation
and is acceptable for a personal-use desktop app, but it is worth being plain
about: anything with read access to the user's app data can read it. Moving to
the OS credential store (Windows Credential Manager, via the `keyring` crate)
is the right follow-up and is listed in §11.

---

## 11. Open questions

Resolved since the first draft:

- ~~Default window size~~ → companion-sized 480×854.
- ~~Asset copies or symlink~~ → moot; no assets are bundled.
- ~~Vendor `spine-webgl.js` or rebuild~~ → vendored at 4.2.43 with a `.d.ts`.
- ~~React 19 vs 18~~ → React 19, no issues.

Still open:

1. **MMD fixtures** — the backend is implemented and local PMX fixtures exist,
   but no redistributable PMX/VMD fixture is committed for automated render
   checks or a clean-machine demonstration.
2. **Motion capture scope** — the MMD reference includes a full webcam →
   landmark → bone pipeline. In scope, or authored `.vmd` motions only?
3. **Key storage** — the API key is plain text in the app data folder. Move to
   the OS credential store (`keyring`) before this is more than personal use.
4. **Additional 2D formats** — Live2D (`.moc3`) is the other obvious 2D runtime
   and would slot in behind the same `CharacterRenderer` contract.
5. **Import ergonomics** — a Spine model is three files that must be selected
   together, which is easy to get wrong. A folder-based import or a
   drag-and-drop target would be kinder. Today the error explains the
   requirement rather than preventing the mistake.

---

## 12. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `avatar.js` port is 127 KB of dense WebGL | High | Port in Phase 2 in isolation; it is the largest single task in the plan |
| First release build is slow | Low | The Windows NSIS build succeeds; Rust release compilation is the main cost. |
| `_ws-proxy` close propagation regresses | Medium | Explicit acceptance test in Phase 3; RyzaChat's notes document the exact failure |
| WebView2 WebGL perf vs Electron | Medium | Same engine family. Measure in Phase 2; fall back to `--use-angle=gl` if needed |
| MMD render has no public fixture | Medium | Keep local test models ignored; document the need for a licensed public fixture. |
| Realtime TTS needs DashScope region parity | Low | Default host is intl (`dashscope-intl`); user pastes own base URL |

---

## Appendix A — Verified environment

```
cargo    1.91.1 (2025-10-10)
rustc    1.91.1 (2025-11-07)
rustup   1.28.2 (2025-04-28)
node     22.22.2
npm      10.9.7
WebView2 153.0.4234.48
```

Tauri CLI 2.11.5 is installed through `package-lock.json`.

## Appendix B — Spine version verification

`crf_skn_002_0001_01.skel` carries a version trailer, read from bytes 12–18:

```
00000000: e248 54da d57e 54cd 0734 2e32 2e34 33c4
                                  4  .  2  .  4  3
```

Spine **4.2.43**. `vendor/spine-webgl.js` targets the same release. A version
skew here produces silent, partial, or corrupt rendering — do not upgrade the
runtime without regenerating the skeletons.
