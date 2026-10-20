import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ArrowDownUp, Columns3, Copy, Folder, Heart, FolderMinus, FolderPlus, Images, Info, Image as ImageIcon, ImagePlus, LayoutGrid, Pencil, Search, Star, Tag as TagIcon, Trash2, X } from "lucide-react";
import FolderNode from "./FolderTree";
import { SettingsButton } from "./Settings";
import { NewStoreDialog, SourcePicker, StorePanel } from "./Stores";
import AlbumsPanel, { albumOptions, NameDialog, PICTURE_DRAG, type AlbumView } from "./Albums";
import TagsPanel, { type TagView } from "./Tags";
import { DuplicateGroups, DuplicatesPanel, type DuplicateView } from "./Duplicates";
import { DEFAULT_GALLERY_ORDER, type GalleryOrder, type ImageEntry, type PictureFacts, type Store, type StoreStats } from "./types";
import { storage } from "./storage";
import { usePreference } from "./preferences";

/** The image store shown instead of a folder, with its sidebar actions. */
export type StoreView = {
  stores: Store[];
  active: Store | null;
  revealed: boolean;
  stats: StoreStats | null;
  progress: { done: number; total: number } | null;
  error: string;
  albums: AlbumView;
  /** Which albums each picture is in, for the mark on its card. */
  albumsByPath: Record<string, string[]>;
  /** Where pictures dragged from another program would go: an album's id, "" for the store, null when none is. */
  windowDrop: string | null;
  dropMessage: string;
  onDropMessageClear: () => void;
  tags: TagView;
  duplicates: DuplicateView;
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
  /** How pictures are ordered and which are left out, and which of those choices apply here. */
  order: GalleryOrder;
  onOrder: (order: GalleryOrder) => void;
  orderChoices: { tagged: boolean; inAlbums: boolean };
  /** How many pictures the order's choices leave out. */
  leftOut: number;
  /** Favourites and ratings, for the marks on the cards. */
  facts: Record<string, PictureFacts>;
  store: StoreView;
  onOpenFolder: () => void;
  onSelectFolder: (path: string) => void;
  onOpenSettings: () => void;
  onEdit: (index: number) => void;
  /** Deletes the pictures and answers with what became of them. */
  onDeletePictures: (paths: string[]) => Promise<string>;
  initialScrollTop: number;
  onScrollPositionChange: (scrollTop: number) => void;
};

const fileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** A picture tagged `location/outside` also carries `location`; only the whole name is worth showing. */
const leafTags = (tags: string[] | undefined) =>
  (tags ?? []).filter((tag) => !tags?.some((other) => other !== tag && other.startsWith(`${tag}/`))).sort((a, b) => a.localeCompare(b));

type StoreTab = "albums" | "tags" | "duplicates" | "info";
/** The sidebar's panels for an open store, in the order their tabs stand. */
const STORE_TABS: { id: StoreTab; label: string; icon: typeof Images }[] = [
  { id: "albums", label: "Albums", icon: Images },
  { id: "tags", label: "Tags", icon: TagIcon },
  { id: "duplicates", label: "Duplicates", icon: Copy },
  { id: "info", label: "Info", icon: Info },
];

// Stores hold tens of thousands of pictures, so the gallery only renders the rows near the
// viewport. Keep these in step with .image-row and .thumbnail-wrap in styles.css.
const GRID_GAP = 20;
const META_HEIGHT = 0;
const THUMBNAIL_RATIO = 1.18;
const OVERSCAN_ROWS = 2;
/** How wide a card may be asked to become; a thumbnail is 480 px, so more than this only softens it. */
const CARD_WIDTHS = { min: 120, max: 420, step: 10, fallback: 190 };

// What shape each picture turned out to be, learned as its thumbnail loads, for the masonry layout.
// Pictures whose thumbnail has not arrived stand at the grid's shape until it does.
const shapes = new Map<string, number>();
let shapesLearned = 0;
let learnTimer = 0;

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

