/* `/_ws-proxy?u=<wss-url>&k=<key>` — the WebSocket proxy.
 *
 * This route is the reason the loopback server exists. A browser cannot set an
 * `Authorization` header on a raw WebSocket, and the realtime voice-clone TTS
 * endpoint requires one. Here, in Rust, the header can simply be added.
 *
 * Close propagation in BOTH directions is load-bearing. The original Node
 * implementation records what happens without it: every finished turn leaked
 * its upstream session for the full backstop window, and rapid turns got
 * throttled into failed syntheses. So each direction explicitly emits a Close
 * on its own sink when it finishes, rather than relying on the socket being
 * dropped.
 */

use std::time::Duration;

use axum::extract::ws::{
    CloseFrame as ClientCloseFrame, Message as ClientMessage, WebSocket, WebSocketUpgrade,
};
use axum::extract::Query;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as UpstreamCloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

use super::{json_error, target_allowed};

/// How long to let the opposite direction flush its close frame after one side
/// finishes. Without a bound, a peer that ignores Close would hang the task.
const CLOSE_GRACE: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
pub struct WsQuery {
    pub u: String,
    /// Kept for compatibility with the original call shape. The upstream
    /// credential is set as an `Authorization` header on the Rust side, so a
    /// key in the URL is no longer needed — and a URL is the wrong place for a
    /// secret, since it reaches logs, history and `Referer`.
    #[serde(default)]
    pub k: String,
}

/// Authentication is enforced by the `require_session` layer on this route,
/// which accepts the session token from either the `X-Animate-Token` header or
/// the `t` query parameter — a browser cannot attach headers to
/// `new WebSocket(...)`, so the handshake needs the fallback.
///
/// That layer is what makes this route safe despite `WebSocketUpgrade` being
/// an extractor: extractors run before the handler body, so an auth check here
/// would sit *behind* the upgrade validation rather than in front of it.
pub async fn handle(ws: WebSocketUpgrade, Query(query): Query<WsQuery>) -> Response {
    if !target_allowed(&query.u) {
        return json_error(StatusCode::FORBIDDEN, "target host not allowed");
    }

    ws.on_upgrade(move |socket| bridge(socket, query.u, query.k))
}

async fn bridge(client: WebSocket, target: String, key: String) {
    let mut request = match target.into_client_request() {
        Ok(request) => request,
        Err(err) => {
            eprintln!("[animate] ws proxy: unusable target: {err}");
            return;
        }
    };

    if !key.is_empty() {
        match HeaderValue::from_str(&format!("Bearer {key}")) {
            Ok(value) => {
                request.headers_mut().insert(header::AUTHORIZATION, value);
            }
            Err(_) => {
                eprintln!("[animate] ws proxy: key is not a valid header value; refusing");
                return;
            }
        }
    }

    let upstream = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _response)) => socket,
        Err(err) => {
            eprintln!("[animate] ws proxy: upstream connect failed: {err}");
            return;
        }
    };

    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let client_to_upstream = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let closing = client_is_close(&message);
            if upstream_tx.send(to_upstream(message)).await.is_err() {
                break;
            }
            if closing {
                break;
            }
        }
        /* Emitted unconditionally, including when the client simply vanished:
        that is what releases the provider session immediately. */
        let _ = upstream_tx.send(UpstreamMessage::Close(None)).await;
        let _ = upstream_tx.close().await;
    };

    let upstream_to_client = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let closing = upstream_is_close(&message);
            if let Some(out) = to_client(message) {
                if client_tx.send(out).await.is_err() {
                    break;
                }
            }
            if closing {
                break;
            }
        }
        let _ = client_tx.send(ClientMessage::Close(None)).await;
        let _ = client_tx.close().await;
    };

    let mut c2u = Box::pin(client_to_upstream);
    let mut u2c = Box::pin(upstream_to_client);

    /* When either direction ends, give the other a bounded window to finish
    rather than dropping it mid-flight. */
    tokio::select! {
        _ = &mut c2u => {
            let _ = tokio::time::timeout(CLOSE_GRACE, &mut u2c).await;
        }
        _ = &mut u2c => {
            let _ = tokio::time::timeout(CLOSE_GRACE, &mut c2u).await;
        }
    }
}

/* axum defines its own WebSocket message types rather than re-exporting
tungstenite's, and its `CloseCode` is a bare `u16` while tungstenite's is an
enum. So the two enums cannot be matched structurally and every variant has
to be rebuilt. Text and close reasons round-trip through `&str`, which both
sides can build from. */

fn client_is_close(message: &ClientMessage) -> bool {
    matches!(message, ClientMessage::Close(_))
}

fn upstream_is_close(message: &UpstreamMessage) -> bool {
    matches!(message, UpstreamMessage::Close(_))
}

/// Client -> upstream.
fn to_upstream(message: ClientMessage) -> UpstreamMessage {
    match message {
        ClientMessage::Text(text) => UpstreamMessage::Text(text.as_str().into()),
        ClientMessage::Binary(data) => UpstreamMessage::Binary(data),
        ClientMessage::Ping(data) => UpstreamMessage::Ping(data),
        ClientMessage::Pong(data) => UpstreamMessage::Pong(data),
        ClientMessage::Close(frame) => {
            UpstreamMessage::Close(frame.map(|frame| UpstreamCloseFrame {
                code: UpstreamCloseCode::from(frame.code),
                reason: frame.reason.as_str().into(),
            }))
        }
    }
}

/// Upstream -> client. `Frame` is a raw protocol frame that never carries
/// application data, so it is dropped rather than forwarded.
fn to_client(message: UpstreamMessage) -> Option<ClientMessage> {
    match message {
        UpstreamMessage::Text(text) => Some(ClientMessage::Text(text.as_str().into())),
        UpstreamMessage::Binary(data) => Some(ClientMessage::Binary(data)),
        UpstreamMessage::Ping(data) => Some(ClientMessage::Ping(data)),
        UpstreamMessage::Pong(data) => Some(ClientMessage::Pong(data)),
        UpstreamMessage::Close(frame) => {
            Some(ClientMessage::Close(frame.map(|frame| ClientCloseFrame {
                code: u16::from(frame.code),
                reason: frame.reason.as_str().into(),
            })))
        }
        UpstreamMessage::Frame(_) => None,
    }
}
