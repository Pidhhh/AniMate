/* The user's model library.
 *
 * Nothing ships with the app. The stage is empty until a model is imported,
 * and every model lives in the app data directory so it survives updates and
 * is never part of the installed tree.
 *
 * Read paths (`listModels`) swallow failures and return an empty registry —
 * a missing library is a normal first-run state, not an error worth throwing
 * into a render. Write paths propagate, because a failed import must be
 * visible.
 */

import { invoke } from '../bridge/ipc';
import type { ModelKind, ModelSource } from '../character/types';

export interface ModelEntry {
  id: string;
  name: string;
  kind: ModelKind;
  /** Entry file name, relative to the model's own directory. */
  entry: string;
  /** Every file in the model, relative to its own directory. */
  files: string[];
  importedAt: string;
}

export interface ModelRegistry {
  models: ModelEntry[];
  active: string | null;
}

const EMPTY_REGISTRY: ModelRegistry = { models: [], active: null };

export async function listModels(): Promise<ModelRegistry> {
  try {
    return await invoke<ModelRegistry>('models_list');
  } catch {
    return EMPTY_REGISTRY;
  }
}
/** Open the native picker and import whatever the user chooses.
 *
 *  Takes no paths: the dialog runs in Rust, so the file list never passes
 *  through the renderer. Returns null when the user cancelled — a normal
 *  outcome, not an error. */
export async function importModels(): Promise<ModelEntry | null> {
  return invoke<ModelEntry | null>('models_import');
}

export async function deleteModel(id: string): Promise<ModelRegistry> {
  return invoke<ModelRegistry>('models_delete', { id });
}

export async function setActiveModel(id: string | null): Promise<ModelRegistry> {
  return invoke<ModelRegistry>('models_set_active', { id });
}

/** Resolve a registry entry into fetchable URLs. */
export function toSource(entry: ModelEntry): ModelSource {
  return {
    id: entry.id,
    kind: entry.kind,
    baseUrl: `/models/${entry.id}/`,
    entry: entry.entry,
    files: entry.files,
  };
}

/** The source for whichever model is active, or null when there is none. */
export function activeSource(registry: ModelRegistry): ModelSource | null {
  if (!registry.active) return null;
  const entry = registry.models.find((m) => m.id === registry.active);
  return entry ? toSource(entry) : null;
}

/** Human-readable format label for the UI. */
export function kindLabel(kind: ModelKind): string {
  switch (kind) {
    case 'spine':
      return 'Spine (2D)';
    case 'mmd':
      return 'MMD (3D)';
    case 'gltf':
      return 'glTF (3D)';
    case 'vrm':
      return 'VRM (3D)';
    default:
      return 'Unrecognised';
  }
}
