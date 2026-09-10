import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronsRight, Play, Plus, Trash2 } from "lucide-react";

// Thumbnails of saved face photos stay loaded while the app runs, so moving between pictures does not
// read them again. null marks a photo that could not be read.
const thumbnails = new Map<string, string | null>();

// Space kept between the column and the window's top and bottom edges.
const EDGE = 8;

const fileName = (path: string) => path.split("/").at(-1) ?? path;

type CardProps = {
  path: string;
  active: boolean;
  busy: boolean;
  onUse: (path: string, preview: string) => void;
  onApply: (path: string) => void;
  onRemove: (path: string) => void;
};

function FaceCard({ path, active, busy, onUse, onApply, onRemove }: CardProps) {
  const [preview, setPreview] = useState(() => thumbnails.get(path));
  useEffect(() => {
    if (preview !== undefined) return;
    let current = true;
    invoke<string>("read_thumbnail_data", { path })
      .then((data) => { thumbnails.set(path, data); if (current) setPreview(data); })
      .catch(() => { thumbnails.set(path, null); if (current) setPreview(null); });
    return () => { current = false; };
  }, [path, preview]);
  const name = fileName(path);
  const missing = preview === null;

  return <li className={`face-card ${active ? "active" : ""}`}>
    <button type="button" className="face-card-photo" disabled={busy || !preview} aria-pressed={active}
      title={missing ? `${path} cannot be read` : active ? `${name} is in use` : `Use ${name}`}
      onClick={() => { if (preview) onUse(path, preview); }}>
      {preview ? <img src={preview} alt={name} draggable={false} /> : missing ? <span className="face-card-missing">Missing</span> : <span className="thumbnail-loading" />}
      {active && <span className="face-card-badge"><Check size={11} strokeWidth={3} /> In use</span>}
    </button>
    <div className="face-card-actions">
      <button type="button" title="Remove from saved faces" aria-label={`Remove ${name} from saved faces`} onClick={() => onRemove(path)}><Trash2 size={14} /></button>
      <button type="button" title="Replace the face with this photo" aria-label={`Replace the face with ${name}`} disabled={busy || missing} onClick={() => onApply(path)}><Play size={14} /></button>
    </div>
  </li>;
}

type Props = {
  paths: string[];
  activePath?: string;
  busy: boolean;
  /** Makes a saved photo the face source; the preview is its thumbnail. */
  onUse: (path: string, preview: string) => void;
  /** Replaces the face with a saved photo without making it the face source. */
  onApply: (path: string) => void;
  onRemove: (path: string) => void;
  onAdd: () => void;
};

/**
 * The saved face photos: a tab beside the face source picker that opens a column of cards to the right
 * of the tool panel while hovered. The column is placed on the page, so the scrolling panel cannot clip it.
 */
export default function FaceLibrary({ paths, activePath, busy, onUse, onApply, onRemove, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef(0);
  const show = () => { window.clearTimeout(closeTimer.current); setOpen(true); };
  // A short delay lets the pointer cross from the tab to the column.
  const hideSoon = () => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 240); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    // The cards, not the heading and Add button, are centred on the tab and the photo beside it; the
    // column may use the whole window height and stays inside it.
    const measure = () => {
      const trigger = triggerRef.current;
      const column = columnRef.current;
      if (!trigger || !column) return;
      const box = trigger.getBoundingClientRect();
      const panel = trigger.closest(".plugin-toolbar")?.getBoundingClientRect();
      const list = column.querySelector("ul");
      const listMiddle = list ? list.offsetTop + list.offsetHeight / 2 : column.offsetHeight / 2;
      const maxHeight = window.innerHeight - EDGE * 2;
      const height = Math.min(column.offsetHeight, maxHeight);
      const wanted = box.top + box.height / 2 - listMiddle;
      const next = {
        left: panel ? panel.right : box.right + 6,
        top: Math.round(Math.max(EDGE, Math.min(wanted, window.innerHeight - EDGE - height))),
        maxHeight,
      };
      setPlace((current) => current && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next);
    };
    // Escape closes the column instead of leaving the editor.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setOpen(false);
    };
    measure();
    const resized = new ResizeObserver(measure);
    if (columnRef.current) resized.observe(columnRef.current);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open, paths.length]);

  return <>
    <button ref={triggerRef} type="button" className={`face-library-trigger ${open ? "open" : ""}`}
      aria-haspopup="true" aria-expanded={open} aria-label={`Saved faces: ${paths.length}`} title="Saved faces"
      // Clicking opens it as well, for keyboards; hovering has usually opened it already, so it never toggles.
      onMouseEnter={show} onMouseLeave={hideSoon} onClick={show}>
      <ChevronsRight size={16} />
    </button>
    {open && createPortal(
      // Hidden until placed, so the first frame never shows it in the wrong spot.
      <div ref={columnRef} className="face-library" role="dialog" aria-label="Saved faces"
        style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { visibility: "hidden", top: EDGE, maxHeight: window.innerHeight - EDGE * 2 }}
        onMouseEnter={show} onMouseLeave={hideSoon}>
        <div className="face-library-heading"><span>Saved faces</span><small>{paths.length}</small></div>
        <ul>
          {paths.map((path) => <FaceCard key={path} path={path} active={path === activePath} busy={busy} onUse={onUse} onApply={onApply} onRemove={onRemove} />)}
        </ul>
        <button type="button" className="face-library-add" disabled={busy} onClick={onAdd}><Plus size={14} /> Add photos</button>
      </div>,
      document.body,
    )}
  </>;
}
