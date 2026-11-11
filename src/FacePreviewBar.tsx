import { ArrowLeft, ArrowRight, Check, LoaderCircle, X } from "lucide-react";
import type { FacePreview, PreviewProgress } from "./facePreviews";

export default function FacePreviewBar({ results, selected, busy, accepting, progress, errors, onSelect, onMove, previousKey, nextKey, onAccept, onDiscard, onStop }: {
  results: FacePreview[]; selected: string | null; busy: boolean; accepting: boolean;
  progress: PreviewProgress | null; errors: [string, string][];
  onMove: (direction: -1 | 1) => void; previousKey: string; nextKey: string;
  onSelect: (donor: string | null) => void; onAccept: () => void; onDiscard: () => void; onStop: () => void;
}) {
  const at = results.findIndex((item) => item.donor === selected);
  return <div className="face-preview-bar" role="region" aria-label="Face previews" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
    <div className="face-preview-heading"><strong>Compare faces</strong><div className="face-preview-progress"><span role="status">{busy ? <><LoaderCircle size={14} className="spin" /> Completed {progress?.done ?? 0} / {progress?.total ?? 1}</> : `${results.length} preview${results.length === 1 ? "" : "s"}`}</span><button type="button" disabled={!busy || accepting} title="Finish the running faces, then stop generating more previews" onClick={onStop}>Stop generation</button></div></div>
    <div className="face-preview-controls">
      <button type="button" disabled={!results.length || accepting} aria-label="Previous face preview" title={`Previous preview (←${previousKey ? ` / ${previousKey}` : ""})`} onClick={() => onMove(-1)}><ArrowLeft size={16} /></button>
      <span className="face-preview-name" title={selected ?? "Original before these previews"}>{at < 0 ? "Original" : `${at + 1}/${results.length} · ${selected?.split("/").at(-1)}`}</span>
      <button type="button" disabled={!results.length || accepting} aria-label="Next face preview" title={`Next preview (→${nextKey ? ` / ${nextKey}` : ""})`} onClick={() => onMove(1)}><ArrowRight size={16} /></button>
      <button type="button" disabled={accepting} aria-pressed={at < 0} onClick={() => onSelect(null)}>Original</button>
      <button type="button" className="accent" title="Apply selected preview (Space)" disabled={at < 0 || accepting} onClick={onAccept}><Check size={14} />{accepting ? "Applying…" : "Use this · Space"}</button>
      <button type="button" title="Discard previews and close (Esc)" disabled={accepting} onClick={onDiscard}><X size={14} /> Discard all · Esc</button>
    </div>
    <small>Every preview uses the same starting picture. Only “Use this” adds an edit; nothing is saved to the file yet.</small>
    {errors.length > 0 && <details><summary>{errors.length} face{errors.length === 1 ? "" : "s"} could not be previewed</summary>{errors.map(([path, error]) => <p key={path}>{path.split("/").at(-1)}: {error}</p>)}</details>}
  </div>;
}
