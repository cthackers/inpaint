// Ctrl+Alt + hover an image that links to a bigger version of itself
// (<a href="big.jpg"><img src="small.jpg"></a>) to load the big version
// in place, keeping the image's current rendered size so layout is intact.
(() => {
    let hovered = null;

    function upgrade(img) {
        if (img.dataset.upgradeState === 'loading' || img.dataset.upgradeState === 'done') return;

        const link = img.closest('a[href]');
        if (!link) return;
        const href = link.href;
        if (!/^https?:/i.test(href)) return;
        if (href === img.currentSrc || href === img.src) return;

        img.dataset.upgradeState = 'loading';
        const prevOutline = img.style.outline;
        img.style.outline = '2px solid #f0ad4e';

        // Preload the target: only swap if it really is an image.
        const loader = new Image();
        loader.onload = () => {
            // Freeze the current rendered size before changing the source.
            const rect = img.getBoundingClientRect();
            if (rect.width && rect.height) {
                img.style.width = rect.width + 'px';
                img.style.height = rect.height + 'px';
                img.style.objectFit = 'contain';
            }
            // srcset/sizes and <picture> sources would override src — neutralize.
            img.removeAttribute('srcset');
            img.removeAttribute('sizes');
            const picture = img.closest('picture');
            if (picture) {
                for (const source of picture.querySelectorAll('source')) source.remove();
            }
            img.src = href;
            img.dataset.upgradeState = 'done';
            img.style.outline = '2px solid #5cb85c';
            setTimeout(() => { img.style.outline = prevOutline; }, 600);
        };
        loader.onerror = () => {
            // Target isn't a loadable image (e.g. links to an HTML page).
            delete img.dataset.upgradeState;
            img.style.outline = prevOutline;
        };
        loader.src = href;
    }

    document.addEventListener('mouseover', (e) => {
        hovered = e.target instanceof HTMLImageElement ? e.target : null;
        if (hovered && e.ctrlKey && e.altKey) upgrade(hovered);
    }, true);

    document.addEventListener('mouseout', (e) => {
        if (e.target === hovered) hovered = null;
    }, true);

    // Also trigger when Ctrl+Alt is pressed while already hovering an image.
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.altKey && hovered) upgrade(hovered);
    }, true);
})();
