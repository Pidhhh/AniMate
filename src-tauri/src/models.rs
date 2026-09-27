/* Imported character models.
 *
 * Users bring their own models; nothing ships with the app. Each import is
 * copied into its own directory under the app data dir and recorded in
 * `index.json`, so the originals can be moved or deleted afterwards without
 * breaking the app.
 *
 * Layout:
 *
 *   <app_data>/models/index.json      registry
 *   <app_data>/models/<id>/           one model's files, verbatim
 *
 * The loopback server serves `/models/<id>/...` from that directory, which is
 * what lets the renderer fetch a model by URL. `settings.json` deliberately
 * lives one level up so it is never inside the served subtree.
 *
 * The core functions take a `&Path` root rather than an `AppHandle`. That is
 * not incidental: it is what makes the import path testable without a running
 * Tauri app, and the import path is the part most worth testing.
 */

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Formats the renderer knows how to load. `Unknown` is kept rather than
/// rejected at import time so a user can see that a file was copied but is
/// not yet loadable, instead of it vanishing silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Spine,
    Mmd,
    Gltf,
    Vrm,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub kind: ModelKind,
    /// Entry file, relative to the model's own directory.
    pub entry: String,
    /// Every file in the model, relative to the model's own directory.
    pub files: Vec<String>,
    pub imported_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelRegistry {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub active: Option<String>,
}

/* ------------------------------------------------------------------ paths */

/// Resolves the models directory for a running app and creates it.
pub fn models_root_for(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir(app)
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

pub fn load_registry(root: &Path) -> ModelRegistry {
    match fs::read_to_string(registry_path(root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => ModelRegistry::default(),
    }
}

fn save_registry(root: &Path, registry: &ModelRegistry) -> Result<(), String> {
    let path = registry_path(root);
    let text = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/* -------------------------------------------------------------- detection */

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn detect_kind(files: &[PathBuf]) -> ModelKind {
    let mut kind = ModelKind::Unknown;
    for file in files {
        match extension_of(file).as_str() {
            /* A Spine model is a set, so any member of it identifies the kind. */
            "skel" | "atlas" => return ModelKind::Spine,
            "pmx" | "pmd" => return ModelKind::Mmd,
            "vrm" => return ModelKind::Vrm,
            "glb" | "gltf" => kind = ModelKind::Gltf,
            _ => {}
        }
    }
    kind
}

/// The file the renderer should open first.
fn pick_entry(files: &[PathBuf], kind: ModelKind) -> Option<PathBuf> {
    let wanted: &[&str] = match kind {
        ModelKind::Spine => &["skel"],
        ModelKind::Mmd => &["pmx", "pmd"],
        ModelKind::Vrm => &["vrm"],
        ModelKind::Gltf => &["glb", "gltf"],
        ModelKind::Unknown => &[],
    };

    for ext in wanted {
        if let Some(hit) = files.iter().find(|f| extension_of(f) == *ext) {
            return Some(hit.clone());
        }
    }
    /* Unknown kind: fall back to the first file so the import is still
    recorded and visible rather than rejected. */
    files.first().cloned()
}

/* ------------------------------------------------------------ id and names */

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("model");
    }
    out.truncate(48);
    out
}

fn unique_id(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", chrono::Local::now().timestamp())
}

/* ---------------------------------------------------------------- importing */

/// Copies a set of user-chosen files into a new model directory.
///
/// Paths come verbatim from the file dialog, so they are absolute and already
/// exist. Nothing here trusts a path that arrived over IPC from the renderer —
/// imports always go through the native picker.
pub fn import_files(root: &Path, paths: &[PathBuf]) -> Result<ModelEntry, String> {
    if paths.is_empty() {
        return Err("no files selected".into());
    }

    for path in paths {
        if !path.is_file() {
            return Err(format!("not a file: {}", path.display()));
        }
    }

    let kind = detect_kind(paths);
    let entry_source =
        pick_entry(paths, kind).ok_or_else(|| "could not determine an entry file".to_string())?;
    let entry_name = entry_source
        .file_name()
        .ok_or_else(|| "entry file has no name".to_string())?
        .to_owned();

    let base_name = entry_source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model");
    let id = unique_id(root, &slugify(base_name));

    let target_dir = root.join(&id);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("cannot create {}: {e}", target_dir.display()))?;

    let mut files = Vec::new();

    for path in paths {
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let dest = target_dir.join(file_name);
        fs::copy(path, &dest).map_err(|e| format!("cannot copy {}: {e}", path.display()))?;
        files.push(file_name.to_string_lossy().to_string());
    }

    let entry_rel = entry_name.to_string_lossy().to_string();

    let entry = ModelEntry {
        id: id.clone(),
        name: base_name.to_string(),
        kind,
        entry: entry_rel,
        files,
        imported_at: chrono::Local::now().to_rfc3339(),
    };

    let mut registry = load_registry(root);
    registry.models.push(entry.clone());
    /* First import becomes active automatically — otherwise the stage stays
    empty after a successful import and looks like it failed. */
    if registry.active.is_none() {
        registry.active = Some(id);
    }
    save_registry(root, &registry)?;

    Ok(entry)
}

