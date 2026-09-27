/* The loopback server.
 *
 * Why this exists at all, rather than serving from a custom scheme: the app's
 * network client routes LLM and TTS calls through a same-origin `/_proxy`, but
 * only when `location.origin` is a loopback origin. The proxy is not optional
 * because a browser cannot set an `Authorization` header on a raw WebSocket,
 * and the realtime voice-clone TTS endpoint requires exactly that — `/_ws-proxy`
 * re-dials upstream from Rust where the header can be set.
 *
 * Keeping the renderer on `http://127.0.0.1:<port>` therefore keeps the whole
 * ported network layer working unmodified. A `tauri://` or custom-scheme origin
 * would silently break realtime voice.
 */

pub mod diag;
pub mod proxy;
pub mod static_files;
pub mod ws;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::{any, get};
use axum::Router;

use crate::session::{self, SessionToken};

pub const DEFAULT_PORT: u16 = 8933;

/// Shared server state, cloned per request. Cheap: one Arc and one pooled
/// HTTP client.
#[derive(Clone)]
pub struct Ctx {
    pub root: Arc<PathBuf>,
    /// Imported character models, served at `/models/`. Separate from `root`
    /// because they live in the app data dir and must survive app updates.
    /// `None` when that directory could not be resolved.
    pub models_root: Option<Arc<PathBuf>>,
    pub client: reqwest::Client,
    /// Where to append diagnostics. `None` when the server is run standalone.
    pub log_path: Option<Arc<PathBuf>>,
    /// Log every static subresource, not just the document. Off by default —
    /// a boot pulls a few dozen assets and would bury the signal — but
    /// invaluable when a window comes up blank.
    pub log_requests: bool,
    /// Per-run secret the renderer must present on the privileged routes. See
    /// `crate::session` for why origin checking alone is not sufficient.
    pub session_token: SessionToken,
}

/// Appends a timestamped line to the shell's log file. Silent on failure —
/// diagnostics must never take the server down.
pub fn log_line(ctx: &Ctx, line: &str) {
    let Some(path) = ctx.log_path.as_ref() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let row = format!(
        "{} [server] {}\n",
        chrono::Local::now().format("%H:%M:%S"),
        line
    );
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.as_ref())
    {
        let _ = file.write_all(row.as_bytes());
    }
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("AniMate/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        /* No overall timeout: realtime TTS and long completions legitimately
        stay open far longer than any request timeout worth setting. */
        .pool_idle_timeout(Duration::from_secs(90))
        /* Redirects are NOT followed.
         *
         * The target allowlist validates the URL we were handed, and nothing
         * else. Following a redirect would apply that check to the first hop
         * only, so a permitted `https://` target could bounce the request to a
         * plain-`http` host — the exact case the allowlist exists to prevent,
         * with the caller's `Authorization` header riding along.
         *
         * Returning the 3xx to the client instead means the browser follows it
         * through this same proxy, so every hop is re-validated. */
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("failed to build the HTTP client")
}

/// Binds the loopback port *synchronously* so the caller can guarantee the
/// server is listening before a window is pointed at it. Returns a std
/// listener; `serve` converts it to the async runtime.
pub fn bind_loopback(port: u16) -> std::io::Result<std::net::TcpListener> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = std::net::TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

pub fn router(
    root: PathBuf,
    log_path: Option<PathBuf>,
    models_root: Option<PathBuf>,
    session_token: SessionToken,
) -> Router {
    let ctx = Ctx {
        root: Arc::new(root),
        models_root: models_root.map(Arc::new),
        client: build_client(),
        log_path: log_path.map(Arc::new),
        log_requests: std::env::var_os("ANIMATE_LOG_REQUESTS").is_some(),
        session_token,
    };

    /* Auth is a layer, not a line at the top of each handler.
     *
     * That distinction is load-bearing. Extractors run *before* the handler
     * body, so a handler that opens with an auth check is still preceded by
     * every extractor it declares. `/ _ws-proxy` takes `WebSocketUpgrade`,
     * which rejects a non-upgrade request with 400 — meaning an unauthenticated
     * caller could reach that rejection path without ever being authenticated,
     * and the route's own auth check would never run.
     *
     * A layer wraps the whole route, so it runs first regardless of what any
     * handler extracts. */
    let privileged = Router::new()
        .route("/_proxy", any(proxy::handle))
        .route("/_ws-proxy", get(ws::handle))
        .route("/_diag", get(diag::handle))
        .layer(axum::middleware::from_fn_with_state(
            ctx.clone(),
            require_session,
        ));

    privileged.fallback(static_files::handle).with_state(ctx)
}