function Thumbnail({ image, row, onShape }: { image: ImageEntry; row: number; onShape?: () => void }) {
  const url = thumbnailUrl(image);
  const [source, setSource] = useState(() => (loadedUrls.has(url) ? url : ""));
  const [shown, setShown] = useState(() => loadedUrls.has(url));
  // A GIF plays while the pointer is on its card; the moving thumbnail covers the still one once it loaded.
  const [hovered, setHovered] = useState(false);
  const [moving, setMoving] = useState(false);
  const [playPreview, setPlayPreview] = useState(false);
  const animated = image.extension === "gif";
  useEffect(() => {
    setPlayPreview(false);
    setMoving(false);
    if (!hovered || !animated) return;
    // Passing over cards while scrolling should not start a batch of GIF decoders.
    const timer = window.setTimeout(() => setPlayPreview(true), 200);
    const stop = () => { window.clearTimeout(timer); setHovered(false); setPlayPreview(false); setMoving(false); };
    const visibility = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [hovered, animated, url]);
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
    <div className="thumbnail-wrap"
      onPointerEnter={animated ? () => setHovered(true) : undefined}
      onPointerLeave={animated ? () => { setHovered(false); setMoving(false); } : undefined}>
      {source && <img src={source} alt={image.name} draggable={false} decoding="async" className={shown ? "shown" : ""}
        onLoad={(event) => {
          loadedUrls.add(url);
          const picture = event.currentTarget;
          if (picture.naturalHeight > 0 && !shapes.has(image.path)) {
            shapes.set(image.path, picture.naturalWidth / picture.naturalHeight);
            shapesLearned += 1;
            onShape?.();
          }
          setShown(true);
          release();
        }}
        onError={release} />}
      {hovered && playPreview && shown && <img src={`${url}&animated&preview=2`} alt="" draggable={false} decoding="async"
        className={`thumbnail-animation ${moving ? "shown" : ""}`} onLoad={() => setMoving(true)}
        onError={() => { setPlayPreview(false); setMoving(false); }} />}
      <div className="edit-hint">Double-click to edit</div>
    </div>
  );
}

type CardProps = {
  image: ImageEntry;
  index: number;
  row: number;
  chosen: boolean;
  /** The picture's tags, joined for the mark's tooltip; empty when it has none. */
  tags: string;
  /** The albums the picture is in, joined the same way. */
  albums?: string;
  favorite?: boolean;
  /** 0 to 5 stars. */
  rating?: number;
  /** In masonry the card fills the place the layout gave it, rather than the grid's shape. */
  filling?: boolean;
  onShape?: () => void;
  onEdit: (index: number) => void;
  onChoose: (index: number, event: React.MouseEvent) => void;
  onMenu: (index: number, event: React.MouseEvent) => void;
  onDragPictures: (index: number, event: React.DragEvent) => void;
};

// Memoized, so scrolling to another row does not render the cards already on screen again.
const ImageCard = memo(function ImageCard({ image, index, row, chosen, tags, albums, favorite, rating = 0, filling, onEdit, onChoose, onMenu, onDragPictures, onShape }: CardProps) {
  return (
    <button
      className={`image-card ${chosen ? "chosen" : ""} ${filling ? "filling" : ""}`}
      aria-pressed={chosen}
      draggable
      onClick={(event) => onChoose(index, event)}
      onDoubleClick={() => onEdit(index)}
      onContextMenu={(event) => onMenu(index, event)}
      onDragStart={(event) => onDragPictures(index, event)}
    >
      <Thumbnail image={image} row={row} onShape={onShape} />
      {(tags || albums || favorite || rating > 0) && <span className="image-marks">
        {tags && <span className="image-mark" title={tags}><TagIcon size={13} /></span>}
        {albums && <span className="image-mark" title={albums}><Folder size={13} /></span>}
        {favorite && <span className="image-mark favorite" title="Favourite"><Heart size={13} fill="currentColor" /></span>}
        {rating > 0 && <span className="image-mark rating" title={`${rating}/5`}><Star size={13} fill="currentColor" /></span>}
      </span>}
    </button>
  );
});

type MenuProps = {
  x: number;
  y: number;
  paths: string[];
  albums: AlbumView;
  onEdit: () => void;
  onNewAlbum: () => void;
  onTag: () => void;
  onClose: () => void;
};

