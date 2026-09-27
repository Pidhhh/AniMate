# Third-party notices

AniMate's own source is MIT (see [LICENSE](LICENSE)). It bundles or depends on
the following, which are **not** covered by that license.

---

## Provenance: the ported Spine pipeline

Parts of the 2D renderer were ported from **RyzaChat 1.2.15**, a personal-use
fan project, which in turn builds on the Spine runtimes below. Files carrying
ported code say so in their header — see `src/character/spine/SpineBackend.ts`
and `src/chat/protocol.ts`.

This is recorded for attribution, not as a claim of any relationship with that
project or with the rights holders of the characters it was built around.
Nothing from it is redistributed here beyond the logic, and no art, audio or
scene data came across.

This repository does not contain a redistribution license for the ported
logic. Confirm the rights to publish those portions before a public push.

`MIGRATION-PLAN.md` is the working document from that port and describes the
process in detail, including what was deliberately left behind.

---

## Spine Runtimes

**Component:** `public/vendor/spine-webgl.js` — the spine-ts WebGL runtime,
version 4.2.43, vendored as a built bundle.

**Copyright:** © Esoteric Software LLC.

**License:** the Spine Runtimes License Agreement. This is **not** an open
source license and it is **not** MIT. Integration and distribution have
conditions under the Spine Runtimes and Spine Editor agreements.

The vendored bundle has no license header. The complete
[Spine Runtimes license and copyright notice](public/vendor/Spine-Runtimes-License-Agreement.txt)
is included beside it in the source tree and the packaged frontend. The
authoritative text is at:

<https://esotericsoftware.com/spine-runtimes-license>

**Before publishing the source or distributing a build of AniMate, confirm the
applicable integration and distribution terms are met.** The MMD backend does
not depend on this runtime.

> Note: the version is pinned deliberately. Skeleton binaries carry a version
> trailer, and the runtime must match it exactly — a skew renders silently wrong
> with no error. 4.2.43 matches the `.skel` files this was developed against.

---

## Babylon.js and babylon-mmd

**Components:** `@babylonjs/core` (Apache-2.0) and `babylon-mmd` (MIT).

The [Apache 2.0 license](public/licenses/Apache-2.0.md),
[Babylon.js notice](public/licenses/BabylonJS-NOTICE.md), and
[babylon-mmd MIT license](public/licenses/babylon-mmd-MIT.txt) are included in
the source tree and packaged frontend.

---

## Tauri

**Component:** the Tauri framework and its plugins (MIT or Apache-2.0).

The [Tauri MIT license](public/licenses/Tauri-MIT.txt) and
[Apache 2.0 license](public/licenses/Apache-2.0.md) are included in the
packaged frontend.

---

## Fonts, icons and other assets

AniMate ships **no** character art, voice clips, scene plates or other media.
Those are supplied by the user at runtime and are not part of this repository —
see `.gitignore`, which excludes `models/` and `public/assets/`.

The application icons under `src-tauri/icons/` are currently the **Tauri
default template icons**, not AniMate artwork. Replace them before any release
that people will see.
