/* The conversation.
 *
 * One turn is: stream the reply, parse the machine tag off it, show the spoken
 * line, drive the character's expression, and — if voice is configured —
 * synthesise and play it.
 *
 * The ordering is deliberate. Text appears as it streams, so the reply is
 * readable immediately; emotion is applied as soon as the tag is known (the
 * tag arrives in the first few tokens); speech starts once the line is
 * complete, because synthesising a half-finished sentence produces the wrong
 * audio.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SYSTEM_PROMPT, streamChat, type ChatTurn } from './llm';
import { parseReply, resolveEmotion, type EmotionName } from './protocol';
import { play, synthesize } from './tts';
import type { Settings } from '../library/settings';

export interface ChatMessage {
  id: string;
  text: string;
  from: 'user' | 'companion';
  at: number;
  /** Set while the reply is still streaming in. */
  streaming?: boolean;
  emotion?: EmotionName | null;
  /** Set when the turn failed, so the bubble can be styled as an error. */
  failed?: boolean;
}

export interface UseChatOptions {
  settings: Settings;
  /** Called when the reply's emotion is known. */
  onEmotion?: (emotion: EmotionName) => void;
  /** Called as speech starts and stops, to drive the talking animation. */
  onSpeaking?: (speaking: boolean) => void;
}

export interface ChatStore {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  send: (text: string) => void;
  /** Cancel the in-flight turn and stop any speech. */
  stop: () => void;
  clear: () => void;
}

export function useChat({ settings, onEmotion, onSpeaking }: UseChatOptions): ChatStore {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const speechRef = useRef<{ stop: () => void } | null>(null);

  /* Keep the latest callbacks without making `send` depend on them, so the
     callback identity never forces a re-render mid-turn. */
  const handlers = useRef({ onEmotion, onSpeaking });
  handlers.current = { onEmotion, onSpeaking };

  /* Any pending turn and speech must be torn down if the app unmounts, or the
     character is left stuck in the talking state. */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      speechRef.current?.stop();
      handlers.current.onSpeaking?.(false);
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    speechRef.current?.stop();
    speechRef.current = null;
    handlers.current.onSpeaking?.(false);
    setBusy(false);
  }, []);

  const clear = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
  }, [stop]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      /* A new turn supersedes the old one — both the request and any audio
         still playing from the previous reply. */
      abortRef.current?.abort();
      speechRef.current?.stop();
      speechRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;

      const now = Date.now();
      const userId = `u-${now}`;
      const replyId = `c-${now}`;

      setError(null);
      setBusy(true);

      /* Snapshot the history *before* adding this turn, so the request carries
         the conversation up to but not including the new message — which is
         appended below. */
      const history = messages;

      setMessages((prev) => [
        ...prev,
        { id: userId, text, from: 'user', at: now },
        { id: replyId, text: '', from: 'companion', at: now + 1, streaming: true },
      ]);

      const turns: ChatTurn[] = [
        { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
        ...history.map((m) => ({
          role: (m.from === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.text,
        })),
        { role: 'user', content: text },
      ];

      /* Deltas arrive far faster than the display needs. Accumulate and flush
         once per frame so a long reply does not cost one render per token. */
      let pending = '';
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (!pending) return;
        const chunk = pending;
        pending = '';
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, text: m.text + chunk } : m)),
        );
      };
      const queue = (chunk: string) => {
        pending += chunk;
        if (!frame) frame = window.requestAnimationFrame(flush);
      };

      void (async () => {
        try {
          const rawReply = await streamChat({
            settings: settings.llm,
            messages: turns,
            onDelta: queue,
            signal: controller.signal,
          });

          /* Flush anything still buffered before parsing. */
          if (frame) window.cancelAnimationFrame(frame);
          frame = 0;
          const streamed = pending;
          pending = '';

          const parsed = parseReply(
            streamed ? streamed : rawReply,
          );
          const emotion = resolveEmotion(parsed);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId
                ? { ...m, text: parsed.text || '…', streaming: false, emotion }
                : m,
            ),
          );

          if (emotion) handlers.current.onEmotion?.(emotion);

          /* Speech is best-effort and never blocks the turn. */
          if (parsed.text) {
            const clip = await synthesize(parsed.text, settings.tts, settings.llm, controller.signal);
            if (clip && !controller.signal.aborted) {
              const playback = play(clip, {
                onStart: () => handlers.current.onSpeaking?.(true),
                onEnd: () => handlers.current.onSpeaking?.(false),
              });
              speechRef.current = playback;
              await playback.done;
              speechRef.current = null;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;

          if (frame) window.cancelAnimationFrame(frame);
          frame = 0;

          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId
                ? { ...m, text: message, streaming: false, failed: true }
                : m,
            ),
          );
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    },
    [messages, settings],
  );

  return { messages, busy, error, send, stop, clear };
}
