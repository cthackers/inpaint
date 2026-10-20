import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type HiddenStatus = { passwordSet: boolean; revealed: boolean; timeoutMinutes: number };

/** Asks for the password, or for a new one the first time. */
export function HiddenDialog({ passwordSet, onClose, onUnlocked }: { passwordSet: boolean; onClose: () => void; onUnlocked: (status: HiddenStatus) => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  const submit = async () => {
    if (!passwordSet && password !== repeat) { setError("The passwords are not the same."); return; }
    setBusy(true);
    setError("");
    try {
      onUnlocked(await invoke<HiddenStatus>("hidden_unlock", { password }));
    } catch (failure) {
      setError(String(failure));
      setPassword("");
      setRepeat("");
    } finally {
      setBusy(false);
    }
  };

  return <div className="leave-dialog-backdrop" role="presentation">
    <form className="server-dialog hidden-dialog" role="dialog" aria-modal="true" aria-labelledby="hidden-dialog-title"
      onKeyDown={(event) => event.stopPropagation()}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="server-dialog-heading">
        <strong id="hidden-dialog-title">{passwordSet ? "Password" : "Choose a password"}</strong>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="workspace-form">
        <label>{passwordSet ? "Password" : "New password"}
          <input type="password" autoFocus autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {!passwordSet && <label>Repeat it
          <input type="password" autoComplete="off" value={repeat} disabled={busy} onChange={(event) => setRepeat(event.target.value)} />
        </label>}
      </div>
      {error && <p className="server-message">{error}</p>}
      <div className="leave-dialog-actions">
        <button type="button" className="leave-no" onClick={onClose}>Cancel</button>
        <button type="submit" className="leave-yes" disabled={busy || !password || (!passwordSet && !repeat)}>{passwordSet ? "Unlock" : "Save"}</button>
      </div>
    </form>
  </div>;
}

/** The time without use after which hidden stores go away again. */
export function HiddenTab() {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void invoke<HiddenStatus>("hidden_status").then((status) => { setMinutes(status.timeoutMinutes); setSaved(status.timeoutMinutes); });
  }, []);
  if (minutes === null) return <p className="server-message">Loading…</p>;

  const apply = async () => {
    try {
      const status = await invoke<HiddenStatus>("hidden_configure", { timeoutMinutes: minutes });
      setSaved(status.timeoutMinutes);
      setMinutes(status.timeoutMinutes);
      setMessage("Settings applied.");
    } catch (failure) {
      setMessage(String(failure));
    }
  };

  return <section className="settings-section">
    <h3>Hidden</h3>
    <div className="workspace-form">
      <label>Hide again after this many minutes without use
        <input type="number" min={0} max={1440} value={minutes} onChange={(event) => setMinutes(Math.max(0, Math.min(1440, Math.round(Number(event.target.value) || 0))))} />
      </label>
      <small>Using the app, running duplicate searches, dropping pictures on the drop box and API requests all count as use. After a duplicate search ends, the full idle timeout starts again. 0 keeps them shown until Ctrl+Alt+H.</small>
    </div>
    <div className="settings-actions">
      {message && <p className="server-message">{message}</p>}
      <button className="leave-yes" disabled={minutes === saved} onClick={() => void apply()}>Apply</button>
    </div>
  </section>;
}
