# Vendored runtime

`spine-webgl.js` — the spine-ts WebGL runtime, **4.2.43**, built as a classic
script that exposes itself as the global `spine`.

## Why it is vendored rather than installed

The bundle is not published to npm in this form, and the version has to be
pinned exactly: skeleton binaries carry a version trailer, and a runtime that
does not match renders silently wrong with no error. Read the trailer before
changing anything:

```bash
xxd -l 16 path/to/character.skel
# 00000000: e248 54da d57e 54cd 0734 2e32 2e34 33c4   .......4.2.43.
#                                                ^^^^^^^ version
```

## Why it is a classic script

The bundle is `var spine = (() => {…})()` and assigns a global. It is loaded by
a plain `<script>` in `index.html`, before the app module, rather than as an ES
import. `src/character/spine/spine.d.ts` declares the shape for TypeScript.

## License

**Not MIT.** © Esoteric Software LLC, under the
[Spine Runtimes License Agreement](Spine-Runtimes-License-Agreement.txt).
The full license and copyright notice are kept beside the runtime and included
in the packaged frontend. See also
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md).

Confirm the applicable integration and distribution terms before publishing
source or a build. The MMD backend does not depend on this file.