/// Refuses any request to a privileged route that cannot prove it came from
/// this app's page.
///
/// Static files are deliberately not behind this: they are the bundled
/// frontend and the user's own imported models, and requiring a token would
/// stop `<img>` and `<audio>` from loading them. They get the Host check
/// instead, which is the relevant guard for them.
async fn require_session(
    State(ctx): State<Ctx>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let route = request.uri().path().to_string();
    let headers = request.headers();

    let header_ok = privileged_allowed(headers, &ctx, &route);

    /* A WebSocket handshake cannot carry custom headers from a browser, so
    that one route also accepts the token as a query parameter. Confined to
    loopback and never logged, which is what makes it acceptable there and
    nowhere else. */
    let query_ok = route == "/_ws-proxy"
        && query_param(request.uri(), "t")
            .is_some_and(|presented| session::matches(&ctx.session_token, &presented));

    if !header_ok && !query_ok {
        return json_error(
            axum::http::StatusCode::FORBIDDEN,
            "cross-origin or unauthenticated use of the local server is not allowed",
        );
    }

    next.run(request).await
}

pub async fn serve(
    listener: std::net::TcpListener,
    root: PathBuf,
    log_path: Option<PathBuf>,
    models_root: Option<PathBuf>,
    session_token: SessionToken,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router(root, log_path, models_root, session_token)).await
}

/* ---- Shared helpers ----------------------------------------------------- */

/// True when the `Host` header names a loopback address.
///
/// This is the DNS-rebinding guard. Rebinding works by pointing a
/// attacker-controlled hostname at 127.0.0.1, so the request arrives with
/// `Host: evil.com` while the connection is genuinely local. Rejecting any
/// Host that is not loopback stops the attack at the door.
///
/// A missing Host is rejected too: HTTP/1.1 requires it, and there is no
/// legitimate caller here that omits it.
pub fn host_allowed(headers: &axum::http::HeaderMap) -> bool {
    let Some(host) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };

    /* Strip the port. `[::1]:8933` keeps its brackets until the port is gone,
    so handle the bracketed form explicitly rather than splitting on the
    first colon. */
    let bare = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        host.split(':').next().unwrap_or(host)
    };

    matches!(bare, "127.0.0.1" | "localhost" | "::1")
}

/// True when the request carries no Origin (a non-browser client, i.e. our own
/// webview on a same-origin GET) or an Origin that is itself loopback.
///
/// This is a deliberate hardening over the original Node server, which had no
/// such check: without it, any website the user visits could use the local
/// proxy as an open relay to reach the internet from their machine.
///
/// Note that "no Origin" is *not* sufficient on its own — browsers omit Origin
/// on `<img>` and `<script>` loads. The session token is what actually closes
/// that hole; see `crate::session`.
pub fn origin_allowed(headers: &axum::http::HeaderMap) -> bool {
    match headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        None => true,
        Some(origin) => is_loopback_origin(origin),
    }
}

/// True when the caller presented this run's session token.
///
/// Required on every route that can reach the network, read user files, or
/// write to the log. Static files are deliberately exempt: they are either the
/// bundled frontend or models the user chose to import, and requiring a token
/// would mean `<img>` and `<audio>` could no longer load them.
pub fn token_allowed(headers: &axum::http::HeaderMap, ctx: &Ctx) -> bool {
    match headers
        .get(session::TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        Some(presented) => session::matches(&ctx.session_token, presented),
        None => false,
    }
}

/// The combined gate for privileged routes.
///
/// Both checks run, and the reason for refusal is logged without echoing the
/// presented token — a near-miss token is still a secret.
pub fn privileged_allowed(headers: &axum::http::HeaderMap, ctx: &Ctx, route: &str) -> bool {
    if !host_allowed(headers) {
        log_line(ctx, &format!("{route}: refused, Host is not loopback"));
        return false;
    }
    if !origin_allowed(headers) {
        log_line(ctx, &format!("{route}: refused, cross-origin"));
        return false;
    }
    if !token_allowed(headers, ctx) {
        log_line(
            ctx,
            &format!("{route}: refused, missing or invalid session token"),
        );
        return false;
    }
    true
}

fn is_loopback_origin(origin: &str) -> bool {
    match reqwest::Url::parse(origin) {
        Ok(url) => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")),
        Err(_) => false,
    }
}

/// Why a proxy target was refused. Distinguishing these matters for
/// diagnosis: a malformed URL is a client bug (400), a policy refusal is a
/// deliberate block (403).
pub enum TargetRejection {
    Malformed,
    Disallowed,
}

