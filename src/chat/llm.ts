/* LLM transport.
 *
 * OpenAI-compatible chat completions. Two things are carried over from the
 * reference implementation because they are load-bearing:
 *
 * 1. **The proxy gate.** Calls are rewritten onto the same-origin `/_proxy`
 *    when the page is served from loopback. That is what lets a browser reach
 *    an endpoint without a CORS preflight it would otherwise fail — and it is
 *    the reason the loopback server exists at all.
 *
 * 2. **Tolerant parsing.** These endpoints are whatever the user configured,
 *    and they vary. A response that is not exactly one clean JSON object — SSE
 *    wrapped, BOM prefixed, trailing bytes, a `choices` variant — is recovered
 *    rather than treated as a failure.
 */

import type { LlmSettings } from '../library/settings';
import { sessionHeaders } from '../bridge/session';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The system prompt.
 *
 *  Asks for the emotion tag the reply parser understands, and asks for the
 *  reply to be spoken text — no stage directions, no markdown, because this
 *  line is both displayed and read aloud. */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are a warm, playful companion living in a desktop app. Keep replies',
  'conversational and fairly short — two or three sentences unless asked for more.',
  '',
  'Begin every reply with a single machine tag naming how you look, then the',
  'spoken line. For example:',
  '',
  '  [emotion:happy|attitude:agree] Oh, hello! I was hoping you would come by.',
  '',
  'emotion is one of: neutral, happy, laughing, tease, shy, cuddle, sad,',
  'crying, angry. attitude is one of: agree, deny, question.',
  '',
  'The tag is never shown to the user, and only the text after it is spoken, so',
  'write the line as natural speech: no stage directions, no markdown, no',
  'asterisks, no emoji.',
].join('\n');

/* ------------------------------------------------------------- proxy gate */

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

/**
 * Rewrite an absolute URL onto the local proxy when — and only when — the page
 * is served from loopback. Off loopback the target is returned untouched and
 * the call goes direct.
 */
export function viaProxy(target: string): string {
  const origin = String(window.location.origin || '');
  if (!LOOPBACK_ORIGIN.test(origin)) return target;
  return `/_proxy?u=${encodeURIComponent(target)}`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/* -------------------------------------------------------- tolerant parsing */

/**
 * Recover a payload from a body that may not be exactly one clean JSON object.
 *
 * Handles a BOM prefix, a leading SSE `data:` stream, and trailing bytes after
 * the object. Returns null when nothing usable is found — callers surface that
 * as a real error rather than guessing.
 */
export function lenientJson(raw: string): unknown {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  if (/(^|\n)\s*data:/.test(text)) {
    /* SSE: take the last complete data line that parses. */
    let last: unknown = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        last = JSON.parse(payload);
      } catch {
        /* keep looking */
      }
    }
    if (last !== null) return last;
  }

  /* Trailing bytes: take the outermost {...} span. */
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Pull a human-readable message out of the several error shapes in the wild. */
function describeError(status: number, body: string): string {
  const parsed = lenientJson(body) as
    | { error?: { message?: string } | string; message?: string; code?: string }
    | null;

  if (parsed) {
    const err = parsed.error;
    if (typeof err === 'string' && err) return err;
    if (err && typeof err === 'object' && err.message) return err.message;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  }

  const trimmed = body.trim().slice(0, 200);
  return trimmed
    ? `HTTP ${status}: ${trimmed}`
    : `HTTP ${status} (empty response body)`;
}

/* -------------------------------------------------------------- streaming */

export interface StreamOptions {
  settings: LlmSettings;
  messages: ChatTurn[];
  /** Called for each incremental token as it arrives. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

/** Extract the next token from one SSE line, or null if the line carries none. */
function deltaFromSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  try {
    const obj = JSON.parse(payload) as {
      choices?: { delta?: { content?: string }; text?: string }[];
    };
    const choice = obj.choices?.[0];
    return choice?.delta?.content ?? choice?.text ?? null;
  } catch {
    return null;
  }
}

/** Read a non-streaming body into its full text. */
function textFromBody(body: string): string {
  const parsed = lenientJson(body) as {
    choices?: { message?: { content?: string }; text?: string }[];
  } | null;

  const choice = parsed?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content;

  throw new Error('The endpoint returned no message content.');
}

/**
 * Send a turn and stream the reply.
 *
 * Resolves with the complete raw text (tag included — parsing is the caller's
 * job). Streaming is requested but not assumed: an endpoint that ignores
 * `stream` and answers with one JSON object still works, because a body with
 * no SSE lines is read whole.
 */
export async function streamChat(options: StreamOptions): Promise<string> {
  const { settings, messages, onDelta, signal } = options;

  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('No endpoint configured. Open Settings to add one.');
  if (!settings.model.trim()) throw new Error('No model name configured. Open Settings.');

  const target = joinUrl(baseUrl, '/chat/completions');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    /* Proves to the local proxy that this is the app's own page. */
    ...sessionHeaders(),
  };
  /* A key is optional: local routers commonly need none, and sending an empty
     bearer token makes some of them reject the request outright. */
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  const response = await fetch(viaProxy(target), {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.model.trim(),
      messages,
      stream: true,
      temperature: 0.8,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(describeError(response.status, body));
  }

  /* No body at all is legal for some endpoints under stream; fall back to
     reading it as a whole. */
  if (!response.body) {
    return textFromBody(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sawSse = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      /* Process complete lines only; a token can split across chunks. */
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        if (line.trim().startsWith('data:')) sawSse = true;
        const delta = deltaFromSseLine(line);
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      }
    }

    /* Anything left without a trailing newline. */
    const tail = deltaFromSseLine(buffer);
    if (tail) {
      full += tail;
      onDelta?.(tail);
    }
  } finally {
    reader.releaseLock();
  }

  /* The endpoint ignored `stream` and sent one JSON object. The buffer holds
     it verbatim, since no line ever matched the SSE shape. */
  if (!sawSse && !full.trim()) {
    const whole = textFromBody(buffer);
    onDelta?.(whole);
    return whole;
  }

  return full;
}
