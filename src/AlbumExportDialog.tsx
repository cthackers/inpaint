import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import type { AlbumExportRequest } from "./albumExport";

type Progress = { done: number; total: number };
type ExportResult = { copied: number; failures: { path: string; error: string }[] };

export default function AlbumExportDialog({ request, onClose }: { request: AlbumExportRequest; onClose: () => void }) {
  const [destination, setDestination] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const busy = choosing || running;
  const started = useRef(false);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [busy, onClose]);

  const choose = async () => {
    setChoosing(true);
    setError("");
    try {
      const folder = await open({ directory: true, multiple: false, title: `Export “${request.name}” to folder`, defaultPath: destination || undefined });
      if (typeof folder === "string") setDestination(folder);
    } catch (error) {
      setError(String(error));
    } finally {
      setChoosing(false);
    }
  };

  const start = async () => {
    if (started.current || !destination) return;
    started.current = true;
    setRunning(true);
    setProgress(null);
    setError("");
    try {
      const paths = await request.loadPaths();
      const onProgress = new Channel<Progress>(setProgress);
      setResult(await invoke<ExportResult>("export_pictures", { paths, destination, onProgress }));
    } catch (error) {
      setError(String(error));
    } finally {
      started.current = false;
      setRunning(false);
    }
  };

  return <div className="leave-dialog-backdrop" role="presentation">
    <div className="server-dialog album-export-dialog" role="dialog" aria-modal="true" aria-labelledby="album-export-title"
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="server-dialog-heading">
        <strong id="album-export-title">Export “{request.name}”</strong>
        <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={17} /></button>
      </div>
      <p>Copy all pictures, including nested albums, into the chosen folder. Gallery filters do not limit the export.</p>
      <p>Files keep their saved format and embedded metadata. Matching filenames get a number; existing files stay unchanged.</p>
      <div className="album-export-destination">
        <span>{destination || "Choose a destination folder"}</span>
        {!result && <button type="button" autoFocus disabled={busy} onClick={() => void choose()}><FolderOpen size={15} /> Browse…</button>}
      </div>
      {running && <div role="status" aria-live="polite" className="album-export-progress">
        <span><LoaderCircle className="spin" size={15} /> {progress ? `Exporting ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}…` : "Reading album pictures…"}</span>
        <progress aria-label="Export progress" max={progress?.total || 1} value={progress?.done} />
      </div>}
      {result && <p role="status">{result.copied.toLocaleString()} {result.copied === 1 ? "picture" : "pictures"} exported.
        {result.failures.length > 0 ? ` ${result.failures.length.toLocaleString()} could not be copied.` : result.copied === 0 ? " This album has no pictures to export." : ""}</p>}
      {!!result?.failures.length && <details className="album-export-failures" open>
        <summary>Files that could not be copied</summary>
        <ul>{result.failures.map((failure, index) => <li key={index}><strong>{failure.path}</strong><br />{failure.error}</li>)}</ul>
      </details>}
      {error && <p className="immich-error" role="alert">{error}</p>}
      <div className="leave-dialog-actions">
        <button type="button" className="leave-no" disabled={busy} onClick={onClose}>{result ? "Close" : "Cancel"}</button>
        {result
          ? <button type="button" className="leave-yes" onClick={() => void invoke("open_folder", { path: destination }).catch((error) => setError(String(error)))}>Open folder</button>
          : <button type="button" className="leave-yes" disabled={busy || !destination} onClick={() => void start()}>Export album</button>}
      </div>
    </div>
  </div>;
}
