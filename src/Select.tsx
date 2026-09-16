import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type Choice = { value: string; label: ReactNode; text: string; disabled: boolean };

type Props = {
  value: string | number;
  /** Called like a native select's handler, so `event.target.value` keeps working where it is used. */
  onChange?: (event: { target: { value: string } }) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  id?: string;
};

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children)
    : "";

/** The `<option>` children, including those inside fragments, as the choices the list shows. */
function choicesOf(children: ReactNode): Choice[] {
  const found: Choice[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>;
    if (element.type === "option") {
      const label = element.props.children;
      found.push({ value: String(element.props.value ?? textOf(label)), label, text: textOf(label), disabled: !!element.props.disabled });
    } else if (element.props.children) {
      found.push(...choicesOf(element.props.children));
    }
  });
  return found;
}

/**
 * A dark list in place of the browser's own, which WebKit draws in light colours over the app. It takes
 * the same props and `<option>` children as `<select>`, so swapping one for the other changes nothing
 * else: arrows, Home/End, Enter, Escape and typing the start of a choice work as they do in a select.
 */
export default function Select({ value, onChange, disabled, className = "", children, id, ...rest }: Props) {
  const choices = choicesOf(children);
  const current = choices.find((choice) => choice.value === String(value));
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const choose = (choice: Choice | undefined) => {
    if (!choice || choice.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (choice.value !== String(value)) onChange?.({ target: { value: choice.value } });
  };

  const show = () => {
    if (disabled || !choices.length) return;
    setHighlight(Math.max(0, choices.findIndex((choice) => choice.value === String(value))));
    setOpen(true);
  };

  // The list hangs below the button, or above it when the window has more room there.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const measure = () => {
      const box = button.current?.getBoundingClientRect();
      if (!box) return;
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const wanted = Math.min(320, choices.length * 32 + 10);
      const upward = below < wanted && above > below;
      setPlace({
        left: box.left, width: Math.max(box.width, 160),
        top: upward ? box.top - 4 : box.bottom + 4,
        maxHeight: Math.max(120, Math.min(320, upward ? above : below)),
        above: upward,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, choices.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    // A panel scrolling under an open list would leave it hanging in the wrong place.
    const closeOnScroll = (event: Event) => { if (!list.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, place]);

  const move = (from: number, step: number) => {
    for (let at = from + step; at >= 0 && at < choices.length; at += step) if (!choices[at].disabled) return at;
    return from;
  };

  const keyDown = (event: React.KeyboardEvent) => {
    // Like a focused select, the keys belong to the list, not to the editor's shortcuts.
    if (event.key !== "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
    if (disabled) return;
    const at = open ? highlight : Math.max(0, choices.findIndex((choice) => choice.value === String(value)));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = move(at, event.key === "ArrowDown" ? 1 : -1);
      if (open) setHighlight(next); else choose(choices[next]);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? move(-1, 1) : move(choices.length, -1);
      if (open) setHighlight(next); else choose(choices[next]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(choices[highlight]); else show();
    } else if (event.key === "Escape") {
      if (open) { event.preventDefault(); setOpen(false); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing the start of a choice jumps to it.
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + event.key.toLowerCase() : event.key.toLowerCase(), at: now };
      const found = choices.findIndex((choice) => !choice.disabled && choice.text.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) { if (open) setHighlight(found); else choose(choices[found]); }
    }
  };

  return <>
    <button ref={button} type="button" id={id} className={`select-button ${open ? "open" : ""} ${className}`} disabled={disabled}
      role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={rest["aria-label"]}
      onClick={() => (open ? setOpen(false) : show())} onKeyDown={keyDown}>
      <span>{current?.label ?? ""}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && place && createPortal(
      <ul ref={list} id={listId} role="listbox" className="select-list"
        style={{ left: place.left, width: place.width, maxHeight: place.maxHeight, ...(place.above ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}
        onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        {choices.map((choice, at) => <li key={`${choice.value}-${at}`} data-index={at} role="option" aria-selected={choice.value === String(value)} aria-disabled={choice.disabled}
          className={`${at === highlight ? "active" : ""} ${choice.value === String(value) ? "chosen" : ""} ${choice.disabled ? "disabled" : ""}`}
          onMouseEnter={() => setHighlight(at)}
          onMouseDown={(event) => { event.preventDefault(); choose(choice); }}>
          <span>{choice.label}</span>
          {choice.value === String(value) && <Check size={13} aria-hidden="true" />}
        </li>)}
      </ul>,
      document.body,
    )}
  </>;
}
