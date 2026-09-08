import { useEffect, useState } from "react";

// Recover individual fields when preferences from an older version are incomplete.
function restore<T>(saved: unknown, fallback: T): T {
  if (typeof fallback === "number") return (typeof saved === "number" && Number.isFinite(saved) ? saved : fallback) as T;
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    const object = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [key, restore(object[key], value)])) as T;
  }
  return (typeof saved === typeof fallback && !Array.isArray(saved) ? saved : fallback) as T;
}

export function usePreference<T>(key: string, fallback: T, valid?: (value: T) => boolean) {
  const [value, setValue] = useState<T>(() => {
    try {
      const restored = restore(JSON.parse(localStorage.getItem(key) ?? "null"), fallback);
      return !valid || valid(restored) ? restored : fallback;
    } catch { return fallback; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Editing remains usable if local storage is unavailable or full. */ }
  }, [key, value]);
  return [value, setValue] as const;
}

// Preserve the storage format of existing model preferences.
export function useSavedChoice<T extends string | number>(key: string, choices: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try { return choices.find((choice) => String(choice) === localStorage.getItem(key)) ?? choices[0]; }
    catch { return choices[0]; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, String(value)); } catch { /* See above. */ }
  }, [key, value]);
  return [value, setValue] as const;
}