/** Right-click menu of the gallery: albums to put the pictures in, and what to do with them. */
function PictureMenu({ x, y, paths, albums, onEdit, onNewAlbum, onTag, onClose }: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ x, y });
  const [albumQuery, setAlbumQuery] = useState("");
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  // Keep the whole menu on screen, whichever corner it was opened in.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setPlace({ x: Math.min(x, window.innerWidth - box.width - 8), y: Math.min(y, window.innerHeight - box.height - 8) });
  }, [x, y]);

  const selected = albums.selected;
  const many = paths.length > 1;
  const act = (action: () => void) => { onClose(); action(); };
  const text = albumQuery.trim().toLowerCase();
  const listed = albumOptions(albums.albums).filter(({ album }) => !text || album.fullName.toLowerCase().includes(text) || album.name.toLowerCase().includes(text));

  return <div className="picture-menu" role="menu" ref={root} style={{ left: place.x, top: place.y }}>
    <div className="picture-menu-title">{many ? `${paths.length} pictures` : paths[0].split("/").at(-1)}</div>
    <button role="menuitem" onClick={() => act(onEdit)} disabled={many}><Pencil size={14} /> Edit</button>
    {selected && !selected.isVirtual && <button role="menuitem" onClick={() => act(() => albums.onRemovePictures(selected, paths))}>
      <FolderMinus size={14} /><span>Remove from “{selected.name}”</span>
    </button>}
    <hr />
    <div className="picture-menu-title">Add to album</div>
    {albums.albums.length > 6 && <label className="album-search picture-menu-search">
      <Search size={13} />
      <input autoFocus value={albumQuery} placeholder="Search albums" aria-label="Search albums"
        onChange={(event) => setAlbumQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && albumQuery) { event.stopPropagation(); setAlbumQuery(""); }
          // The first album listed is the one Enter adds to.
          else if (event.key === "Enter" && listed[0]) { event.preventDefault(); act(() => albums.onAddPictures(listed[0].album, paths)); }
        }} />
      {albumQuery && <button type="button" aria-label="Clear the search" onClick={() => setAlbumQuery("")}><X size={13} /></button>}
    </label>}
    <div className="picture-menu-albums">
      {listed.map(({ album, depth }) => (
        // A grouping album has nothing to add to, but it is still the way to read the ones below it.
        <button key={album.id} role="menuitem" style={{ paddingLeft: 10 + depth * 13 }} disabled={album.isVirtual}
          title={album.isVirtual ? `${album.name} only groups the albums below it` : album.fullName}
          onClick={() => act(() => albums.onAddPictures(album, paths))}>
          <ImagePlus size={14} /><span>{album.name}</span>
        </button>
      ))}
      {!listed.length && <small>{albums.albums.length ? "No album matches." : "No albums yet."}</small>}
    </div>
    <button role="menuitem" onClick={() => act(onNewAlbum)}><FolderPlus size={14} /> New album with {many ? "these pictures" : "this picture"}…</button>
    <button role="menuitem" onClick={() => act(onTag)}><TagIcon size={14} /> Add a tag…</button>
    {selected && !selected.isVirtual && <>
      <hr />
      <button role="menuitem" onClick={() => act(() => albums.onSetCover(selected, paths[0]))} disabled={many}>
        <Star size={14} /><span>Use as cover of “{selected.name}”</span>
      </button>
    </>}
  </div>;
}

const ORDERS: { id: GalleryOrder["by"]; label: string; first: [string, string] }[] = [
  { id: "modified", label: "Date modified", first: ["Newest first", "Oldest first"] },
  { id: "added", label: "Date added", first: ["Newest first", "Oldest first"] },
  { id: "rating", label: "Star rating", first: ["Most stars first", "Fewest stars first"] },
  { id: "name", label: "Name", first: ["Z to A", "A to Z"] },
];

