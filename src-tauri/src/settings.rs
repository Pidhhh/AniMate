/* User settings.
 *
 * Stored at `<app_data>/settings.json` — deliberately a sibling of the
 * `models/` directory, not inside it, because `models/` is served over HTTP by
 * the loopback server. Keeping the file one level up means the API key cannot
 * be fetched by the renderer, or by anything else that can reach the port.
 *
 * The key is stored in plain text. That matches the reference implementation
 * and is acceptable for a personal-use desktop app, but it is worth being
 * explicit about: anyone with read access to the user's app data can read it.
 * Moving to the OS credential store (Windows Credential Manager via the
 * `keyring` crate) is the right follow-up and is tracked in the plan.
 */

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    /// OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`.
    /// Empty means "not configured".
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

impl LlmSettings {
    pub fn is_configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettings {
    /// Voice is opt-in: text works without it, and a misconfigured voice
    /// should never be able to break a turn.
    #[serde(default)]
    pub enabled: bool,
    /// Its own endpoint, because speech is often served from a different
    /// provider than chat. Empty falls back to the LLM's.
    ///
    /// The fallback itself is resolved on the renderer side (`ttsBaseUrl` /
    /// `ttsApiKey` in `src/chat/tts.ts`), which is where the request is built.
    /// Duplicating it here would mean two places to keep in step and only one
    /// of them reachable.
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub llm: LlmSettings,
    #[serde(default)]
    pub tts: TtsSettings,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir(app).map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    save(&app, &settings)?;
    /* Never log the key itself — only whether one is present. The endpoint and
    model are logged as set/unset rather than verbatim, so a support log
    never carries someone's private endpoint. */
    crate::commands::append_log(
        &app,
        &format!(
            "settings saved: llm configured={} base={} model={} key={}",
            settings.llm.is_configured(),
            if settings.llm.base_url.trim().is_empty() {
                "-"
            } else {
                "set"
            },
            if settings.llm.model.trim().is_empty() {
                "-"
            } else {
                "set"
            },
            if settings.llm.api_key.trim().is_empty() {
                "absent"
            } else {
                "present"
            }
        ),
    );
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_is_detected() {
        assert!(!LlmSettings::default().is_configured());
        assert!(!LlmSettings {
            base_url: "https://x/v1".into(),
            ..Default::default()
        }
        .is_configured());
        assert!(LlmSettings {
            base_url: "https://x/v1".into(),
            model: "m".into(),
            api_key: String::new(),
        }
        .is_configured());
    }

    #[test]
    fn round_trips_through_json() {
        let s = Settings {
            llm: LlmSettings {
                base_url: "https://example.test/v1".into(),
                api_key: "secret".into(),
                model: "some-model".into(),
            },
            tts: TtsSettings::default(),
        };
        let text = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.llm.model, "some-model");
        assert_eq!(back.llm.api_key, "secret");
    }

    #[test]
    fn tts_is_off_by_default() {
        assert!(!TtsSettings::default().enabled);
    }

    #[test]
    fn an_older_settings_file_still_loads() {
        /* A file written before voice existed has no `tts` block. It must load
        rather than fail, or upgrading would silently wipe the LLM config. */
        let back: Settings =
            serde_json::from_str(r#"{"llm":{"baseUrl":"https://x/v1","apiKey":"k","model":"m"}}"#)
                .unwrap();
        assert_eq!(back.llm.model, "m");
        assert!(!back.tts.enabled);
    }

    #[test]
    fn missing_fields_default_rather_than_fail() {
        let back: Settings = serde_json::from_str("{}").unwrap();
        assert!(back.llm.base_url.is_empty());
    }
}
