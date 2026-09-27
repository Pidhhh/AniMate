# Character assets

**This directory is intentionally empty.**

AniMate ships with no character models. Everything on the stage is brought by
the user, through **Settings → Models → Import**, and stored outside the
installed app so it survives updates.

## Why nothing is bundled

AniMate has no default character. Users import models they have the right to
use; no character assets are included in the source or installer.

## Where imported models live

Not here. The importer copies files into the app data directory:

```
<app_data>/models/index.json      registry: id, name, kind, entry, files
<app_data>/models/<id>/           that model's files, verbatim
```

and the embedded loopback server exposes them at `/models/<id>/...`.

`settings.json` sits one level *up* from `models/`, deliberately — it holds the
LLM API key, and `models/` is served over HTTP. Keeping them apart means the
key is never inside the served subtree.

On Windows:

```
%LOCALAPPDATA%\app.animate.companion\models\
%LOCALAPPDATA%\app.animate.companion\settings.json
```

## What the importer accepts

| Format | Extension | Status |
|---|---|---|
| Spine (2D) | `.skel` + `.atlas` + texture | **Loads** |
| MMD (3D) | `.pmx`, `.pmd` | Imported, no loader yet |
| glTF / VRM | `.glb`, `.gltf`, `.vrm` | Imported, no loader yet |

A model is a *set*, not a file. For Spine, select the `.skel`, the `.atlas` and
the texture page together in one go — the importer keeps them side by side,
which is what the atlas needs when it resolves its texture pages.

Unsupported formats are accepted and listed rather than rejected, so a file
that was copied stays visible instead of vanishing silently.

## Spine version lock

Skeleton binaries carry a version trailer. The runtime must match it exactly —
a skew renders silently wrong or corrupt, with no error at all. Read the
trailer at byte offset 12 before swapping either side:

```bash
xxd -l 16 path/to/character.skel
# 00000000: e248 54da d57e 54cd 0734 2e32 2e34 33c4   .......4.2.43.
#                                                ^^^^^^^ version
```

The vendored runtime in `public/vendor/spine-webgl.js` is **4.2.43**.
