/* The five native calls the renderer is allowed to make.
 *
 * Deliberately small. Electron's preload exposed exactly this surface, and
 * keeping it identical means the ported call sites need no changes. Adding to
 * it should require a reason.
 */

use std::io::Write;
use std::path::PathBuf;

use chrono::Local;
use tauri::{AppHandle, Manager, WebviewWindow};

/// Longest log line accepted, matching the Electron shell's truncation.
const LOG_LINE_MAX: usize = 500;

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

#[tauri::command]
pub fn shell_minimize(app: AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.minimize();
    }
}

#[tauri::command]
pub fn shell_close(app: AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.close();
    }
}

/// Sets always-on-top and reports the state the window manager actually
/// settled on. Callers toggle against this return value, so returning the
/// *requested* value instead would desync the pin button.
#[tauri::command]
pub fn shell_set_topmost(app: AppHandle, on: bool) -> bool {
    match main_window(&app) {
        Some(win) => {
            let _ = win.set_always_on_top(on);
            win.is_always_on_top().unwrap_or(false)
        }
        None => false,
    }
}

#[tauri::command]
pub fn shell_is_topmost(app: AppHandle) -> bool {
    main_window(&app)
        .and_then(|win| win.is_always_on_top().ok())
        .unwrap_or(false)
}

/// Toggles fullscreen and reports the state the window manager settled on.
///
/// Like `shell_set_topmost`, the return value is the *applied* state rather
/// than the requested one — the UI toggles against it, and a window manager
/// that refuses the change would otherwise desync the button.
#[tauri::command]
pub fn shell_toggle_fullscreen(app: AppHandle) -> bool {
    let Some(win) = main_window(&app) else {
        return false;
    };
    let next = !win.is_fullscreen().unwrap_or(false);
    let _ = win.set_fullscreen(next);
    win.is_fullscreen().unwrap_or(next)
}

#[tauri::command]
pub fn shell_set_fullscreen(app: AppHandle, on: bool) -> bool {
    let Some(win) = main_window(&app) else {
        return false;
    };
    let _ = win.set_fullscreen(on);
    win.is_fullscreen().unwrap_or(on)
}

#[tauri::command]
pub fn shell_is_fullscreen(app: AppHandle) -> bool {
    main_window(&app)
        .and_then(|win| win.is_fullscreen().ok())
        .unwrap_or(false)
}

/// Geometry of the main window right now, for callers that need it without
/// waiting for a resize event.
#[tauri::command]
pub fn shell_window_geometry(app: AppHandle) -> Option<crate::window_state::WindowGeometry> {
    let win = main_window(&app)?;
    crate::window_state::capture(&app, &win)
}

#[tauri::command]
pub fn shell_append_log(app: AppHandle, line: String) {
    append_log(&app, &line);
}

/* ---- Disk log ----------------------------------------------------------- */

/// `…/logs/app-YYYYMMDD.log` under the app's log directory, so support can
/// read it straight off disk without the user pasting anything.
pub fn log_file(app: &AppHandle) -> PathBuf {
    let dir = crate::paths::app_log_dir(app)
        .unwrap_or_else(|_| std::env::temp_dir().join("animate-logs"));
    let day = Local::now().format("%Y%m%d");
    dir.join(format!("app-{day}.log"))
}

/// Fire-and-forget. Logging must never be able to break a turn, so every
/// failure path here is swallowed.
///
/// Newlines are stripped. The renderer supplies these lines, and so do model
/// filenames — neither is trusted to be single-line. Without this, a value
/// containing `\n` forges what look like genuine log entries, which matters
/// because this file is the thing support reads to work out what happened.
pub fn append_log(app: &AppHandle, line: &str) {
    let path = log_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let clipped: String = line
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .take(LOG_LINE_MAX)
        .collect();
    let row = format!("{} {}\n", Local::now().format("%H:%M:%S"), clipped);

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(row.as_bytes());
    }
}
