import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lenientJson, streamChat, viaProxy } from './llm';
import type { LlmSettings } from '../library/settings';

/* `llm.ts` holds the trickiest untested logic in the chat layer: reassembling
   SSE frames that arrive split across chunk boundaries, and recovering a reply
   from an endpoint that ignores `stream`. Both are testable with a fake fetch,
   so they are tested here rather than left to be discovered against a real
   provider. */

const SETTINGS: LlmSettings = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
};

/** A Response whose body emits the given chunks verbatim, with no regard for
 *  frame boundaries — exactly what a real socket does. */
function streamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
}

function sse(...contents: string[]): string {
  return contents
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
    .join('');
}

beforeEach(() => {
  /* `viaProxy` reads location.origin to decide whether to route locally. */
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:8933' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('viaProxy', () => {
  it('routes through the proxy when served from loopback', () => {
    expect(viaProxy('https://api.example.test/v1/chat/completions')).toBe(
      '/_proxy?u=' + encodeURIComponent('https://api.example.test/v1/chat/completions'),
    );
  });

  it('leaves the target alone off loopback', () => {
    vi.stubGlobal('window', { location: { origin: 'https://some.site' } });
    const url = 'https://api.example.test/v1/chat/completions';
    expect(viaProxy(url)).toBe(url);
  });
});

describe('lenientJson', () => {
  it('parses clean JSON', () => {
    expect(lenientJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a BOM', () => {
    expect(lenientJson('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers the last payload from an SSE stream', () => {
    const body = sse('Hel', 'lo');
    expect(lenientJson(body)).toEqual({ choices: [{ delta: { content: 'lo' } }] });
  });

  it('recovers an object with trailing bytes', () => {
    expect(lenientJson('{"a":1}garbage')).toEqual({ a: 1 });
  });

  it('returns null when there is nothing usable', () => {
    expect(lenientJson('not json at all')).toBeNull();
  });
});

describe('streamChat — streaming', () => {
  it('reassembles frames split across chunk boundaries', async () => {
    /* The important case. A token straddling two reads must not be dropped or
       duplicated, and this is where a naive implementation breaks. */
    const full = sse('Hello ', 'there', '!');
    const cut = Math.floor(full.length / 2);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([full.slice(0, cut), full.slice(cut)])),
    );

    const deltas: string[] = [];
    const result = await streamChat({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });

    expect(result).toBe('Hello there!');
    expect(deltas.join('')).toBe('Hello there!');
  });

  it('sends the key, model and stream flag, through the proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([sse('ok')]));
    vi.stubGlobal('fetch', fetchMock);

    await streamChat({ settings: SETTINGS, messages: [{ role: 'user', content: 'hi' }] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('/_proxy?u=')).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

    const body = JSON.parse(String(init.body)) as { model: string; stream: boolean };
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
  });

  it('omits Authorization when no key is set', async () => {
    /* Local routers commonly need none, and an empty bearer token makes some
       of them reject the request outright. */
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([sse('ok')]));
    vi.stubGlobal('fetch', fetchMock);

    await streamChat({
      settings: { ...SETTINGS, apiKey: '' },
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('handles a final frame with no trailing newline', async () => {
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([frame])));

    const result = await streamChat({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toBe('tail');
  });

  it('ignores keep-alive and malformed frames', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([': keep-alive\n\n', 'data: {not json}\n\n', sse('fine')]),
      ),
    );

    const result = await streamChat({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toBe('fine');
  });
});

describe('streamChat — non-streaming endpoints', () => {
  it('reads a plain JSON body when the endpoint ignores `stream`', async () => {
    /* Not every gateway honours the flag; failing the turn over it would be
       wrong when the reply is right there. */
    const payload = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'One clean object.' } }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );

    const deltas: string[] = [];
    const result = await streamChat({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });

    expect(result).toBe('One clean object.');
    expect(deltas).toEqual(['One clean object.']);
  });

  it('reads an SSE body that carries no frames', async () => {
    /* Content-type says event-stream but the body is one JSON object. */
    const payload = JSON.stringify({ choices: [{ message: { content: 'sneaky' } }] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([payload], 'text/event-stream')),
    );

    const result = await streamChat({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toBe('sneaky');
  });
});

describe('streamChat — failures', () => {
  it('refuses to call without an endpoint', async () => {
    await expect(
      streamChat({
        settings: { ...SETTINGS, baseUrl: '' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/endpoint/i);
  });

  it('refuses to call without a model', async () => {
    await expect(
      streamChat({
        settings: { ...SETTINGS, model: '' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/model/i);
  });

  it('surfaces the provider error message, not just the status', async () => {
    /* The real reason is always in the body — an invalid key, an unknown
       model, a quota. Returning only "401" helps nobody. */
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key provided.' } }), {
          status: 401,
        }),
      ),
    );

    await expect(
      streamChat({ settings: SETTINGS, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Invalid API key/);
  });

  it('still reports a status when the error body is unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    await expect(
      streamChat({ settings: SETTINGS, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/503/);
  });

  it('propagates an abort', async () => {
    const controller = new AbortController();
    controller.abort();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    await expect(
      streamChat({
        settings: SETTINGS,
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
