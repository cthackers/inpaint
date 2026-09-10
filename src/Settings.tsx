import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Eye, EyeOff, FolderOpen, FolderPlus, Images, Inbox, RefreshCw, Server, Settings as SettingsIcon, Trash2, X } from "lucide-react";
import DropboxTab from "./DropboxSettings";
import type { Store } from "./types";

type ServerSettings = { enabled: boolean; listenAll: boolean; port: number; token: string; allowedFolders: string[]; allowUrls: boolean; saveFolder: string };
type ServerStatus = { settings: ServerSettings; running: boolean; address: string | null; error: string | null; saveFolder: string };
type ImmichSettings = { url: string; apiKey: string };

const TABS = [
  { id: "server", label: "API server", icon: Server },
  { id: "immich", label: "Immich", icon: Images },
  { id: "dropbox", label: "Drop box", icon: Inbox },
] as const;
export type SettingsTab = (typeof TABS)[number]["id"];

/** Sidebar button showing the API server state; opens the settings. */
export function SettingsButton({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  // The settings dialog and the tray menu start and stop the server.
  useEffect(() => {
    const load = () => { void invoke<ServerStatus>("server_status").then(setStatus).catch(() => {}); };
    load();
    const listening = listen("server-status", load);
    return () => { void listening.then((unlisten) => unlisten()); };
  }, []);
  const state = !status?.settings.enabled ? "API off" : status.running ? `API :${status.settings.port}` : "API error";
  return <button className="server-toggle" onClick={onOpen} title="API server, Immich and drop box settings">
    <SettingsIcon size={16} /><span>Settings</span>
    <small className={`server-state ${status?.running ? "on" : status?.error ? "error" : ""}`}>{state}</small>
  </button>;
}

type DialogProps = { tab: SettingsTab; onTab: (tab: SettingsTab) => void; onClose: () => void; stores: Store[] };

export function SettingsDialog({ tab, onTab, onClose, stores }: DialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="leave-dialog-backdrop" role="presentation">
    <div className="server-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="server-dialog-heading">
        <strong id="settings-title">Settings</strong>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="settings-body">
        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={id === tab} className={id === tab ? "active" : ""} onClick={() => onTab(id)}>
            <Icon size={15} />{label}
          </button>)}
        </nav>
        {/* Hidden tabs stay mounted, so unapplied changes survive switching tabs. */}
        <div className="settings-panel" role="tabpanel" hidden={tab !== "server"}><ServerTab /></div>
        <div className="settings-panel" role="tabpanel" hidden={tab !== "immich"}><ImmichTab /></div>
        <div className="settings-panel" role="tabpanel" hidden={tab !== "dropbox"}><DropboxTab stores={stores} /></div>
      </div>
    </div>
  </div>;
}

