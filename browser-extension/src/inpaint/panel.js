// Inpaint panel: pick the pictures that get the Inpaint menu on this site, and choose
// the menu's actions. Toggle it with Alt+Shift+I or the page context
// menu. Tokens and keys are entered on the options page instead, because a web page
// can observe keystrokes typed into it.
(() => {
    const page = globalThis.inpaintPage;
    if (!page) return;
    const { h, svg, title } = page;
    // inpaint needs a painted mask, detect-faces returns data, crop needs a region.
    const HIDDEN_OPERATIONS = new Set(['inpaint', 'detect-faces', 'crop']);

    let panel = null;
    let proposal = null;
    let shown = '';

    const toggle = (list, value) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
    const report = (promise) => promise.catch((error) => page.toast(error.message, true));

    page.togglePanel = () => (panel ? close() : open());

    function open() {
        const stop = (event) => event.stopPropagation();
        // Keep the page's keyboard shortcuts from reacting to typing in the panel.
        panel = h('aside', { className: 'panel', onkeydown: stop, onkeyup: stop, onkeypress: stop });
        page.shadow.append(panel);
        page.subscribe(render);
        render();
        page.ensureStatus(true);
    }

    function close() {
        page.unsubscribe(render);
        page.stopPicking();
        page.highlight('');
        proposal = null;
        shown = '';
        panel.remove();
        panel = null;
    }

    function render() {
        if (!panel) return;
        const scroll = panel.scrollTop;
        panel.replaceChildren(...[header(), siteSection(), faceSourceSection(), menuSection(), pictureSection()].filter(Boolean));
        panel.scrollTop = scroll;
    }

    function header() {
        const status = page.status;
        const text = status === null ? 'Connecting to Inpaint…' : status.ready ? `Connected to Inpaint ${status.version}` : status.error;
        return h('section', {},
            h('div', { className: 'row' },
                h('h2', { className: 'grow' }, 'Inpaint'),
                status && !status.ready ? h('button', { onclick: () => page.ensureStatus(true) }, 'Retry') : null,
                h('button', { onclick: () => report(page.send('inpaint:open-options')) }, 'Settings'),
                h('button', { title: 'Close (Alt+Shift+I)', onclick: close }, 'Close')),
            h('p', { className: status?.ready ? 'ok' : status ? 'error' : '' }, text));
    }

    function siteSection() {
        const selectors = page.siteSelectors();
        const notes = [];
        if (page.isImmichPage()) notes.push(h('small', {}, 'Immich pictures are matched automatically.'));
        if (page.imageDocument) notes.push(h('small', {}, 'This picture is matched automatically.'));
        if (!selectors.length && !notes.length) notes.push(h('small', {}, 'No pictures chosen yet. Pick one, and similar pictures on this site get the Inpaint menu.'));
        return h('section', {},
            h('h3', {}, `Pictures on ${page.siteKey}`),
            notes,
            selectors.map((selector, index) => h('div', { className: 'row' },
                h('span', { className: 'grow code', title: `${page.countMatches(selector)} matches on this page` }, selector),
                h('button', {
                    onclick: () => {
                        shown = shown === selector ? '' : selector;
                        page.highlight(shown);
                        render();
                    }
                }, shown === selector ? 'Hide' : 'Show'),
                h('button', { onclick: () => report(page.saveSiteSelectors(selectors.filter((_, i) => i !== index))) }, 'Remove'))),
            proposal ? proposalEditor(selectors) : h('button', {
                className: 'accent',
                disabled: page.isPicking(),
                onclick: () => {
                    page.startPicking((selector) => {
                        proposal = { selector };
                        render();
                    });
                    render();
                }
            }, page.isPicking() ? 'Click a picture on the page…' : 'Pick pictures'));
    }

    function proposalEditor(selectors) {
        // Handlers keep their own proposal: a second click on Save or Cancel arrives after the
        // first one cleared it but before the panel is redrawn.
        const draft = proposal;
        const count = h('small');
        const updateCount = () => {
            const matches = page.highlight(draft.selector);
            count.textContent = matches < 0 ? 'Not a valid CSS selector.' : `${matches} matching element${matches === 1 ? '' : 's'} on this page.`;
        };
        const input = h('input', {
            className: 'code',
            value: draft.selector,
            oninput: () => {
                draft.selector = input.value;
                if (proposal === draft) updateCount();
            }
        });
        updateCount();
        const finish = () => {
            if (proposal !== draft) return false;
            proposal = null;
            page.highlight(shown);
            render();
            return true;
        };
        return h('div', { className: 'options' },
            h('small', {}, 'Selector for similar pictures. Edit it to match more or fewer.'),
            input,
            count,
            h('div', { className: 'row' },
                h('button', {
                    className: 'accent',
                    onclick: () => {
                        const selector = draft.selector.trim();
                        if (!selector || page.countMatches(selector) < 0 || !finish()) return;
                        report(page.saveSiteSelectors([...new Set([...selectors, selector])]));
                    }
                }, 'Save'),
                h('button', { onclick: finish }, 'Cancel')));
    }

    // Face swap uses the face source photo chosen in Inpaint; the panel only shows it.
    function faceSourceSection() {
        const status = page.status;
        const source = status?.faceSource;
        let note = 'Connect to Inpaint to see the face source.';
        if (source) note = 'Face swap uses this photo. Change or clear it in the Face swap section of Inpaint.';
        else if (status?.ready) note = 'No face source. Choose a photo in the Face swap section of Inpaint, then refresh.';
        return h('section', {},
            h('div', { className: 'row' },
                h('h3', { className: 'grow' }, 'Face source'),
                h('button', { onclick: () => page.ensureStatus(true) }, 'Refresh')),
            source
                ? h('div', { className: 'row', title: source.path },
                    source.preview ? h('img', { className: 'donor', src: source.preview, alt: '' }) : null,
                    h('small', { className: 'grow' }, source.name))
                : null,
            h('small', {}, note));
    }

    function menuSection() {
        const status = page.status;
        const section = h('section', {}, h('h3', {}, 'Picture menu'));
        if (!status?.ready) {
            section.append(h('small', {}, 'Connect to Inpaint to choose the actions.'));
            return section;
        }
        const { actions, workflows } = page.config.menu;
        section.append(h('small', {}, 'Actions use the models and settings currently chosen in Inpaint\'s editor.'));
        for (const operation of status.operations.filter((item) => !HIDDEN_OPERATIONS.has(item.name))) {
            section.append(h('label', { className: 'row', title: operation.summary },
                h('input', {
                    type: 'checkbox',
                    checked: actions.includes(operation.name),
                    onchange: () => report(page.saveMenu({ actions: toggle(actions, operation.name) }))
                }),
                svg(operation.name),
                h('span', {}, title(operation.name))));
        }
        if (status.workflows.length) section.append(h('h3', {}, 'Workflows'));
        for (const workflow of status.workflows) {
            section.append(h('label', { className: 'row', title: workflow.steps.join(' → ') },
                h('input', {
                    type: 'checkbox',
                    checked: workflows.includes(workflow.id),
                    onchange: () => report(page.saveMenu({ workflows: toggle(workflows, workflow.id) }))
                }),
                svg('workflow'),
                h('span', {}, workflow.name)));
        }
        return section;
    }

    // When the tab shows a single picture, offer its actions here as well.
    function pictureSection() {
        const picture = page.documentPicture();
        if (!picture || !page.status?.ready) return null;
        return h('section', {},
            h('h3', {}, 'This picture'),
            page.menuItems(picture).filter(Boolean).map((item) => h('button', {
                className: 'row picture-action',
                title: item.unavailable || item.hint || item.label,
                disabled: !!item.unavailable,
                onclick: item.run
            }, svg(item.icon), h('span', {}, item.label))));
    }
})();
