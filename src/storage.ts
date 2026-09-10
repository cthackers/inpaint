import { invoke } from "@tauri-apps/api/core";

// The editor's preferences and the user's data (workflows, saved faces, last folder and more) live in
// Inpaint's database. They load once before the app renders and are read synchronously from memory;
// changes are written back shortly after, so dragging a slider does not write on every step.
const values = new Map<string, string>();
const pending = new Map<string, string | null>();
const WRITE_DELAY_MS = 250;
let timer = 0;

function flush() {
  window.clearTimeout(timer);
  timer = 0;
  for (const [key, value] of pending) {
    void invoke("preferences_set", { key, value }).catch((error) => console.error(`Cannot save ${key}`, error));
  }
  pending.clear();
}

function schedule(key: string, value: string | null) {
  pending.set(key, value);
  if (!timer) timer = window.setTimeout(flush, WRITE_DELAY_MS);
}

// The webview's local storage held these before the database; it is read only to bring them over.
function legacyEntries() {
  try {
    return Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("inpaint.")).map((key) => [key, localStorage.getItem(key) ?? ""]));
  } catch {
    return {};
  }
}

export async function loadStorage() {
  try {
    let saved = await invoke<Record<string, string>>("preferences_all");
    if (!Object.keys(saved).length) {
      const legacy = legacyEntries();
      if (Object.keys(legacy).length) {
        await invoke("preferences_import", { entries: legacy });
        saved = legacy;
      }
    }
    for (const [key, value] of Object.entries(saved)) values.set(key, value);
  } catch (error) {
    console.error("Cannot load preferences", error);
  }
  window.addEventListener("pagehide", flush);
}

/** Like localStorage, backed by the preferences in Inpaint's database. */
export const storage = {
  getItem(key: string): string | null {
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (values.get(key) === value) return;
    values.set(key, value);
    schedule(key, value);
  },
  removeItem(key: string) {
    if (!values.has(key)) return;
    values.delete(key);
    schedule(key, null);
  },
};