function ServerTab() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [draft, setDraft] = useState<ServerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    void invoke<ServerStatus>("server_status").then((value) => { setStatus(value); setDraft(value.settings); }).catch((error) => setMessage(String(error)));
  }, []);
  if (!status || !draft) return <p className="server-message">{message || "Loading…"}</p>;

  const update = (patch: Partial<ServerSettings>) => setDraft({ ...draft, ...patch });
  const changed = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const apply = async () => {
    setBusy(true); setMessage("");
    try {
      const next = await invoke<ServerStatus>("server_configure", { settings: draft });
      setStatus(next); setDraft(next.settings);
      setMessage(next.error ?? "Settings applied.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const chooseFolder = async (title: string) => {
    try {
      const folder = await openDialog({ directory: true, multiple: false, title });
      return typeof folder === "string" ? folder : null;
    } catch (error) { setMessage(String(error)); return null; }
  };
  const addFolder = async () => {
    const folder = await chooseFolder("Allow API access to a folder");
    if (folder && !draft.allowedFolders.includes(folder)) update({ allowedFolders: [...draft.allowedFolders, folder] });
  };
  const copyToken = async () => {
    try { await navigator.clipboard.writeText(draft.token); setMessage("Token copied."); }
    catch { setShowToken(true); setMessage("Copying failed. The token is now visible so you can select it."); }
  };
  const address = status.address ?? `http://127.0.0.1:${draft.port}`;

  return <section className="settings-section">
    <h3>Local API server</h3>
    <p className={`server-status ${status.error ? "error" : status.running ? "on" : ""}`}>
      {status.error ?? (status.running ? `Listening on ${status.address}` : "The server is off.")}
    </p>
    <div className="workspace-form">
      <label className="check-label"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} /> Enable the API server</label>
      <div className="form-row">
        <label>Listen on<select value={draft.listenAll ? "all" : "local"} disabled={busy} onChange={(e) => update({ listenAll: e.target.value === "all" })}>
          <option value="local">This computer only · 127.0.0.1</option>
          <option value="all">All network interfaces · 0.0.0.0</option>
        </select></label>
        <label>Port<input type="number" min={1024} max={65535} value={draft.port} disabled={busy} onChange={(e) => update({ port: Math.round(+e.target.value) })} /></label>
      </div>
      {draft.listenAll && <small className="server-warning">Other devices on your network can reach the API. Requests still need the token, but plain HTTP sends the token and pictures unencrypted.</small>}

      <label>Access token<span className="server-token">
        <input type={showToken ? "text" : "password"} readOnly value={draft.token} onFocus={(e) => e.target.select()} />
        <button type="button" className="icon-button" title={showToken ? "Hide token" : "Show token"} onClick={() => setShowToken(!showToken)}>{showToken ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        <button type="button" className="icon-button" title="Copy token" onClick={() => void copyToken()}><Copy size={16} /></button>
        <button type="button" className="icon-button" title="Generate a new token" disabled={busy} onClick={() => void invoke<string>("server_new_token").then((token) => update({ token }))}><RefreshCw size={16} /></button>
      </span></label>
      <small>Send it with every request as <code>Authorization: Bearer &lt;token&gt;</code>. A new token takes effect when you apply.</small>

      <div className="server-folders">
        <span>Folders the API may read and write</span>
        {draft.allowedFolders.map((folder) => <div className="memory-row" key={folder}>
          <span className="path-text">{folder}</span>
          <button type="button" className="icon-button" aria-label={`Remove ${folder}`} disabled={busy} onClick={() => update({ allowedFolders: draft.allowedFolders.filter((item) => item !== folder) })}><Trash2 size={15} /></button>
        </div>)}
        {!draft.allowedFolders.length && <small>None yet, so requests that use disk paths are refused.</small>}
        <button type="button" className="plugin-run" disabled={busy} onClick={() => void addFolder()}><FolderPlus size={14} /> Add folder</button>
      </div>

      <div className="server-folders">
        <span>Save folder for pictures sent to /save without a path</span>
        <span className="path-text">{draft.saveFolder || status.saveFolder}</span>
        <div className="form-row">
          <button type="button" className="plugin-run" disabled={busy} onClick={() => void chooseFolder("Save folder for API pictures").then((folder) => { if (folder) update({ saveFolder: folder }); })}><FolderOpen size={14} /> Choose</button>
          <button type="button" className="plugin-run" disabled={busy || !draft.saveFolder} onClick={() => update({ saveFolder: "" })}>Use default</button>
        </div>
      </div>

      <label className="check-label"><input type="checkbox" checked={draft.allowUrls} disabled={busy} onChange={(e) => update({ allowUrls: e.target.checked })} /> Download pictures from http(s) URLs</label>
      <small>Anyone with the token can then make the app fetch addresses on your network.</small>
      <small>Try it: <code className="path-text">curl -H "Authorization: Bearer $TOKEN" {address}/operations</code></small>
    </div>
    <div className="settings-actions">
      {message && <p className="server-message">{message}</p>}
      <button className="leave-yes" disabled={busy || !changed} onClick={() => void apply()}>Apply</button>
    </div>
  </section>;
}

function ImmichTab() {
  const [saved, setSaved] = useState<ImmichSettings | null>(null);
  const [draft, setDraft] = useState<ImmichSettings>({ url: "", apiKey: "" });
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void invoke<ImmichSettings>("immich_settings").then((value) => { setSaved(value); setDraft(value); }).catch((error) => setMessage(String(error)));
  }, []);
  const saveAndTest = async () => {
    setBusy(true); setMessage("");
    try {
      const next = await invoke<ImmichSettings>("immich_configure", { settings: draft });
      setSaved(next); setDraft(next);
      setMessage(next.url && next.apiKey ? await invoke<string>("immich_test") : "Saved. Immich is not contacted until both the address and the API key are set.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const changed = !saved || draft.url !== saved.url || draft.apiKey !== saved.apiKey;

  return <section className="settings-section">
    <h3>Immich</h3>
    <small>Used by image stores marked Immich compatible. After Inpaint saves one of their pictures, Immich rebuilds its thumbnail, deleting one moves it to Immich's trash, the editor's Immich panel edits their favorite mark, rating, description, tags and albums, and the drop box uploads pictures into them through Immich. Create the API key with the account that owns the pictures and give it the asset.read, asset.update, asset.upload, asset.delete, job.create, tag.read, tag.create, tag.asset, album.read, album.create, albumAsset.create and albumAsset.delete permissions.</small>
    <div className="workspace-form">
      <label>Address<input value={draft.url} placeholder="http://nas.local:2283" disabled={busy} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>
      <label>API key<span className="server-token">
        <input type={showKey ? "text" : "password"} value={draft.apiKey} disabled={busy} autoComplete="off" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
        <button type="button" className="icon-button" title={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      </span></label>
    </div>
    <div className="settings-actions">
      {message && <p className="server-message">{message}</p>}
      <button className="leave-yes" disabled={busy || (!changed && !draft.url)} onClick={() => void saveAndTest()}>{changed ? "Save and test" : "Test"}</button>
    </div>
  </section>;
}
