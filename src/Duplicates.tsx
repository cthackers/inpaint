import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, CopyX, EyeOff, Folder, RotateCcw, Search, Square, Tag as TagIcon, Trash2, X } from "lucide-react";
import type { ImageEntry } from "./types";

/** How close two pictures must be to count as copies: `close` near-identical, `loose` also strongly edited ones. */
export type DuplicateLevel = "close" | "normal" | "loose";
export const DUPLICATE_LEVELS: { id: DuplicateLevel; label: string; hint: string }[] = [
  { id: "close", label: "Near-identical", hint: "Resized or recompressed copies of one picture" },
  { id: "normal", label: "Edited", hint: "Also cropped, retouched or watermarked copies" },
  { id: "loose", label: "Loose", hint: "Also heavily edited copies; check the groups before deleting" },
];

/** What `duplicates_search` answers, and what the last search of a store kept. */
export type DuplicatePicture = { path: string; width: number; height: number; size: number; modifiedMs: number };
export type Duplicates = {
  groups: { pictures: DuplicatePicture[]; similarity: number }[];
  pictures: number;
  unreadable: number;
  level: DuplicateLevel;
  searchedMs: number;
  partial?: boolean;
};

export type DuplicateMember = {
  image: ImageEntry;
  compared: DuplicatePicture;
  width: number;
  height: number;
  /** Whether the picture carries tags or is in an album. */
  tags: string[];
  albums: string[];
  keep: boolean;
};

/** A group as shown: its pictures still in the store, the one kept by default first. */
export type DuplicateGroupView = {
  /** Every path the search put in the group, so the group keeps its name while pictures leave it. */
  key: string;
  similarity: number;
  members: DuplicateMember[];
};

export type DuplicateProgress = {
  stage: "scan" | "trash" | "model" | "embed" | "compare" | "verify";
  done: number;
  total: number;
  picturesDone?: number;
  picturesTotal?: number;
};

export type DuplicateView = {
  result: Duplicates | null;
  groups: DuplicateGroupView[];
  progress: DuplicateProgress | null;
  error: string;
  notice: string;
  busy: boolean;
  level: DuplicateLevel;
  ignored: number;
  onLevel: (level: DuplicateLevel) => void;
  onSearch: () => void;
  onCancel: () => void;
  onClear: () => void;
  onToggle: (path: string) => void;
  /** Deletes the pictures marked for deletion in these groups, after asking. */
  onResolve: (groups: DuplicateGroupView[]) => void;
  onIgnore: (group: DuplicateGroupView) => void;
  onUnignore: () => void;
  /** Opens the group's pictures in the editor, at this one. */
  onOpen: (group: DuplicateGroupView, index: number) => void;
  onNoticeClear: () => void;
};

const STAGES: Record<DuplicateProgress["stage"], string> = {
  scan: "Scanning folder",
  trash: "Checking Immich’s trash…",
  model: "Loading the model…",
  embed: "Reading picture",
  compare: "Comparing picture",
  verify: "Checking pair in batch",
};

const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const deleting = (groups: DuplicateGroupView[]) => groups.flatMap((group) => group.members.filter((member) => !member.keep));

/** The Duplicates tab of the store sidebar: how close copies must be, the search, and resolving every group. */
export function DuplicatesPanel({ view }: { view: DuplicateView }) {
  const searching = !!view.progress;
  const doomed = deleting(view.groups);
  const bytes = doomed.reduce((sum, member) => sum + member.image.size, 0);
  const { progress } = view;
  return <div className="albums-panel duplicates-panel">
    <div className="albums-actions">
      {searching
        ? <button onClick={view.onCancel}><Square size={13} /> Stop</button>
        : <button disabled={view.busy} onClick={view.onSearch}><Search size={14} /> {view.result ? "Search again" : "Find duplicates"}</button>}
      <button disabled={view.busy || searching || !view.result} onClick={view.onClear} title="Clear saved results without deleting pictures"><X size={14} /> Clear</button>
      {doomed.length > 0 && <button className="danger" disabled={view.busy} onClick={() => view.onResolve(view.groups)}>
        <Trash2 size={14} /> Delete {doomed.length.toLocaleString()} marked
      </button>}
    </div>
    <div className="duplicate-levels" role="radiogroup" aria-label="How alike copies must be">
      {DUPLICATE_LEVELS.map((level) => <button key={level.id} role="radio" aria-checked={view.level === level.id} title={level.hint}
        className={view.level === level.id ? "active" : ""} disabled={searching} onClick={() => view.onLevel(level.id)}>{level.label}</button>)}
    </div>
    <small className="sidebar-note">{DUPLICATE_LEVELS.find((level) => level.id === view.level)?.hint}.</small>
    {progress && <label className="store-scan">
      {progress.stage === "model" || !progress.total ? STAGES[progress.stage] : `${STAGES[progress.stage]} ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`}
      {progress.total ? <progress max={progress.total} value={progress.done} /> : <progress />}
      {!!progress.picturesTotal && <small>Scanned {progress.picturesDone?.toLocaleString()} of {progress.picturesTotal.toLocaleString()} pictures</small>}
    </label>}
    {view.error && <p className="store-error">{view.error}</p>}
    {view.notice && <p className="duplicate-notice">{view.notice}<button aria-label="Hide" onClick={view.onNoticeClear}><X size={13} /></button></p>}
    {view.result && <dl className="store-stats">
      <dt>Groups</dt><dd>{view.groups.length.toLocaleString()}</dd>
      <dt>To delete</dt><dd>{doomed.length.toLocaleString()}{doomed.length > 0 && ` · ${fileSize(bytes)}`}</dd>
      <dt>Pictures read</dt><dd>{view.result.pictures.toLocaleString()}</dd>
      {view.result.unreadable > 0 && <><dt>Unreadable</dt><dd>{view.result.unreadable.toLocaleString()}</dd></>}
      <dt>Searched</dt><dd>{new Date(view.result.searchedMs).toLocaleString()}</dd>
      <dt>Alike</dt><dd>{DUPLICATE_LEVELS.find((level) => level.id === view.result?.level)?.label ?? view.result.level}</dd>
    </dl>}
    {searching && <small className="sidebar-note">You can review, ignore or delete confirmed matches while the search continues. Deletion applies only to the pictures selected when you click Delete.</small>}
    {!searching && view.result?.partial && <p className="duplicate-notice">Partial results — the search did not finish. Search again to continue using saved checks.</p>}
    {view.ignored > 0 && <button className="link-button" onClick={view.onUnignore}><RotateCcw size={13} /> Show {view.ignored.toLocaleString()} marked “not duplicates” again</button>}
    <small className="sidebar-note">
      Each group keeps its biggest picture, or when they are the same size, the one with tags or albums; the tags and albums
      of the pictures deleted move to the one kept. Click a picture to switch it between keep and delete, double-click to
      go through the group in the editor. Later searches reuse saved picture data and completed pair checks.
      {" "}Animations and images over 40 megapixels are skipped and counted as unreadable.
    </small>
  </div>;
}