/* ---- folder import ------------------------------------------------------- */

/// Caps on a folder import, so pointing the picker at something enormous fails
/// with a message instead of freezing the app while it copies a home
/// directory. Generous enough for any real model: the MMD fixture used in
/// development is 48 MB across 12 files.
const MAX_TREE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TREE_FILES: usize = 4000;
const MAX_TREE_DEPTH: usize = 12;

fn collect_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<(PathBuf, PathBuf)>,
    total: &mut u64,
) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH {
        return Err(format!("folder nests deeper than {MAX_TREE_DEPTH} levels"));
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let path = entry.path();

        /* `symlink_metadata` does not follow, which is the point: a symlink
        pointing outside the chosen folder would otherwise let an import
        copy files the user did not select. Skipped rather than rejected —
        a model folder with a stray link in it is still importable. */
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            collect_tree(root, &path, depth + 1, out, total)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }

        if out.len() >= MAX_TREE_FILES {
            return Err(format!("folder holds more than {MAX_TREE_FILES} files"));
        }
        *total += meta.len();
        if *total > MAX_TREE_BYTES {
            return Err(format!(
                "folder is larger than {} MB",
                MAX_TREE_BYTES / 1024 / 1024
            ));
        }

        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("{} is outside the chosen folder", path.display()))?
            .to_path_buf();
        out.push((path, rel));
    }

    Ok(())
}

/// Copies a directory tree into the library, preserving relative paths.
///
/// Preserving structure is the entire reason this exists alongside
/// `import_files`. MMD models reference their textures by relative path — the
/// PMX stores `tex/Body.png`, not `Body.png` — so flattening the tree produces
/// a model that loads with no textures at all. Spine models are three files in
/// one directory and are unaffected either way, which is why both paths are
/// kept rather than replacing one with the other.
pub fn import_tree(root: &Path, source: &Path) -> Result<ModelEntry, String> {
    if !source.is_dir() {
        return Err(format!("not a directory: {}", source.display()));
    }

    let mut collected: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    collect_tree(source, source, 0, &mut collected, &mut total)?;

    if collected.is_empty() {
        return Err("that folder has no files in it".into());
    }

    let paths: Vec<PathBuf> = collected.iter().map(|(abs, _)| abs.clone()).collect();
    let kind = detect_kind(&paths);
    let entry_abs =
        pick_entry(&paths, kind).ok_or_else(|| "could not determine an entry file".to_string())?;
    let entry_rel = collected
        .iter()
        .find(|(abs, _)| abs == &entry_abs)
        .map(|(_, rel)| rel.clone())
        .ok_or_else(|| "the entry file was not collected".to_string())?;

    let base_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let id = unique_id(root, &slugify(&base_name));
    let target_dir = root.join(&id);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("cannot create {}: {e}", target_dir.display()))?;

    let mut files = Vec::with_capacity(collected.len());
    for (abs, rel) in &collected {
        let dest = target_dir.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        fs::copy(abs, &dest).map_err(|e| format!("cannot copy {}: {e}", abs.display()))?;
        /* Forward slashes, because these are served as URL paths and compared
        against what the model file itself references. */
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }

    let entry = ModelEntry {
        id: id.clone(),
        name: base_name,
        kind,
        entry: entry_rel.to_string_lossy().replace('\\', "/"),
        files,
        imported_at: chrono::Local::now().to_rfc3339(),
    };

    let mut registry = load_registry(root);
    registry.models.push(entry.clone());
    if registry.active.is_none() {
        registry.active = Some(id);
    }
    save_registry(root, &registry)?;

    Ok(entry)
}

