import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronRight, FolderPlus, Image as ImageIcon, MoreVertical, Pencil, Search, Trash2, Undo2, X } from "lucide-react";
import type { Album } from "./types";
import { storage } from "./storage";

// Which albums are unfolded, per store, so the tree looks the same after a picture was edited.
const OPEN_ALBUMS = "inpaint.albumsOpen";

function readOpen(storeId: string): Set<string> {
  try {
    const saved = JSON.parse(storage.getItem(OPEN_ALBUMS) ?? "{}");
    const ids = saved && typeof saved === "object" ? saved[storeId] : null;
    return new Set(Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeOpen(storeId: string, ids: Set<string>) {
  try {
    const saved = JSON.parse(storage.getItem(OPEN_ALBUMS) ?? "{}");
    const all = saved && typeof saved === "object" ? saved : {};
    storage.setItem(OPEN_ALBUMS, JSON.stringify({ ...all, [storeId]: [...ids] }));
  } catch {
    /* The tree simply opens closed next time. */
  }
}

/** The store's albums and everything the sidebar and the gallery menus do with them. */
export type AlbumView = {
  storeId: string;
  /** Where pictures dragged from another program would go: an album's id, "" for the store, null when none is. */
  windowDrop?: string | null;
  albums: Album[];
  selected: Album | null;
  loading: boolean;
  error: string;
  /** Immich keeps its albums flat, so those cannot hold other albums. */
  immich: boolean;
  onSelect: (id: string | null) => void;
  /** Creates an album, holding `paths` from the start when the gallery asked for it. */
  onCreate: (name: string, parentId: string, paths?: string[]) => void;
  onRename: (album: Album, name: string) => void;
  onMove: (album: Album, parentId: string) => void;
  onSetCover: (album: Album, path: string) => void;
  onDelete: (album: Album) => void;
  onAddPictures: (album: Album, paths: string[]) => void;
  onRemovePictures: (album: Album, paths: string[]) => void;
};

/** Pictures being dragged from the gallery, as the paths the drop target adds to an album. */
export const PICTURE_DRAG = "application/x-inpaint-pictures";
/** An album dragged onto another one to move it there. */
export const ALBUM_DRAG = "application/x-inpaint-album";

export const dragPaths = (transfer: DataTransfer): string[] => {
  try {
    const value: unknown = JSON.parse(transfer.getData(PICTURE_DRAG) || "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
};

/** The albums of `parentId`, by name. */
const childrenOf = (albums: Album[], parentId: string) =>
  albums.filter((album) => album.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

/** Every album as one flat list with its depth, for the menus that add pictures. */
export function albumOptions(albums: Album[], parentId = "", depth = 0): { album: Album; depth: number }[] {
  return childrenOf(albums, parentId).flatMap((album) => [{ album, depth }, ...albumOptions(albums, album.id, depth + 1)]);
}

const coverUrl = (path: string) => `${convertFileSrc(path, "thumb")}?v=cover`;

/** A short modal that asks for one name, for creating and renaming albums. */
export function NameDialog({ title, label, initial, action, suggestions, onClose, onSubmit, onSubmitMany }: {
  title: string; label: string; initial: string; action: string; suggestions?: string[]; onClose: () => void;
  onSubmit?: (name: string) => void;
  /** Given instead of onSubmit, the dialog gathers several names: choosing one lists it below and clears the field. */
  onSubmitMany?: (names: string[]) => void;
}) {
  const [name, setName] = useState(initial);
  const [chosen, setChosen] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const many = !!onSubmitMany;
  const text = name.trim().toLowerCase();
  const taken = new Set(chosen.map((choice) => choice.toLowerCase()));
  const matches = (suggestions ?? [])
    .filter((choice) => choice.toLowerCase().includes(text) && choice.toLowerCase() !== text && !taken.has(choice.toLowerCase()))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(text)) - Number(!b.toLowerCase().startsWith(text)) || a.localeCompare(b))
    .slice(0, 80);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const choose = (choice: string) => {
    const value = choice.trim();
    if (!many) { setName(value); setHighlight(0); return; }
    if (value && !taken.has(value.toLowerCase())) setChosen((current) => [...current, value]);
    setName("");
    setHighlight(0);
  };
  // The field's own text counts too, so typing one name and pressing the button still works.
  const names = many ? [...chosen, ...(name.trim() && !taken.has(name.trim().toLowerCase()) ? [name.trim()] : [])] : [name.trim()].filter(Boolean);

  return <div className="leave-dialog-backdrop" role="presentation">
    <form className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="album-dialog-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!names.length) return;
        if (onSubmitMany) onSubmitMany(names);
        else onSubmit?.(names[0]);
        onClose();
      }}>
      <div className="server-dialog-heading">
        <strong id="album-dialog-title">{title}</strong>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="workspace-form">
        <label>{label}
          <input autoFocus value={name} maxLength={120} autoComplete="off" role={suggestions ? "combobox" : undefined} aria-expanded={!!matches.length}
            onChange={(event) => { setName(event.target.value); setHighlight(0); }}
            onKeyDown={(event) => {
              // Enter on an empty field adds the listed names, as the button does.
              if (many && event.key === "Enter" && !name.trim()) return;
              // Enter with nothing highlighted lists what was typed, as a new name.
              if (many && event.key === "Enter" && name.trim() && !matches.length) { event.preventDefault(); choose(name); return; }
              if (many && event.key === "Backspace" && !name && chosen.length) { setChosen((current) => current.slice(0, -1)); return; }
              if (!matches.length) return;
              if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((at) => Math.min(matches.length - 1, at + 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((at) => Math.max(0, at - 1)); }
              else if (event.key === "Enter" && matches[highlight]) { event.preventDefault(); choose(matches[highlight]); }
            }} />
        </label>
        {/* The list is ours rather than the browser's, which draws a white box over the dialog. */}
        {matches.length > 0 && <ul className="immich-options name-dialog-options" role="listbox">
          {matches.map((choice, at) => <li key={choice} role="option" aria-selected={at === highlight} className={at === highlight ? "active" : ""}
            onMouseEnter={() => setHighlight(at)}
            onMouseDown={(event) => { event.preventDefault(); choose(choice); }}>
            <span>{choice}</span>
          </li>)}
        </ul>}
        {suggestions && name.trim() && !suggestions.some((choice) => choice.toLowerCase() === name.trim().toLowerCase()) &&
          <small className="name-dialog-new">{many ? `Enter lists “${name.trim()}” as a new one.` : `${action} “${name.trim()}” as a new one.`}</small>}
        {many && chosen.length > 0 && <ul className="name-dialog-chosen" aria-label="Chosen">
          {chosen.map((choice) => <li key={choice}>
            <span>{choice}</span>
            <button type="button" className="icon-button" aria-label={`Remove ${choice}`} title="Remove"
              onClick={() => setChosen((current) => current.filter((entry) => entry !== choice))}><X size={13} /></button>
          </li>)}
        </ul>}
      </div>
      <div className="leave-dialog-actions">
        <button type="button" className="leave-no" onClick={onClose}>Cancel</button>
        <button type="submit" className="leave-yes" disabled={!names.length}>{many && names.length > 1 ? `${action}s (${names.length})` : action}</button>
      </div>
    </form>
  </div>;
}

type RowProps = {
  album: Album;
  albums: Album[];
  view: AlbumView;
  depth: number;
  open: Set<string>;
  /** While searching, only these albums are listed and every one of them is open. */
  found: Set<string> | null;
  onToggle: (id: string) => void;
  onRename: (album: Album) => void;
  onNewInside: (album: Album) => void;
};

function AlbumRow({ album, albums, view, depth, open, found, onToggle, onRename, onNewInside }: RowProps) {
  // The menu hangs outside the scrolling tree, so it is placed against the window instead.
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null);
  const menuOpen = menuAt !== null;
  const setMenuOpen = (open: boolean) => { if (!open) setMenuAt(null); };
  const [dropping, setDropping] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const children = childrenOf(albums, album.id).filter((child) => !found || found.has(child.id));
  const expanded = found ? children.length > 0 : open.has(album.id);
  const selected = view.selected?.id === album.id;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!row.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  // Pictures dropped from the gallery join the album; an album dropped on it moves inside.
  const accepts = (event: React.DragEvent) =>
    (event.dataTransfer.types.includes(PICTURE_DRAG) && !album.isVirtual) || (!view.immich && event.dataTransfer.types.includes(ALBUM_DRAG));
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    const paths = dragPaths(event.dataTransfer);
    if (paths.length) {
      view.onAddPictures(album, paths);
      return;
    }
    const moved = albums.find((candidate) => candidate.id === event.dataTransfer.getData(ALBUM_DRAG));
    if (moved && moved.id !== album.id) {
      view.onMove(moved, album.id);
      if (!expanded) onToggle(album.id);
    }
  };

  return <div className="album-node">
    <div
      ref={row}
      data-album-id={album.id}
      className={`album-row ${selected ? "selected" : ""} ${dropping || view.windowDrop === album.id ? "dropping" : ""} ${menuOpen ? "menu-open" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable={!view.immich && !album.isVirtual}
      onDragStart={(event) => { event.dataTransfer.setData(ALBUM_DRAG, album.id); event.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(event) => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
      onClick={() => view.onSelect(selected ? null : album.id)}
    >
      <button
        className={`tree-toggle ${expanded ? "open" : ""} ${children.length ? "" : "empty"}`}
        onClick={(event) => { event.stopPropagation(); onToggle(album.id); }}
        aria-label={expanded ? "Collapse album" : "Expand album"}
        tabIndex={children.length ? 0 : -1}
      ><ChevronRight size={13} /></button>
      <span className="album-cover">
        {album.coverPath
          ? <img src={coverUrl(album.coverPath)} alt="" draggable={false} decoding="async" />
          : <ImageIcon size={14} />}
      </span>
      <span className="album-name" title={album.name}>{album.name}</span>
      {/* The count and the actions share one slot: the dots take its place while the row is hovered. */}
      <span className="album-end">
      <span className="album-count">{album.total.toLocaleString()}</span>
      <button className="album-menu-button" aria-label={`Actions for ${album.name}`} aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          if (menuOpen) { setMenuAt(null); return; }
          const box = event.currentTarget.getBoundingClientRect();
          setMenuAt({ left: Math.min(box.right - 232, window.innerWidth - 240), top: Math.min(box.bottom + 4, window.innerHeight - 200) });
        }}><MoreVertical size={14} /></button>
      </span>
      {menuAt && <div className="album-menu" role="menu" style={menuAt} onClick={(event) => event.stopPropagation()}>
        {/* Renaming a grouping album renames the part in every album below it, as its name holds it. */}
        <button role="menuitem" onClick={() => { setMenuOpen(false); onRename(album); }}><Pencil size={14} /> Rename…</button>
        <button role="menuitem" onClick={() => { setMenuOpen(false); onNewInside(album); }}><FolderPlus size={14} /> New album inside…</button>
        {!view.immich && <>
          {album.coverPath && <button role="menuitem" onClick={() => { setMenuOpen(false); view.onSetCover(album, ""); }}><Undo2 size={14} /> Use the newest picture as cover</button>}
          {album.parentId && <button role="menuitem" onClick={() => { setMenuOpen(false); view.onMove(album, ""); }}><Undo2 size={14} /> Move to the top</button>}
        </>}
        {album.isVirtual
          ? <small>Only a part of the names below it, so Immich has no album of its own to delete.</small>
          : <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); view.onDelete(album); }}><Trash2 size={14} /> Delete album</button>}
      </div>}
    </div>
    {expanded && children.map((child) => (
      <AlbumRow key={child.id} album={child} albums={albums} view={view} depth={depth + 1} open={open} found={found} onToggle={onToggle} onRename={onRename} onNewInside={onNewInside} />
    ))}
  </div>;
}

/** The albums of the open store: a tree of covers and counts that filters the gallery. */
export default function AlbumsPanel({ view }: { view: AlbumView }) {
  const [open, setOpen] = useState<Set<string>>(() => readOpen(view.storeId));
  useEffect(() => { setOpen(readOpen(view.storeId)); }, [view.storeId]);
  const [dialog, setDialog] = useState<{ kind: "create"; parentId: string } | { kind: "rename"; album: Album } | null>(null);
  const [droppingRoot, setDroppingRoot] = useState(false);
  const [query, setQuery] = useState("");

  // Searching keeps the albums whose name matches, with the albums holding them as the way there.
  const found = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return null;
    const byId = new Map(view.albums.map((album) => [album.id, album]));
    const keep = new Set<string>();
    for (const album of view.albums) {
      if (!album.name.toLowerCase().includes(text)) continue;
      let walked: Album | undefined = album;
      while (walked && !keep.has(walked.id)) {
        keep.add(walked.id);
        walked = walked.parentId ? byId.get(walked.parentId) : undefined;
      }
    }
    return keep;
  }, [view.albums, query]);

  const roots = childrenOf(view.albums, "").filter((album) => !found || found.has(album.id));

  const setUnfolded = (id: string, unfolded: boolean) => setOpen((current) => {
    const next = new Set(current);
    unfolded ? next.add(id) : next.delete(id);
    writeOpen(view.storeId, next);
    return next;
  });
  const toggle = (id: string) => setUnfolded(id, !open.has(id));

  let dialogNode: ReactNode = null;
  if (dialog?.kind === "create") {
    dialogNode = <NameDialog title="New album" label="Name" initial="" action="Create album"
      onClose={() => setDialog(null)} onSubmit={(name) => { view.onCreate(name, dialog.parentId); if (dialog.parentId) setOpen((current) => new Set(current).add(dialog.parentId)); }} />;
  } else if (dialog?.kind === "rename") {
    dialogNode = <NameDialog title="Rename album" label="Name" initial={dialog.album.name} action="Save"
      onClose={() => setDialog(null)} onSubmit={(name) => view.onRename(dialog.album, name)} />;
  }

  return <div className="albums-panel">
    <div className="albums-actions">
      <button onClick={() => setDialog({ kind: "create", parentId: "" })}><FolderPlus size={14} /> New album</button>
      {view.selected && <button onClick={() => view.onSelect(null)}><X size={14} /> Show all</button>}
    </div>
    {view.albums.length > 6 && <label className="album-search">
      <Search size={14} />
      <input value={query} placeholder="Search albums" aria-label="Search albums" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
      {query && <button type="button" aria-label="Clear the search" onClick={() => setQuery("")}><X size={13} /></button>}
    </label>}
    {view.error && <p className="store-error">{view.error}</p>}
    <div
      className={`album-tree ${droppingRoot ? "dropping" : ""}`}
      // An album dragged onto the empty space below the tree moves back to the top level.
      onDragOver={(event) => { if (!view.immich && event.dataTransfer.types.includes(ALBUM_DRAG)) { event.preventDefault(); setDroppingRoot(true); } }}
      onDragLeave={() => setDroppingRoot(false)}
      onDrop={(event) => {
        setDroppingRoot(false);
        const moved = view.albums.find((album) => album.id === event.dataTransfer.getData(ALBUM_DRAG));
        if (moved && moved.parentId) { event.preventDefault(); view.onMove(moved, ""); }
      }}
    >
      {view.loading && !view.albums.length
        ? <div className="sidebar-empty">Reading albums…</div>
        : roots.length
          ? roots.map((album) => (
              <AlbumRow key={album.id} album={album} albums={view.albums} view={view} depth={0} open={open} found={found} onToggle={toggle}
                onRename={(target) => setDialog({ kind: "rename", album: target })}
                onNewInside={(target) => setDialog({ kind: "create", parentId: target.id })} />
            ))
          : found
            ? <div className="sidebar-empty">No album matches “{query.trim()}”.</div>
            : <div className="sidebar-empty">No albums yet. Create one, then drop pictures on it or use a picture's right-click menu.</div>}
    </div>
    {dialogNode}
  </div>;
}