function DuplicateCard({ member, onToggle, onOpen }: { member: DuplicateMember; onToggle: () => void; onOpen: () => void }) {
  const { image } = member;
  const [shown, setShown] = useState(false);
  return <button className={`duplicate-card ${member.keep ? "keep" : "drop"}`} aria-pressed={member.keep}
    title={`${image.name}\nClick to ${member.keep ? "delete" : "keep"} it, double-click to open the group`}
    onClick={onToggle} onDoubleClick={onOpen}>
    <div className="duplicate-thumb">
      <img src={`${convertFileSrc(image.path, "thumb")}?v=${image.size}-${image.modifiedMs}`} alt={image.name} loading="lazy" decoding="async" draggable={false}
        className={shown ? "shown" : ""} onLoad={() => setShown(true)} />
      <span className="duplicate-badge">{member.keep ? <><Check size={13} /> Keep</> : <><Trash2 size={13} /> Delete</>}</span>
    </div>
    <span className="duplicate-facts">
      <span>{member.width && member.height ? `${member.width.toLocaleString()} × ${member.height.toLocaleString()}` : image.extension.toUpperCase()}</span>
      <span>{fileSize(image.size)}</span>
      {member.tags.length > 0 && <span className="duplicate-mark" title={member.tags.join("\n")}><TagIcon size={12} /></span>}
      {member.albums.length > 0 && <span className="duplicate-mark" title={member.albums.join("\n")}><Folder size={12} /></span>}
    </span>
  </button>;
}

const PAGE = 30;

/** The groups themselves, in place of the gallery while the Duplicates tab is open. */
export function DuplicateGroups({ view }: { view: DuplicateView }) {
  const [limit, setLimit] = useState(PAGE);
  const more = useRef<HTMLDivElement>(null);
  const hasMore = view.groups.length > limit;
  useEffect(() => {
    const element = more.current;
    if (!element || !hasMore) return;
    // Groups arrive a page at a time as the end of the list comes into view.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + PAGE);
    }, { rootMargin: "600px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, limit]);

  if (!view.groups.length) {
    return <div className="empty-gallery">
      <div className="empty-icon"><CopyX size={28} /></div>
      <h2>{view.progress ? "Looking for duplicates…" : view.result?.partial ? "No duplicates found yet" : view.result ? view.result.pictures < 2 ? "Not enough pictures to compare" : "No duplicates" : "Find duplicate pictures"}</h2>
      <p>{view.progress ? "Confirmed groups appear here while the search continues."
        : view.result?.partial ? "The search stopped before checking every batch. Search again to reuse the checks already saved."
        : view.result ? view.result.pictures < 2 ? `The search could read ${view.result.pictures} pictures. Check that the store is mounted and its pictures are accessible.`
          : `No duplicates found among ${view.result.pictures.toLocaleString()} compared pictures.`
        : "Copies, resized, recompressed, edited or cropped, are grouped here, with the one to keep marked."}</p>
      {!view.progress && <button className="primary-button" disabled={view.busy} onClick={view.onSearch}>{view.result ? "Search again" : "Find duplicates"}</button>}
    </div>;
  }

  return <div className="duplicate-groups">
    {view.groups.slice(0, limit).map((group) => {
      const doomed = group.members.filter((member) => !member.keep).length;
      return <section className="duplicate-group" key={group.key}>
        <header>
          <strong>{group.members.length} pictures</strong>
          <span>{Math.round(group.similarity * 100)}% alike</span>
          <span className="duplicate-group-actions">
            <button disabled={view.busy} onClick={() => view.onIgnore(group)} title="Hide this group, now and after later searches"><EyeOff size={13} /> Not duplicates</button>
            <button className="danger" disabled={!doomed || view.busy} onClick={() => view.onResolve([group])}>
              <Trash2 size={13} /> {doomed ? `Delete ${doomed}` : "Nothing to delete"}
            </button>
          </span>
        </header>
        <div className="duplicate-pictures">
          {group.members.map((member, index) => <DuplicateCard key={member.image.path} member={member}
            onToggle={() => view.onToggle(member.image.path)} onOpen={() => view.onOpen(group, index)} />)}
        </div>
      </section>;
    })}
    {hasMore && <div ref={more} className="duplicate-more">Showing {limit} of {view.groups.length.toLocaleString()} groups</div>}
  </div>;
}
