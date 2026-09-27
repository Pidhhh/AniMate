/* LLM connection settings.
 *
 * Stored by the Rust side in `<app_data>/settings.json` — deliberately a
 * sibling of the served `models/` directory, so the key is never reachable
 * over the loopback port.
 *
 * The app ships with these empty. It does not seed an endpoint or a key, so a
 * fresh install cannot leak anyone's credentials and the user is told plainly
 * that they need to bring their own.
 */

import { invoke } from '../bridge/ipc';

export interface LlmSettings {
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TtsSettings {
  /** Voice is opt-in. Text works without it, and a broken voice must never be
   *  able to break a turn. */
  enabled: boolean;
  /** Its own endpoint, since speech is often served elsewhere than chat.
   *  Empty falls back to the LLM's. */
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

export interface Settings {
  llm: LlmSettings;
  tts: TtsSettings;
}

export const EMPTY_SETTINGS: Settings = {
  llm: { baseUrl: '', apiKey: '', model: '' },
  tts: { enabled: false, baseUrl: '', apiKey: '', model: '', voice: '' },
};

export async function loadSettings(): Promise<Settings> {
  try {
    const loaded = await invoke<Partial<Settings>>('settings_get');
    /* Merge over the defaults so a settings file written by an older build —
       one without a `tts` block — does not produce undefined fields. */
    return {
      llm: { ...EMPTY_SETTINGS.llm, ...(loaded?.llm ?? {}) },
      tts: { ...EMPTY_SETTINGS.tts, ...(loaded?.tts ?? {}) },
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>('settings_set', { settings });
}

/** Whether the LLM is usable. A key is optional: local routers often need
 *  none, so only the endpoint and model name are required. */
export function isConfigured(settings: Settings): boolean {
  return Boolean(settings.llm.baseUrl.trim() && settings.llm.model.trim());
}

/** Whether voice is both switched on and actually pointed somewhere. */
export function isVoiceConfigured(settings: Settings): boolean {
  if (!settings.tts.enabled) return false;
  const base = settings.tts.baseUrl.trim() || settings.llm.baseUrl.trim();
  return Boolean(base && settings.tts.model.trim());
}

/** Trailing slashes are a common paste artefact and produce `//chat/...`. */
export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
