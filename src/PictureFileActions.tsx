import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Clipboard, LoaderCircle } from "lucide-react";

/** Actions on the saved file, shared by the local and Immich Info panels. */
export default function PictureFileActions({ path, name }: { path: string; name?: string }) {
  const [pending, setPending] = useState<"reveal" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = async (action: "reveal" | "copy") => {
    setPending(action);
    setError("");
    setCopied(false);
    try {
      await invoke(action === "reveal" ? "reveal_image" : "copy_image_to_clipboard", { path });
      if (action === "copy") setCopied(true);
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(null);
    }
  };

  const copyLabel = copied ? "Image copied" : pending === "copy" ? "Copying image…" : "Copy image to clipboard";
  return <>
    <div className="picture-file-actions">
      <button type="button" className="picture-file-name" title={`Show in file explorer: ${path}`}
        disabled={pending !== null} onClick={() => void run("reveal")}>
        {name || path.split("/").pop() || path}
      </button>
      <button type="button" className="icon-button" title={copyLabel} aria-label={copyLabel}
        disabled={pending !== null} onClick={() => void run("copy")}>
        {pending === "copy" ? <LoaderCircle className="spin" size={14} /> : copied ? <Check size={14} /> : <Clipboard size={14} />}
      </button>
    </div>
    {copied && <small className="immich-muted" role="status">Image copied</small>}
    {error && <p className="immich-error" role="alert">{error}</p>}
  </>;
}
