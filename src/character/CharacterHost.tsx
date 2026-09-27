import { useEffect, useRef, useState } from 'react';
import type {
  CharacterKind,
  CharacterRenderer,
  CharacterState,
  EmotionProfile,
  LookTarget,
  ModelSource,
  MotionOptions,
} from './types';

/* Backend registry.
 *
 * Backends register themselves here rather than being imported directly, so
 * CharacterHost never has a static dependency on any engine. That keeps the
 * MMD bundle out of a build that only uses Spine, and vice versa.
 */
type BackendFactory = () => CharacterRenderer;

const registry = new Map<CharacterKind, BackendFactory>();

export function registerCharacterBackend(kind: CharacterKind, factory: BackendFactory): void {
  registry.set(kind, factory);
}

export function hasCharacterBackend(kind: CharacterKind): boolean {
  return registry.has(kind);
}

export function listCharacterBackends(): CharacterKind[] {
  return [...registry.keys()];
}

/** Which runtime a model format needs. Null when nothing can load it yet. */
export function backendKindFor(source: ModelSource | null): CharacterKind | null {
  if (!source) return null;
  if (source.kind === 'spine') return 'spine';
  if (source.kind === 'mmd') return 'mmd';
  return null;
}

export interface CharacterHostProps {
  /** The active model, or null when the user has imported nothing yet. */
  source: ModelSource | null;
  /** Imperative handle so callers can drive emotion/motion without re-rendering. */
  onReady?: (renderer: CharacterRenderer | null) => void;
  /** Invoked when the user asks to import from the empty stage. */
  onRequestImport?: () => void;
}

export function CharacterHost({ source, onReady, onRequestImport }: CharacterHostProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CharacterRenderer | null>(null);
  const [state, setState] = useState<CharacterState>('idle');
  const [error, setError] = useState<Error | null>(null);

  const kind = backendKindFor(source);

  useEffect(() => {
    const canvas = canvasRef.current;
    const factory = kind ? registry.get(kind) : undefined;

    /* Nothing to mount: either no model is imported, or its format has no
       loader yet. Both are normal states, not failures — the stage says so. */
    if (!canvas || !factory || !source) {
      rendererRef.current = null;
      setState('idle');
      setError(null);
      onReady?.(null);
      return;
    }

    let disposed = false;
    const renderer = factory();
    rendererRef.current = renderer;
    setState('loading');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    renderer
      .mount(canvas, { assetPath: '', source, maxDpr: 2 })
      .then(() => {
        if (disposed) return;
        setState('ready');
        setError(null);
        renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
        onReady?.(renderer);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const e = err instanceof Error ? err : new Error(String(err));
        setState('error');
        setError(e);
        onReady?.(null);
      });

    return () => {
      disposed = true;
      rendererRef.current = null;
      renderer.unmount();
    };
  }, [kind, source, onReady]);

  /* Canvas resize is debounced — a window drag fires this dozens of times a
     second and re-fitting the camera on every frame is wasted work. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
      }, 80);
    });

    observer.observe(canvas);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {state !== 'ready' && (
        <StageMessage
          source={source}
          kind={kind}
          state={state}
          error={error}
          onRequestImport={onRequestImport}
        />
      )}
    </div>
  );
}

/** What the stage shows when there is no character on it.
 *
 *  Each case gets its own wording, because "the stage is empty" has three
 *  different causes and only one of them is a mistake. */
function StageMessage({
  source,
  kind,
  state,
  error,
  onRequestImport,
}: {
  source: ModelSource | null;
  kind: CharacterKind | null;
  state: CharacterState;
  error: Error | null;
  onRequestImport?: () => void;
}) {
  if (state === 'error') {
    return (
      <Panel>
        <Title tone="err">Could not load this model</Title>
        <Detail>{error?.message ?? 'unknown error'}</Detail>
        {onRequestImport && (
          <ImportButton onClick={onRequestImport} label="Import a different model" />
        )}
      </Panel>
    );
  }

  if (state === 'loading') {
    return (
      <Panel>
        <Title>Loading…</Title>
        <Detail>{source?.entry}</Detail>
      </Panel>
    );
  }

  /* Imported, but nothing can load it yet. Saying so beats an empty stage. */
  if (source && !kind) {
    return (
      <Panel>
        <Title>No loader for this format yet</Title>
        <Detail>
          {source.entry} was imported, but AniMate cannot display {source.kind} models
          yet.
        </Detail>
        {onRequestImport && (
          <ImportButton onClick={onRequestImport} label="Import a different model" />
        )}
      </Panel>
    );
  }

  return (
    <Panel>
      <Title>No character yet</Title>
      <Detail>
        AniMate ships with none. Import your own — a Spine model needs its{' '}
        <code className="font-mono">.skel</code>,{' '}
        <code className="font-mono">.atlas</code> and texture selected together.
      </Detail>
      {onRequestImport && <ImportButton onClick={onRequestImport} label="Import a model" />}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
      {children}
    </div>
  );
}

function Title({ children, tone }: { children: React.ReactNode; tone?: 'err' }) {
  return (
    <span className={`text-sm font-medium ${tone === 'err' ? 'text-err' : 'text-ink-dim'}`}>
      {children}
    </span>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-[24rem] text-[11px] leading-relaxed text-ink-faint">
      {children}
    </span>
  );
}

function ImportButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 rounded-lg bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-ink hover:opacity-90"
    >
      {label}
    </button>
  );
}

/** Imperative surface for callers that hold a renderer reference. */
export function driveCharacter(
  renderer: CharacterRenderer | null,
  emotion: EmotionProfile,
): void {
  renderer?.setEmotion(emotion);
}

export function pointCharacterGaze(
  renderer: CharacterRenderer | null,
  target: LookTarget,
): void {
  renderer?.lookAt(target);
}

export function playCharacterMotion(
  renderer: CharacterRenderer | null,
  name: string,
  opts?: MotionOptions,
): void {
  void renderer?.playMotion(name, opts).catch(() => {
    /* Unknown clip names are expected across backends; not an error. */
  });
}
