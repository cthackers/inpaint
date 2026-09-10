import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Image as ImageIcon } from "lucide-react";
import FolderNode from "./FolderTree";
import { SettingsButton } from "./Settings";
import { NewStoreDialog, SourcePicker, StorePanel } from "./Stores";
import type { ImageEntry, Store, StoreStats } from "./types";
import { storage } from "./storage";

/** The image store shown instead of a folder, with its sidebar actions. */
export type StoreView = {
  stores: Store[];
  active: Store | null;
  stats: StoreStats | null;
  progress: { done: number; total: number } | null;
  error: string;
  onOpen: (id: string) => void;
  onCreated: (store: Store) => void;
  onChanged: (store: Store) => void;
  onRemoved: () => void;
  onRescan: () => void;
};

type BrowserProps = {
  rootPath: string | null;
  currentPath: string | null;
  images: ImageEntry[];
  loading: boolean;
  store: StoreView;
  onOpenFolder: () => void;
  onSelectFolder: (path: string) => void;
  onOpenSettings: () => void;
  onEdit: (index: number) => void;
  initialScrollTop: number;
  onScrollPositionChange: (scrollTop: number) => void;
};

const fileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

// Stores hold tens of thousands of pictures, so the gallery only renders the rows near the
// viewport. Keep these in step with .image-row, .image-meta and .thumbnail-wrap in styles.css.
const CARD_MIN_WIDTH = 190;
const GRID_GAP = 20;
const META_HEIGHT = 54;
const THUMBNAIL_RATIO = 1.18;
const OVERSCAN_ROWS = 2;

// Thumbnails load as ordinary images from the app's thumb: address, which the webview decodes off its
// main thread and caches. The address includes the picture's size and time, so an edited picture gets a
// new one. Only a few load at once, nearest the middle of the view first, and cards scrolled away give up
// their turn, so a fast scroll leaves no backlog.
const MAX_LOADING = 16;
const loadedUrls = new Set<string>();
const waiting = new Set<{ row: number; start: () => void }>();
let loading = 0;
let focusRow = 0;

function loadNext() {
  while (loading < MAX_LOADING && waiting.size) {
    let next = waiting.values().next().value!;
    for (const waiter of waiting) {
      if (Math.abs(waiter.row - focusRow) < Math.abs(next.row - focusRow)) next = waiter;
    }
    waiting.delete(next);
    loading += 1;
    next.start();
  }
}

function setThumbnailFocus(row: number) {
  focusRow = row;
  loadNext();
}

const thumbnailUrl = (image: ImageEntry) => `${convertFileSrc(image.path, "thumb")}?v=${image.size}-${image.modifiedMs}`;