/** The button beside the layout one: how the gallery is ordered, and which pictures it leaves out. */
function OrderPicker({ order, onOrder, choices }: { order: GalleryOrder; onOrder: (order: GalleryOrder) => void; choices: { tagged: boolean; inAlbums: boolean } }) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as globalThis.Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const current = ORDERS.find((entry) => entry.id === order.by) ?? ORDERS[0];
  const change = (part: Partial<GalleryOrder>) => onOrder({ ...order, ...part });
  // Only choices that apply here count, so the button does not stay lit inside an album.
  const leavingOut = !order.notFavorites || (choices.tagged && !order.tagged) || (choices.inAlbums && !order.inAlbums);
  const changed = leavingOut || order.by !== DEFAULT_GALLERY_ORDER.by || order.descending !== DEFAULT_GALLERY_ORDER.descending;
  return <div className="layout-picker" ref={picker}>
    <button className={`icon-button ${changed ? "active" : ""}`} aria-haspopup="dialog" aria-expanded={open} title="Order and filter" aria-label="Order and filter"
      onClick={() => setOpen(!open)}><ArrowDownUp size={17} /></button>
    {open && <div className="layout-menu order-menu" role="dialog" aria-label="Order and filter">
      <div className="order-options" role="radiogroup" aria-label="Order by">
        {ORDERS.map((entry) => <button key={entry.id} role="radio" aria-checked={order.by === entry.id} className={order.by === entry.id ? "active" : ""}
          onClick={() => change({ by: entry.id })}>{entry.label}</button>)}
      </div>
      <div className="layout-modes">
        <button className={order.descending ? "active" : ""} aria-pressed={order.descending} onClick={() => change({ descending: true })}>{current.first[0]}</button>
        <button className={!order.descending ? "active" : ""} aria-pressed={!order.descending} onClick={() => change({ descending: false })}>{current.first[1]}</button>
      </div>
      <div className="order-filters">
        <label className={choices.tagged ? "" : "unavailable"} title={choices.tagged ? "Untick to show only pictures without tags" : "Only while every picture of a store is shown"}>
          <input type="checkbox" checked={order.tagged} disabled={!choices.tagged} onChange={(event) => change({ tagged: event.target.checked })} /> Show tagged pictures
        </label>
        {choices.inAlbums && <label title="Untick to show only pictures that are in no album">
          <input type="checkbox" checked={order.inAlbums} onChange={(event) => change({ inAlbums: event.target.checked })} /> Show pictures in albums
        </label>}
        <label title="Untick to show only favourites">
          <input type="checkbox" checked={order.notFavorites} onChange={(event) => change({ notFavorites: event.target.checked })} /> Show pictures that are not favourites
        </label>
      </div>
    </div>}
  </div>;
}

