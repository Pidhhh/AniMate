import { useCallback, useState } from 'react';
import { kindLabel, type ModelEntry } from '../library/models';
import type { ModelLibrary } from '../library/useModelLibrary';
import type { SettingsStore } from '../library/useSettings';
import { LOADABLE_KINDS } from '../character/types';

type Tab = 'llm' | 'voice' | 'models';

/** Settings, in three sections.
 *
 *  Both the library and the settings store are passed in rather than created
 *  here. The stage and the chat need the same values, and independent hook
 *  instances would each hold their own copy — a key saved here would not reach
 *  the conversation until a reload. */
export function SettingsPanel({
  onClose,
  library,
  settings,
  initialTab = 'llm',
}: {
  onClose: () => void;
  library: ModelLibrary;
  settings: SettingsStore;
  /** Opening straight to Models is what the empty stage wants — the user has
   *  already expressed intent by clicking "Import a model". */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-stage">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-edge-soft px-3">
        <span className="text-[11px] font-medium text-ink">Settings</span>
        <nav className="flex gap-1">
          <TabButton active={tab === 'llm'} onClick={() => setTab('llm')}>
            LLM
          </TabButton>
          <TabButton active={tab === 'voice'} onClick={() => setTab('voice')}>
            Voice
          </TabButton>
          <TabButton active={tab === 'models'} onClick={() => setTab('models')}>
            Models
          </TabButton>
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-[10px] text-ink-faint hover:bg-edge hover:text-ink"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'llm' && <LlmSection store={settings} />}
        {tab === 'voice' && <VoiceSection store={settings} />}
        {tab === 'models' && <ModelsSection library={library} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded px-2 py-1 text-[10px] transition-colors',
        active ? 'bg-accent-soft text-ink' : 'text-ink-faint hover:bg-edge hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- LLM */

function LlmSection({ store }: { store: SettingsStore }) {
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const llm = store.settings.llm;
  const set = (patch: Partial<typeof llm>) =>
    store.edit({ ...store.settings, llm: { ...llm, ...patch } });

  const save = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await store.save(store.settings);
      setNotice({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setNotice({ kind: 'err', text: message(err) });
    } finally {
      setBusy(false);
    }
  }, [store]);

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-ink-faint">
        AniMate ships with no endpoint and no key. Point it at any
        OpenAI-compatible API — a hosted provider or a local router. Stored on this
        machine only.
      </p>

      <Field label="Base URL" hint="e.g. https://api.openai.com/v1">
        <TextInput
          value={llm.baseUrl}
          onChange={(v) => set({ baseUrl: v })}
          placeholder="https://…/v1"
        />
      </Field>

      <Field label="API key" hint="leave empty for a local router that needs none">
        <div className="flex gap-2">
          <TextInput
            value={llm.apiKey}
            onChange={(v) => set({ apiKey: v })}
            placeholder="sk-…"
            secret={!reveal}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="shrink-0 rounded-lg border border-edge px-2 py-1 text-[10px] text-ink-dim hover:text-ink"
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>

      <Field label="Model" hint="the model name the endpoint expects">
        <TextInput
          value={llm.model}
          onChange={(v) => set({ model: v })}
          placeholder="gpt-4o-mini"
        />
      </Field>

      <SaveRow busy={busy} onSave={save} note="Keys are stored in plain text in your app data folder." />
      {notice && <NoticeBox notice={notice} />}
    </div>
  );
}

/* ----------------------------------------------------------------- voice */

function VoiceSection({ store }: { store: SettingsStore }) {
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const tts = store.settings.tts;
  const set = (patch: Partial<typeof tts>) =>
    store.edit({ ...store.settings, tts: { ...tts, ...patch } });

  const save = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      await store.save(store.settings);
      setNotice({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setNotice({ kind: 'err', text: message(err) });
    } finally {
      setBusy(false);
    }
  }, [store]);

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={tts.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          className="mt-0.5 accent-[var(--color-accent-soft)]"
        />
        <span className="text-[11px] leading-relaxed text-ink">
          Speak replies aloud
          <span className="block text-ink-faint">
            Off by default. Text always works without this.
          </span>
        </span>
      </label>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        An OpenAI-compatible <code className="font-mono">/audio/speech</code>{' '}
        endpoint. Leave the URL and key empty to reuse the LLM's.
      </p>

      <Field label="Voice endpoint" hint="optional — falls back to the LLM's">
        <TextInput
          value={tts.baseUrl}
          onChange={(v) => set({ baseUrl: v })}
          placeholder="same as LLM"
        />
      </Field>

      <Field label="Voice API key" hint="optional — falls back to the LLM's">
        <div className="flex gap-2">
          <TextInput
            value={tts.apiKey}
            onChange={(v) => set({ apiKey: v })}
            placeholder="same as LLM"
            secret={!reveal}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="shrink-0 rounded-lg border border-edge px-2 py-1 text-[10px] text-ink-dim hover:text-ink"
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>

      <Field label="Speech model" hint="e.g. tts-1">
        <TextInput value={tts.model} onChange={(v) => set({ model: v })} placeholder="tts-1" />
      </Field>

      <Field label="Voice" hint="e.g. alloy, nova, shimmer">
        <TextInput value={tts.voice} onChange={(v) => set({ voice: v })} placeholder="alloy" />
      </Field>

      <SaveRow
        busy={busy}
        onSave={save}
        note={
          store.voiceReady
            ? 'Voice is ready.'
            : 'Voice stays off until an endpoint and a model are set.'
        }
      />
      {notice && <NoticeBox notice={notice} />}
    </div>
  );
}

