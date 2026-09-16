import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { comboOf, FIXED_KEYS, keyLabel, resetShortcut, setShortcut, SHORTCUTS, useShortcutKeys, type ShortcutId } from "./shortcuts";

/**
 * The shortcuts, grouped as the editor uses them. Clicking a key waits for the next one pressed:
 * Escape leaves it as it was, Backspace or Delete takes the key away, and a key already in use is
 * moved here from the shortcut that had it.
 */
export default function ShortcutsTab() {
  const keys = useShortcutKeys();
  const [waiting, setWaiting] = useState<ShortcutId | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!waiting) return;
    // Captured before anything else, so the key does not also close the settings or reach the editor.
    const listen = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") { setWaiting(null); return; }
      if (event.key === "Backspace" || event.key === "Delete") {
        setShortcut(waiting, "");
        setNote("");
        setWaiting(null);
        return;
      }
      const combo = comboOf(event);
      if (!combo) return;
      if (FIXED_KEYS.includes(combo)) {
        setNote(`${keyLabel(combo)} always does the same thing in the editor. Choose another key.`);
        return;
      }
      const taken = (Object.keys(keys) as ShortcutId[]).find((id) => id !== waiting && keys[id] === combo);
      if (taken) {
        setShortcut(taken, "");
        setNote(`${keyLabel(combo)} was ${SHORTCUTS.find((shortcut) => shortcut.id === taken)?.label}; that one has no key now.`);
      } else {
        setNote("");
      }
      setShortcut(waiting, combo);
      setWaiting(null);
    };
    window.addEventListener("keydown", listen, true);
    return () => window.removeEventListener("keydown", listen, true);
  }, [waiting, keys]);

  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];
  const changed = SHORTCUTS.some((shortcut) => keys[shortcut.id] !== shortcut.keys);

  return <div className="settings-section shortcut-settings">
    <div className="shortcut-heading">
      <h3>Shortcuts</h3>
      <button type="button" disabled={!changed} onClick={() => { resetShortcut(); setNote(""); }}><RotateCcw size={14} /> Reset all</button>
    </div>
    <small>Click a key, then press the new one. Escape keeps it, Backspace removes it. ← → and Esc stay as they are.</small>
    {note && <p className="server-message">{note}</p>}
    {groups.map((group) => <section key={group} className="shortcut-group">
      <h4>{group}</h4>
      {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => {
        const current = keys[shortcut.id];
        const custom = current !== shortcut.keys;
        return <div key={shortcut.id} className="shortcut-row">
          <span>{shortcut.label}</span>
          <button type="button" className={`shortcut-key ${waiting === shortcut.id ? "waiting" : ""} ${custom ? "custom" : ""}`}
            onClick={() => { setNote(""); setWaiting(waiting === shortcut.id ? null : shortcut.id); }}>
            {waiting === shortcut.id ? "Press a key…" : current ? keyLabel(current) : "None"}
          </button>
          <button type="button" className="icon-button shortcut-reset" disabled={!custom} title={`Back to ${keyLabel(shortcut.keys)}`}
            aria-label={`Reset ${shortcut.label}`} onClick={() => resetShortcut(shortcut.id)}><RotateCcw size={13} /></button>
        </div>;
      })}
    </section>)}
  </div>;
}
