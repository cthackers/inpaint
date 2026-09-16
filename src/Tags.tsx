import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, MoreVertical, Pencil, RefreshCw, Search, Tag as TagIcon, TagsIcon, Trash2, X } from "lucide-react";
import { NameDialog } from "./Albums";

/** The tags of the open store and the one the gallery is filtered by. */
export type TagView = {
  /** Every tag name, as full paths such as `action/cooking`. */
  names: string[];
  /** Which tags each picture carries, by path. */
  byPath: Record<string, string[]>;
  selected: string;
  loading: boolean;
  /** Reading a store's tags from Immich takes a while, so its progress is shown. */
  progress: { done: number; total: number } | null;
  error: string;
  /** Immich keeps the tags, so they are read again on request rather than on every start. */
  refreshable: boolean;
  onSelect: (name: string) => void;
  onRefresh: () => void;
  /** Puts one tag on the pictures picked in the gallery, creating it when it is new. */
  onTagPictures: (paths: string[], names: string[]) => void;
  /** Creates a tag, inside `parent` when one is given. */
  onCreate: (parent: string, leaf: string) => void;
  /** Renames a tag's last part, carrying the tags below it. */
  onRename: (name: string, leaf: string) => void;
  /** Removes a tag and the tags below it from every picture. */
  onDelete: (name: string) => void;
};

/** A tag holds the pictures carrying it and the ones carrying any tag below it. */
export const taggedWith = (tags: string[] | undefined, name: string) =>
  !!tags?.some((tag) => tag === name || tag.startsWith(`${name}/`));

type TagNode = { name: string; full: string; children: TagNode[] };

