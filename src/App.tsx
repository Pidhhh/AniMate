import { useCallback, useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { Diagnostics } from './components/Diagnostics';
import { ChatPanel } from './components/ChatPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { FullscreenHint } from './components/FullscreenHint';
import { CharacterHost } from './character/CharacterHost';
import { useModelLibrary } from './library/useModelLibrary';
import { useSettings } from './library/useSettings';
import { useChat } from './chat/useChat';
import type { EmotionName } from './chat/protocol';
import { reportDiag } from './bridge/shell';
import { useWindowChrome } from './bridge/useWindowChrome';
import type { CharacterRenderer } from './character/types';

/* The shell.
 *
 * Layout, and the height chain matters:
 *
 *   root      h-full flex-col overflow-hidden
 *   TitleBar  shrink-0
 *   stage     flex-1 min-h-0        <- takes what is left
 *   chat      shrink-0, fixed height
 *
 * The chat area is deliberately a fixed height with its own internal scroll.
 * The stage is what absorbs window resizing, so the composer never moves.
 *
 * All three stores — models, settings, conversation — are created once, here,
 * and passed down. Creating any of them inside a child would give that child a
 * private copy, and a change made in one place would not reach the other.
 */
export default function App() {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'llm' | 'voice' | 'models' | null>(null);
  const rendererRef = useRef<CharacterRenderer | null>(null);

  const library = useModelLibrary();
  const settings = useSettings();

  /* Fullscreen, plus the shortcuts for it. Ctrl+, opens settings. */
  const chrome = useWindowChrome(() => setSettingsTab('llm'));

  /* The reply drives the character. Both handlers go through the ref so a
     streaming reply never depends on a re-render to reach the renderer. */
  const handleEmotion = useCallback((emotion: EmotionName) => {
    rendererRef.current?.setEmotion({ emotion, intensity: 1 });
  }, []);

  const handleSpeaking = useCallback((speaking: boolean) => {
    rendererRef.current?.setSpeaking(speaking);
  }, []);

  const chat = useChat({
    settings: settings.settings,
    onEmotion: handleEmotion,
    onSpeaking: handleSpeaking,
  });

  const handleReady = useCallback((renderer: CharacterRenderer | null) => {
    rendererRef.current = renderer;

    /* Reported over HTTP rather than IPC: a backend that fails to construct
       cannot use the shell bridge to say so, and this is the only channel
       that survives that. */
    if (!renderer) {
      reportDiag('character: nothing mounted (no model, or no loader for it)');
      return;
    }

    reportDiag(
      `character ready: kind=${renderer.kind} state=${renderer.state} ` +
        `caps=${Object.keys(renderer.capabilities).join(',')}`,
    );

    /* "ready" only means the assets decoded. Report again once the render
       loop has had time to tick, so a pipeline that loads but never draws is
       distinguishable from one that works. */
    window.setTimeout(() => {
      const withStats = renderer as { stats?: Record<string, unknown> };
      const stats = withStats.stats;
      if (!stats) return;

      /* Reported generically rather than by named field.
       *
       * Each backend exposes different counters — the Spine one has idle
       * clip, pose type and rim pass, the MMD one has morph count and bone
       * count. Naming them here meant an MMD model reported six `undefined`
       * values under a "spine stats" label, which is worse than useless: it
       * looks like the backend failed when it had loaded fine. */
      const detail = Object.entries(stats)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
      reportDiag(`${renderer.kind} stats: ${detail}`);
    }, 4000);
  }, []);

  /* Import straight from the empty stage. Opening on the Models tab is the
     point — the user has already said what they want by clicking. */
  const importFromStage = useCallback(() => setSettingsTab('models'), []);

  /* Smoke test: `?selftest=chat` sends one canned turn shortly after boot.
   *
   * Exists so the whole chain — proxy, streaming, tag parsing, character
   * reaction, speech — can be exercised end to end without a human at the
   * keyboard. The harness points the window at
   * `http://127.0.0.1:8933/?selftest=chat` and reads the result from the log.
   * Fires once; the guard is a ref rather than state so a re-render cannot
   * send a second message. */
  const smokeFired = useRef(false);
  useEffect(() => {
    if (smokeFired.current) return;
    if (!settings.ready) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('selftest') !== 'chat') return;

    smokeFired.current = true;
    const timer = window.setTimeout(() => {
      reportDiag('smoke test: sending one canned turn');
      chat.send('Hello there.');
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [settings.ready, chat]);

  /* The outcome of that turn, reported so the harness can assert on it. */
  useEffect(() => {
    if (!smokeFired.current || !chat.messages.length) return;
    const last = chat.messages[chat.messages.length - 1];
    if (last?.streaming) return;
    reportDiag(
      `smoke result: busy=${chat.busy} error=${chat.error ?? '-'} ` +
        `emotion=${last?.emotion ?? '-'} failed=${Boolean(last?.failed)} ` +
        `text=${JSON.stringify((last?.text ?? '').slice(0, 80))}`,
    );
  }, [chat.messages, chat.busy, chat.error]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-stage">
      {/* Hidden in fullscreen: window chrome has no meaning there, and the
          stage is the thing worth the space. */}
      {!chrome.fullscreen && (
        <TitleBar
          onOpenSettings={() => setSettingsTab('llm')}
          onToggleFullscreen={chrome.toggle}
        />
      )}

      {chrome.fullscreen && <FullscreenHint onExit={() => chrome.set(false)} />}

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <CharacterHost
            source={library.source}
            onReady={handleReady}
            onRequestImport={importFromStage}
          />

          {!showDiagnostics && (
            <button
              type="button"
              onClick={() => setShowDiagnostics(true)}
              className="absolute right-2 top-2 rounded bg-panel/80 px-2 py-1 text-[10px] text-ink-dim hover:text-ink"
            >
              Diagnostics
            </button>
          )}
        </main>

        {showDiagnostics && (
          <div className="w-[19rem] shrink-0">
            <Diagnostics onClose={() => setShowDiagnostics(false)} />
          </div>
        )}
      </div>

      <div className="h-[15rem] shrink-0">
        <ChatPanel
          messages={chat.messages}
          busy={chat.busy}
          llmReady={settings.llmReady}
          onSend={chat.send}
          onStop={chat.stop}
          onOpenSettings={() => setSettingsTab('llm')}
        />
      </div>

      {settingsTab && (
        <SettingsPanel
          onClose={() => setSettingsTab(null)}
          library={library}
          settings={settings}
          initialTab={settingsTab}
        />
      )}
    </div>
  );
}
