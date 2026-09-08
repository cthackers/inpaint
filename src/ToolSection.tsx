import { useId, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { usePreference } from "./preferences";

export default function ToolSection({ id, title, icon: Icon, defaultOpen = true, children, className = "" }: {
  id: string; title: string; icon: LucideIcon; defaultOpen?: boolean; children: ReactNode; className?: string;
}) {
  const [expanded, setExpanded] = usePreference(`inpaint.section.${id}`, defaultOpen);
  const contentId = useId();
  return <section className={`plugin-section tool-section ${className}`}>
    <button type="button" className="tool-section-heading" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded((value) => !value)}>
      <Icon size={16} aria-hidden="true" /><span>{title}</span><ChevronDown size={15} className={expanded ? "expanded" : ""} aria-hidden="true" />
    </button>
    <div id={contentId} hidden={!expanded} className="tool-section-content">{expanded && children}</div>
  </section>;
}
