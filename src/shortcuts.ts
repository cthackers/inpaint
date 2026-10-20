import { useSyncExternalStore } from "react";
import { storage } from "./storage";

/**
 * The editor's keyboard shortcuts: what each one does, the key it starts with, and the key the user gave
 * it instead. A key is written as its modifiers and name, `Ctrl+Shift+Z`, `Alt+[`, `NumpadAdd`, and a
 * shortcut the user cleared has no key at all.
 */
export const SHORTCUTS = [
  { id: "tool.restore", group: "Tools", label: "Restore detail", keys: "Alt+T" },
  { id: "tool.upscale", group: "Tools", label: "Upscale image", keys: "Alt+U" },
  { id: "tool.downscale", group: "Tools", label: "Downscale image", keys: "Alt+Z" },
  { id: "tool.gfpgan", group: "Tools", label: "Restore faces · GFPGAN", keys: "Alt+F" },
  { id: "tool.faceSwap", group: "Tools", label: "Replace selected / largest face", keys: "Alt+R" },
  { id: "tool.detectFaces", group: "Tools", label: "Detect / choose a face", keys: "Alt+D" },
  { id: "tool.removeBackground", group: "Tools", label: "Remove background", keys: "Alt+B" },
  { id: "tool.applyBackground", group: "Tools", label: "Apply replacement background", keys: "Alt+G" },
  { id: "tool.refineEdges", group: "Tools", label: "Refine background edges", keys: "Alt+E" },
  { id: "tool.crop", group: "Tools", label: "Toggle crop / straighten", keys: "Alt+C" },
  { id: "tool.flipHorizontal", group: "Tools", label: "Flip horizontally", keys: "Alt+H" },
  { id: "tool.flipVertical", group: "Tools", label: "Flip vertically", keys: "Alt+V" },
  { id: "tool.rotateLeft", group: "Tools", label: "Rotate left", keys: "Alt+[" },
  { id: "tool.rotateRight", group: "Tools", label: "Rotate right", keys: "Alt+]" },

  // Numbered in the order the tabs stand in the rail.
  { id: "panel.info", group: "Panels", label: "Info", keys: "Alt+1" },
  { id: "panel.annotations", group: "Panels", label: "Annotations", keys: "Alt+2" },
  { id: "panel.history", group: "Panels", label: "History", keys: "Alt+3" },
  { id: "panel.workflows", group: "Panels", label: "Workflows", keys: "Alt+4" },
  { id: "panel.batch", group: "Panels", label: "Batch", keys: "Alt+5" },
  { id: "panel.export", group: "Panels", label: "Export", keys: "Alt+6" },
  { id: "panel.memory", group: "Panels", label: "Memory", keys: "Alt+7" },
  { id: "panel.strip", group: "Panels", label: "Picture strip", keys: "S" },

  { id: "workspace.runWorkflow", group: "Workflows and export", label: "Run the selected workflow", keys: "Alt+W" },
  { id: "workspace.export", group: "Workflows and export", label: "Export a copy", keys: "Alt+X" },
  { id: "workspace.runBatch", group: "Workflows and export", label: "Run the batch", keys: "Alt+Shift+B" },

  { id: "editor.save", group: "Editor", label: "Save", keys: "Ctrl+S" },
  { id: "editor.undo", group: "Editor", label: "Undo", keys: "Ctrl+Z" },
  { id: "editor.redo", group: "Editor", label: "Redo", keys: "Ctrl+Y" },
  { id: "editor.original", group: "Editor", label: "Show the original", keys: "O" },
  { id: "editor.previous", group: "Editor", label: "Previous picture", keys: "A" },
  { id: "editor.next", group: "Editor", label: "Next picture", keys: "D" },
  { id: "editor.first", group: "Editor", label: "First picture", keys: "Home" },
  { id: "editor.last", group: "Editor", label: "Last picture", keys: "End" },
  { id: "editor.fit", group: "Editor", label: "Fit and center", keys: "NumpadMultiply" },
  { id: "editor.actualSize", group: "Editor", label: "Actual size", keys: "NumpadDivide" },
  { id: "editor.zoomIn", group: "Editor", label: "Zoom in", keys: "NumpadAdd" },
  { id: "editor.zoomOut", group: "Editor", label: "Zoom out", keys: "NumpadSubtract" },
  { id: "editor.keep", group: "Editor", label: "Keep or delete, in a group of duplicates", keys: "K" },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** Keys that always do the same thing and cannot be given to anything else. */
export const FIXED_KEYS = ["Space", "Escape", "ArrowLeft", "ArrowRight", "Ctrl+Shift+Z"];

const PREFERENCE = "inpaint.shortcuts";
const MODIFIERS = ["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock"];

/** The key an event stands for, in the same spelling as the defaults; empty for a lone modifier. */
export function comboOf(event: KeyboardEvent | React.KeyboardEvent): string {
  if (MODIFIERS.includes(event.key)) return "";
  const key = event.code.startsWith("Numpad") && !/^Numpad\d$/.test(event.code) ? event.code
    : event.code === "Space" ? "Space"
    : event.key.length === 1 ? event.key.toUpperCase()
    : event.key;
  return [event.ctrlKey && "Ctrl", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** A key as the settings and tooltips show it. */
export const keyLabel = (combo: string) => combo
  .replace("NumpadMultiply", "Numpad *").replace("NumpadDivide", "Numpad /").replace("NumpadAdd", "Numpad +").replace("NumpadSubtract", "Numpad −")
  .replace("ArrowLeft", "←").replace("ArrowRight", "→");

type Overrides = Partial<Record<ShortcutId, string>>;

function read(): Overrides {
  try {
    const saved = JSON.parse(storage.getItem(PREFERENCE) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    const known = new Set<string>(SHORTCUTS.map((shortcut) => shortcut.id));
    return Object.fromEntries(Object.entries(saved).filter(([id, keys]) => known.has(id) && typeof keys === "string")) as Overrides;
  } catch {
    return {};
  }
}

let overrides: Overrides | null = null;
let current: Record<ShortcutId, string> | null = null;
const listeners = new Set<() => void>();

function keys(): Record<ShortcutId, string> {
  if (!current) {
    overrides ??= read();
    current = Object.fromEntries(SHORTCUTS.map((shortcut) => [shortcut.id, overrides?.[shortcut.id] ?? shortcut.keys])) as Record<ShortcutId, string>;
  }
  return current;
}

function write(next: Overrides) {
  overrides = next;
  current = null;
  storage.setItem(PREFERENCE, JSON.stringify(next));
  for (const listener of listeners) listener();
}

/** Gives a shortcut another key, or none with an empty one. */
export function setShortcut(id: ShortcutId, combo: string) {
  const defaults = SHORTCUTS.find((shortcut) => shortcut.id === id)?.keys;
  const next = { ...(overrides ?? read()) };
  if (combo === defaults) delete next[id];
  else next[id] = combo;
  write(next);
}

/** Puts one shortcut, or every one, back to the key it started with. */
export function resetShortcut(id?: ShortcutId) {
  if (!id) return write({});
  const next = { ...(overrides ?? read()) };
  delete next[id];
  write(next);
}

/** Every shortcut's key, following changes made in the settings while the editor is open. */
export function useShortcutKeys() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, keys);
}

/** The shortcut a key starts, if any. */
export function shortcutFor(map: Record<ShortcutId, string>, combo: string): ShortcutId | undefined {
  if (!combo) return undefined;
  return (Object.keys(map) as ShortcutId[]).find((id) => map[id] === combo);
}