export default function BrowserView({
  rootPath,
  currentPath,
  images,
  loading,
  order,
  onOrder,
  orderChoices,
  leftOut,
  facts,
  store,
  onOpenFolder,
  onSelectFolder,
  onOpenSettings,
  onEdit,
  onDeletePictures,
  initialScrollTop,
  onScrollPositionChange,
}: BrowserProps) {
  const galleryRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const restoredViewRef = useRef<string | null>(null);
  const [newStoreOpen, setNewStoreOpen] = useState(false);
  const [storeTab, setStoreTab] = useState<StoreTab>(() => {
    const saved = storage.getItem("inpaint.storeTab");
    return STORE_TABS.some((tab) => tab.id === saved) ? saved as StoreTab : "albums";
  });
  // The Duplicates tab shows its groups in place of the gallery.
  const duplicatesShown = !!store.active && storeTab === "duplicates";
  // Pictures picked in the gallery, by path, for adding several of them to an album at once.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const chosenAnchor = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; paths: string[]; index: number } | null>(null);
  const [albumFor, setAlbumFor] = useState<string[] | null>(null);
  const [tagFor, setTagFor] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");

  const removePictures = async (paths: string[]) => {
    if (!paths.length) return;
    const question = paths.length === 1
      ? "Delete this picture? It goes to the trash, or to Immich's trash in an Immich-compatible store."
      : `Delete these ${paths.length.toLocaleString()} pictures? They go to the trash, or to Immich's trash in an Immich-compatible store.`;
    if (!await confirm(question, { title: "Delete pictures", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" })) return;
    setDeleting(true);
    setNotice("");
    try {
      setNotice(await onDeletePictures(paths));
      setChosen(new Set());
    } finally {
      setDeleting(false);
    }
  };
  const [grid, setGrid] = useState({ width: 0, top: 0, viewport: 0 });
  const [firstRow, setFirstRow] = useState(0);
  // The header keeps its place while the grid scrolls under it, and draws a line once it does.
  const [scrolled, setScrolled] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [layout, setLayout] = usePreference<"grid" | "masonry">("inpaint.galleryLayout", "grid", (value) => value === "grid" || value === "masonry");
  const [cardWidth, setCardWidth] = usePreference("inpaint.cardWidth", CARD_WIDTHS.fallback, (value) => value >= CARD_WIDTHS.min && value <= CARD_WIDTHS.max);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutMenu = useRef<HTMLDivElement>(null);
  // Masonry follows the shapes thumbnails bring in, at most a few times a second.
  const [learned, setLearned] = useState(0);
  const noteShape = useCallback(() => {
    if (learnTimer) return;
    learnTimer = window.setTimeout(() => { learnTimer = 0; setLearned(shapesLearned); }, 250);
  }, []);
  useEffect(() => () => { if (learnTimer) { window.clearTimeout(learnTimer); learnTimer = 0; } }, []);
  useEffect(() => {
    if (!layoutOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!layoutMenu.current?.contains(event.target as globalThis.Node)) setLayoutOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setLayoutOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [layoutOpen]);
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
  // The cards call these while the gallery keeps changing, so they read the current list from a ref.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  // Picking pictures, their menu and their drag are about albums, which only a store has.
  const inStoreRef = useRef(false);
  inStoreRef.current = !!store.active;

  const choose = useCallback((index: number, event: React.MouseEvent) => {
    const image = imagesRef.current[index];
    if (!image || !inStoreRef.current) return;
    if (event.shiftKey && chosenAnchor.current !== null) {
      const [from, to] = [chosenAnchor.current, index].sort((a, b) => a - b);
      const range = imagesRef.current.slice(from, to + 1).map((entry) => entry.path);
      setChosen((current) => new Set(event.ctrlKey || event.metaKey ? [...current, ...range] : range));
      return;
    }
    chosenAnchor.current = index;
    setChosen((current) => {
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(current);
        next.has(image.path) ? next.delete(image.path) : next.add(image.path);
        return next;
      }
      return current.size === 1 && current.has(image.path) ? new Set() : new Set([image.path]);
    });
  }, []);

  /** What a card's menu or drag acts on: the picked pictures when it is one of them, else itself. */
  const actedOn = useCallback((index: number) => {
    const image = imagesRef.current[index];
    if (!image || !inStoreRef.current) return [];
    return chosenRef.current.has(image.path) ? [...chosenRef.current] : [image.path];
  }, []);

  const openMenu = useCallback((index: number, event: React.MouseEvent) => {
    event.preventDefault();
    const paths = actedOn(index);
    if (paths.length) setMenu({ x: event.clientX, y: event.clientY, paths, index });
  }, [actedOn]);

  const dragPictures = useCallback((index: number, event: React.DragEvent) => {
    const paths = actedOn(index);
    if (!paths.length) return;
    event.dataTransfer.setData(PICTURE_DRAG, JSON.stringify(paths));
    event.dataTransfer.effectAllowed = "copy";
  }, [actedOn]);

  const viewKey = store.active ? `store:${store.active.id}${store.albums.selected ? `/album:${store.albums.selected.id}` : ""}` : currentPath;

  // Pictures picked in one view are not picked in the next.
  useEffect(() => {
    setChosen(new Set());
    setMenu(null);
    chosenAnchor.current = null;
  }, [viewKey]);
  const columns = Math.max(1, Math.floor((grid.width + GRID_GAP) / (cardWidth + GRID_GAP)));
  const columnWidth = (grid.width - GRID_GAP * (columns - 1)) / columns;
  const rowStep = columnWidth / THUMBNAIL_RATIO + META_HEIGHT + GRID_GAP;
  const rowCount = Math.ceil(images.length / columns);
  const rowAt = (scrollTop: number) => Math.max(0, Math.floor((scrollTop - grid.top) / rowStep) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, firstRow + Math.ceil(grid.viewport / rowStep) + 1 + OVERSCAN_ROWS * 2);

  // Masonry keeps each picture's own shape: every card goes into the column that ends highest.
  const masonry = useMemo(() => {
    if (layout !== "masonry" || !columnWidth) return null;
    const bottoms = new Array(columns).fill(0);
    const places = images.map((image) => {
      let column = 0;
      for (let at = 1; at < columns; at += 1) if (bottoms[at] < bottoms[column]) column = at;
      const height = Math.round(columnWidth / (shapes.get(image.path) ?? THUMBNAIL_RATIO));
      const place = { top: Math.round(bottoms[column]), left: Math.round(column * (columnWidth + GRID_GAP)), height };
      bottoms[column] += height + GRID_GAP;
      return place;
    });
    return { places, height: Math.max(0, Math.max(...bottoms, 0) - GRID_GAP) };
  // The shapes are learned as thumbnails arrive; `learned` counts them so the layout follows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, images, columns, columnWidth, learned]);
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
  }, [showsGrid, duplicatesShown]);

  useLayoutEffect(() => {
    if (galleryRef.current) setFirstRow(rowAt(galleryRef.current.scrollTop));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, rowStep, images.length]);

  useLayoutEffect(() => {
    if (loading || duplicatesShown || !viewKey || restoredViewRef.current === viewKey) return;
    const gallery = galleryRef.current;
    if (!gallery || (images.length && !grid.width)) return;
    gallery.scrollTop = initialScrollTop;
    restoredViewRef.current = viewKey;
    setFirstRow(rowAt(gallery.scrollTop));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, images.length, initialScrollTop, loading, grid.width, duplicatesShown]);

  // Thumbnails nearest the middle of the view load first.
  useEffect(() => {
    setThumbnailFocus(firstRow + OVERSCAN_ROWS + Math.floor(grid.viewport / rowStep / 2));
  }, [firstRow, grid.viewport, rowStep]);

  const rows = [];
  if (masonry) {
    // Only the cards near the view are built, as in the grid.
    const from = grid.top === 0 ? 0 : scrollTop - grid.top - grid.viewport * OVERSCAN_ROWS;
    const to = scrollTop - grid.top + grid.viewport * (1 + OVERSCAN_ROWS);
    images.forEach((image, at) => {
      const place = masonry.places[at];
      if (!place || place.top + place.height < from || place.top > to) return;
      rows.push(
        <div className="masonry-card" key={image.path} style={{ top: place.top, left: place.left, width: columnWidth, height: place.height }}>
          <ImageCard image={image} index={at} row={Math.round(place.top / Math.max(1, rowStep))} chosen={chosen.has(image.path)}
            tags={leafTags(store.tags.byPath[image.path]).join("\n")} albums={(store.albumsByPath[image.path] ?? []).join("\n")} favorite={!!facts[image.path]?.favorite} rating={facts[image.path]?.rating ?? 0} filling
            onEdit={edit} onChoose={choose} onMenu={openMenu} onDragPictures={dragPictures} onShape={noteShape} />
        </div>,
      );
    });
  } else {
    for (let row = firstRow; row < lastRow; row += 1) {
      const start = row * columns;
      rows.push(
        <div className="image-row" key={row} style={{ top: Math.round(row * rowStep), gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {images.slice(start, start + columns).map((image, offset) => (
            <ImageCard key={image.path} image={image} index={start + offset} row={row} chosen={chosen.has(image.path)}
              tags={leafTags(store.tags.byPath[image.path]).join("\n")} albums={(store.albumsByPath[image.path] ?? []).join("\n")} favorite={!!facts[image.path]?.favorite} rating={facts[image.path]?.rating ?? 0}
              onEdit={edit} onChoose={choose} onMenu={openMenu} onDragPictures={dragPictures} onShape={noteShape} />
          ))}
        </div>,
      );
    }
  }

  const album = store.albums.selected;
  const tag = store.tags.selected;
  const title = tag ? tag.split("/").at(-1) ?? tag : album ? album.name : store.active ? store.active.name : currentPath ? baseName(currentPath) : "Your images";
  const subtitle = tag
    ? `Tagged ${tag} in ${store.active?.name ?? "the store"}`
    : album ? `Album of ${store.active?.name ?? "the store"}` : store.active ? store.active.path : currentPath ?? "Open a folder containing PNG, JPG, WebP, GIF, BMP, or TIFF images.";
  const scanningStore = !!store.active && !!store.progress;
  useEffect(() => {
    // Back from the groups, the gallery returns to where it was scrolled.
    if (duplicatesShown) restoredViewRef.current = null;
  }, [duplicatesShown]);

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
        {store.active ? <div className="sidebar-body">
          <nav className="sidebar-rail" aria-label="Store panels">
            {STORE_TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} title={label} aria-label={label} aria-pressed={storeTab === id} className={storeTab === id ? "active" : ""}
                onClick={() => { setStoreTab(id); storage.setItem("inpaint.storeTab", id); }}>
                <Icon size={18} aria-hidden="true" />
              </button>
            ))}
          </nav>
          <div className="sidebar-panel">
            {storeTab === "albums" && <AlbumsPanel view={store.albums} />}
            {storeTab === "tags" && <TagsPanel view={store.tags} />}
            {storeTab === "duplicates" && <DuplicatesPanel view={store.duplicates} />}
            {storeTab === "info" && <StorePanel
              store={store.active}
              revealed={store.revealed}
              stats={store.stats}
              progress={store.progress}
              error={store.error}
              onRescan={store.onRescan}
              onChange={store.onChanged}
              onRemove={store.onRemoved}
            />}
          </div>
        </div> : <>
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
        className={`gallery ${store.windowDrop !== null ? "window-dropping" : ""}`}
        ref={galleryRef}
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop;
          setFirstRow(rowAt(scrollTop));
          setScrolled(scrollTop > 4);
          setScrollTop(scrollTop);
          if (!loading && !duplicatesShown && restoredViewRef.current === viewKey) onScrollPositionChange(scrollTop);
        }}
      >
        <header className={`gallery-header ${scrolled ? "stuck" : ""}`}>
          <div>
            <h1>{duplicatesShown ? "Duplicates" : title}</h1>
            <p title={store.active?.path ?? currentPath ?? undefined}>{duplicatesShown ? `Copies of the same picture in ${store.active?.name ?? "the store"}` : subtitle}</p>
          </div>
          {/* Everything after the title keeps together at the right edge, next to the layout button. */}
          <div className="gallery-header-actions">
          {notice && <div className="gallery-notice" role="status">{notice}<button aria-label="Hide" onClick={() => setNotice("")}><X size={13} /></button></div>}
          {store.windowDrop !== null && <div className="gallery-notice" role="status">
            Drop to save into {store.windowDrop ? `“${store.albums.albums.find((album) => album.id === store.windowDrop)?.name ?? "the album"}”` : `“${store.active?.name ?? "the store"}”`}
          </div>}
          {store.dropMessage && store.windowDrop === null && <div className="gallery-notice" role="status">{store.dropMessage}<button aria-label="Hide" onClick={store.onDropMessageClear}><X size={13} /></button></div>}
          {duplicatesShown ? <div className="image-count">
            {store.duplicates.groups.length.toLocaleString()} {store.duplicates.groups.length === 1 ? "group" : "groups"}
          </div> : chosen.size > 0 ? <div className="chosen-bar">
            <span>{chosen.size.toLocaleString()} picked</span>
            {store.albums.selected && !store.albums.selected.isVirtual && <button title={`Remove the picked pictures from “${store.albums.selected.fullName || store.albums.selected.name}”`}
              onClick={() => { store.albums.onRemovePictures(store.albums.selected!, [...chosen]); setChosen(new Set()); }}>
              <FolderMinus size={14} /> Remove from “{store.albums.selected.name}”
            </button>}
            <button onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const paths = [...chosen];
              setMenu({ x: box.left, y: box.bottom + 6, paths, index: images.findIndex((image) => image.path === paths[0]) });
            }}><FolderPlus size={14} /> Add to album…</button>
            <button onClick={() => setTagFor([...chosen])}><TagIcon size={14} /> Tag…</button>
            <button className="danger" disabled={deleting} onClick={() => void removePictures([...chosen])}><Trash2 size={14} /> Delete…</button>
            <button onClick={() => setAlbumFor([...chosen])}><FolderPlus size={14} /> New album…</button>
            <button onClick={() => setChosen(new Set())}>Clear</button>
          </div> : viewKey && !loading && <div className="image-count" title={leftOut ? `${leftOut.toLocaleString()} left out by the filters` : undefined}>
            {images.length.toLocaleString()} {images.length === 1 ? "image" : "images"}{leftOut > 0 && ` · ${leftOut.toLocaleString()} hidden`}
          </div>}
          {!duplicatesShown && <OrderPicker order={order} onOrder={onOrder} choices={orderChoices} />}
          {!duplicatesShown && <div className="layout-picker" ref={layoutMenu}>
            <button className="icon-button" aria-haspopup="dialog" aria-expanded={layoutOpen} title="Layout and thumbnail size" aria-label="Layout and thumbnail size"
              onClick={() => setLayoutOpen(!layoutOpen)}><LayoutGrid size={17} /></button>
            {layoutOpen && <div className="layout-menu" role="dialog" aria-label="Layout">
              <div className="layout-modes">
                <button className={layout === "grid" ? "active" : ""} aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>
                  <LayoutGrid size={15} /> Grid
                </button>
                <button className={layout === "masonry" ? "active" : ""} aria-pressed={layout === "masonry"} onClick={() => setLayout("masonry")}>
                  <Columns3 size={15} /> Masonry
                </button>
              </div>
              <label className="layout-size">
                <span>Thumbnail width<output>{cardWidth} px</output></span>
                <input type="range" min={CARD_WIDTHS.min} max={CARD_WIDTHS.max} step={CARD_WIDTHS.step} value={cardWidth}
                  onChange={(event) => setCardWidth(Number(event.target.value))} />
              </label>
            </div>}
          </div>}
          </div>
        </header>

        {duplicatesShown ? (
          <DuplicateGroups view={store.duplicates} />
        ) : loading || (scanningStore && !images.length) ? (
          <div className="center-state"><span className="spinner" />{store.active ? "Scanning store" : "Loading images"}</div>
        ) : images.length ? (
          <div className={`image-grid ${masonry ? "masonry" : ""}`} ref={gridRef} style={{ height: masonry ? masonry.height : rowCount * rowStep - GRID_GAP }}>{rows}</div>
        ) : leftOut > 0 ? (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>The filters leave out every picture</h2>
            <p>{leftOut.toLocaleString()} {leftOut === 1 ? "picture is" : "pictures are"} hidden by the choices under the order button.</p>
            <button className="primary-button" onClick={() => onOrder({ ...order, tagged: true, inAlbums: true, notFavorites: true })}>Show them</button>
          </div>
        ) : tag ? (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>{store.tags.refreshable && !Object.keys(store.tags.byPath).length ? "The tags have not been read yet" : "No picture carries this tag"}</h2>
            <p>{store.tags.refreshable && !Object.keys(store.tags.byPath).length
              ? "Immich keeps which pictures carry which tag. Read them once with “Read tags” in the sidebar, and they are kept until you read them again."
              : `Nothing in this store is tagged ${tag} or below it.`}</p>
            <button className="primary-button" onClick={() => store.tags.onSelect("")}>Show every picture</button>
          </div>
        ) : album ? (
          <div className="empty-gallery">
            <div className="empty-icon"><ImageIcon size={28} /></div>
            <h2>{album.total ? "None of these pictures are in this store" : "This album is empty"}</h2>
            <p>{album.total
              ? `${album.total.toLocaleString()} ${album.total === 1 ? "picture is" : "pictures are"} in the album, but none of them were found in ${store.active?.name ?? "this store"}${store.albums.immich ? ". Check the folder as Immich sees it, in Info." : "."}`
              : "Drop pictures on the album in the sidebar, or add them from a picture's right-click menu."}</p>
            <button className="primary-button" onClick={() => store.albums.onSelect(null)}>Show every picture</button>
          </div>
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
      {menu && <PictureMenu
        x={menu.x}
        y={menu.y}
        paths={menu.paths}
        albums={store.albums}
        onEdit={() => onEdit(menu.index)}
        onNewAlbum={() => setAlbumFor(menu.paths)}
        onTag={() => setTagFor(menu.paths)}
        onClose={() => setMenu(null)}
      />}
      {tagFor && <NameDialog
        title={`Tag ${tagFor.length.toLocaleString()} ${tagFor.length === 1 ? "picture" : "pictures"}`}
        label="Tag (a name like location/outside makes a tag inside another)"
        initial=""
        action="Add tag"
        suggestions={store.tags.names}
        onClose={() => setTagFor(null)}
        onSubmitMany={(names) => store.tags.onTagPictures(tagFor, names)}
      />}
      {albumFor && <NameDialog
        title="New album"
        label="Name"
        initial=""
        action={`Create with ${albumFor.length.toLocaleString()} ${albumFor.length === 1 ? "picture" : "pictures"}`}
        onClose={() => setAlbumFor(null)}
        onSubmit={(name) => store.albums.onCreate(name, "", albumFor)}
      />}
      {newStoreOpen && <NewStoreDialog
        onClose={() => setNewStoreOpen(false)}
        onCreated={(created) => { setNewStoreOpen(false); store.onCreated(created); }}
      />}
    </div>
  );
}