/* ------------------------------------------------------------------ models */

function ModelsSection({ library }: { library: ModelLibrary }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const doImport = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const entry = await library.importFromPicker();
      if (entry) {
        setNotice({ kind: 'ok', text: `Imported ${entry.name} (${kindLabel(entry.kind)}).` });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: message(err) });
    } finally {
      setBusy(false);
    }
  }, [library]);

  const activate = useCallback(
    async (entry: ModelEntry) => {
      setBusy(true);
      try {
        await library.activate(entry.id);
      } catch (err) {
        setNotice({ kind: 'err', text: message(err) });
      } finally {
        setBusy(false);
      }
    },
    [library],
  );

  const remove = useCallback(
    async (entry: ModelEntry) => {
      setBusy(true);
      try {
        await library.remove(entry);
        setNotice({ kind: 'ok', text: `Removed ${entry.name}.` });
      } catch (err) {
        setNotice({ kind: 'err', text: message(err) });
      } finally {
        setBusy(false);
      }
    },
    [library],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-[11px] leading-relaxed text-ink-faint">
          Import your own character. Nothing is bundled — the stage stays empty
          until you add one.
        </p>
        <button
          type="button"
          onClick={() => void doImport()}
          disabled={busy}
          className="shrink-0 rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-ink hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Working…' : 'Import'}
        </button>
      </div>

      {library.registry.models.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge p-4 text-center">
          <p className="text-[11px] text-ink-dim">No models imported yet.</p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            A Spine model needs three files together — <code>.skel</code>,{' '}
            <code>.atlas</code> and the texture <code>.png</code>. Select all three
            at once.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {library.registry.models.map((m) => {
            const isActive = m.id === library.registry.active;
            const loadable = LOADABLE_KINDS.includes(m.kind);
            return (
              <li
                key={m.id}
                className={[
                  'rounded-lg border p-2',
                  isActive ? 'border-accent-soft bg-panel' : 'border-edge-soft bg-stage-soft',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void activate(m)}
                    disabled={busy || isActive || !loadable}
                    title={loadable ? 'Make active' : 'This format has no loader yet'}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <div className="truncate text-[11px] font-medium text-ink">{m.name}</div>
                    <div className="mt-0.5 text-[10px] text-ink-faint">
                      {kindLabel(m.kind)}
                      {isActive && <span className="ml-1 text-accent">· active</span>}
                      {!loadable && <span className="ml-1">· no loader yet</span>}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(m)}
                    disabled={busy}
                    className="shrink-0 rounded px-2 py-1 text-[10px] text-ink-faint hover:bg-err/20 hover:text-err disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notice && <NoticeBox notice={notice} />}
    </div>
  );
}

/* ------------------------------------------------------------------- bits */

interface Notice {
  kind: 'ok' | 'err';
  text: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[10px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={secret ? 'password' : 'text'}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-2.5 py-1.5 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-accent-soft focus:outline-none"
    />
  );
}

function SaveRow({
  busy,
  onSave,
  note,
}: {
  busy: boolean;
  onSave: () => void;
  note: string;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-ink hover:opacity-90 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <span className="text-[10px] text-ink-faint">{note}</span>
    </div>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  return (
    <p
      className={[
        'rounded-lg border border-edge-soft px-2.5 py-1.5 text-[11px]',
        notice.kind === 'ok' ? 'text-ok' : 'text-err',
      ].join(' ')}
    >
      {notice.text}
    </p>
  );
}
