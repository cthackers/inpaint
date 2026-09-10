// Settings for the Inpaint integration, shared by the service worker and the options page.
// Content scripts only read the Immich address from them.

export const SETTINGS_KEY = 'inpaintSettings';

export const DEFAULT_SETTINGS = {
    appUrl: 'http://127.0.0.1:7865',
    token: '',
    immich: { url: '', apiKey: '', mappings: [] }
};

export async function loadSettings() {
    const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
    return {
        ...DEFAULT_SETTINGS,
        ...saved,
        immich: { ...DEFAULT_SETTINGS.immich, ...saved.immich }
    };
}

export function saveSettings(settings) {
    return chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
