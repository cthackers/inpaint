import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
type Status = { ready: boolean; running: boolean; stage: string; log: string[]; directory: string; error?: string };
type Progress = { label: string; detail: string; percent?: number; done?: boolean };

export default function RuntimeSetup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [gpu, setGpu] = useState(true);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => { void invoke<Status>("runtime_status").then((value) => {
      if (!active) return;
      setStatus(value);
      if (value.ready) window.clearInterval(timer);
    }).catch((e) => { if (active) setError(String(e)); }); };
    refresh();
    const timer = window.setInterval(refresh, 1500);
    const listening = listen<Progress>("model-progress", (event) => setProgress(event.payload.done ? null : event.payload));
    return () => { active = false; clearInterval(timer); void listening.then((unlisten) => unlisten()); };
  }, []);
  if (!status?.ready) return <div className="setup-backdrop"><section className="setup-card">
    <h1>Set up Inpaint</h1><p>Install the private Python runtime and editing tools. Models download only when you use them.</p>
    <label>Processing hardware<select disabled={status?.running} value={gpu ? "gpu" : "cpu"} onChange={(e) => setGpu(e.target.value === "gpu")}><option value="gpu">NVIDIA GPU · CUDA 12.8 driver required</option><option value="cpu">CPU · Any supported Linux machine</option></select></label>
    <p className="path-text">Storage: {status?.directory || "Locating application storage…"}</p>
    <p>The initial installation needs internet access and several gigabytes of disk space. Your pictures stay on this computer.</p>
    {status?.running && <><strong>{status.stage}</strong><progress /><pre>{status.log.slice(-12).join("\n")}</pre></>}
    {(error || status?.error) && <p className="setup-error">{error || status?.error}</p>}
    <button className="primary-button" disabled={!status || status.running} onClick={() => { setError(""); setStatus((old) => old ? { ...old, running: true } : old); void invoke("setup_runtime", { gpu }).catch((e) => setError(String(e))); }}>{status?.running ? "Installing…" : error || status?.error ? "Retry installation" : "Install and continue"}</button>
    <small>Linux system libraries are included in the AppImage distribution. GPU drivers remain a system requirement.</small>
  </section></div>;
  return <>{children}{progress && <div className="download-status" role="status"><strong>{progress.label}</strong><span>{progress.detail}</span><progress max="100" value={progress.percent ?? undefined} />{progress.percent !== undefined && <span>{progress.percent}%</span>}</div>}</>;
}
