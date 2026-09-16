import { useState } from "react";
import { Eye, EyeOff, SquareDashedMousePointer, Trash2, X } from "lucide-react";

/** A note on part of a picture; the box is in fractions of the picture's width and height. */
export type Annotation = { id: string; x: number; y: number; width: number; height: number; text: string; createdMs: number };

type Props = {
  annotations: Annotation[];
  /** False for a picture that was never saved, which has no path to keep notes under. */
  available: boolean;
  visible: boolean;
  drawing: boolean;
  onVisible: (visible: boolean) => void;
  onDrawing: (drawing: boolean) => void;
  /** The note under the pointer in the list, shown on the picture even while notes are hidden. */
  onHover: (id: string | null) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

/** The Annotations panel: the picture's notes, the switch that shows them, and drawing a new one. */
export default function AnnotationsPanel({ annotations, available, visible, drawing, onVisible, onDrawing, onHover, onEdit, onDelete, onClose }: Props) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // Keys typed here must not reach the editor's shortcuts, and pointer input must not paint on the canvas.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  const finishEdit = () => {
    if (editing && editing.text.trim()) onEdit(editing.id, editing.text);
    setEditing(null);
  };

  return <aside className="immich-panel annotations-panel" onKeyDown={stop} onPointerDown={stop} onWheel={stop}>
    <div className="immich-heading">
      <strong>Annotations</strong>
      <span className="immich-heading-actions">
        <button type="button" className="icon-button" title="Close" aria-label="Close the panel" onClick={onClose}><X size={16} /></button>
      </span>
    </div>
    <div className="immich-content">
      {!available ? <p className="immich-muted">Save the picture first; annotations are kept with a saved file.</p> : <>
        <div className="immich-toggles">
          <button type="button" className={`immich-toggle ${visible ? "on" : ""}`} aria-pressed={visible} onClick={() => onVisible(!visible)}>
            {visible ? <Eye size={15} /> : <EyeOff size={15} />} {visible ? "Shown" : "Hidden"}
          </button>
          <button type="button" className={`immich-toggle ${drawing ? "on" : ""}`} aria-pressed={drawing} onClick={() => onDrawing(!drawing)}>
            <SquareDashedMousePointer size={15} /> {drawing ? "Drawing" : "Draw a box"}
          </button>
        </div>
        <small className="immich-muted">{drawing
          ? "Drag over the picture, then write the note. Esc stops drawing."
          : "Hover a note on the picture to read it. Hover one here to find it."}</small>

        {annotations.length === 0
          ? <p className="immich-muted">No annotations on this picture yet.</p>
          : <ul className="annotation-list">
              {annotations.map((note) => <li key={note.id} onMouseEnter={() => onHover(note.id)} onMouseLeave={() => onHover(null)}>
                {editing?.id === note.id
                  ? <input autoFocus value={editing.text} aria-label="Annotation text" maxLength={2000}
                      onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                      onBlur={finishEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); finishEdit(); }
                        else if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                      }} />
                  : <button type="button" className="annotation-text" title={`${note.text}\n\nClick to change it.`} onClick={() => setEditing({ id: note.id, text: note.text })}>{note.text}</button>}
                <button type="button" className="icon-button annotation-delete" aria-label={`Delete “${note.text}”`} title="Delete"
                  onClick={() => { onHover(null); onDelete(note.id); }}><Trash2 size={14} /></button>
              </li>)}
            </ul>}
      </>}
    </div>
  </aside>;
}