/// Validates a proxy target and returns it parsed.
///
/// https/wss go anywhere; plain http/ws only to loopback and private hosts, so
/// credentials can never be sent in the clear by accident.
pub fn check_target(target: &str) -> Result<reqwest::Url, TargetRejection> {
    let url = reqwest::Url::parse(target).map_err(|_| TargetRejection::Malformed)?;

    let allowed = match url.scheme() {
        "https" | "wss" => true,
        "http" | "ws" => match url.host_str() {
            Some("localhost") => true,
            Some(host) => host.parse::<IpAddr>().map(is_private_addr).unwrap_or(false),
            None => false,
        },
        _ => false,
    };

    if allowed {
        Ok(url)
    } else {
        Err(TargetRejection::Disallowed)
    }
}

/// Convenience for callers that only need the yes/no answer.
pub fn target_allowed(target: &str) -> bool {
    check_target(target).is_ok()
}

fn is_private_addr(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Headers that must not be forwarded in either direction.
pub fn is_hop_by_hop(name: &axum::http::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// Reads one percent-decoded query parameter.
pub fn query_param(uri: &axum::http::Uri, key: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => (pair, ""),
        };
        if k == key {
            return percent_encoding::percent_decode_str(v)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned());
        }
    }
    None
}

/// Small JSON error body, so failures are diagnosable from the client side.
pub fn json_error(status: axum::http::StatusCode, message: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    let body = serde_json::json!({ "error": message }).to_string();
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    /* ---- host_allowed: the DNS-rebinding guard ---- */

    #[test]
    fn accepts_loopback_hosts_in_every_spelling() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:8933",
            "localhost",
            "localhost:8933",
            "[::1]",
            "[::1]:8933",
        ] {
            assert!(
                host_allowed(&headers(&[("host", host)])),
                "{host} should be accepted"
            );
        }
    }

    #[test]
    fn rejects_a_rebound_hostname() {
        /* The whole point: the connection is local, but the Host says
        otherwise. This is what a rebinding attack looks like. */
        for host in [
            "evil.com",
            "evil.com:8933",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
            /* A hostname that merely *starts* with a loopback literal. */
            "127.0.0.1.attacker.net",
            /* Not loopback, despite looking local. */
            "127.0.0.2",
            "0.0.0.0",
            "[::2]",
        ] {
            assert!(
                !host_allowed(&headers(&[("host", host)])),
                "{host} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_a_missing_host() {
        /* HTTP/1.1 requires Host, and nothing legitimate here omits it. */
        assert!(!host_allowed(&HeaderMap::new()));
    }

    /* ---- origin_allowed ---- */

    #[test]
    fn accepts_loopback_origins_and_absent_origin() {
        assert!(origin_allowed(&HeaderMap::new()));
        assert!(origin_allowed(&headers(&[(
            "origin",
            "http://127.0.0.1:8933"
        )])));
        assert!(origin_allowed(&headers(&[(
            "origin",
            "http://localhost:8933"
        )])));
    }

    #[test]
    fn rejects_foreign_origins() {
        for origin in [
            "https://evil.com",
            "http://127.0.0.1.evil.com",
            "null",
            "http://[::1]:8933/",
        ] {
            assert!(
                !origin_allowed(&headers(&[("origin", origin)])),
                "{origin} must be rejected"
            );
        }
    }

    /* ---- token_allowed ---- */

    fn ctx_with(token: &str) -> Ctx {
        Ctx {
            root: Arc::new(PathBuf::from(".")),
            models_root: None,
            client: build_client(),
            log_path: None,
            log_requests: false,
            session_token: Arc::new(token.to_string()),
        }
    }

    #[test]
    fn token_must_match_exactly() {
        let ctx = ctx_with("deadbeef");
        assert!(token_allowed(
            &headers(&[(crate::session::TOKEN_HEADER, "deadbeef")]),
            &ctx
        ));
        assert!(!token_allowed(
            &headers(&[(crate::session::TOKEN_HEADER, "deadbee")]),
            &ctx
        ));
        assert!(!token_allowed(
            &headers(&[(crate::session::TOKEN_HEADER, "deadbeeff")]),
            &ctx
        ));
        assert!(!token_allowed(
            &headers(&[(crate::session::TOKEN_HEADER, "")]),
            &ctx
        ));
    }

    #[test]
    fn a_missing_token_is_refused() {
        /* The regression this guards: an origin-less request from a web page
        passes `origin_allowed`, so without the token check it would reach
        the proxy. */
        let ctx = ctx_with("deadbeef");
        assert!(!token_allowed(&HeaderMap::new(), &ctx));
    }

    #[test]
    fn a_wrong_header_name_does_not_authenticate() {
        let ctx = ctx_with("deadbeef");
        assert!(!token_allowed(
            &headers(&[("authorization", "deadbeef")]),
            &ctx
        ));
        assert!(!token_allowed(&headers(&[("x-token", "deadbeef")]), &ctx));
    }

    /* ---- privileged_allowed: the combination ---- */

    #[test]
    fn privileged_requires_the_host_and_token_checks() {
        let ctx = ctx_with("deadbeef");
        let good = [
            ("host", "127.0.0.1:8933"),
            ("origin", "http://127.0.0.1:8933"),
            (crate::session::TOKEN_HEADER, "deadbeef"),
        ];
        assert!(privileged_allowed(&headers(&good), &ctx, "/test"));

        /* Host and token are load-bearing. */
        for skip in [0usize, 2] {
            let partial: Vec<(&str, &str)> = good
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != skip)
                .map(|(_, pair)| *pair)
                .collect();
            assert!(
                !privileged_allowed(&headers(&partial), &ctx, "/test"),
                "omitting {} must fail",
                good[skip].0
            );
        }

        /* Origin is deliberately NOT required. A same-origin GET carries no
        Origin header — the renderer's `/_diag` call is exactly that — so
        demanding one would break legitimate traffic. The token is what
        covers the origin-less case, which is why it is the check that must
        not be optional. */
        let without_origin = [
            ("host", "127.0.0.1:8933"),
            (crate::session::TOKEN_HEADER, "deadbeef"),
        ];
        assert!(
            privileged_allowed(&headers(&without_origin), &ctx, "/test"),
            "an absent Origin must still be accepted when the token is valid"
        );

        /* And with no token, the same origin-less request is refused. */
        let no_token = [("host", "127.0.0.1:8933")];
        assert!(
            !privileged_allowed(&headers(&no_token), &ctx, "/test"),
            "an origin-less request without a token must be refused"
        );
    }

    #[test]
    fn privileged_refuses_a_rebound_host_even_with_a_valid_token() {
        /* Rebinding gives the attacker same-origin access, so they could in
        principle observe a token in flight — but not read it from the
        injected script. Either way the Host check is independent. */
        let ctx = ctx_with("deadbeef");
        let rebound = [
            ("host", "evil.com"),
            ("origin", "http://evil.com:8933"),
            (crate::session::TOKEN_HEADER, "deadbeef"),
        ];
        assert!(!privileged_allowed(&headers(&rebound), &ctx, "/test"));
    }

    /* ---- check_target ---- */

    #[test]
    fn https_goes_anywhere_but_plain_http_does_not() {
        assert!(target_allowed("https://api.example.com/v1"));
        assert!(target_allowed("wss://api.example.com/rt"));
        assert!(!target_allowed("http://api.example.com/v1"));
        assert!(!target_allowed("ws://api.example.com/rt"));
    }

    #[test]
    fn plain_http_is_allowed_to_loopback_and_private_literals() {
        for target in [
            "http://127.0.0.1:8933/x",
            "http://localhost:1234/x",
            "http://192.168.1.10/x",
            "http://10.0.0.5/x",
            "http://172.16.0.1/x",
            "http://169.254.1.1/x",
        ] {
            assert!(target_allowed(target), "{target} should be allowed");
        }
    }

    #[test]
    fn plain_http_to_a_private_looking_hostname_is_refused() {
        /* Only IP literals are accepted for plain http. A hostname could
        resolve anywhere, so allowing it would make the check meaningless —
        `internal.corp` is not something we can reason about. */
        for target in [
            "http://internal.corp/x",
            "http://router.local/x",
            "http://127.0.0.1.nip.io/x",
            "http://[::ffff:127.0.0.1]/x",
        ] {
            assert!(!target_allowed(target), "{target} must be refused");
        }
    }

    #[test]
    fn non_http_schemes_are_refused() {
        for target in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "data:text/html,<script>",
            "javascript:alert(1)",
            "gopher://example.com/",
        ] {
            assert!(!target_allowed(target), "{target} must be refused");
        }
    }

    #[test]
    fn malformed_targets_are_refused() {
        for target in ["", "not a url", "://missing-scheme", "http://"] {
            assert!(!target_allowed(target), "{target} must be refused");
        }
    }
}
