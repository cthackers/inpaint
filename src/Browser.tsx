import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, Image as ImageIcon } from "lucide-react";
import FolderNode from "./FolderTree";
import type { ImageEntry } from "./types";

type BrowserProps = {
  rootPath: string | null;
  currentPath: string | null;
  images: ImageEntry[];
  loading: boolean;
  onOpenFolder: () => void;
  onSelectFolder: (path: string) => void;
  onEdit: (index: number) => void;
  initialScrollTop: number;
  onScrollPositionChange: (scrollTop: number) => void;
};

const fileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

const thumbnailCache = new Map<string, string>();
const thumbnailQueue: Array<() => Promise<void>> = [];
let activeThumbnailLoads = 0;

const runThumbnailQueue = () => {
  while (activeThumbnailLoads < 4 && thumbnailQueue.length) {
    const task = thumbnailQueue.shift()!;
    activeThumbnailLoads += 1;
    void task().finally(() => {
      activeThumbnailLoads -= 1;
      runThumbnailQueue();
    });
  }
};

const queueThumbnail = (task: () => Promise<void>) => {
  thumbnailQueue.push(task);
  runThumbnailQueue();
};

function Thumbnail({ image }: { image: ImageEntry }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cacheKey = `${image.path}:${image.size}:${image.modifiedMs}`;
  const [source, setSource] = useState(() => thumbnailCache.get(cacheKey) ?? "");

  useEffect(() => {
    if (source) return;
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    let requested = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || requested) return;
      requested = true;
      observer.disconnect();
      queueThumbnail(async () => {
        try {
          const data = thumbnailCache.get(cacheKey)
            ?? await invoke<string>("read_thumbnail_data", { path: image.path });
          thumbnailCache.set(cacheKey, data);
          if (active) setSource(data);
        } catch (error) {
          console.error(`Cannot load thumbnail for ${image.path}`, error);
        }
      });
    }, { rootMargin: "120px" });
    observer.observe(container);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cacheKey, image.path, source]);

  return (
    <div className="thumbnail-wrap" ref={containerRef}>
      {source ? <img src={source} alt={image.name} draggable={false} /> : <span className="thumbnail-loading" />}
      <div className="edit-hint">Double-click to edit</div>
    </div>
  );
}

export default function BrowserView({
  rootPath,
  currentPath,
  images,
  loading,
  onOpenFolder,
  onSelectFolder,
  onEdit,
  initialScrollTop,
  onScrollPositionChange,
}: BrowserProps) {
  const galleryRef = useRef<HTMLElement>(null);
  const restoredFolderRef = useRef<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("inpaint.expandedFolders") ?? "[]"));
    } catch {
      return new Set();
    }
  });

  const setFolderOpen = (path: string, open: boolean) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      open ? next.add(path) : next.delete(path);
      localStorage.setItem("inpaint.expandedFolders", JSON.stringify([...next]));
      return next;
    });
  };

  useLayoutEffect(() => {
    if (loading || !currentPath || restoredFolderRef.current === currentPath) return;
    const gallery = galleryRef.current;
    if (!gallery) return;
    gallery.scrollTop = initialScrollTop;
    restoredFolderRef.current = currentPath;
  }, [currentPath, images.length, initialScrollTop, loading]);

  return (
    <div className="browser-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" /> INPAINT</div>
        <button className="open-folder" onClick={onOpenFolder}>
          <FolderPlus size={17} /> Open folder
        </button>
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
      </aside>

      <main
        className="gallery"
        ref={galleryRef}
        onScroll={(event) => {
          if (!loading && restoredFolderRef.current === currentPath) {
            onScrollPositionChange(event.currentTarget.scrollTop);
          }
        }}
      >
        <header className="gallery-header">
          <div>
            <h1>{currentPath ? baseName(currentPath) : "Your images"}</h1>
            <p>{currentPath ?? "Open a folder containing PNG, JPG, or WebP images."}</p>
          </div>
          {currentPath && <div className="image-count">{images.length} {images.length === 1 ? "image" : "images"}</div>}
        </header>

        {loading ? (
          <div className="center-state"><span className="spinner" />Loading images</div>
        ) : images.length ? (
          <div className="image-grid">
            {images.map((image, index) => (
              <button className="image-card" key={image.path} onDoubleClick={() => onEdit(index)}>
                <Thumbnail image={image} />
                <div className="image-meta">
                  <span className="image-name" title={image.name}>{image.name}</span>
                  <span>{image.extension.toUpperCase()} · {fileSize(image.size)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>{currentPath ? "No images here" : "Open an image folder"}</h2>
            <p>{currentPath ? "This folder has no PNG, JPG, or WebP files." : "Your image previews will appear here."}</p>
            {!currentPath && <button className="primary-button" onClick={onOpenFolder}>Choose folder</button>}
          </div>
        )}
      </main>
    </div>
  );
}