pub fn delete_model(root: &Path, id: &str) -> Result<ModelRegistry, String> {
    let dir = safe_join(root, id)?;

    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("cannot remove {}: {e}", dir.display()))?;
    }

    let mut registry = load_registry(root);
    registry.models.retain(|m| m.id != id);
    if registry.active.as_deref() == Some(id) {
        registry.active = registry.models.first().map(|m| m.id.clone());
    }
    save_registry(root, &registry)?;
    Ok(registry)
}

pub fn set_active(root: &Path, id: Option<String>) -> Result<ModelRegistry, String> {
    let mut registry = load_registry(root);
    if let Some(ref wanted) = id {
        if !registry.models.iter().any(|m| &m.id == wanted) {
            return Err(format!("no such model: {wanted}"));
        }
    }
    registry.active = id;
    save_registry(root, &registry)?;
    Ok(registry)
}

/// Joins a single path segment onto a root, rejecting anything that could
/// escape it. Used for model ids, which arrive over IPC.
///
/// Requires *exactly one* component. Iterating components and checking each is
/// `Normal` is not enough: `Path::new("a/b")` yields two `Normal` components,
/// so that check would happily accept a nested path. Model ids are single
/// segments by definition, so anything else is rejected outright.
pub fn safe_join(root: &Path, segment: &str) -> Result<PathBuf, String> {
    if segment.is_empty() {
        return Err("empty path segment".into());
    }
    let candidate = Path::new(segment);
    let mut components = candidate.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(root.join(candidate)),
        _ => Err(format!("unsafe path segment: {segment}")),
    }
}

/* ---------------------------------------------------------------- commands */

/// Extensions the picker offers. A Spine model is a set of three files that
/// must be chosen together, so the filter is deliberately broad rather than
/// one entry per format.
const MODEL_EXTENSIONS: &[&str] = &[
    "skel", "atlas", "png", // Spine
    "pmx", "pmd", // MMD
    "glb", "gltf", "vrm", // glTF / VRM
];

/// Opens the native picker and returns the chosen paths.
///
/// Runs in Rust rather than the renderer, and that is a security boundary, not
/// a style preference. `models_import` copies whatever it is given into a
/// directory the loopback server exposes over HTTP. If the renderer supplied
/// the paths, a compromised renderer could hand it `~/.ssh/id_rsa` and then
/// fetch the copy from `/models/<id>/id_rsa` — turning a scripting bug into
/// arbitrary file disclosure. Taking the paths from a dialog the user
/// physically operated removes that primitive entirely.
async fn pick_model_files(app: &AppHandle) -> Result<Option<Vec<PathBuf>>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Import a character model")
        .add_filter("Character model", MODEL_EXTENSIONS)
        .pick_files(move |paths| {
            /* Send failure just means the receiver was dropped; nothing to do. */
            let _ = tx.send(paths);
        });

    let picked = rx
        .await
        .map_err(|_| "the file dialog closed unexpectedly".to_string())?;

    let Some(files) = picked else {
        return Ok(None); // the user cancelled
    };

    let mut out = Vec::with_capacity(files.len());
    for file in files {
        match file.into_path() {
            Ok(path) => out.push(path),
            Err(err) => return Err(format!("unusable path from the file dialog: {err}")),
        }
    }
    Ok(Some(out))
}

/// Opens the native folder picker and returns the chosen directory.
///
/// The folder variant exists because a multi-file picker cannot express "this
/// model and the `tex/` folder beside it". MMD models are trees, not sets of
/// files, and asking a user to select 12 textures by hand across a
/// subdirectory is a way of guaranteeing they get it wrong.
async fn pick_model_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Import a model folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .await
        .map_err(|_| "the folder dialog closed unexpectedly".to_string())?;

    let Some(dir) = picked else {
        return Ok(None);
    };

    dir.into_path()
        .map(Some)
        .map_err(|err| format!("unusable path from the folder dialog: {err}"))
}

#[tauri::command]
pub fn models_list(app: AppHandle) -> ModelRegistry {
    match models_root_for(&app) {
        Ok(root) => load_registry(&root),
        Err(_) => ModelRegistry::default(),
    }
}