/** Turns `action/cooking` names into the tree the panel shows. */
function treeOf(names: string[]): TagNode[] {
  const roots: TagNode[] = [];
  const byFull = new Map<string, TagNode>();
  for (const full of [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const parts = full.split("/").filter(Boolean);
    let prefix = "";
    let siblings = roots;
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let node = byFull.get(prefix.toLowerCase());
      if (!node) {
        node = { name: part, full: prefix, children: [] };
        byFull.set(prefix.toLowerCase(), node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  return roots;
}

function TagRow({ node, view, counts, depth, open, onToggle, found, onRename, onNewInside }: {
  node: TagNode; view: TagView; counts: Map<string, number>; depth: number; open: Set<string>; onToggle: (full: string) => void; found: Set<string> | null;
  onRename: (node: TagNode) => void; onNewInside: (node: TagNode) => void;
}) {
  const children = node.children.filter((child) => !found || found.has(child.full));
  const expanded = found ? children.length > 0 : open.has(node.full);
  const selected = view.selected === node.full;
  const count = counts.get(node.full) ?? 0;
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuAt) return;
    const closeOutside = (event: PointerEvent) => { if (!row.current?.contains(event.target as globalThis.Node)) setMenuAt(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuAt(null); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuAt]);

  return <div className="album-node">
    <div ref={row} className={`album-row ${selected ? "selected" : ""} ${menuAt ? "menu-open" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => view.onSelect(selected ? "" : node.full)}>
      <button className={`tree-toggle ${expanded ? "open" : ""} ${children.length ? "" : "empty"}`} tabIndex={children.length ? 0 : -1}
        aria-label={expanded ? "Collapse tag" : "Expand tag"}
        onClick={(event) => { event.stopPropagation(); onToggle(node.full); }}><ChevronRight size={13} /></button>
      <span className="tag-mark"><TagIcon size={13} /></span>
      <span className="album-name" title={node.full}>{node.name}</span>
      <span className="album-end">
        <span className="album-count">{count > 0 ? count.toLocaleString() : ""}</span>
        <button className="album-menu-button" aria-label={`Actions for ${node.full}`} aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            if (menuAt) { setMenuAt(null); return; }
            const box = event.currentTarget.getBoundingClientRect();
            setMenuAt({ left: Math.min(box.right - 232, window.innerWidth - 240), top: Math.min(box.bottom + 4, window.innerHeight - 170) });
          }}><MoreVertical size={14} /></button>
      </span>
      {menuAt && <div className="album-menu" role="menu" style={menuAt} onClick={(event) => event.stopPropagation()}>
        <button role="menuitem" onClick={() => { setMenuAt(null); onRename(node); }}><Pencil size={14} /> Rename…</button>
        <button role="menuitem" onClick={() => { setMenuAt(null); onNewInside(node); }}><TagsIcon size={14} /> New tag inside…</button>
        <button role="menuitem" className="danger" onClick={() => { setMenuAt(null); view.onDelete(node.full); }}><Trash2 size={14} /> Delete tag</button>
      </div>}
    </div>
    {expanded && children.map((child) => (
      <TagRow key={child.full} node={child} view={view} counts={counts} depth={depth + 1} open={open} onToggle={onToggle} found={found} onRename={onRename} onNewInside={onNewInside} />
    ))}
  </div>;
}

/** The tags of the open store as a tree, read the same way as its albums. */
export default function TagsPanel({ view }: { view: TagView }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ kind: "create"; parent: string } | { kind: "rename"; node: TagNode } | null>(null);
  // Immich has no call for which pictures carry a tag, so opening this panel reads them once. A failed
  // read is not tried again on its own; the button above the tree asks for another.
  const asked = useRef("");
  useEffect(() => {
    const store = `${view.refreshable}:${view.names.length}`;
    if (!view.refreshable || view.progress || view.error || !view.names.length) return;
    if (Object.keys(view.byPath).length || asked.current === store) return;
    asked.current = store;
    view.onRefresh();
  }, [view]);

  const tree = useMemo(() => treeOf(view.names), [view.names]);
  // How many of the store's pictures each tag holds, counting the tags below it.
  const counts = useMemo(() => {
    const totals = new Map<string, number>();
    for (const tags of Object.values(view.byPath)) {
      const branches = new Set<string>();
      for (const tag of tags) {
        const parts = tag.split("/").filter(Boolean);
        let prefix = "";
        for (const part of parts) {
          prefix = prefix ? `${prefix}/${part}` : part;
          branches.add(prefix);
        }
      }
      for (const branch of branches) totals.set(branch, (totals.get(branch) ?? 0) + 1);
    }
    return totals;
  }, [view.byPath]);

  const found = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return null;
    const keep = new Set<string>();
    for (const name of view.names) {
      if (!name.toLowerCase().includes(text)) continue;
      const parts = name.split("/").filter(Boolean);
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        keep.add(prefix);
      }
    }
    return keep;
  }, [view.names, query]);

  const toggle = (full: string) => setOpen((current) => {
    const next = new Set(current);
    next.has(full) ? next.delete(full) : next.add(full);
    return next;
  });
  const roots = tree.filter((node) => !found || found.has(node.full));

  let dialogNode: ReactNode = null;
  if (dialog?.kind === "create") {
    dialogNode = <NameDialog title={dialog.parent ? `New tag inside ${dialog.parent}` : "New tag"} label="Name" initial="" action="Create tag"
      onClose={() => setDialog(null)}
      onSubmit={(leaf) => { view.onCreate(dialog.parent, leaf); if (dialog.parent) setOpen((current) => new Set(current).add(dialog.parent)); }} />;
  } else if (dialog?.kind === "rename") {
    dialogNode = <NameDialog title={`Rename ${dialog.node.full}`} label="Name" initial={dialog.node.name} action="Save"
      onClose={() => setDialog(null)} onSubmit={(leaf) => view.onRename(dialog.node.full, leaf)} />;
  }

  return <div className="albums-panel">
    <div className="albums-actions">
      <button onClick={() => setDialog({ kind: "create", parent: "" })}><TagsIcon size={14} /> New tag</button>
      {view.refreshable && <button disabled={!!view.progress} onClick={view.onRefresh}><RefreshCw size={14} /> Read tags</button>}
      {view.selected && <button onClick={() => view.onSelect("")}><X size={14} /> Show all</button>}
    </div>
    {view.progress && <label className="store-scan">
      {view.progress.total ? `Reading tag ${view.progress.done} of ${view.progress.total}` : "Reading tags…"}
      {view.progress.total ? <progress max={view.progress.total} value={view.progress.done} /> : <progress />}
    </label>}
    {view.names.length > 6 && <label className="album-search">
      <Search size={14} />
      <input value={query} placeholder="Search tags" aria-label="Search tags" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
      {query && <button type="button" aria-label="Clear the search" onClick={() => setQuery("")}><X size={13} /></button>}
    </label>}
    {view.error && <p className="store-error">{view.error}</p>}
    {view.refreshable && !view.progress && view.names.length > 0 && !Object.keys(view.byPath).length &&
      <small className="sidebar-note">Immich holds which pictures carry these tags. Read them to count and open them here.</small>}
    <div className="album-tree">
      {view.loading && !view.names.length
        ? <div className="sidebar-empty">Reading tags…</div>
        : roots.length
          ? roots.map((node) => <TagRow key={node.full} node={node} view={view} counts={counts} depth={0} open={open} onToggle={toggle} found={found}
              onRename={(target) => setDialog({ kind: "rename", node: target })}
              onNewInside={(target) => setDialog({ kind: "create", parent: target.full })} />)
          : found
            ? <div className="sidebar-empty">No tag matches “{query.trim()}”.</div>
            : <div className="sidebar-empty">{view.refreshable
                ? "No tags read yet. Read them from Immich to see them here."
                : "No tags yet. Create one, or add them to a picture in its Info panel."}</div>}
    </div>
    {dialogNode}
  </div>;
}
