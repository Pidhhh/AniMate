/* The model library, as a single source of truth.
 *
 * Both the stage and the settings panel need the same registry and the same
 * import action. Keeping the state in one hook rather than two components
 * means an import started from either place updates both — and it is the
 * reason `importModel` lives here rather than in the panel.
 */

import { useCallback, useEffect, useState } from 'react';
import { reportDiag } from '../bridge/shell';
import {
  activeSource,
  deleteModel,
  importModels,
  listModels,
  setActiveModel,
  type ModelEntry,
  type ModelRegistry,
} from './models';
import type { ModelSource } from '../character/types';

export interface ModelLibrary {
  registry: ModelRegistry;
  /** False until the first read completes, so the stage does not flash its
   *  "no character yet" state on every boot before the registry arrives. */
  ready: boolean;
  source: ModelSource | null;
  /** Open the native picker and import whatever is chosen. Resolves to the
   *  new entry, or null when the user cancelled. */
  importFromPicker: () => Promise<ModelEntry | null>;
  activate: (id: string) => Promise<void>;
  remove: (entry: ModelEntry) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useModelLibrary(): ModelLibrary {
  const [registry, setRegistry] = useState<ModelRegistry>({ models: [], active: null });
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    setRegistry(await listModels());
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* The file picker runs in Rust, not here.
   *
   * `models_import` copies whatever it is handed into a directory the loopback
   * server exposes over HTTP. If this side supplied the paths, a bug in the
   * renderer would become arbitrary file disclosure — hand it `~/.ssh/id_rsa`
   * and fetch the copy back. Letting the user operate the dialog on the Rust
   * side removes that primitive rather than relying on this code being
   * correct forever. */
  const importFromPicker = useCallback(async () => {
    const entry = await importModels();
    if (!entry) return null; // the user cancelled

    setRegistry(await listModels());
    reportDiag(
      `model imported: id=${entry.id} kind=${entry.kind} files=${entry.files.length}`,
    );
    return entry;
  }, []);

  const activate = useCallback(async (id: string) => {
    setRegistry(await setActiveModel(id));
  }, []);

  const remove = useCallback(async (entry: ModelEntry) => {
    setRegistry(await deleteModel(entry.id));
  }, []);

  return {
    registry,
    ready,
    source: activeSource(registry),
    importFromPicker,
    activate,
    remove,
    refresh,
  };
}
