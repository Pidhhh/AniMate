/* Window geometry that survives a restart.
 *
 * A frameless window that forgets its size and position every launch does not
 * feel like a desktop app. This persists them next to the other app data.
 *
 * Implemented directly rather than through `tauri-plugin-window-state`, which
 * pulls in a `kuchikiki` version that conflicts with the one `wry` pins. The
 * logic is small enough that owning it is cheaper than resolving that, and it
 * gives us the off-screen guard below, which the plugin does not provide.
 */

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Matches the size the window is created with, used when nothing is saved.
pub const DEFAULT_WIDTH: f64 = 480.0;
pub const DEFAULT_HEIGHT: f64 = 854.0;

/// Below this the layout starts to break, so it is a hard floor rather than a
/// preference — the same value `build_main_window` passes to `min_inner_size`.
pub const MIN_WIDTH: f64 = 360.0;
pub const MIN_HEIGHT: f64 = 420.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH as u32,
            height: DEFAULT_HEIGHT as u32,
            x: None,
            y: None,
            maximized: false,
            fullscreen: false,
        }
    }
}

fn path_for(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::app_data_dir(app)
        .ok()
        .map(|dir| dir.join("window.json"))
}

pub fn load(app: &AppHandle) -> Option<WindowGeometry> {
    let path = path_for(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(app: &AppHandle, geometry: &WindowGeometry) {
    let Some(path) = path_for(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(geometry) {
        /* Best-effort: failing to remember the window size is not worth
        surfacing to the user, let alone aborting a quit over. */
        let _ = std::fs::write(path, text);
    }
}

/// Reads the live geometry off a window.
///
/// When the window is maximized or fullscreen, `inner_size()` reports the
/// *maximized* size. Saving that would mean un-maximizing later lands on a
/// window the size of the screen — so in those states the previous normal
/// geometry is kept and only the flags are updated.
///
/// Captures the **inner** size, and this is load-bearing. `set_size` sets the
/// client area, so pairing it with `outer_size` compounds the window frame on
/// every launch: the outer size is saved, restored as an inner size, and the
/// next capture is one frame larger again. Measured on Windows that was +16px
/// per start, which is unbounded growth rather than a rounding wobble.
pub fn capture(app: &AppHandle, window: &WebviewWindow) -> Option<WindowGeometry> {
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let maximized = window.is_maximized().unwrap_or(false);

    if fullscreen || maximized {
        let mut geometry = load(app).unwrap_or_default();
        geometry.fullscreen = fullscreen;
        geometry.maximized = maximized;
        return Some(geometry);
    }

    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;

    Some(WindowGeometry {
        width: size.width.max(MIN_WIDTH as u32),
        height: size.height.max(MIN_HEIGHT as u32),
        x: Some(position.x),
        y: Some(position.y),
        maximized: false,
        fullscreen: false,
    })
}

/// Restores saved geometry onto a freshly created window.
///
/// `set_size` takes the client area and `set_position` takes the outer
/// top-left, matching what `capture` reads. Changing either to its counterpart
/// breaks the round trip.
pub fn apply(window: &WebviewWindow, geometry: &WindowGeometry) {
    let width = geometry.width.max(MIN_WIDTH as u32);
    let height = geometry.height.max(MIN_HEIGHT as u32);

    let _ = window.set_size(PhysicalSize::new(width, height));

    if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
        if is_reachable(window, x, y, width, height) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }

    if geometry.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if geometry.maximized {
        let _ = window.maximize();
    }
}

/// True when enough of the window would land on a monitor that the user can
/// actually grab it.
///
/// A saved position can go stale: a second monitor is unplugged, or the
/// display layout changes. Restoring blindly puts the window somewhere
/// unreachable, which is indistinguishable from the app failing to start.
///
/// Requires a quarter of the width and an eighth of the height to overlap —
/// a window with one pixel on-screen is not reachable either.
fn is_reachable(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        /* Cannot enumerate displays — assume the position is fine rather than
        silently discarding the user's layout. */
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    let need_w = ((width / 4).max(80)) as i32;
    let need_h = ((height / 8).max(40)) as i32;
    let w = width as i32;
    let h = height as i32;

    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let mw = size.width as i32;
        let mh = size.height as i32;

        let overlap_w = (x + w).min(origin.x + mw) - x.max(origin.x);
        let overlap_h = (y + h).min(origin.y + mh) - y.max(origin.y);

        overlap_w >= need_w && overlap_h >= need_h
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_usable() {
        let d = WindowGeometry::default();
        assert_eq!(d.width, DEFAULT_WIDTH as u32);
        assert_eq!(d.height, DEFAULT_HEIGHT as u32);
        assert!(!d.maximized && !d.fullscreen);
        assert!(d.x.is_none() && d.y.is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let geo = WindowGeometry {
            width: 900,
            height: 1200,
            x: Some(-1200),
            y: Some(40),
            maximized: true,
            fullscreen: false,
        };
        let text = serde_json::to_string(&geo).expect("serialize");
        let back: WindowGeometry = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(back.width, 900);
        assert_eq!(back.x, Some(-1200));
        assert!(back.maximized);
    }

    #[test]
    fn a_partial_file_still_loads() {
        /* Only the fields we write are required; the rest default. A file
        written by an older build must not fail to parse. */
        let back: WindowGeometry =
            serde_json::from_str(r#"{"width":700,"height":900}"#).expect("deserialize");
        assert_eq!(back.width, 700);
        assert!(back.x.is_none());
        assert!(!back.fullscreen);
    }
}
