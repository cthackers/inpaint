// Inpaint integration service worker.
//
// Content scripts ask it to run pictures through the Inpaint desktop app's local API
// and, for pictures on the configured Immich server, to use the Immich API. Both need
// secrets and cross-origin requests, which stay out of web pages this way.
// API reference: docs/server-api.md in the Inpaint repository.

import { loadSettings } from './settings.js';

const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ASSET_ID = /\/api\/assets\/([0-9a-f-]{36})\//i;
const MENU_OPEN = 'inpaint-open-editor';
const MENU_PANEL = 'inpaint-toggle-panel';

chrome.runtime.onInstalled.addListener(() => {
    // Face sources used to be picked from web pages; Inpaint's own selection replaced them.
    chrome.storage.local.remove('inpaintDonor');
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: MENU_OPEN, title: 'Open in Inpaint', contexts: ['image'] });
        chrome.contextMenus.create({ id: MENU_PANEL, title: 'Inpaint panel', contexts: ['page', 'image'] });
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === MENU_PANEL) {
        chrome.tabs.sendMessage(tab.id, { type: 'inpaint:toggle-panel' }).catch(() => {});
    } else if (info.menuItemId === MENU_OPEN && info.srcUrl) {
        const target = { src: info.srcUrl, pageUrl: info.pageUrl, name: fileName(info.srcUrl) };
        if (info.srcUrl.startsWith('data:')) target.bytes = info.srcUrl;
        keepAlive(openInEditor(target, tab.id)).then(
            ({ note }) => notify(tab.id, `Opened in the Inpaint editor.${note ? ` ${note}` : ''}`),
            (error) => notify(tab.id, `Open in Inpaint failed: ${error.message}`, true)
        );
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle-inpaint-panel') return;
    const active = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (active?.id) chrome.tabs.sendMessage(active.id, { type: 'inpaint:toggle-panel' }).catch(() => {});
});

// Handlers get the sending tab, whose page can read pictures and call Immich with its own login.
const handlers = {
    'inpaint:status': () => appStatus(),
    'inpaint:run': ({ target, action, options }, tabId) => runOnPicture(target, action, options, tabId),
    'inpaint:save': ({ target }, tabId) => savePicture(target, tabId),
    'inpaint:load': ({ target }, tabId) => openInEditor(target, tabId),
    'inpaint:refresh-immich': ({ target }, tabId) => refreshImmich(target, tabId),
    'inpaint:test-immich': () => testImmich(),
    'inpaint:open-options': () => chrome.runtime.openOptionsPage()
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !Object.hasOwn(handlers, message?.type)) return false;
    keepAlive(Promise.resolve().then(() => handlers[message.type](message, sender.tab?.id))).then(
        (value) => sendResponse({ ok: true, ...value }),
        (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
    );
    return true;
});

// A pending fetch does not keep a service worker running, but extension API calls do.
// Model runs can take minutes, especially the first time a model downloads.
async function keepAlive(promise) {
    const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    try {
        return await promise;
    } finally {
        clearInterval(timer);
    }
}

function notify(tabId, text, error = false) {
    chrome.tabs.sendMessage(tabId, { type: 'inpaint:toast', text, error }).catch(() => {});
}

// ---------- helpers ----------

function fileName(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'image';
    } catch {
        return 'image';
    }
}

async function toDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // chunked to avoid call-stack limits on large pictures
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function errorMessage(response, service) {
    const text = await response.text();
    let detail = text.slice(0, 300);
    try {
        // Immich puts the explanation in "message" and the status text in "error"; Inpaint only sends "error".
        const json = JSON.parse(text);
        detail = [json.message].flat().filter(Boolean).join(' ') || json.error || detail;
    } catch {
        // plain-text error body
    }
    return detail ? `${service}: ${detail}` : `${service} returned HTTP ${response.status}`;
}

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

// ---------- Inpaint app ----------

async function callApp(path, body) {
    const { appUrl, token } = await loadSettings();
    if (!token) throw new Error('Add the Inpaint access token in the extension options.');
    let response;
    try {
        response = await fetch(new URL(path, appUrl), {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
            body: body && JSON.stringify(body)
        });
    } catch {
        throw new Error(`Cannot reach Inpaint at ${appUrl}. Open the app and enable its API server.`);
    }
    if (!response.ok) throw new Error(await errorMessage(response, 'Inpaint'));
    return response;
}

async function appStatus() {
    const health = await (await callApp('/health')).json();
    if (!health.ready) return { ready: false, error: 'Inpaint is open but not ready. Finish its setup.' };
    const [operations, workflows, faceSource] = await Promise.all([
        callApp('/operations').then((response) => response.json()),
        callApp('/workflows').then((response) => response.json()),
        // Inpaint builds from before GET /face-source answer 405 but run everything else.
        callApp('/face-source').then((response) => response.json(), () => ({ faceSource: null }))
    ]);
    return {
        ready: true,
        version: health.version,
        operations: operations.operations,
        workflows: workflows.workflows,
        faceSource: faceSource.faceSource
    };
}

