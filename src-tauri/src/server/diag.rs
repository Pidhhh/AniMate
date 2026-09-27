/* `/_diag?m=<message>` — an out-of-band logging channel for the renderer.
 *
 * This exists because the bridge cannot be used to diagnose the bridge. When
 * the shell IPC is missing or misconfigured, `ryzaShell.appendLog` is exactly
 * the thing that is unavailable, so there would be no way to learn why the
 * page failed. A plain `fetch()` to the loopback server always works, since
 * the page was served from it in the first place.
 *
 * Loopback-only and origin-checked like the proxy. Messages are capped and
 * newline-stripped so a caller cannot forge log lines.
 */

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{log_line, Ctx};

const MAX_MESSAGE_LEN: usize = 300;

#[derive(Deserialize)]
pub struct DiagQuery {
    #[serde(default)]
    pub m: String,
}

/// Authentication is enforced by the `require_session` layer on this route —
/// see `server::router`. It matters here because the renderer calls this with a
/// same-origin GET, which carries no Origin header: the origin check alone
/// would let any website write to the user's log.
pub async fn handle(
    State(ctx): State<Ctx>,
    Query(query): Query<DiagQuery>,
    headers: HeaderMap,
) -> Response {
    let cleaned: String = query
        .m
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .take(MAX_MESSAGE_LEN)
        .collect();

    let agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");

    log_line(&ctx, &format!("[renderer] {cleaned} | ua={agent}"));

    StatusCode::NO_CONTENT.into_response()
}
