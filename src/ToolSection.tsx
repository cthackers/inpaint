import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, GripVertical, type LucideIcon } from "lucide-react";
import { usePreference } from "./preferences";

/** One collapsible tool in the editor's left panel, as the rail and the reordering see it. */
export type SectionEntry = { id: string; title: string; icon: LucideIcon; node: ReactNode };

/** A tool section being dragged to another place in the panel. */
export const SECTION_DRAG = "application/x-inpaint-section";

export default function ToolSection({ id, title, icon: Icon, defaultOpen = true, children, className = "", openSignal = 0, onMove }: {
  id: string; title: string; icon: LucideIcon; defaultOpen?: boolean; children: ReactNode; className?: string;
  /** Rises when the rail asks for this section, which opens it wherever it was left. */
  openSignal?: number;
  /** Given, the heading can be dragged onto another section to change their order. */
  onMove?: (moved: string, before: string) => void;
}) {
  const [expanded, setExpanded] = usePreference(`inpaint.section.${id}`, defaultOpen);
  const [dropping, setDropping] = useState(false);
  // The section lights up for a moment when the rail asks for it, so it is clear which one it opened.
  const [asked, setAsked] = useState(false);
  const contentId = useId();
  useEffect(() => {
    if (openSignal <= 0) return;
    setExpanded(true);
    setAsked(true);
    const stop = window.setTimeout(() => setAsked(false), 900);
    return () => window.clearTimeout(stop);
  // Only a new signal opens the section; the user may close it again afterwards.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  return <section id={`tool-${id}`} className={`plugin-section tool-section ${dropping ? "dropping" : ""} ${asked ? "asked" : ""} ${className}`}>
    <button type="button" className="tool-section-heading" aria-expanded={expanded} aria-controls={contentId}
      draggable={!!onMove}
      onDragStart={(event) => { event.dataTransfer.setData(SECTION_DRAG, id); event.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(event) => { if (onMove && event.dataTransfer.types.includes(SECTION_DRAG)) { event.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        const moved = event.dataTransfer.getData(SECTION_DRAG);
        if (onMove && moved && moved !== id) { event.preventDefault(); onMove(moved, id); }
      }}
      onClick={() => setExpanded((value) => !value)}>
      {onMove && <GripVertical size={13} className="tool-section-grip" aria-hidden="true" />}
      <Icon size={16} aria-hidden="true" /><span>{title}</span><ChevronDown size={15} className={expanded ? "expanded" : ""} aria-hidden="true" />
    </button>
    <div id={contentId} hidden={!expanded} className="tool-section-content">{expanded && children}</div>
  </section>;
}
