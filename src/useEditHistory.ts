import { useCallback, useState } from "react";
import type { Operation } from "./editorOperations";

export type HistoryEntry = { data: string; label: string; operation?: Operation };
export function useEditHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [position, setPosition] = useState(0);
  const [saved, setSaved] = useState("");
  const data = entries[position]?.data ?? "";
  const reset = useCallback((initial: string) => {
    setEntries(initial ? [{ data: initial, label: "Original" }] : []);
    setPosition(0); setSaved(initial);
  }, []);
  const commit = useCallback((next: string, label: string, operation?: Operation) => {
    setEntries((old) => [...old.slice(0, position + 1), { data: next, label, operation }]);
    setPosition(position + 1);
  }, [position]);
  const revise = useCallback((next: string, label: string, operation?: Operation) => {
    setEntries((old) => old.map((entry, index) => index === position ? { data: next, label, operation } : entry));
  }, [position]);
  const commitMany = useCallback((next: HistoryEntry[]) => {
    if (!next.length) return;
    setEntries((old) => [...old.slice(0, position + 1), ...next]);
    setPosition(position + next.length);
  }, [position]);
  return { entries, position, data, dirty: !!data && data !== saved, reset, commit, revise, commitMany,
    jump: setPosition, markSaved: () => setSaved(data), canUndo: position > 0, canRedo: position + 1 < entries.length };
}
