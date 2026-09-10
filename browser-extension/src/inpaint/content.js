// Inpaint integration: a menu on pictures that sends them to the Inpaint desktop app.
//
// Pictures match CSS selectors picked per site in the Inpaint panel (panel.js), and
// every asset picture on the configured Immich server matches too. Results replace
// the picture on the page only; Save writes them through the app. All requests go
// through the service worker (background.js).
(() => {
    const SITES_KEY = 'inpaintSites';
    const MENU_KEY = 'inpaintMenu';
    const SETTINGS_KEY = 'inpaintSettings';
    const DEFAULT_ACTIONS = ['upscale', 'restore-faces', 'restore-detail', 'remove-background', 'face-swap'];
    const IMMICH_SELECTOR = 'img[src*="/api/assets/"]';
    const IMMICH_ASSET = /\/api\/assets\/([0-9a-f-]{36})\//i;
    const MIN_SIZE = 64;
    // How long a known app status is trusted before hovering a picture checks again.
    const STATUS_MAX_AGE = 10000;

    // 24×24 stroke icons, one path each.
    const ICONS = {
        logo: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
        upscale: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
        'restore-faces': 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
        'restore-detail': 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 17v4M17 19h4',
        'remove-background': 'M6 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
        'replace-background': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4M21 15l-5-5L5 21',
        'face-swap': 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
        'refine-edges': 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5',
        adjust: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
        outpaint: 'M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5M9 9h6v6H9z',
        'flip-horizontal': 'M12 3v18M16 7l4 5-4 5zM8 7l-4 5 4 5z',
        'flip-vertical': 'M3 12h18M7 8l5-4 5 4zM7 16l5 4 5-4z',
        'rotate-left': 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
        'rotate-right': 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
        workflow: 'M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
        editor: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
        save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
        undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
        restore: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
        immich: 'M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5',
        fallback: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8v4M12 16h.01'
    };

    const STYLES = `
        :host { all: initial; }
        [hidden] { display: none !important; }
        * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; }
        svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        button { color: inherit; }
        /* Barely visible over the picture; solid while the button or its menu is under the pointer. */
        .badge { position: fixed; display: grid; width: 28px; height: 28px; padding: 0; place-items: center; color: #f06742; border: 1px solid rgba(255,255,255,.3); border-radius: 50%; background: rgba(24,24,21,.88); box-shadow: 0 2px 8px rgba(0,0,0,.4); cursor: pointer; opacity: .15; transition: opacity .15s; pointer-events: auto; }
        .badge:hover, .badge.active { opacity: 1; }
        .badge.busy svg { animation: spin 1s linear infinite; }
        .menu { position: fixed; width: 206px; padding: 6px; color: #e9e8e3; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; background: rgba(28,28,25,.97); box-shadow: 0 12px 32px rgba(0,0,0,.5); pointer-events: auto; }
        .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
        .grid button { display: grid; height: 34px; padding: 0; place-items: center; color: #d4d3cd; border: 0; border-radius: 6px; background: transparent; cursor: pointer; }
        .grid button:hover { color: #fff; background: #36362e; }
        .grid button.unavailable { opacity: .35; cursor: default; }
        .grid hr { grid-column: 1 / -1; width: 100%; margin: 3px 0; border: 0; border-top: 1px solid rgba(255,255,255,.1); }
        .caption { min-height: 18px; margin-top: 4px; padding: 0 4px; overflow: hidden; color: #b1afa5; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .toast { position: fixed; left: 50%; bottom: 24px; max-width: min(560px, calc(100vw - 32px)); padding: 9px 14px; color: #e9e8e3; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(29,29,26,.96); box-shadow: 0 8px 25px rgba(0,0,0,.35); transform: translateX(-50%); pointer-events: auto; overflow-wrap: anywhere; }
        .toast.error { color: #ffac95; }
        .pick-box, .match { position: fixed; border: 2px solid #f06742; border-radius: 3px; background: rgba(240,103,66,.14); pointer-events: none; }
        .match { border-color: #67e0b0; background: rgba(103,224,176,.12); }
        @keyframes spin { to { transform: rotate(360deg); } }

        .panel { position: fixed; top: 0; right: 0; bottom: 0; display: grid; width: 340px; padding: 14px; overflow-y: auto; align-content: start; gap: 12px; color: #e9e8e3; border-left: 1px solid rgba(255,255,255,.12); background: #1c1c19; box-shadow: -12px 0 32px rgba(0,0,0,.4); pointer-events: auto; }
        .panel section { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; }
        .panel h2 { margin: 0; font-size: 16px; font-weight: 650; }
        .panel h3 { margin: 4px 0 0; font-size: 13px; font-weight: 650; }
        .panel p, .panel small { margin: 0; color: #b1afa5; font-size: 12px; overflow-wrap: anywhere; }
        .panel button { padding: 5px 9px; border: 1px solid rgba(255,255,255,.14); border-radius: 6px; background: #2b2b26; cursor: pointer; }
        .panel button:hover:not(:disabled) { background: #36362e; }
        .panel button:disabled { opacity: .45; cursor: default; }
        .panel button.accent { color: #fff; border-color: #c15a3a; background: #a8482b; }
        .panel input, .panel select { width: 100%; padding: 5px 7px; color: #eee; border: 1px solid #55554c; border-radius: 5px; background: #24241f; }
        .panel input[type=checkbox] { width: auto; margin: 0; accent-color: #f06742; }
        .panel input[type=color] { height: 30px; padding: 2px; }
        .panel .row { display: flex; align-items: center; gap: 6px; }
        .panel .grow { flex: 1; min-width: 0; }
        .panel .code { font-family: ui-monospace, monospace; font-size: 12px; overflow-wrap: anywhere; }
        .panel .ok { color: #67e0b0; }
        .panel .error { color: #ffac95; }
        .panel .donor { width: 64px; height: 64px; border-radius: 6px; object-fit: cover; }
        .panel .options { display: grid; gap: 6px; margin-left: 24px; }
        .panel .options label { display: grid; gap: 3px; color: #c9c8c1; font-size: 12px; }
        .panel .picture-action { justify-content: flex-start; text-align: left; }
    `;

    const config = {
        sites: {},
        menu: { actions: DEFAULT_ACTIONS, workflows: [], options: {} },
        immichOrigin: ''
    };
    const listeners = new Set();
    const states = new WeakMap();
    const siteKey = location.hostname;
    const imageDocument = document.contentType.startsWith('image/');
    let status = null;
    let statusTime = 0;
    let statusRequest = null;

    // ---------- DOM helpers ----------

    // Elements are built without innerHTML so strict Trusted Types pages keep working.
    function h(tag, props = {}, ...children) {
        const element = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;
            if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
            else if (key in element) element[key] = value;
            else element.setAttribute(key, value === true ? '' : value);
        }
        element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
        return element;
    }

    function svg(name) {
        const namespace = 'http://www.w3.org/2000/svg';
        const element = document.createElementNS(namespace, 'svg');
        element.setAttribute('viewBox', '0 0 24 24');
        element.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', ICONS[name] ?? ICONS.fallback);
        element.append(path);
        return element;
    }

    const title = (name) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

    function originOf(url) {
        try {
            return new URL(url).origin;
        } catch {
            return '';
        }
    }

    function fileName(url) {
        try {
            return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'image';
        } catch {
            return 'image';
        }
    }

    const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });

    function dataUrlToBlob(dataUrl) {
        const comma = dataUrl.indexOf(',');
        const binary = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: dataUrl.slice(5, comma).split(';')[0] });
    }

    // ---------- overlay root ----------

    const host = document.createElement('inpaint-extension');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    // A constructed stylesheet is not subject to the page's style-src policy.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];
    const matchesLayer = h('div');
    const pickBox = h('div', { className: 'pick-box', hidden: true });
    const badge = h('button', { className: 'badge', hidden: true, title: 'Inpaint' }, svg('logo'));
    const menu = h('div', { className: 'menu', hidden: true });
    const toastBox = h('div', { className: 'toast', hidden: true });
    shadow.append(matchesLayer, pickBox, badge, menu, toastBox);

    // Some pages remove unknown fixed elements; put the root back when needed.
    const attach = () => {
        if (!host.isConnected) document.documentElement.append(host);
    };
    attach();

    // ---------- settings ----------

    async function loadConfig() {
        const stored = await chrome.storage.local.get([SITES_KEY, MENU_KEY, SETTINGS_KEY]);
        config.sites = stored[SITES_KEY] ?? {};
        config.menu = { actions: DEFAULT_ACTIONS, workflows: [], options: {}, ...stored[MENU_KEY] };
        config.immichOrigin = originOf(stored[SETTINGS_KEY]?.immich?.url);
        emit();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || ![SITES_KEY, MENU_KEY, SETTINGS_KEY].some((key) => key in changes)) return;
        if (SETTINGS_KEY in changes) status = null;
        loadConfig().catch(() => {});
    });

    function emit() {
        for (const listener of listeners) listener();
        if (hovered && !menu.hidden) renderMenu();
        placeOverlay();
    }

    function siteSelectors() {
        return config.sites[siteKey]?.selectors ?? [];
    }

    async function saveSiteSelectors(selectors) {
        const sites = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] ?? {};
        if (selectors.length) sites[siteKey] = { selectors };
        else delete sites[siteKey];
        await chrome.storage.local.set({ [SITES_KEY]: sites });
    }

    function saveMenu(changes) {
        return chrome.storage.local.set({ [MENU_KEY]: { ...config.menu, ...changes } });
    }

    function activeSelector() {
        const selectors = [...siteSelectors()];
        if (config.immichOrigin === location.origin) selectors.push(IMMICH_SELECTOR);
        if (imageDocument) selectors.push('body > img');
        return selectors.join(', ');
    }

    // ---------- messaging ----------

    async function send(type, payload = {}) {
        let reply;
        try {
            reply = await chrome.runtime.sendMessage({ type, ...payload });
        } catch {
            throw new Error('The extension was reloaded. Reload this page.');
        }
        if (!reply?.ok) throw new Error(reply?.error ?? 'No answer from the extension.');
        return reply;
    }

    // The badge only shows while the app answers, so the status is checked again when stale.
    function ensureStatus(force = false) {
        if (!statusRequest && (force || !status || Date.now() - statusTime > STATUS_MAX_AGE)) {
            statusRequest = send('inpaint:status')
                .then((reply) => { status = reply; }, (error) => { status = { ready: false, error: error.message }; })
                .finally(() => {
                    statusTime = Date.now();
                    statusRequest = null;
                    emit();
                });
        }
        return statusRequest ?? Promise.resolve();
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'inpaint:toast') toast(message.text, message.error);
        if (message?.type === 'inpaint:toggle-panel') page.togglePanel?.();
        // The service worker reads pictures through the page, whose requests carry the page's
        // login (such as an Immich session) that the extension's own requests lack.
        if (message?.type === 'inpaint:read-picture') {
            fetch(message.src, { credentials: 'include' })
                .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`))))
                .then(blobToDataUrl)
                .then((image) => sendResponse({ ok: true, image }), (error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }
        // Immich API requests from the Immich page act as the account signed in there.
        if (message?.type === 'inpaint:immich-request') {
            if (location.origin !== config.immichOrigin || !String(message.path).startsWith('/api/')) return false;
            fetch(message.path, {
                method: message.body ? 'POST' : 'GET',
                credentials: 'include',
                headers: message.body ? { 'Content-Type': 'application/json' } : {},
                body: message.body ? JSON.stringify(message.body) : undefined
            }).then(async (response) => {
                const text = await response.text();
                let data = text;
                try {
                    data = text ? JSON.parse(text) : null;
                } catch {
                    // not JSON
                }
                if (response.ok) sendResponse({ ok: true, data });
                else sendResponse({ ok: false, status: response.status, error: [data?.message].flat().filter(Boolean).join(' ') || `HTTP ${response.status}` });
            }, (error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }
        return false;
    });

    let toastTimer = 0;
    function toast(text, error = false) {
        attach();
        toastBox.textContent = text;
        toastBox.classList.toggle('error', error);
        toastBox.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastBox.hidden = true; }, error ? 9000 : 4000);
    }

    // ---------- pictures ----------

    function backgroundUrl(element) {
        const url = getComputedStyle(element).backgroundImage.match(/url\((['"]?)(.*?)\1\)/)?.[2];
        try {
            return url ? new URL(url, document.baseURI).href : '';
        } catch {
            return '';
        }
    }

    function isPicture(element) {
        if (element instanceof HTMLImageElement) return !!(element.currentSrc || element.src);
        return element instanceof HTMLElement && element !== host && !!backgroundUrl(element);
    }

    // The URL the picture came from, and the URL it shows right now.
    const pictureUrl = (picture) => (picture instanceof HTMLImageElement ? picture.currentSrc || picture.src : backgroundUrl(picture));
    const shownUrl = (picture) => (picture instanceof HTMLImageElement ? picture.src : backgroundUrl(picture));

    function bigEnough(element) {
        const rect = element.getBoundingClientRect();
        return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
    }

    function closest(element, selector) {
        try {
            return element.closest(selector);
        } catch {
            return null;
        }
    }

    // Sites often cover pictures with transparent layers, so look through the whole stack.
    function findPicture(stack) {
        const selector = activeSelector();
        if (!selector) return null;
        for (const element of stack) {
            const match = closest(element, selector);
            if (!match) continue;
            const picture = isPicture(match) ? match : match.querySelector('img');
            if (picture && isPicture(picture) && bigEnough(picture)) return picture;
        }
        return null;
    }

    function stateFor(picture) {
        let state = states.get(picture);
        // Sites reuse elements for other pictures (carousels, virtual lists); start over
        // when the element no longer shows our result or the picture we started from.
        const stale = state && (state.objectUrl ? shownUrl(picture) !== state.objectUrl : pictureUrl(picture) !== state.original);
        if (stale && !state.busy) {
            if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
            state = null;
        }
        if (!state) {
            state = { original: pictureUrl(picture), results: [], objectUrl: '', saved: null, busy: false };
            states.set(picture, state);
        }
        return state;
    }

    function isImmichPicture(picture) {
        const url = stateFor(picture).original;
        return !!config.immichOrigin && originOf(url) === config.immichOrigin && IMMICH_ASSET.test(url);
    }

    async function targetFor(picture) {
        const state = stateFor(picture);
        const target = { src: state.original, pageUrl: location.href, name: fileName(state.original) };
        if (state.results.length) target.current = state.results.at(-1);
        else if (state.original.startsWith('data:')) target.bytes = state.original;
        // blob: URLs only resolve inside the page that created them.
        else if (state.original.startsWith('blob:')) target.bytes = await blobToDataUrl(await (await fetch(state.original)).blob());
        return target;
    }

    function captureOriginal(picture) {
        if (!(picture instanceof HTMLImageElement)) return { backgroundImage: picture.style.backgroundImage };
        const saved = {
            src: picture.getAttribute('src'),
            srcset: picture.getAttribute('srcset'),
            sizes: picture.getAttribute('sizes'),
            width: picture.style.width,
            height: picture.style.height,
            objectFit: picture.style.objectFit,
            sources: []
        };
        // Keep the rendered size so a larger or reshaped result leaves the layout alone.
        const rect = picture.getBoundingClientRect();
        if (rect.width && rect.height) {
            picture.style.width = `${rect.width}px`;
            picture.style.height = `${rect.height}px`;
            if (getComputedStyle(picture).objectFit === 'fill') picture.style.objectFit = 'contain';
        }
        // srcset and <picture> sources would override src.
        for (const source of picture.closest('picture')?.querySelectorAll('source') ?? []) {
            saved.sources.push([source, source.getAttribute('srcset')]);
            source.removeAttribute('srcset');
        }
        picture.removeAttribute('srcset');
        picture.removeAttribute('sizes');
        return saved;
    }

    function showResult(picture, dataUrl, remember = true) {
        const state = stateFor(picture);
        state.saved ??= captureOriginal(picture);
        if (remember) state.results.push(dataUrl);
        const objectUrl = URL.createObjectURL(dataUrlToBlob(dataUrl));
        if (picture instanceof HTMLImageElement) picture.src = objectUrl;
        else picture.style.backgroundImage = `url("${objectUrl}")`;
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = objectUrl;
    }

    function setAttribute(element, name, value) {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
    }

    function restoreOriginal(picture) {
        const state = states.get(picture);
        if (!state?.saved) return;
        const saved = state.saved;
        if (picture instanceof HTMLImageElement) {
            for (const [source, srcset] of saved.sources) setAttribute(source, 'srcset', srcset);
            setAttribute(picture, 'srcset', saved.srcset);
            setAttribute(picture, 'sizes', saved.sizes);
            setAttribute(picture, 'src', saved.src);
            Object.assign(picture.style, { width: saved.width, height: saved.height, objectFit: saved.objectFit });
        } else {
            picture.style.backgroundImage = saved.backgroundImage;
        }
        URL.revokeObjectURL(state.objectUrl);
        states.delete(picture);
        emit();
    }

    function undo(picture) {
        const state = stateFor(picture);
        state.results.pop();
        if (state.results.length) showResult(picture, state.results.at(-1), false);
        else restoreOriginal(picture);
        emit();
    }

    function setBusy(picture, busy) {
        const state = stateFor(picture);
        state.busy = busy;
        if (busy) {
            state.outline = [picture.style.outline, picture.style.outlineOffset];
            picture.style.outline = '3px solid #f06742';
            picture.style.outlineOffset = '-3px';
        } else {
            [picture.style.outline, picture.style.outlineOffset] = state.outline ?? ['', ''];
        }
        emit();
    }

    async function withPicture(picture, label, work) {
        if (stateFor(picture).busy) return;
        setBusy(picture, true);
        try {
            toast(await work(await targetFor(picture)));
        } catch (error) {
            toast(`${label} failed: ${error.message}`, true);
            // Hide the badge right away if the app went away.
            ensureStatus(true);
        } finally {
            setBusy(picture, false);
        }
    }

    const runAction = (picture, action, label = title(action)) => withPicture(picture, label, async (target) => {
        // No options: Inpaint applies the models and settings chosen in its editor.
        const reply = await send('inpaint:run', { target, action, options: {} });
        showResult(picture, reply.image);
        return `${label} done${reply.width ? ` · ${reply.width} × ${reply.height} px` : ''}.`;
    });

    const openInEditor = (picture) => withPicture(picture, 'Open in Inpaint', async (target) => {
        const reply = await send('inpaint:load', { target });
        return `Opened in the Inpaint editor.${reply.note ? ` ${reply.note}` : ''}`;
    });

    const save = (picture) => withPicture(picture, 'Save', async (target) => {
        const before = isImmichPicture(picture) ? await immichThumbnailVersion(target.src) : null;
        const reply = await send('inpaint:save', { target });
        if (!reply.immich) return `Saved ${reply.path}.${reply.note ? ` ${reply.note}` : ''}`;
        followImmichRebuild(target.src, before);
        return `Saved ${reply.path}. Waiting for Immich to rebuild the thumbnail…`;
    });

    const refreshImmich = (picture) => withPicture(picture, 'Refresh in Immich', async (target) => {
        const before = await immichThumbnailVersion(target.src);
        await send('inpaint:refresh-immich', { target });
        followImmichRebuild(target.src, before);
        return 'Immich is rebuilding the thumbnail and metadata…';
    });

    // Immich writes a rebuilt thumbnail to the same URL, which browsers keep cached for a day,
    // so once Immich has rebuilt it the cached copies are fetched again.
    function immichVariant(url, size) {
        const variant = new URL(url);
        variant.pathname = variant.pathname.replace(/\/[^/]+$/, '/thumbnail');
        variant.searchParams.set('size', size);
        return variant.href;
    }

    async function immichThumbnailVersion(url) {
        const response = await fetch(immichVariant(url, 'preview'), { method: 'HEAD', cache: 'no-store', credentials: 'include' }).catch(() => null);
        const etag = response?.headers.get('etag');
        const modified = response?.headers.get('last-modified');
        return response?.ok && (etag || modified) ? `${etag}|${modified}` : null;
    }

    async function refreshImmichThumbnails(url, before) {
        let rebuilt = false;
        for (let attempt = 0; attempt < 20 && !rebuilt; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const version = await immichThumbnailVersion(url);
            // Without version headers, give the job a few seconds.
            rebuilt = before ? version !== null && version !== before : attempt >= 3;
        }
        await Promise.all(['thumbnail', 'preview'].map((size) => fetch(immichVariant(url, size), { cache: 'reload', credentials: 'include' })
            .then((response) => response.blob(), () => null)));
        const id = url.match(IMMICH_ASSET)?.[1];
        for (const image of document.querySelectorAll('img')) {
            if (!id || !image.src.includes(`/api/assets/${id}/`) || states.get(image)?.results.length) continue;
            const src = image.getAttribute('src');
            image.removeAttribute('src');
            requestAnimationFrame(() => image.setAttribute('src', src));
        }
        return rebuilt;
    }

    function followImmichRebuild(url, before) {
        refreshImmichThumbnails(url, before).then((rebuilt) => toast(rebuilt
            ? 'Immich rebuilt the thumbnail. Other open Immich tabs show it after a reload.'
            : 'Immich has not rebuilt the thumbnail yet. Check its Generate Thumbnails job, then reload the page.', !rebuilt));
    }

    // Entries for the picture menu and the panel; null separates groups.
    function menuItems(picture) {
        const edited = !!states.get(picture)?.results.length;
        const immich = isImmichPicture(picture);
        const items = [];
        for (const operation of status?.operations ?? []) {
            if (!config.menu.actions.includes(operation.name)) continue;
            // Face swap uses the face source photo selected in Inpaint.
            const needsFaceSource = operation.name === 'face-swap' && !status.faceSource;
            items.push({
                icon: operation.name,
                label: title(operation.name),
                hint: needsFaceSource ? '' : operation.summary,
                unavailable: needsFaceSource ? 'Choose a face source photo in the Face swap section of Inpaint first.' : '',
                run: () => runAction(picture, operation.name)
            });
        }
        for (const workflow of status?.workflows ?? []) {
            if (!config.menu.workflows.includes(workflow.id)) continue;
            items.push({
                icon: 'workflow',
                label: workflow.name,
                hint: `Workflow: ${workflow.steps.join(' → ')}`,
                run: () => runAction(picture, `workflow:${workflow.id}`, workflow.name)
            });
        }
        items.push(null);
        items.push({ icon: 'editor', label: 'Open in Inpaint editor', run: () => openInEditor(picture) });
        items.push({
            icon: 'save',
            label: 'Save',
            hint: immich ? 'Save: writes the Immich library file when its folder is mapped, otherwise the Inpaint save folder' : 'Save to the Inpaint save folder',
            run: () => save(picture)
        });
        if (edited) {
            items.push({ icon: 'undo', label: 'Undo last change', run: () => undo(picture) });
            items.push({ icon: 'restore', label: 'Show original', run: () => restoreOriginal(picture) });
        }
        if (immich) items.push({ icon: 'immich', label: 'Refresh thumbnail in Immich', run: () => refreshImmich(picture) });
        return items;
    }

    // ---------- hover badge and menu ----------

    let pointer = null;
    let frame = 0;
    let hovered = null;
    let hideTimer = 0;

    document.addEventListener('pointermove', (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        schedule();
    }, { capture: true, passive: true });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }

    function update() {
        frame = 0;
        attach();
        drawMatches();
        if (pointer) {
            const stack = document.elementsFromPoint(pointer.x, pointer.y);
            if (picking) {
                showCandidate(stack[0] === host ? null : stack.find(isPicture) ?? null);
            } else if (stack[0] === host) {
                // over the badge, menu or panel
                clearTimeout(hideTimer);
            } else {
                const picture = findPicture(stack);
                clearTimeout(hideTimer);
                if (picture) {
                    ensureStatus();
                    if (picture !== hovered) setHovered(picture);
                } else if (hovered) {
                    hideTimer = setTimeout(() => setHovered(null), 300);
                }
            }
        }
        placeOverlay();
    }

    function setHovered(picture) {
        hovered = picture;
        menu.hidden = true;
        placeOverlay();
    }

    function placeOverlay() {
        const rect = hovered?.isConnected ? hovered.getBoundingClientRect() : null;
        // No badge while the app is unreachable or not ready.
        const visible = !!status?.ready && rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE
            && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        badge.hidden = !visible;
        if (!visible) menu.hidden = true;
        badge.classList.toggle('active', !menu.hidden);
        if (!visible) return;
        const left = Math.min(rect.right, innerWidth) - 36;
        const top = Math.max(rect.top, 0) + 8;
        Object.assign(badge.style, { left: `${left}px`, top: `${top}px` });
        badge.classList.toggle('busy', !!states.get(hovered)?.busy);
        if (!menu.hidden) {
            const width = menu.offsetWidth;
            const height = menu.offsetHeight;
            menu.style.left = `${Math.max(8, Math.min(left + 28 - width, innerWidth - width - 8))}px`;
            menu.style.top = `${top + 34 + height > innerHeight ? Math.max(8, top - height - 6) : top + 34}px`;
        }
    }

    function renderMenu() {
        const picture = hovered;
        if (!picture) return;
        const busy = !!states.get(picture)?.busy;
        const caption = h('div', { className: 'caption' }, busy ? 'Working…' : 'Inpaint');
        const grid = h('div', { className: 'grid' });
        for (const item of menuItems(picture)) {
            if (!item) {
                grid.append(h('hr'));
                continue;
            }
            const unavailable = busy ? 'Wait for the current operation to finish.' : item.unavailable;
            grid.append(h('button', {
                className: unavailable ? 'unavailable' : '',
                'aria-label': item.label,
                onpointerenter: () => { caption.textContent = unavailable || item.hint || item.label; },
                onclick: () => {
                    if (unavailable) toast(unavailable, true);
                    else item.run();
                }
            }, svg(item.icon)));
        }
        menu.replaceChildren(grid, caption);
    }

    function openMenu() {
        if (!hovered || !status?.ready) return;
        renderMenu();
        menu.hidden = false;
        placeOverlay();
        // Picks up a face source chosen in Inpaint a moment ago.
        ensureStatus();
    }

    badge.addEventListener('pointerenter', openMenu);
    badge.addEventListener('click', openMenu);

    // The menu closes shortly after the pointer leaves it and the button, even over the picture.
    let menuTimer = 0;
    for (const element of [badge, menu]) {
        element.addEventListener('pointerenter', () => clearTimeout(menuTimer));
        element.addEventListener('pointerleave', () => {
            clearTimeout(menuTimer);
            menuTimer = setTimeout(() => {
                menu.hidden = true;
                placeOverlay();
            }, 400);
        });
    }
    // No more pointer moves arrive once the pointer leaves the page, so hide right away.
    document.documentElement.addEventListener('pointerleave', () => setHovered(null));
    window.addEventListener('blur', () => setHovered(null));

    // ---------- picking pictures ----------

    let picking = null;
    let candidate = null;

    function startPicking(onPick) {
        picking = onPick;
        setHovered(null);
        toast('Click a picture to match similar ones. Esc cancels.');
    }

    function stopPicking() {
        picking = null;
        candidate = null;
        pickBox.hidden = true;
    }

    function showCandidate(element) {
        candidate = element;
        const rect = element?.getBoundingClientRect();
        pickBox.hidden = !rect;
        if (rect) {
            Object.assign(pickBox.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        }
    }

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        window.addEventListener(type, (event) => {
            if (!picking || event.composedPath().includes(host)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (type === 'click' && candidate) {
                const onPick = picking;
                const selector = suggestSelector(candidate);
                stopPicking();
                onPick(selector);
            }
        }, true);
    }

    window.addEventListener('keydown', (event) => {
        if (picking && event.key === 'Escape') {
            stopPicking();
            emit();
        }
    }, true);

    function simpleSelector(node) {
        // Leave out class names that look generated per build or per item.
        const classes = [...node.classList].filter((name) => /^[a-z_-][\w-]*$/i.test(name) && !/\d{4,}/.test(name)).slice(0, 2);
        return node.localName + classes.map((name) => `.${CSS.escape(name)}`).join('');
    }

    // The shortest parent chain with class names, so similar pictures on the site match too.
    function suggestSelector(element) {
        const chain = [];
        for (let node = element; node && node !== document.body && node !== document.documentElement && chain.length < 4; node = node.parentElement) {
            chain.unshift(simpleSelector(node));
        }
        for (let length = 1; length <= chain.length; length++) {
            const selector = chain.slice(-length).join(' > ');
            if (selector.includes('.') && closest(element, selector) === element) return selector;
        }
        return chain.join(' > ');
    }

    let highlighted = '';

    function countMatches(selector) {
        if (!selector) return 0;
        try {
            return document.querySelectorAll(selector).length;
        } catch {
            return -1;
        }
    }

    function highlight(selector) {
        highlighted = selector;
        drawMatches();
        return countMatches(selector);
    }

    function drawMatches() {
        if (!highlighted) {
            if (matchesLayer.childElementCount) matchesLayer.replaceChildren();
            return;
        }
        let elements = [];
        try {
            elements = document.querySelectorAll(highlighted);
        } catch {
            // an unfinished selector while typing
        }
        const boxes = [];
        for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
            const box = h('div', { className: 'match' });
            Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
            boxes.push(box);
            if (boxes.length === 300) break;
        }
        matchesLayer.replaceChildren(...boxes);
    }

    // ---------- shared with panel.js ----------

    const page = globalThis.inpaintPage = {
        shadow,
        h,
        svg,
        title,
        config,
        siteKey,
        imageDocument,
        get status() {
            return status;
        },
        ensureStatus,
        send,
        toast,
        subscribe: (listener) => listeners.add(listener),
        unsubscribe: (listener) => listeners.delete(listener),
        isImmichPage: () => config.immichOrigin === location.origin,
        siteSelectors,
        saveSiteSelectors,
        saveMenu,
        startPicking,
        stopPicking,
        isPicking: () => !!picking,
        highlight,
        countMatches,
        menuItems,
        documentPicture: () => (imageDocument ? document.querySelector('body > img') : null)
    };

    loadConfig().catch(() => {});
})();
