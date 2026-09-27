/* Static file serving with Range support.
 *
 * Range/206 is not optional: the browser seeks inside voice clips, and without
 * it every `<audio>` seek re-downloads from byte zero — or fails outright.
 */

use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use super::{host_allowed, json_error, log_line, Ctx};

pub async fn handle(
    State(ctx): State<Ctx>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return json_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "only GET and HEAD are supported",
        );
    }

    /* The DNS-rebinding guard.
     *
     * Rebinding points an attacker's hostname at 127.0.0.1, so the request is
     * genuinely local but arrives with `Host: evil.com` — and because the
     * page's origin is then `http://evil.com:8933`, it is same-origin with
     * this server and can *read* every response.
     *
     * Static files carry no session token (they must stay loadable by `<img>`
     * and `<audio>`), so this Host check is the only thing standing between a
     * rebound page and the user's imported models. */
    if !host_allowed(&headers) {
        log_line(
            &ctx,
            &format!("static {}: refused, Host is not loopback", uri.path()),
        );
        return json_error(
            StatusCode::FORBIDDEN,
            "requests must address a loopback host",
        );
    }

    /* Imported models live outside the installed tree, so they are served
    from a second root. Both roots get the same traversal guard below. */
    let selected = match select_root(&ctx, uri.path()) {
        Some(selected) => selected,
        None => return json_error(StatusCode::NOT_FOUND, "no model directory configured"),
    };
    let (root, sub_path, from_models) = selected;

    let path = match resolve(root, sub_path) {
        Some(path) => path,
        None => return json_error(StatusCode::BAD_REQUEST, "invalid path"),
    };

    let meta = match tokio::fs::metadata(&path).await {
        Ok(meta) if meta.is_file() => meta,
        _ => {
            /* Misses are logged even when `log_requests` is off.
             *
             * A missing texture is the single most confusing failure this
             * server can produce: the model loads, the geometry renders, and
             * it comes up untextured with nothing anywhere saying why. The
             * request that failed is the only evidence, and it was being
             * dropped on the floor — the old code returned here, before the
             * logging below. */
            log_line(&ctx, &format!("MISS {} (no such file)", uri.path()));
            return json_error(StatusCode::NOT_FOUND, "not found");
        }
    };

    let total = meta.len();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();

    /* The document load is always logged — it is the one signal that proves
    the webview fetched the app. Subresources are logged only on request,
    via ANIMATE_LOG_REQUESTS, since a boot pulls a few dozen of them. */
    let is_document = !from_models && path.file_name().is_some_and(|name| name == "index.html");
    if is_document {
        log_line(&ctx, &format!("document {} ({} bytes)", uri.path(), total));
    } else if ctx.log_requests {
        log_line(
            &ctx,
            &format!("static {} ({} bytes, {})", uri.path(), total, mime.as_ref()),
        );
    }

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let spec = parse_range(range_header, total);

    let (status, start, end) = match spec {
        RangeSpec::Full => (StatusCode::OK, 0u64, total.saturating_sub(1)),
        RangeSpec::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
        RangeSpec::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Body::empty())
                .expect("static response");
        }
    };

    let len = if total == 0 { 0 } else { end - start + 1 };

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len)
        /* No caching, deliberately, for everything.
         *
         * This is a loopback server: every byte comes off the local disk, so a
         * cache saves nothing measurable. What it does cost is correctness —
         * an aggressively cached bundle means the webview can keep executing a
         * stale build after a rebuild, which presents as "my changes did
         * nothing" and is very hard to see. Freshness is worth far more here
         * than a cache hit. */
        .header(header::CACHE_CONTROL, "no-store");

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }

    /* HEAD gets the same headers and no body. */
    if method == Method::HEAD || len == 0 {
        return builder.body(Body::empty()).expect("static response");
    }

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return json_error(StatusCode::NOT_FOUND, "not found"),
    };

    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
    }

    /* Streamed rather than buffered: scene plates and voice clips run to
    tens of megabytes and should never be held in memory whole. */
    let body = Body::from_stream(ReaderStream::new(file.take(len)));
    builder.body(body).unwrap_or_else(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build response",
        )
    })
}

/// Chooses the on-disk root a request is served from.
///
/// `/models/<id>/...` comes from the app data directory so imported models
/// survive app updates; everything else comes from the bundled frontend.
/// Returns `None` when `/models/` was requested but no models directory could
/// be resolved — a 404 is more honest there than silently serving nothing.
///
/// The third element says whether the models root was used, which the caller
/// needs to keep model requests out of the document-load log.
fn select_root<'a>(ctx: &'a Ctx, uri_path: &'a str) -> Option<(&'a Path, &'a str, bool)> {
    if let Some(rest) = uri_path.strip_prefix("/models/") {
        let root = ctx.models_root.as_ref()?;
        return Some((root.as_path(), rest, true));
    }
    Some((ctx.root.as_path(), uri_path, false))
}

/// Maps a URI path onto a path inside the served root, rejecting anything that
/// could escape it. Every component must be a plain name — no `..`, no root,
/// no drive prefix.
fn resolve(root: &Path, uri_path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(uri_path)
        .decode_utf8()
        .ok()?;

    let trimmed = decoded.trim_start_matches('/');
    let rel = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    let candidate = Path::new(rel);
    for component in candidate.components() {
        if !matches!(component, Component::Normal(_)) {
            return None;
        }
    }

    let mut full = root.join(candidate);
    if full.is_dir() {
        full = full.join("index.html");
    }
    Some(full)
}

enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parses a single-range `bytes=` header. Multi-range requests fall back to a
/// full response, which is legal and far simpler than multipart/byteranges.
fn parse_range(header: Option<&str>, total: u64) -> RangeSpec {
    let raw = match header {
        Some(raw) => raw.trim(),
        None => return RangeSpec::Full,
    };
    let spec = match raw.strip_prefix("bytes=") {
        Some(spec) => spec.split(',').next().unwrap_or("").trim(),
        None => return RangeSpec::Full,
    };
    let (first, second) = match spec.split_once('-') {
        Some(pair) => pair,
        None => return RangeSpec::Full,
    };

    /* Suffix form: `bytes=-N` means the final N bytes. */
    if first.is_empty() {
        let n: u64 = match second.parse() {
            Ok(n) => n,
            Err(_) => return RangeSpec::Full,
        };
        if n == 0 || total == 0 {
            return RangeSpec::Unsatisfiable;
        }
        let n = n.min(total);
        return RangeSpec::Partial {
            start: total - n,
            end: total - 1,
        };
    }

    let start: u64 = match first.parse() {
        Ok(n) => n,
        Err(_) => return RangeSpec::Full,
    };
    if start >= total {
        return RangeSpec::Unsatisfiable;
    }

    let end = if second.is_empty() {
        total - 1
    } else {
        match second.parse::<u64>() {
            Ok(n) => n.min(total - 1),
            Err(_) => total - 1,
        }
    };

    if end < start {
        return RangeSpec::Unsatisfiable;
    }

    RangeSpec::Partial { start, end }
}
