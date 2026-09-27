/* Settings, as a single source of truth.
 *
 * Same reasoning as `useModelLibrary`: the settings panel edits these and the
 * chat reads them. Two independent instances would mean a saved key did not
 * reach the conversation until a reload.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_SETTINGS,
  isConfigured,
  isVoiceConfigured,
  loadSettings,
  normaliseBaseUrl,
  saveSettings,
  type Settings,
} from './settings';

export interface SettingsStore {
  settings: Settings;
  /** False until the first read completes. */
  ready: boolean;
  /** Whether chat can work at all. */
  llmReady: boolean;
  /** Whether voice is on *and* pointed somewhere. */
  voiceReady: boolean;
  /** Persist, normalising the base URLs on the way out. */
  save: (next: Settings) => Promise<Settings>;
  /** Replace locally without persisting — for controlled inputs. */
  edit: (next: Settings) => void;
}

export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
      setReady(true);
    });
  }, []);

  const save = useCallback(async (next: Settings) => {
    const saved = await saveSettings({
      llm: { ...next.llm, baseUrl: normaliseBaseUrl(next.llm.baseUrl) },
      tts: { ...next.tts, baseUrl: normaliseBaseUrl(next.tts.baseUrl) },
    });
    setSettings(saved);
    return saved;
  }, []);

  const edit = useCallback((next: Settings) => setSettings(next), []);

  return {
    settings,
    ready,
    llmReady: isConfigured(settings),
    voiceReady: isVoiceConfigured(settings),
    save,
    edit,
  };
}
