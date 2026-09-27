/* App-owned paths.
 *
 * Windows known folders are resolved by the OS, not by the APPDATA and
 * LOCALAPPDATA environment variables. The Windows smoke harnesses need a
 * separate profile so they cannot overwrite a user's settings or geometry.
 * This override exists only in debug builds; release builds always use
 * Tauri's normal app directories.
 */

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

#[cfg(debug_assertions)]
fn test_profile() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("ANIMATE_TEST_PROFILE")?);
    assert!(root.is_absolute(), "ANIMATE_TEST_PROFILE must be absolute");
    Some(root)
}

pub fn app_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(root) = test_profile() {
        return Ok(root.join("data"));
    }
    app.path().app_data_dir()
}

pub fn app_log_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(root) = test_profile() {
        return Ok(root.join("logs"));
    }
    app.path().app_log_dir()
}
