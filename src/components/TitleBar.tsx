import { useEffect, useState } from 'react';
import { hasNativeShell, isTopmost, minimize, close, setTopmost } from '../bridge/shell';

/* Frameless-window chrome.
 *
 * The whole bar is a drag region via data-tauri-drag-region; the buttons opt
 * out with .no-drag. Buttons are hidden entirely when the native shell is
 * absent (plain-browser dev), because there is no window to control.
 */
export function TitleBar({
  onOpenSettings,
  onToggleFullscreen,
}: {
  onOpenSettings?: () => void;
  onToggleFullscreen?: () => void;
}) {
  const [pinned, setPinned] = useState(false);
  const [native, setNative] = useState(false);

  useEffect(() => {
    if (!hasNativeShell()) return;
    setNative(true);
    /* Reflect whatever the OS already has, rather than assuming false. */
    void isTopmost()
      .then(setPinned)
      .catch(() => setPinned(false));
  }, []);

  const onTogglePin = async () => {
    /* The command returns the state the OS actually applied — trust that
       over our optimistic guess. */
    const applied = await setTopmost(!pinned);
    setPinned(applied);
  };

  return (
    <header
      data-tauri-drag-region
      className="no-select flex h-9 shrink-0 items-center gap-2 border-b border-edge-soft bg-stage-soft px-3"
    >
      <span className="text-[11px] font-medium tracking-wide text-ink-dim">AniMate</span>

      <div className="flex-1" />

      {onOpenSettings && (
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
          className="no-drag rounded px-2 py-1 text-[10px] text-ink-faint hover:bg-edge hover:text-ink"
        >
          Settings
        </button>
      )}

      {native && (
        <div className="flex items-center gap-1">
          <ChromeButton
            label={pinned ? 'Unpin' : 'Pin on top'}
            active={pinned}
            onClick={() => void onTogglePin()}
            glyph="pin"
          />
          {onToggleFullscreen && (
            <ChromeButton
              label="Fullscreen (F11)"
              onClick={onToggleFullscreen}
              glyph="expand"
            />
          )}
          <ChromeButton label="Minimize" onClick={() => void minimize()} glyph="min" />
          <ChromeButton label="Close" onClick={() => void close()} glyph="close" danger />
        </div>
      )}
    </header>
  );
}

function ChromeButton({
  label,
  onClick,
  glyph,
  active = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  glyph: 'pin' | 'min' | 'close' | 'expand';
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={[
        'no-drag grid h-6 w-6 place-items-center rounded transition-colors',
        active
          ? 'bg-accent-soft text-ink'
          : danger
            ? 'text-ink-faint hover:bg-err/20 hover:text-err'
            : 'text-ink-faint hover:bg-edge hover:text-ink',
      ].join(' ')}
    >
      <Glyph name={glyph} />
    </button>
  );
}

/* Inline SVG rather than an icon dependency — three glyphs do not justify a
   package, and this keeps the bundle honest. */
function Glyph({ name }: { name: 'pin' | 'min' | 'close' | 'expand' }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (name === 'min') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M2.5 6h7" />
      </svg>
    );
  }

  /* Corner brackets, pointing out. Reads as "expand" without a caption. */
  if (name === 'expand') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M7 1.8h3.2V5" />
        <path d="M5 10.2H1.8V7" />
        <path d="M10.2 1.8L6.6 5.4" />
        <path d="M1.8 10.2l3.6-3.6" />
      </svg>
    );
  }

  if (name === 'close') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    );
  }

  return (
    <svg {...common} aria-hidden="true">
      <path d="M7.2 1.6l3.2 3.2-1.6.6-1.9 2.5-1.2-.4-1.9 2.4-.5-.5 2.4-1.9-.4-1.2 2.5-1.9z" />
    </svg>
  );
}
