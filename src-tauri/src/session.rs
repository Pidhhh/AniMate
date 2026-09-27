/* The loopback session token.
 *
 * WHY THIS EXISTS
 *
 * Two attacks work against a loopback HTTP server that authenticates only by
 * origin, and both are reachable from any web page the user happens to visit
 * while AniMate is running.
 *
 * 1. **Origin-less requests.** A browser omits `Origin` on `<img>`, `<script>`
 *    and same-origin GETs. An origin check that treats "no Origin" as "our own
 *    webview" therefore also admits `<img src="http://127.0.0.1:8933/_proxy?
 *    u=http://127.0.0.1:5432/">` from `evil.com` — a localhost port scan, and
 *    a way to make requests from the user's IP.
 *
 * 2. **DNS rebinding.** `evil.com` resolves to the attacker, serves a page,
 *    then re-resolves to 127.0.0.1. The page's origin is now
 *    `http://evil.com:8933`, which is *same-origin* with the server, so it can
 *    read every response — including the served model library.
 *
 * A random token, generated per run, defeats both. It is injected into the
 * page by Tauri's initialization script, which runs before any page script and
 * is not something an HTTP client can fetch: a rebinding attacker that GETs
 * `/` receives the built `index.html` *without* the injection. So the token is
 * unreadable to them.
 *
 * This is defence in depth, not the only control. The origin check and the
 * target allowlist both stay — they reject attacks cheaply and give better
 * errors.
 */

use std::sync::Arc;

/// Header the renderer sends. A custom header rather than a query parameter,
/// so the token cannot leak through a URL — into a log, a `Referer`, or a
/// browser history entry.
pub const TOKEN_HEADER: &str = "x-animate-token";

/// 32 bytes, hex encoded. Long enough that guessing is not a consideration.
const TOKEN_BYTES: usize = 32;

pub type SessionToken = Arc<String>;

/// Generates a fresh token from the OS RNG.
///
/// Panics if the OS RNG is unavailable. That is the correct outcome: running
/// without a token would silently leave the loopback server open to both
/// attacks above, and a failure to read 32 bytes from the system is not a
/// condition worth degrading around.
pub fn generate() -> SessionToken {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("OS RNG unavailable; cannot secure the loopback server");

    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Arc::new(hex)
}

/// Constant-time comparison.
///
/// The token is high-entropy so a timing side channel is not a realistic
/// threat here, but comparing byte-by-byte without an early return costs
/// nothing and removes the question.
pub fn matches(expected: &str, presented: &str) -> bool {
    let a = expected.as_bytes();
    let b = presented.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_well_formed() {
        let a = generate();
        let b = generate();
        assert_ne!(*a, *b, "two runs must not share a token");
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn comparison_accepts_only_the_exact_token() {
        let token = generate();
        assert!(matches(&token, &token));
        assert!(!matches(&token, ""));
        assert!(!matches(&token, "00"));
        assert!(!matches(&token, &token[..token.len() - 1]));
        /* A prefix must not pass. */
        assert!(!matches(&token, &token[..16]));
    }
}
