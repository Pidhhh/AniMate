/* Speech.
 *
 * OpenAI-compatible `/audio/speech`: send text, get audio bytes back. Routed
 * through the same proxy gate as chat, for the same reason.
 *
 * Voice is strictly optional. Every failure path here resolves to null rather
 * than throwing, because a broken voice endpoint must never be able to stop a
 * reply from being displayed — the text is the conversation, the audio is a
 * bonus.
 */

import { viaProxy } from './llm';
import { sessionHeaders } from '../bridge/session';
import type { LlmSettings, TtsSettings } from '../library/settings';

/** Audio formats the endpoint may return, in preference order. */
const FORMAT = 'mp3';

export interface SpeakResult {
  url: string;
  /** Revokes the blob URL. Always call this when the clip is done. */
  release: () => void;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** The endpoint to call: the voice's own, or the LLM's. */
export function ttsBaseUrl(tts: TtsSettings, llm: LlmSettings): string {
  return (tts.baseUrl.trim() || llm.baseUrl.trim()).replace(/\/+$/, '');
}

export function ttsApiKey(tts: TtsSettings, llm: LlmSettings): string {
  return tts.apiKey.trim() || llm.apiKey.trim();
}

/** Whether a call has any chance of succeeding. */
export function canSpeak(tts: TtsSettings, llm: LlmSettings): boolean {
  if (!tts.enabled) return false;
  if (!tts.model.trim()) return false;
  return Boolean(ttsBaseUrl(tts, llm));
}

/**
 * Synthesise `text` and return a playable object URL.
 *
 * Resolves to null on any failure — unconfigured, network, a non-audio
 * response, an empty body. Callers show the text and move on.
 */
export async function synthesize(
  text: string,
  tts: TtsSettings,
  llm: LlmSettings,
  signal?: AbortSignal,
): Promise<SpeakResult | null> {
  const spoken = text.trim();
  if (!spoken) return null;
  if (!canSpeak(tts, llm)) return null;

  const base = ttsBaseUrl(tts, llm);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    /* Proves to the local proxy that this is the app's own page. */
    ...sessionHeaders(),
  };
  const key = ttsApiKey(tts, llm);
  /* A key is optional: local speech servers commonly need none, and an empty
     bearer token makes some of them reject outright. */
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const response = await fetch(viaProxy(joinUrl(base, '/audio/speech')), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: tts.model.trim(),
        input: spoken,
        voice: tts.voice.trim() || 'alloy',
        response_format: FORMAT,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn('[animate] speech failed:', response.status, body.slice(0, 200));
      return null;
    }

    const blob = await response.blob();
    if (blob.size === 0) return null;

    /* Some endpoints answer 200 with a JSON error object. A JSON body is not
       audio, and playing it would produce silence plus a confusing console
       error, so check the type rather than the status. */
    if (blob.type.includes('json')) {
      const detail = await blob.text().catch(() => '');
      console.warn('[animate] speech returned JSON instead of audio:', detail.slice(0, 200));
      return null;
    }

    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null;
    console.warn('[animate] speech error:', err);
    return null;
  }
}

/**
 * Play a synthesised clip, reporting when it starts and ends.
 *
 * `onStart` / `onEnd` drive `setSpeaking`, which is what animates the mouth.
 * They fire from the element's own events rather than around the await, so the
 * character is not left mid-speech if playback is interrupted.
 */
export function play(
  result: SpeakResult,
  handlers: { onStart?: () => void; onEnd?: () => void } = {},
): { stop: () => void; done: Promise<void> } {
  const audio = new Audio(result.url);
  audio.preload = 'auto';

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    handlers.onEnd?.();
    result.release();
  };

  const done = new Promise<void>((resolve) => {
    audio.onended = () => {
      finish();
      resolve();
    };
    audio.onerror = () => {
      finish();
      resolve();
    };
    audio
      .play()
      .then(() => handlers.onStart?.())
      .catch((err) => {
        console.warn('[animate] playback refused:', err);
        finish();
        resolve();
      });
  });

  return {
    stop: () => {
      audio.pause();
      audio.currentTime = 0;
      finish();
    },
    done,
  };
}
