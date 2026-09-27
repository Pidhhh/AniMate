import { useCallback, useEffect, useRef } from 'react';
import { reportDiag } from '../bridge/shell';
import type { ChatMessage } from '../chat/useChat';

/* Layout contract, and it is load-bearing:
 *
 *   section   h-full min-h-0 flex-col   <- fills the height its parent gives it
 *   list      flex-1 min-h-0 overflow-y-auto
 *   composer  shrink-0
 *
 * The section previously had no `h-full`, so it sized to its content instead.
 * Past a few messages it grew taller than the parent, and the composer — being
 * last in the column — was pushed below the visible area and clipped. The
 * message list is the thing that should move; the composer stays put.
 *
 * The transcript is owned by `useChat`, not by this component, so the
 * conversation survives the panel being closed and reopened.
 */
export function ChatPanel({
  messages,
  busy,
  llmReady,
  onSend,
  onStop,
  onOpenSettings,
}: {
  messages: ChatMessage[];
  busy: boolean;
  /** False when no endpoint is configured — the composer says so rather than
   *  letting a turn fail. */
  llmReady: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pinnedToBottom = useRef(true);

  /* One-shot layout assertion.
   *
   * The bug this guards against — the composer being pushed out of the panel
   * once the transcript grew — was invisible to every other check, because
   * nothing errored and nothing logged. If the section ever stops being
   * height-constrained again, this says so instead of leaving it to be
   * noticed by eye. */
  useEffect(() => {
    const section = sectionRef.current;
    const composer = composerRef.current;
    if (!section || !composer) return;
    const s = section.getBoundingClientRect();
    const c = composer.getBoundingClientRect();
    reportDiag(
      `chat layout: panel=${Math.round(s.height)} composerBottom=${Math.round(c.bottom)} ` +
        `panelBottom=${Math.round(s.bottom)} viewport=${window.innerHeight} ` +
        `contained=${c.bottom <= s.bottom + 1}`,
    );
  }, []);

  /* Follow new messages only when the reader is already at the bottom.
     Yanking someone back down while they are scrolling back through the
     transcript is worse than missing the newest line. */
  useEffect(() => {
    const el = listRef.current;
    if (!el || !pinnedToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    /* 24px of slack absorbs sub-pixel rounding and the last line's leading. */
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const submit = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const text = input.value.trim();
    if (!text || busy) return;
    pinnedToBottom.current = true;
    input.value = '';
    onSend(text);
  }, [busy, onSend]);

  return (
    <section
      ref={sectionRef}
      className="flex h-full min-h-0 flex-col border-t border-edge-soft bg-stage-soft"
    >
      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
      >
        {messages.length === 0 ? (
          <p className="text-[11px] text-ink-faint">
            {llmReady
              ? 'Nothing said yet.'
              : 'No endpoint configured — open Settings to add one.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={m.from === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <span
                  className={[
                    'max-w-[85%] break-words rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed',
                    m.from === 'user'
                      ? 'bg-accent-soft text-ink'
                      : m.failed
                        ? 'bg-err/15 text-err'
                        : 'bg-panel text-ink-dim',
                  ].join(' ')}
                >
                  {m.text || (m.streaming ? '…' : '')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div ref={composerRef} className="flex shrink-0 items-center gap-2 border-t border-edge-soft p-2">
        {/* Uncontrolled on purpose. A controlled input would re-render the
            whole panel — transcript included — on every keystroke, while a
            reply is simultaneously streaming in at frame rate. The value is
            read once, on submit. */}
        <input
          ref={inputRef}
          defaultValue=""
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={llmReady ? 'Ask your companion' : 'Configure an endpoint first'}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent-soft focus:outline-none"
        />

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-[11px] font-medium text-ink-dim hover:text-ink"
          >
            Stop
          </button>
        ) : llmReady ? (
          <button
            type="button"
            onClick={submit}
            className="shrink-0 rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            Send
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            Settings
          </button>
        )}
      </div>
    </section>
  );
}
