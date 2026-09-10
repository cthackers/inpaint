import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Store } from "./types";

type DropboxSettings = {
  enabled: boolean;
  storeId: string;
  pinned: boolean;
  width: number;
  height: number;
  margin: number;
  opacity: number;
  monitor: "left" | "middle" | "right";
};
type DropboxStatus = { settings: DropboxSettings; hotkeys: boolean };

const same = (a: DropboxSettings | null, b: DropboxSettings | null) => JSON.stringify(a) === JSON.stringify(b);

/** Settings tab of the drop box, the corner area that saves dropped pictures into a store. */
export default function DropboxTab({ stores }: { stores: Store[] }) {
  const [status, setStatus] = useState<DropboxStatus | null>(null);
  const [draft, setDraft] = useState<DropboxSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const saved = useRef<DropboxSettings | null>(null);
  useEffect(() => {
    void invoke<DropboxStatus>("dropbox_status").then((value) => {
      saved.current = value.settings;
      setStatus(value);
      setDraft(value.settings);
    }).catch((error) => setMessage(String(error)));
    // The tray and the drop box's own menu change settings too; unapplied edits are kept.
    const listening = listen<DropboxSettings>("dropbox-settings", ({ payload }) => {
      // React runs the updater later, so compare with the settings saved before this change.
      const previous = saved.current;
      saved.current = payload;
      setDraft((current) => (!current || same(current, previous) ? payload : current));
      setStatus((current) => current && { ...current, settings: payload });
    });
    return () => { void listening.then((unlisten) => unlisten()); };
  }, []);
  if (!status || !draft) return <p className="server-message">{message || "Loading…"}</p>;

  const update = (patch: Partial<DropboxSettings>) => setDraft({ ...draft, ...patch });
  const number = (value: string) => Math.round(Number(value) || 0);
  const apply = async () => {
    setBusy(true); setMessage("");
    try {
      const next = await invoke<DropboxStatus>("dropbox_configure", { settings: draft });
      saved.current = next.settings;
      setStatus(next);
      setDraft(next.settings);
      setMessage("Settings applied.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const store = stores.find((item) => item.id === draft.storeId);

  return <section className="settings-section">
    <h3>Drop box</h3>
    <small>A translucent area in a corner of the screen. Drop pictures on it from the browser, a file manager or any other program to save them into an image store.</small>
    <div className="workspace-form">
      <label className="check-label"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} /> Show the drop box</label>
      <label>Save into<select value={store ? draft.storeId : ""} disabled={busy || !stores.length} onChange={(e) => update({ storeId: e.target.value })}>
        {!store && <option value="">{stores.length ? "Choose a store" : "Create an image store first"}</option>}
        {stores.map((item) => <option key={item.id} value={item.id}>{item.name}{item.immich ? " · Immich" : ""}</option>)}
      </select></label>
      <small>{store?.immich
        ? "Pictures are uploaded to Immich, which files them and skips pictures it already has."
        : "Pictures are saved as ab/cd/<SHA-1>.jpg, and a picture already in the store is skipped."}</small>

      <label className="check-label"><input type="checkbox" checked={draft.pinned} disabled={busy} onChange={(e) => update({ pinned: e.target.checked })} /> Always visible</label>
      <small>{status.hotkeys
        ? "Otherwise hold Win+Ctrl to show it. While holding them, press V to save the picture on the clipboard."
        : "Showing it with Win+Ctrl needs an X11 session, so keep it always visible."} Right-click it to change the store.</small>

      <div className="form-row">
        <label>Screen<select value={draft.monitor} disabled={busy} onChange={(e) => update({ monitor: e.target.value as DropboxSettings["monitor"] })}>
          <option value="left">Left</option>
          <option value="middle">Middle</option>
          <option value="right">Right</option>
        </select></label>
        <label>Margin (px)<input type="number" min={0} max={2000} value={draft.margin} disabled={busy} onChange={(e) => update({ margin: number(e.target.value) })} /></label>
      </div>
      <div className="form-row">
        <label>Width (px)<input type="number" min={50} max={4000} value={draft.width} disabled={busy} onChange={(e) => update({ width: number(e.target.value) })} /></label>
        <label>Height (px)<input type="number" min={50} max={4000} value={draft.height} disabled={busy} onChange={(e) => update({ height: number(e.target.value) })} /></label>
      </div>
      <label>Opacity · {Math.round(draft.opacity * 100)}%<input type="range" min={0.05} max={1} step={0.05} value={draft.opacity} disabled={busy} onChange={(e) => update({ opacity: Number(e.target.value) })} /></label>
    </div>
    <div className="settings-actions">
      {message && <p className="server-message">{message}</p>}
      <button className="leave-yes" disabled={busy || same(draft, status.settings)} onClick={() => void apply()}>Apply</button>
    </div>
  </section>;
}