/// Imports a model the user picked.
///
/// Takes **no** path argument — see `pick_model_files`. Returns `None` when the
/// user cancelled, which the UI reports as "nothing happened" rather than as an
/// error.
#[tauri::command]
pub async fn models_import(app: AppHandle) -> Result<Option<ModelEntry>, String> {
    let root = models_root_for(&app)?;

    let Some(paths) = pick_model_files(&app).await? else {
        return Ok(None);
    };
    if paths.is_empty() {
        return Ok(None);
    }

    let entry = import_files(&root, &paths)?;
    crate::commands::append_log(
        &app,
        &format!(
            "model imported: id={} kind={:?} files={}",
            entry.id,
            entry.kind,
            entry.files.len()
        ),
    );
    Ok(Some(entry))
}

/// Imports a whole folder, preserving its structure.
///
/// This is the path that works for MMD and for anything else that references
/// sibling files by relative path.
#[tauri::command]
pub async fn models_import_folder(app: AppHandle) -> Result<Option<ModelEntry>, String> {
    let root = models_root_for(&app)?;

    let Some(dir) = pick_model_folder(&app).await? else {
        return Ok(None);
    };

    let entry = import_tree(&root, &dir)?;
    crate::commands::append_log(
        &app,
        &format!(
            "model imported from folder: id={} kind={:?} files={} entry={}",
            entry.id,
            entry.kind,
            entry.files.len(),
            entry.entry
        ),
    );
    Ok(Some(entry))
}

#[tauri::command]
pub fn models_delete(app: AppHandle, id: String) -> Result<ModelRegistry, String> {
    let root = models_root_for(&app)?;
    let registry = delete_model(&root, &id)?;
    crate::commands::append_log(&app, &format!("model deleted: {id}"));
    Ok(registry)
}

