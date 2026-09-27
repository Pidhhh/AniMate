/* AniMate — Tauri shell.
 *
 * Boot order matters: the loopback server is bound *before* the window is
 * created and pointed at it, so the page never races a socket that isn't
 * listening yet.
 */

mod commands;
mod inject;
mod models;
mod paths;
mod server;
mod session;
mod settings;
mod window_state;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const LOOPBACK_HOST: &str = "127.0.0.1";
const DEV_URL: &str = "http://127.0.0.1:5173";
const DEV_PORT: u16 = 5173;

const STAGE_BG: (u8, u8, u8, u8) = (0x12, 0x0d, 0x14, 0xff);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        /* Native file picker for the model importer. */
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_minimize,
            commands::shell_close,
            commands::shell_set_topmost,
            commands::shell_is_topmost,
            commands::shell_append_log,
            commands::shell_toggle_fullscreen,
            commands::shell_set_fullscreen,
            commands::shell_is_fullscreen,
            commands::shell_window_geometry,
            models::models_list,
            models::models_import,
            models::models_import_folder,
            models::models_delete,
            models::models_set_active,
            settings::settings_get,
            settings::settings_set,
        ])
        /* Remember the window's geometry across restarts.
         *
         * Saved on close rather than on every resize: a drag produces dozens
         * of resize events per second, and the only state worth persisting is
         * where the window ended up. */
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                return;
            }
            let app = window.app_handle().clone();
            /* The event hands us a `Window`; the geometry helpers work on
            the `WebviewWindow` so the command layer can share them.
            Same window, two handles. */
            if let Some(webview) = app.get_webview_window("main") {
                if let Some(geometry) = window_state::capture(&app, &webview) {
                    window_state::save(&app, &geometry);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let root = resolve_static_root(&handle);

            commands::append_log(
                &handle,
                &format!("--- AniMate start; static root: {} ---", root.display()),
            );

            /* One token per run, injected into the page before any page script
            and required on every privileged route. See `session.rs` for why
            origin checking alone is not enough. */
            let session_token = session::generate();

            /* Imported models are served from the app data dir, not from the
            bundled frontend, so they survive app updates and are never
            inside the installed tree. */
            let models_root = models::models_root_for(&handle).ok();
            if let Some(ref dir) = models_root {
                commands::append_log(&handle, &format!("models root: {}", dir.display()));
            }

            /* Bind synchronously so the port is live before any window loads. */
            let listener = server::bind_loopback(server::DEFAULT_PORT)?;
            let serve_root = root.clone();
            let serve_log = commands::log_file(&handle);
            let serve_token = session_token.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = server::serve(
                    listener,
                    serve_root,
                    Some(serve_log),
                    models_root,
                    serve_token,
                )
                .await
                {
                    eprintln!("[animate] loopback server stopped: {err}");
                }
            });

            build_main_window(app, &session_token)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AniMate");
}

fn build_main_window(
    app: &mut tauri::App,
    session_token: &session::SessionToken,
) -> Result<(), Box<dyn std::error::Error>> {
    /* Dev loads the Vite server so HMR works. Production loads the loopback
    server, which is what keeps `location.origin` loopback and therefore
    keeps the ported proxy gate engaged.

    ANIMATE_FRONTEND_URL overrides both. It exists so a debug build can be
    pointed at the loopback server — exercising the exact production load
    path without paying for a release build. */
    let url: tauri::Url = match std::env::var("ANIMATE_FRONTEND_URL") {
        Ok(explicit) => explicit.parse()?,
        Err(_) if cfg!(debug_assertions) => DEV_URL.parse()?,
        Err(_) => format!("http://{LOOPBACK_HOST}:{}/", server::DEFAULT_PORT).parse()?,
    };

    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("AniMate")
        .inner_size(window_state::DEFAULT_WIDTH, window_state::DEFAULT_HEIGHT)
        .min_inner_size(window_state::MIN_WIDTH, window_state::MIN_HEIGHT)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .background_color(tauri::window::Color(
            STAGE_BG.0, STAGE_BG.1, STAGE_BG.2, STAGE_BG.3,
        ))
        .initialization_script(inject::script(session_token))
        /* Navigation and load events are logged because a webview that fetches
        the document but never its subresources looks identical from the
        server side to one that loaded fine. These callbacks are the only
        place that distinction is visible. */
        .on_navigation(|url| {
            let allowed = navigation_allowed(url);
            if allowed {
                eprintln!("[animate] navigation -> {url}");
            } else {
                eprintln!("[animate] blocked navigation -> {url}");
            }
            allowed
        })
        .on_page_load(|webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            commands::append_log(
                &webview.app_handle().clone(),
                &format!("webview page load {event}: {}", payload.url()),
            );
        })
        .build()?;

    /* Restore the previous geometry, if there is any worth restoring.
     *
     * Applied after `build` rather than through the builder because the size
     * has to be validated against the monitors that exist *now* — a position
     * saved on a monitor since unplugged would otherwise put the window
     * somewhere unreachable, which looks exactly like a failed launch. */
    if let Some(saved) = window_state::load(&app.handle().clone()) {
        if let Some(native) = app.get_webview_window("main") {
            window_state::apply(&native, &saved);
            commands::append_log(
                &app.handle().clone(),
                &format!(
                    "window restored: {}x{} at ({:?}, {:?}) maximized={} fullscreen={}",
                    saved.width, saved.height, saved.x, saved.y, saved.maximized, saved.fullscreen
                ),
            );
        }
    }

    let _ = window.show();
    Ok(())
}

/// The initialization script contains the loopback session token and runs in
/// every page the webview opens. Keep that page on AniMate's own origins.
fn navigation_allowed(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    url.scheme() == "http"
        && url.host_str() == Some(LOOPBACK_HOST)
        && url.path() == "/"
        && url
            .port()
            .is_some_and(|port| port == server::DEFAULT_PORT || port == DEV_PORT)
}

#[cfg(test)]
mod navigation_tests {
    use super::navigation_allowed;

    #[test]
    fn session_token_stays_on_app_origins() {
        for url in [
            "http://127.0.0.1:8933/",
            "http://127.0.0.1:8933/?selftest=chat",
            "http://127.0.0.1:5173/",
            "about:blank",
        ] {
            assert!(navigation_allowed(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://localhost:8933/",
            "http://127.0.0.1:8123/",
            "http://127.0.0.1:8933/models/untrusted.html",
            "http://127.0.0.1.evil.example:8933/",
            "file:///C:/secret.html",
        ] {
            assert!(!navigation_allowed(&url.parse().unwrap()), "{url}");
        }
    }
}

/// Finds the directory the static server should serve from.
///
/// Bundled builds read from the resource directory. Dev builds read from the
/// project's own `dist`. Nothing found is not fatal — the server still starts
/// and reports 404s, which is far easier to diagnose than a boot failure.
fn resolve_static_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(explicit) = std::env::var("ANIMATE_STATIC_ROOT") {
        let path = PathBuf::from(explicit);
        if path.is_dir() {
            return path;
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("dist"));
    }
    candidates.push(manifest_dir.join("..").join("dist"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist"));
    }

    for candidate in candidates.iter() {
        if candidate.is_dir() {
            return candidate.clone();
        }
    }

    manifest_dir.join("..")
}
