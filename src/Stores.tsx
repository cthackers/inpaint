import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Database, FolderOpen, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { Store, StoreStats } from "./types";

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const immichDefault = (store: Store) => store.immichPath || `/data/upload/${baseName(store.path)}`;

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function since(milliseconds: number) {
  const minutes = Math.round((Date.now() - milliseconds) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(milliseconds).toLocaleDateString();
}

type PickerProps = {
  stores: Store[];
  activeStore: Store | null;
  onOpenFolder: () => void;
  onNewStore: () => void;
  onOpenStore: (id: string) => void;
};

/** Chooses what the gallery shows: a folder from disk or one of the image stores. */
export function SourcePicker({ stores, activeStore, onOpenFolder, onNewStore, onOpenStore }: PickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  const choose = (action: () => void) => { setMenuOpen(false); action(); };

  return <div className="source-picker" ref={root}>
    <button className="source-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
      {activeStore ? <Database size={17} /> : <FolderOpen size={17} />}
      <span>{activeStore ? activeStore.name : "Open folder"}</span>
      <ChevronDown size={15} />
    </button>
    {menuOpen && <div className="source-menu" role="menu">
      <button role="menuitem" onClick={() => choose(onOpenFolder)}><FolderOpen size={15} /> Open folder…</button>
      <button role="menuitem" onClick={() => choose(onNewStore)}><Plus size={15} /> New store…</button>
      <hr />
      {stores.length
        ? stores.map((store) => <button key={store.id} role="menuitem" className={store.id === activeStore?.id ? "active" : ""} title={store.path}
            onClick={() => choose(() => onOpenStore(store.id))}><Database size={15} /><span>{store.name}</span></button>)
        : <small>No image stores yet.</small>}
    </div>}
  </div>;
}

type PanelProps = {
  store: Store;
  stats: StoreStats | null;
  progress: { done: number; total: number } | null;
  error: string;
  onRescan: () => void;
  onChange: (store: Store) => void;
  onRemove: () => void;
};

/** Sidebar details of the open store: statistics, rescan, rename, remove and Immich settings. */
export function StorePanel({ store, stats, progress, error, onRescan, onChange, onRemove }: PanelProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(store.name);
  const [immichPath, setImmichPath] = useState(immichDefault(store));
  const [message, setMessage] = useState("");
  useEffect(() => {
    setRenaming(false);
    setName(store.name);
    setImmichPath(immichDefault(store));
    setMessage("");
  }, [store.id]);

  const save = async (changes: Partial<Store>) => {
    try {
      onChange(await invoke<Store>("store_update", { store: { ...store, ...changes } }));
      setMessage("");
      return true;
    } catch (failure) {
      setMessage(String(failure));
      return false;
    }
  };
  const remove = async () => {
    if (!await confirm(`Forget the store "${store.name}"? Its folder and pictures stay on disk.`, { title: "Remove store", kind: "warning" })) return;
    try {
      await invoke("store_remove", { id: store.id });
      onRemove();
    } catch (failure) { setMessage(String(failure)); }
  };

  return <div className="store-panel">
    {renaming
      ? <form className="store-rename" onSubmit={(event) => { event.preventDefault(); void save({ name }).then((saved) => { if (saved) setRenaming(false); }); }}>
          <input autoFocus aria-label="Store name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          <button type="submit">Save</button>
          <button type="button" onClick={() => { setName(store.name); setRenaming(false); }}>Cancel</button>
        </form>
      : <strong className="store-name" title={store.name}>{store.name}</strong>}
    <span className="store-path" title={store.path}>{store.path}</span>
    <dl className="store-stats">
      <dt>Pictures</dt><dd>{stats ? stats.pictures.toLocaleString() : "…"}</dd>
      <dt>Size</dt><dd>{stats ? formatBytes(stats.bytes) : "…"}</dd>
      <dt title="Videos, sidecar files and files named outside the ab/cd/abcd… layout">Other files</dt><dd>{stats ? stats.otherFiles.toLocaleString() : "…"}</dd>
      <dt>Scanned</dt><dd>{progress ? "now" : stats ? `${since(stats.scannedMs)} · ${stats.scanSeconds.toFixed(1)} s` : "not yet"}</dd>
    </dl>
    {progress && <label className="store-scan">
      {progress.total ? `Scanning folder ${progress.done} of ${progress.total}` : "Scanning…"}
      {progress.total ? <progress max={progress.total} value={progress.done} /> : <progress />}
    </label>}
    {error && <p className="store-error">{error}</p>}
    <div className="store-actions">
      <button disabled={!!progress} onClick={onRescan}><RefreshCw size={14} /> Rescan</button>
      <button onClick={() => setRenaming(true)}><Pencil size={14} /> Rename</button>
      <button onClick={() => void remove()}><Trash2 size={14} /> Remove</button>
    </div>
    <label className="check-label"><input type="checkbox" checked={store.immich} onChange={(event) => void save({ immich: event.target.checked, immichPath })} /> Immich compatible</label>
    {store.immich && <>
      <label className="store-field">Folder as Immich sees it
        <input value={immichPath} onChange={(event) => setImmichPath(event.target.value)}
          onBlur={() => { if (immichPath !== store.immichPath) void save({ immichPath }); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </label>
      <small>After a picture of this store is saved in Inpaint, Immich rebuilds its thumbnail. Enter Immich's address and API key in Settings.</small>
    </>}
    {message && <p className="store-error">{message}</p>}
  </div>;
}

export function NewStoreDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (store: Store) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const chooseFolder = async () => {
    try {
      const folder = await open({ directory: true, multiple: false, title: "Folder of the image store" });
      if (typeof folder !== "string") return;
      setPath(folder);
      if (!name.trim()) setName(baseName(folder));
    } catch (failure) { setError(String(failure)); }
  };
  const create = async () => {
    setBusy(true); setError("");
    try { onCreated(await invoke<Store>("store_create", { name, path })); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  return <div className="leave-dialog-backdrop" role="presentation">
    <div className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="new-store-title">
      <div className="server-dialog-heading">
        <strong id="new-store-title">New image store</strong>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <p>An image store is a folder of pictures kept as <code>ab/cd/abcd….jpg</code>, like Immich's upload folders. For Immich, choose one user's folder inside <code>upload</code>.</p>
      <div className="workspace-form">
        <label>Folder<span className="server-token">
          <input readOnly value={path} placeholder="Choose a folder" />
          <button type="button" className="icon-button" title="Choose folder" onClick={() => void chooseFolder()}><FolderOpen size={16} /></button>
        </span></label>
        <label>Name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {error && <p className="server-message">{error}</p>}
      <div className="leave-dialog-actions">
        <button className="leave-no" onClick={onClose}>Cancel</button>
        <button className="leave-yes" disabled={busy || !path} onClick={() => void create()}>Create store</button>
      </div>
    </div>
  </div>;
}