#[tauri::command]
pub fn models_set_active(app: AppHandle, id: Option<String>) -> Result<ModelRegistry, String> {
    let root = models_root_for(&app)?;
    let registry = set_active(&root, id)?;
    crate::commands::append_log(&app, &format!("active model: {:?}", registry.active));
    Ok(registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A throwaway models root. Uses the system temp dir so the tests exercise
    /// the real filesystem — the whole point of the refactor that made these
    /// functions take a path instead of an AppHandle.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("animate-models-test-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp root");
            TempRoot(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).expect("create source file");
        f.write_all(bytes).expect("write source file");
        path
    }

    #[test]
    fn slugify_is_stable_and_safe() {
        assert_eq!(slugify("Ryza Model 01"), "ryza-model-01");
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(slugify("///"), "model");
        assert_eq!(slugify(""), "model");
    }

    #[test]
    fn safe_join_rejects_traversal_and_nesting() {
        let root = Path::new("/tmp/models");
        assert!(safe_join(root, "abc").is_ok());
        assert!(safe_join(root, "../settings").is_err());
        assert!(safe_join(root, "a/b").is_err());
        assert!(safe_join(root, "").is_err());
    }

    #[test]
    fn detects_kind_from_any_set_member() {
        let skel = vec![PathBuf::from("/m/a.atlas"), PathBuf::from("/m/a.skel")];
        assert_eq!(detect_kind(&skel), ModelKind::Spine);

        let pmx = vec![PathBuf::from("/m/a.pmx"), PathBuf::from("/m/tex.png")];
        assert_eq!(detect_kind(&pmx), ModelKind::Mmd);

        let glb = vec![PathBuf::from("/m/a.glb")];
        assert_eq!(detect_kind(&glb), ModelKind::Gltf);

        let none = vec![PathBuf::from("/m/a.txt")];
        assert_eq!(detect_kind(&none), ModelKind::Unknown);
    }

    #[test]
    fn entry_picks_the_loadable_file() {
        let files = vec![
            PathBuf::from("/m/a.png"),
            PathBuf::from("/m/a.atlas"),
            PathBuf::from("/m/a.skel"),
        ];
        assert_eq!(
            pick_entry(&files, ModelKind::Spine).unwrap(),
            PathBuf::from("/m/a.skel")
        );
    }

    #[test]
    fn import_copies_every_file_and_records_the_set() {
        let src = TempRoot::new("src");
        let root = TempRoot::new("dst");

        let skel = write_file(src.path(), "hero.skel", b"SKEL");
        let atlas = write_file(src.path(), "hero.atlas", b"ATLAS");
        let png = write_file(src.path(), "hero.png", b"PNG");

        let entry = import_files(root.path(), &[skel, atlas, png]).expect("import");

        assert_eq!(entry.kind, ModelKind::Spine);
        assert_eq!(entry.entry, "hero.skel");
        assert_eq!(entry.files.len(), 3);

        let dir = root.path().join(&entry.id);
        for name in ["hero.skel", "hero.atlas", "hero.png"] {
            assert!(dir.join(name).is_file(), "{name} was not copied");
        }
        /* Contents must survive verbatim — the atlas resolves its texture
        pages by name, so a mangled copy is a broken model. */
        assert_eq!(fs::read(dir.join("hero.skel")).unwrap(), b"SKEL");
    }

    #[test]
    fn first_import_becomes_active_and_registry_persists() {
        let src = TempRoot::new("src2");
        let root = TempRoot::new("dst2");

        let skel = write_file(src.path(), "one.skel", b"A");
        let atlas = write_file(src.path(), "one.atlas", b"B");
        let entry = import_files(root.path(), &[skel, atlas]).expect("import");

        let registry = load_registry(root.path());
        assert_eq!(registry.models.len(), 1);
        assert_eq!(registry.active.as_deref(), Some(entry.id.as_str()));

        /* Reloading from disk must give the same answer. */
        let again = load_registry(root.path());
        assert_eq!(again.models[0].id, entry.id);
    }

    #[test]
    fn second_import_does_not_steal_active() {
        let src = TempRoot::new("src3");
        let root = TempRoot::new("dst3");

        let a1 = write_file(src.path(), "first.skel", b"A");
        let a2 = write_file(src.path(), "first.atlas", b"B");
        let first = import_files(root.path(), &[a1, a2]).expect("first import");

        let b1 = write_file(src.path(), "second.skel", b"C");
        let b2 = write_file(src.path(), "second.atlas", b"D");
        import_files(root.path(), &[b1, b2]).expect("second import");

        let registry = load_registry(root.path());
        assert_eq!(registry.models.len(), 2);
        assert_eq!(
            registry.active.as_deref(),
            Some(first.id.as_str()),
            "a later import must not silently replace the active model"
        );
    }

    #[test]
    fn duplicate_names_get_distinct_directories() {
        let src = TempRoot::new("src4");
        let root = TempRoot::new("dst4");

        let a1 = write_file(src.path(), "same.skel", b"A");
        let a2 = write_file(src.path(), "same.atlas", b"B");
        let first = import_files(root.path(), &[a1, a2]).expect("first");

        let b1 = write_file(src.path(), "same.skel", b"C");
        let b2 = write_file(src.path(), "same.atlas", b"D");
        let second = import_files(root.path(), &[b1, b2]).expect("second");

        assert_ne!(first.id, second.id, "ids must not collide");
        assert!(root.path().join(&first.id).is_dir());
        assert!(root.path().join(&second.id).is_dir());
    }

    #[test]
    fn deleting_the_active_model_promotes_another() {
        let src = TempRoot::new("src5");
        let root = TempRoot::new("dst5");

        let a1 = write_file(src.path(), "alpha.skel", b"A");
        let a2 = write_file(src.path(), "alpha.atlas", b"B");
        let first = import_files(root.path(), &[a1, a2]).expect("first");

        let b1 = write_file(src.path(), "beta.skel", b"C");
        let b2 = write_file(src.path(), "beta.atlas", b"D");
        let second = import_files(root.path(), &[b1, b2]).expect("second");

        let registry = delete_model(root.path(), &first.id).expect("delete");
        assert_eq!(registry.models.len(), 1);
        assert_eq!(registry.active.as_deref(), Some(second.id.as_str()));
        assert!(
            !root.path().join(&first.id).exists(),
            "files must be removed"
        );
    }

    #[test]
    fn deleting_the_last_model_clears_active() {
        let src = TempRoot::new("src6");
        let root = TempRoot::new("dst6");

        let a1 = write_file(src.path(), "only.skel", b"A");
        let a2 = write_file(src.path(), "only.atlas", b"B");
        let entry = import_files(root.path(), &[a1, a2]).expect("import");

        let registry = delete_model(root.path(), &entry.id).expect("delete");
        assert!(registry.models.is_empty());
        assert_eq!(registry.active, None);
    }

    #[test]
    fn set_active_rejects_an_unknown_id() {
        let root = TempRoot::new("dst7");
        assert!(set_active(root.path(), Some("nope".into())).is_err());
        assert!(set_active(root.path(), None).is_ok());
    }

    #[test]
    fn import_rejects_a_missing_file() {
        let root = TempRoot::new("dst8");
        let ghost = root.path().join("not-here.skel");
        assert!(import_files(root.path(), &[ghost]).is_err());
    }

    #[test]
    fn import_rejects_an_empty_selection() {
        let root = TempRoot::new("dst9");
        assert!(import_files(root.path(), &[]).is_err());
    }

    /* ---- folder import ---- */

    #[test]
    fn folder_import_preserves_the_tree() {
        /* The reason this path exists. A PMX references `tex/Body.png`, so a
        flattened copy loads with no textures — and nothing errors, it just
        renders untextured, which is easy to misread as a renderer bug. */
        let src = TempRoot::new("tree-src");
        let root = TempRoot::new("tree-dst");

        let model_dir = src.path().join("Hero");
        let tex_dir = model_dir.join("tex");
        fs::create_dir_all(&tex_dir).expect("create tree");

        write_file(&model_dir, "Hero.pmx", b"PMX");
        write_file(&tex_dir, "Body.png", b"PNG1");
        write_file(&tex_dir, "Face.png", b"PNG2");

        let entry = import_tree(root.path(), &model_dir).expect("import tree");

        assert_eq!(entry.kind, ModelKind::Mmd);
        assert_eq!(entry.entry, "Hero.pmx");
        assert_eq!(entry.name, "Hero");

        let dest = root.path().join(&entry.id);
        assert!(dest.join("Hero.pmx").is_file());
        assert!(
            dest.join("tex").join("Body.png").is_file(),
            "textures must stay in tex/, or the PMX cannot find them"
        );
        assert!(dest.join("tex").join("Face.png").is_file());

        /* Paths are recorded with forward slashes — they are served as URL
        paths and compared against what the model file references. */
        assert!(entry.files.contains(&"tex/Body.png".to_string()));
        assert!(
            !entry.files.iter().any(|f| f.contains('\\')),
            "no backslashes in served paths"
        );
    }

    #[test]
    fn folder_import_skips_symlinks() {
        /* Following a link would copy files the user never selected — the
        folder picker only grants access to what is inside the folder. */
        let src = TempRoot::new("link-src");
        let root = TempRoot::new("link-dst");
        let outside = TempRoot::new("link-outside");

        write_file(outside.path(), "secret.txt", b"should not be copied");
        write_file(src.path(), "model.pmx", b"PMX");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let _ = symlink(
                outside.path().join("secret.txt"),
                src.path().join("link.txt"),
            );
        }
        #[cfg(windows)]
        {
            /* Creating a symlink on Windows needs a privilege the test runner
            may not have; skip rather than fail on the environment. */
        }

        let entry = import_tree(root.path(), src.path()).expect("import tree");
        assert!(entry.files.contains(&"model.pmx".to_string()));
        assert!(
            !entry.files.iter().any(|f| f.contains("secret")),
            "a symlink must not pull in files from outside the folder"
        );
    }

    #[test]
    fn folder_import_rejects_an_empty_folder() {
        let src = TempRoot::new("empty-src");
        let root = TempRoot::new("empty-dst");
        assert!(import_tree(root.path(), src.path()).is_err());
    }

    #[test]
    fn folder_import_rejects_a_file() {
        let src = TempRoot::new("notdir-src");
        let root = TempRoot::new("notdir-dst");
        let file = write_file(src.path(), "a.pmx", b"PMX");
        assert!(import_tree(root.path(), &file).is_err());
    }

    #[test]
    fn folder_import_picks_the_entry_from_the_tree() {
        let src = TempRoot::new("entry-src");
        let root = TempRoot::new("entry-dst");
        let model_dir = src.path().join("Nested");
        fs::create_dir_all(model_dir.join("tex")).expect("create");
        write_file(&model_dir, "Hero.pmx", b"PMX");
        write_file(&model_dir.join("tex"), "a.png", b"PNG");

        let entry = import_tree(root.path(), &model_dir).expect("import");
        assert_eq!(entry.entry, "Hero.pmx");
        assert_eq!(entry.kind, ModelKind::Mmd);
    }
}
