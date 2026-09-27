/* `/_proxy?u=<url>` — the request proxy.
 *
 * Same contract as the Node server it replaces: forward method, headers and
 * body upstream, stream the response back. https goes anywhere; plain http is
 * restricted to loopback and private hosts (see `target_allowed`).
 */

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use futures_util::TryStreamExt;

use super::{check_target, is_hop_by_hop, json_error, query_param, Ctx, TargetRejection};

const MAX_TARGET_LEN: usize = 4096;

/// Authentication is enforced by the `require_session` layer on this route —
/// see `server::router`. It is deliberately not repeated here: a second check
/// that can never fire invites the reader to wonder which one is real.
pub async fn handle(
    State(ctx): State<Ctx>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let target = match query_param(&uri, "u") {
        Some(target) => target,
        None => return json_error(StatusCode::BAD_REQUEST, "missing ?u=<url>"),
    };

    if target.len() > MAX_TARGET_LEN {
        return json_error(StatusCode::BAD_REQUEST, "target URL too long");
    }

    if let Err(rejection) = check_target(&target) {
        return match rejection {
            TargetRejection::Malformed => {
                json_error(StatusCode::BAD_REQUEST, "target is not a valid URL")
            }
            TargetRejection::Disallowed => json_error(
                StatusCode::FORBIDDEN,
                "plain http is only allowed for loopback and private hosts",
            ),
        };
    }

    let mut request = ctx.client.request(method, &target);

    for (name, value) in headers.iter() {
        if is_hop_by_hop(name) || name == header::HOST {
            continue;
        }
        /* Let the HTTP client negotiate and transparently decode content
        encoding; forwarding the caller's value would defeat that. */
        if name == header::ACCEPT_ENCODING {
            continue;
        }
        /* Recomputed by the client from the streamed body. */
        if name == header::CONTENT_LENGTH {
            continue;
        }
        /* The app sets no cookies, so anything here would be state the
        browser attached on its own — not ours to forward to a third
        party. */
        if name == header::COOKIE {
            continue;
        }
        /* The session token is for the local server only. Forwarding it
        upstream would hand our own credential to whatever endpoint the
        user configured. */
        if name.as_str() == crate::session::TOKEN_HEADER {
            continue;
        }
        request = request.header(name, value);
    }

    /* Streamed straight through, so SSE token streams arrive incrementally
    instead of being buffered until the completion finishes. */
    let upstream_body = reqwest::Body::wrap_stream(body.into_data_stream());
    let request = request.body(upstream_body);

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                &format!("upstream request failed: {err}"),
            );
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if is_hop_by_hop(name) {
            continue;
        }
        /* Cookies are stripped in this direction.
         *
         * The proxy's origin is `127.0.0.1:8933`, so a forwarded `Set-Cookie`
         * would let any upstream — including a compromised or hostile API
         * endpoint — plant cookies on the app's own origin. The app uses no
         * cookies, so there is nothing to preserve and a real thing to lose:
         * cookie state that the app's own pages would then send on every
         * request. */
        if name == header::SET_COOKIE || name.as_str() == "set-cookie2" {
            continue;
        }
        builder = builder.header(name, value);
    }

    let stream = upstream.bytes_stream().map_err(std::io::Error::other);

    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| json_error(StatusCode::BAD_GATEWAY, "failed to build proxied response"))
}