// ---------- Immich ----------
//
// Requests that come from an open Immich page go through that page, so they act as the
// account signed in there. The API key, which may belong to another account, is the fallback.

function immichBase(settings) {
    return settings.immich.url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

function onImmich(url, settings) {
    try {
        return !!immichBase(settings) && new URL(url).origin === new URL(immichBase(settings)).origin;
    } catch {
        return false;
    }
}

async function callImmich(settings, path, body) {
    let response;
    try {
        response = await fetch(immichBase(settings) + path, {
            method: body ? 'POST' : 'GET',
            headers: { 'x-api-key': settings.immich.apiKey, ...(body && { 'Content-Type': 'application/json' }) },
            body: body && JSON.stringify(body)
        });
    } catch {
        throw new Error(`Cannot reach Immich at ${immichBase(settings)}.`);
    }
    if (!response.ok) throw httpError(await errorMessage(response, 'Immich'), response.status);
    return response;
}

async function immichJson(settings, tabId, path, body) {
    let pageError = null;
    if (tabId !== undefined) {
        const reply = await chrome.tabs.sendMessage(tabId, { type: 'inpaint:immich-request', path, body }).catch(() => null);
        if (reply?.ok) return reply.data;
        if (reply?.status) pageError = httpError(`Immich: ${reply.error}`, reply.status);
    }
    if (!settings.immich.apiKey) {
        throw pageError ?? httpError('Immich: open the picture on the Immich page, or add an API key in the extension options.', 401);
    }
    try {
        const response = await callImmich(settings, path, body);
        return response.status === 204 ? null : response.json();
    } catch (error) {
        throw pageError ?? error;
    }
}

async function immichPicture(settings, tabId, path) {
    if (tabId !== undefined) {
        const reply = await chrome.tabs.sendMessage(tabId, { type: 'inpaint:read-picture', src: immichBase(settings) + path }).catch(() => null);
        if (reply?.ok) return reply.image;
    }
    return toDataUrl(await (await callImmich(settings, path)).blob());
}

function immichAssetId(target, settings) {
    if (!target?.src || !onImmich(target.src, settings)) return null;
    return target.src.match(ASSET_ID)?.[1] ?? null;
}

// The Immich asset behind a picture, or why it cannot be read. Immich answers "Not found or
// no asset.read access" when the account neither owns the asset nor has it shared, and for
// Locked folder assets outside an unlocked session.
async function immichLookup(target, settings, tabId) {
    const id = immichAssetId(target, settings);
    if (!id) return null;
    try {
        return { id, asset: await immichJson(settings, tabId, `/api/assets/${id}`) };
    } catch (error) {
        if (!error.status) throw error;
        return {
            id,
            problem: `Immich would not show asset ${id} to the signed-in account or the API key (${error.message}). Locked folder pictures are only available while the Locked folder is unlocked.`
        };
    }
}

function isPictureAsset(asset) {
    return PICTURE_TYPES.has(asset.originalMimeType) || /\.(jpe?g|png|webp)$/i.test(asset.originalPath ?? '');
}

// The library file as mounted on this computer, when one of the mappings covers it.
function localPath(asset, settings) {
    if (!isPictureAsset(asset) || !asset.originalPath) return null;
    for (const mapping of settings.immich.mappings) {
        const from = mapping.immichPath?.trim().replace(/\/+$/, '');
        const to = mapping.localPath?.trim().replace(/\/+$/, '');
        if (from && to && asset.originalPath.startsWith(`${from}/`)) {
            return to + asset.originalPath.slice(from.length);
        }
    }
    return null;
}

async function runImmichJobs(settings, tabId, assetId, names) {
    for (const name of names) {
        await immichJson(settings, tabId, '/api/assets/jobs', { assetIds: [assetId], name });
    }
}

// ---------- pictures ----------

// What to send to Inpaint as "image": the edited result, a library path, or the picture's
// bytes. `immich` is the lookup result when the caller already has it.
async function pictureSource(target, settings, tabId, immich) {
    if (target.current) return { image: target.current, immich };
    immich ??= await immichLookup(target, settings, tabId);
    const asset = immich?.asset;
    if (asset) {
        const local = localPath(asset, settings);
        if (local) return { image: local, immich, local };
        // Inpaint reads PNG, JPEG and WebP; other originals (HEIC, RAW) use Immich's preview.
        const path = isPictureAsset(asset) ? `/api/assets/${immich.id}/original` : `/api/assets/${immich.id}/thumbnail?size=preview`;
        return { image: await immichPicture(settings, tabId, path), immich };
    }
    if (target.bytes) return { image: target.bytes, immich };
    // The page loads the picture with its own login.
    if (tabId !== undefined) {
        const reply = await chrome.tabs.sendMessage(tabId, { type: 'inpaint:read-picture', src: target.src }).catch(() => null);
        if (reply?.ok) return { image: reply.image, immich };
    }
    try {
        const response = await fetch(target.src, { credentials: 'include' });
        if (response.ok) return { image: await toDataUrl(await response.blob()), immich };
    } catch {
        // let the app download it below
    }
    // Immich only serves pictures to signed-in requests, so the app's download would fail too.
    if (immich?.problem) throw new Error(immich.problem);
    if (onImmich(target.src, settings)) throw new Error('Cannot read this Immich picture. Reload the Immich page and try again.');
    return { image: target.src, immich };
}

// Face swap takes its face from the face source photo selected in Inpaint.
async function runOnPicture(target, action, options = {}, tabId) {
    let path;
    if (action?.startsWith('workflow:')) path = `/workflow/${encodeURIComponent(action.slice('workflow:'.length))}`;
    else if (/^[a-z][a-z-]*$/.test(action ?? '')) path = `/${action}`;
    else throw new Error(`Unknown action ${action}.`);

    const settings = await loadSettings();
    const { image } = await pictureSource(target, settings, tabId);
    const response = await callApp(path, { image, options });
    return {
        image: await toDataUrl(await response.blob()),
        width: Number(response.headers.get('x-image-width')) || null,
        height: Number(response.headers.get('x-image-height')) || null
    };
}

async function savePicture(target, tabId) {
    const settings = await loadSettings();
    const immich = await immichLookup(target, settings, tabId);
    const asset = immich?.asset;
    const local = asset && localPath(asset, settings);
    if (local) {
        if (!target.current) throw new Error('This picture has no changes to save.');
        const saved = await (await callApp('/save', { path: local, image: target.current })).json();
        const jobs = ['regenerate-thumbnail'];
        // Immich stores the dimensions from its metadata scan.
        if (saved.width !== asset.width || saved.height !== asset.height) jobs.push('refresh-metadata');
        await runImmichJobs(settings, tabId, immich.id, jobs);
        return { path: saved.path, immich: true };
    }
    const { image } = await pictureSource(target, settings, tabId, immich);
    const saved = await (await callApp('/save', { image, name: asset?.originalFileName ?? target.name })).json();
    let note = '';
    if (immich?.problem) note = `Not written back to Immich: ${immich.problem}`;
    else if (asset && !isPictureAsset(asset)) note = `Not written back to Immich: Inpaint cannot write ${asset.originalFileName}.`;
    else if (asset) note = `Not written back to Immich: no library folder mapping covers ${asset.originalPath}.`;
    return { path: saved.path, note };
}

// A mapped Immich asset opens with its library file as the save target, so Save in Inpaint
// overwrites the original even when the picture was already edited on the page.
async function openInEditor(target, tabId) {
    const settings = await loadSettings();
    const immich = await immichLookup(target, settings, tabId);
    const local = immich?.asset ? localPath(immich.asset, settings) : null;
    const { image } = local && !target.current ? { image: local } : await pictureSource(target, settings, tabId, immich);
    await callApp('/load', { image, path: local ?? undefined, name: immich?.asset?.originalFileName ?? target.name });
    let note = '';
    if (local) note = 'Save in Inpaint overwrites the Immich original; afterwards use Refresh thumbnail in Immich here.';
    else if (immich?.problem) note = 'Saving it will not update Immich, because Immich would not show this asset to the extension.';
    else if (immich?.asset) note = `Save will ask where to save: no library folder mapping covers ${immich.asset.originalPath}.`;
    return { note };
}

async function refreshImmich(target, tabId) {
    const settings = await loadSettings();
    const immich = await immichLookup(target, settings, tabId);
    if (!immich) throw new Error('This is not a picture from the configured Immich server.');
    if (immich.problem) throw new Error(immich.problem);
    await runImmichJobs(settings, tabId, immich.id, ['regenerate-thumbnail', 'refresh-metadata']);
    return {};
}

async function testImmich() {
    const settings = await loadSettings();
    const base = immichBase(settings);
    if (!base) throw new Error('Enter the Immich address.');
    const ping = await fetch(`${base}/api/server/ping`).catch(() => null);
    if (!ping?.ok) throw new Error(`Cannot reach Immich at ${base}.`);
    if (!settings.immich.apiKey) return { message: 'Immich is reachable. Pictures on the Immich page use your signed-in account.' };
    const headers = { 'x-api-key': settings.immich.apiKey };
    // An unknown asset answers 400 or 404 with a working key, 401 for a bad key, 403 without asset.read.
    const check = await fetch(`${base}/api/assets/00000000-0000-4000-8000-000000000000`, { headers });
    if (check.status === 401) throw new Error('Immich rejected the API key.');
    if (check.status === 403) throw new Error('The API key lacks the asset.read permission.');
    // Naming the key's account helps when pictures belong to another account; needs user.read.
    const me = await fetch(`${base}/api/users/me`, { headers }).catch(() => null);
    const account = me?.ok ? await me.json() : null;
    return {
        message: account
            ? `Immich accepts the API key of ${account.name} (${account.email}, id ${account.id}). Pictures on the Immich page use your signed-in account instead.`
            : 'Immich is reachable and accepts the API key.'
    };
}