function Thumbnail({ image, row }: { image: ImageEntry; row: number }) {
  const url = thumbnailUrl(image);
  const [source, setSource] = useState(() => (loadedUrls.has(url) ? url : ""));
  const [shown, setShown] = useState(() => loadedUrls.has(url));
  const holdsTurn = useRef(false);
  const release = useCallback(() => {
    if (!holdsTurn.current) return;
    holdsTurn.current = false;
    loading -= 1;
    loadNext();
  }, []);

  useEffect(() => {
    if (loadedUrls.has(url)) {
      setSource(url);
      return;
    }
    const waiter = { row, start: () => { holdsTurn.current = true; setSource(url); } };
    waiting.add(waiter);
    loadNext();
    return () => {
      waiting.delete(waiter);
      release();
    };
  // The row only orders the queue; a card keeps its place while it stays mounted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, release]);

  return (
    <div className="thumbnail-wrap">
      {source && <img src={source} alt={image.name} draggable={false} decoding="async" className={shown ? "shown" : ""}
        onLoad={() => { loadedUrls.add(url); setShown(true); release(); }}
        onError={release} />}
      <div className="edit-hint">Double-click to edit</div>
    </div>
  );
}

// Memoized, so scrolling to another row does not render the cards already on screen again.
const ImageCard = memo(function ImageCard({ image, index, row, onEdit }: { image: ImageEntry; index: number; row: number; onEdit: (index: number) => void }) {
  return (
    <button className="image-card" onDoubleClick={() => onEdit(index)}>
      <Thumbnail image={image} row={row} />
      <div className="image-meta">
        <span className="image-name" title={image.name}>{image.name}</span>
        <span>{image.extension.toUpperCase()} · {fileSize(image.size)}</span>
      </div>
    </button>
  );
});

export default function BrowserView({
  rootPath,
  currentPath,
  images,
  loading,
  store,
  onOpenFolder,
  onSelectFolder,
  onOpenSettings,
  onEdit,
  initialScrollTop,
  onScrollPositionChange,
}: BrowserProps) {
  const galleryRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const restoredViewRef = useRef<string | null>(null);
  const [newStoreOpen, setNewStoreOpen] = useState(false);
  const [grid, setGrid] = useState({ width: 0, top: 0, viewport: 0 });
  const [firstRow, setFirstRow] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(storage.getItem("inpaint.expandedFolders") ?? "[]"));
    } catch {
      return new Set();
    }
  });

  const setFolderOpen = (path: string, open: boolean) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      open ? next.add(path) : next.delete(path);
      storage.setItem("inpaint.expandedFolders", JSON.stringify([...next]));
      return next;
    });
  };

  // A stable callback keeps the memoized cards from rendering again when the parent does.
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const edit = useCallback((index: number) => onEditRef.current(index), []);

  const viewKey = store.active ? `store:${store.active.id}` : currentPath;
  const columns = Math.max(1, Math.floor((grid.width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
  const rowStep = (grid.width - GRID_GAP * (columns - 1)) / columns / THUMBNAIL_RATIO + META_HEIGHT + GRID_GAP;
  const rowCount = Math.ceil(images.length / columns);
  const rowAt = (scrollTop: number) => Math.max(0, Math.floor((scrollTop - grid.top) / rowStep) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, firstRow + Math.ceil(grid.viewport / rowStep) + 1 + OVERSCAN_ROWS * 2);
  const showsGrid = !loading && images.length > 0;

  useLayoutEffect(() => {
    const gallery = galleryRef.current;
    const element = gridRef.current;
    if (!gallery || !element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top - gallery.getBoundingClientRect().top + gallery.scrollTop;
      const next = { width: element.clientWidth, top, viewport: gallery.clientHeight };
      setGrid((current) => current.width === next.width && current.top === next.top && current.viewport === next.viewport ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(gallery);
    return () => observer.disconnect();
  }, [showsGrid]);

  useLayoutEffect(() => {
    if (galleryRef.current) setFirstRow(rowAt(galleryRef.current.scrollTop));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, rowStep, images.length]);

  useLayoutEffect(() => {
    if (loading || !viewKey || restoredViewRef.current === viewKey) return;
    const gallery = galleryRef.current;
    if (!gallery || (images.length && !grid.width)) return;
    gallery.scrollTop = initialScrollTop;
    restoredViewRef.current = viewKey;
    setFirstRow(rowAt(gallery.scrollTop));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, images.length, initialScrollTop, loading, grid.width]);

  // Thumbnails nearest the middle of the view load first.
  useEffect(() => {
    setThumbnailFocus(firstRow + OVERSCAN_ROWS + Math.floor(grid.viewport / rowStep / 2));
  }, [firstRow, grid.viewport, rowStep]);

  const rows = [];
  for (let row = firstRow; row < lastRow; row += 1) {
    const start = row * columns;
    rows.push(
      <div className="image-row" key={row} style={{ top: row * rowStep, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {images.slice(start, start + columns).map((image, offset) => (
          <ImageCard key={image.path} image={image} index={start + offset} row={row} onEdit={edit} />
        ))}
      </div>,
    );
  }

  const title = store.active ? store.active.name : currentPath ? baseName(currentPath) : "Your images";
  const subtitle = store.active ? store.active.path : currentPath ?? "Open a folder containing PNG, JPG, WebP, GIF, BMP, or TIFF images.";
  const scanningStore = !!store.active && !!store.progress;

  return (
    <div className="browser-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" /> INPAINT</div>
        <SourcePicker
          stores={store.stores}
          activeStore={store.active}
          onOpenFolder={onOpenFolder}
          onNewStore={() => setNewStoreOpen(true)}
          onOpenStore={store.onOpen}
        />
        {store.active ? <>
          <div className="sidebar-label">IMAGE STORE</div>
          <StorePanel
            store={store.active}
            stats={store.stats}
            progress={store.progress}
            error={store.error}
            onRescan={store.onRescan}
            onChange={store.onChanged}
            onRemove={store.onRemoved}
          />
        </> : <>
          <div className="sidebar-label">FOLDERS</div>
          <div className="folder-tree">
            {rootPath ? (
              <FolderNode
                key={rootPath}
                folder={{ name: baseName(rootPath), path: rootPath }}
                selectedPath={currentPath ?? ""}
                onSelect={onSelectFolder}
                expandedFolders={expandedFolders}
                onSetOpen={setFolderOpen}
                initiallyOpen
              />
            ) : <div className="sidebar-empty">Choose a folder to begin.</div>}
          </div>
        </>}
        <div className="sidebar-footer"><SettingsButton onOpen={onOpenSettings} /></div>
      </aside>

      <main
        className="gallery"
        ref={galleryRef}
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop;
          setFirstRow(rowAt(scrollTop));
          if (!loading && restoredViewRef.current === viewKey) onScrollPositionChange(scrollTop);
        }}
      >
        <header className="gallery-header">
          <div>
            <h1>{title}</h1>
            <p title={store.active?.path ?? currentPath ?? undefined}>{subtitle}</p>
          </div>
          {viewKey && !loading && <div className="image-count">{images.length.toLocaleString()} {images.length === 1 ? "image" : "images"}</div>}
        </header>

        {loading || (scanningStore && !images.length) ? (
          <div className="center-state"><span className="spinner" />{store.active ? "Scanning store" : "Loading images"}</div>
        ) : images.length ? (
          <div className="image-grid" ref={gridRef} style={{ height: rowCount * rowStep - GRID_GAP }}>{rows}</div>
        ) : store.active ? (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>No pictures found</h2>
            <p>Pictures are listed when they are stored as ab/cd/abcd….jpg inside this folder.</p>
          </div>
        ) : (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>{currentPath ? "No images here" : "Open an image folder"}</h2>
            <p>{currentPath ? "This folder has no PNG, JPG, WebP, GIF, BMP, or TIFF files." : "Your image previews will appear here."}</p>
            {!currentPath && <button className="primary-button" onClick={onOpenFolder}>Choose folder</button>}
          </div>
        )}
      </main>
      {newStoreOpen && <NewStoreDialog
        onClose={() => setNewStoreOpen(false)}
        onCreated={(created) => { setNewStoreOpen(false); store.onCreated(created); }}
      />}
    </div>
  );
}
