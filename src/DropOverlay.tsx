import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type OverlayState = { visible: boolean; dragging: boolean; storeName: string | null; busy: number };
type DropReport = { outcome: "saved" | "duplicate" | "failed"; message: string };

// A short flash of the outcome. Failures stay long enough to read, and Rust keeps the window clear meanwhile.
const FLASH_MS = { saved: 650, duplicate: 500, failed: 650 };
const MESSAGE_MS = { saved: 3000, duplicate: 3000, failed: 8000 };

/**
 * The page of the drop box window. Rust handles drops and the right-click menu natively and sets the
 * window's opacity; the page shows the store, outcomes and progress.
 */
export default function DropOverlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [flash, setFlash] = useState<DropReport["outcome"] | null>(null);
  const [message, setMessage] = useState<DropReport | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("dropbox-window");
    void invoke<OverlayState>("dropbox_overlay_state").then(setState).catch(() => {});
    const timers: number[] = [];
    const listeners = [
      listen<OverlayState>("dropbox-state", ({ payload }) => setState(payload)),
      listen<DropReport>("dropbox-result", ({ payload }) => {
        timers.forEach(window.clearTimeout);
        timers.length = 0;
        setFlash(payload.outcome);
        setMessage(payload);
        timers.push(window.setTimeout(() => setFlash(null), FLASH_MS[payload.outcome]));
        timers.push(window.setTimeout(() => setMessage(null), MESSAGE_MS[payload.outcome]));
      }),
    ];
    return () => {
      timers.forEach(window.clearTimeout);
      listeners.forEach((listening) => void listening.then((unlisten) => unlisten()));
    };
  }, []);

  if (!state) return null;
  return <div className={`dropbox ${state.dragging ? "dragging" : ""}`}>
    <div className={`dropbox-flash ${flash ?? ""}`} />
    <div className="dropbox-label"><strong>{state.storeName ?? "No store"}</strong></div>
    {message && <p className={`dropbox-message ${message.outcome}`}>{message.message}</p>}
    {state.busy > 0 && <span className="dropbox-busy" title="Saving" />}
  </div>;
}
