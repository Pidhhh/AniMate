import { useEffect, useState } from 'react';

/* The way out of fullscreen.
 *
 * Fullscreen hides the title bar — that is the point of it, and a companion
 * app should not have window chrome eating the top of the stage. But hiding
 * the only visible control would leave the user relying on knowing that Esc
 * works, which is exactly the kind of thing people do not know.
 *
 * So: nothing is drawn until the pointer approaches the top edge, at which
 * point a single quiet pill fades in. The strip does not capture pointer
 * events while hidden, so the stage underneath stays fully usable.
 */
export function FullscreenHint({ onExit }: { onExit: () => void }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      /* Near the top edge only. A larger zone would flicker on every upward
         mouse movement; a smaller one is hard to find. */
      setRevealed(event.clientY < 64);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  return (
    <div
      className={[
        'absolute inset-x-0 top-0 z-30 flex h-14 items-start justify-end p-2',
        revealed ? 'pointer-events-auto' : 'pointer-events-none',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onExit}
        title="Exit fullscreen (Esc)"
        className={[
          'no-select rounded-lg border border-edge-soft bg-panel/90 px-2.5 py-1',
          'text-[10px] text-ink-dim backdrop-blur transition-opacity duration-200',
          'hover:text-ink',
          revealed ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        Exit fullscreen · Esc
      </button>
    </div>
  );
}
