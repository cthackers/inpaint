import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, ExternalLink, Heart, Images, LoaderCircle, Plus, Star, Tag as TagIcon, UserRound, X } from "lucide-react";

type Tag = { id: string; name: string; value: string };
type Album = { id: string; albumName: string; assetCount: number; shared: boolean };
type Person = { id: string; name: string; isHidden?: boolean };
type Exif = {
  rating?: number | null; description?: string | null; dateTimeOriginal?: string | null; make?: string | null; model?: string | null;
  lensModel?: string | null; fNumber?: number | null; focalLength?: number | null; iso?: number | null; exposureTime?: string | null;
  city?: string | null; state?: string | null; country?: string | null; fileSizeInByte?: number | null;
};
type Asset = {
  id: string; isFavorite: boolean; visibility: "archive" | "timeline" | "hidden" | "locked";
  width?: number | null; height?: number | null; exifInfo?: Exif; tags?: Tag[]; people?: Person[];
};
type Details = { id: string; url: string; asset: Asset; albums: Album[] };
type Catalog = { tags: Tag[]; albums: Album[] };
type Option = { id: string; label: string; hint?: string };

// Every tag and album, shared by the pictures opened in a session and refreshed whenever a panel opens.
let catalogCache: Catalog | null = null;

const withAsset = (details: Details, asset: Partial<Asset>): Details => ({ ...details, asset: { ...details.asset, ...asset } });
const withExif = (details: Details, exif: Partial<Exif>) => withAsset(details, { exifInfo: { ...details.asset.exifInfo, ...exif } });
const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/** Chips for what the picture has, and a search box that adds existing entries or creates new ones. */
function ChipPicker({ chosen, options, placeholder, createLabel, disabled, onAdd, onRemove, onCreate }: {
  chosen: Option[]; options: Option[]; placeholder: string; createLabel: string; disabled: boolean;
  onAdd: (id: string) => void; onRemove: (id: string) => void; onCreate: (label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const chosenIds = new Set(chosen.map((option) => option.id));
  const text = query.trim().toLowerCase();
  const matches = options
    .filter((option) => !chosenIds.has(option.id) && option.label.toLowerCase().includes(text))
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(text)) - Number(!b.label.toLowerCase().startsWith(text)) || byLabel(a, b))
    .slice(0, 60);
  const exists = options.some((option) => option.label.toLowerCase() === text);
  const entries: ({ kind: "add"; option: Option } | { kind: "create"; label: string })[] = [
    ...matches.map((option) => ({ kind: "add" as const, option })),
    ...(text && !exists ? [{ kind: "create" as const, label: query.trim() }] : []),
  ];
  const choose = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.kind === "add") onAdd(entry.option.id);
    else onCreate(entry.label);
    setQuery("");
    setHighlight(0);
  };

  return <>
    {chosen.length > 0 && <div className="immich-chips">
      {[...chosen].sort(byLabel).map((option) => <span className="immich-chip" key={option.id} title={option.label}>
        <span>{option.label}</span>
        <button type="button" aria-label={`Remove ${option.label}`} disabled={disabled} onClick={() => onRemove(option.id)}><X size={12} /></button>
      </span>)}
    </div>}
    <div className="immich-picker">
      <input value={query} placeholder={placeholder} disabled={disabled} aria-label={placeholder} role="combobox" aria-expanded={open && entries.length > 0}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setHighlight((index) => Math.min(entries.length - 1, index + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => Math.max(0, index - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); choose(highlight); }
          else if (event.key === "Escape") { if (query) setQuery(""); else event.currentTarget.blur(); }
          else if (event.key === "Backspace" && !query && chosen.length) onRemove(chosen[chosen.length - 1].id);
        }} />
      {open && entries.length > 0 && <ul className="immich-options" role="listbox">
        {entries.map((entry, index) => <li key={entry.kind === "add" ? entry.option.id : "create"} role="option" aria-selected={index === highlight}
          className={`${index === highlight ? "active" : ""} ${entry.kind === "create" ? "create" : ""}`}
          // Mouse down, not click, so the choice lands before the input loses focus and closes the list.
          onMouseDown={(event) => { event.preventDefault(); choose(index); }}
          onMouseEnter={() => setHighlight(index)}>
          {entry.kind === "add"
            ? <><span>{entry.option.label}</span>{entry.option.hint && <small>{entry.option.hint}</small>}</>
            : <><Plus size={12} /><span>{createLabel} “{entry.label}”</span></>}
        </li>)}
      </ul>}
    </div>
  </>;
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return <section className="immich-section"><h4>{icon}{title}</h4>{children}</section>;
}

/**
 * Immich's record of the open picture: favorite, archive, rating, description, tags, albums, people and
 * photo details. Changes show at once and are put back if Immich refuses them.
 */
export default function ImmichPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(catalogCache);
  const [pending, setPending] = useState(0);
  const [description, setDescription] = useState("");
  const [hoveredStar, setHoveredStar] = useState(0);

  useEffect(() => {
    let current = true;
    invoke<Details | null>("immich_asset", { path })
      .then((value) => {
        if (!current) return;
        if (!value) { setLoadError("This picture is not in an Immich-compatible store."); return; }
        setDetails(value);
        setDescription(value.asset.exifInfo?.description ?? "");
      })
      .catch((error) => { if (current) setLoadError(String(error)); });
    invoke<Catalog>("immich_catalog")
      .then((value) => { catalogCache = value; if (current) setCatalog(value); })
      .catch((error) => { if (current) setNotice(`Cannot list tags and albums: ${String(error)}`); });
    return () => { current = false; };
  }, [path]);

  // Applies a change at once and undoes it if the request fails. Resolves whether it was saved.
  const run = async (apply: (details: Details) => Details, undo: (details: Details) => Details, request: () => Promise<unknown>) => {
    setDetails((current) => current && apply(current));
    setNotice("");
    setPending((count) => count + 1);
    try {
      await request();
      return true;
    } catch (error) {
      setDetails((current) => current && undo(current));
      setNotice(String(error));
      return false;
    } finally {
      setPending((count) => count - 1);
    }
  };

  const header = <div className="immich-heading">
    <strong>Immich</strong>
    {pending > 0 && <LoaderCircle className="spin" size={14} aria-label="Saving" />}
    <span className="immich-heading-actions">
      {details && <button type="button" className="icon-button" title="Open in Immich" aria-label="Open in Immich"
        onClick={() => void invoke("immich_open", { id: details.id }).catch((error) => setNotice(String(error)))}><ExternalLink size={16} /></button>}
      <button type="button" className="icon-button" title="Close" aria-label="Close the Immich panel" onClick={onClose}><X size={16} /></button>
    </span>
  </div>;

  // Keys typed here must not reach the editor's shortcuts, and pointer input must not paint on the canvas.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  if (!details) {
    return <aside className="immich-panel" onKeyDown={stop} onPointerDown={stop} onWheel={stop}>
      {header}
      {loadError ? <p className="immich-error">{loadError}</p> : <div className="immich-loading"><LoaderCircle className="spin" size={16} /> Loading from Immich…</div>}
    </aside>;
  }

  const { id, asset, albums } = details;
  const exif = asset.exifInfo ?? {};
  const rating = exif.rating ?? 0;
  const archived = asset.visibility === "archive";
  const tags = asset.tags ?? [];

  const setFavorite = (isFavorite: boolean) => void run(
    (current) => withAsset(current, { isFavorite }), (current) => withAsset(current, { isFavorite: !isFavorite }),
    () => invoke("immich_update", { id, changes: { isFavorite } }));
  const setArchived = (archive: boolean) => {
    const visibility = archive ? "archive" : "timeline";
    const previous = asset.visibility;
    void run((current) => withAsset(current, { visibility }), (current) => withAsset(current, { visibility: previous }),
      () => invoke("immich_update", { id, changes: { visibility } }));
  };
  // Clicking the current rating again clears it.
  const setRating = (stars: number) => {
    const next = rating === stars ? null : stars;
    const previous = exif.rating ?? null;
    void run((current) => withExif(current, { rating: next }), (current) => withExif(current, { rating: previous }),
      () => invoke("immich_update", { id, changes: { rating: next } }));
  };
  const saveDescription = async () => {
    const previous = exif.description ?? "";
    if (description === previous) return;
    const saved = await run((current) => withExif(current, { description }), (current) => withExif(current, { description: previous }),
      () => invoke("immich_update", { id, changes: { description } }));
    if (!saved) setDescription(previous);
  };

  const addTag = (tag: Tag) => run(
    (current) => withAsset(current, { tags: [...(current.asset.tags ?? []).filter((item) => item.id !== tag.id), tag] }),
    (current) => withAsset(current, { tags: (current.asset.tags ?? []).filter((item) => item.id !== tag.id) }),
    () => invoke("immich_tag", { id, tagId: tag.id, add: true }));
  const removeTag = (tag: Tag) => run(
    (current) => withAsset(current, { tags: (current.asset.tags ?? []).filter((item) => item.id !== tag.id) }),
    (current) => withAsset(current, { tags: [...(current.asset.tags ?? []), tag] }),
    () => invoke("immich_tag", { id, tagId: tag.id, add: false }));
  const createTag = async (name: string) => {
    setPending((count) => count + 1);
    try {
      const tag = await invoke<Tag>("immich_create_tag", { name });
      setCatalog((current) => {
        const next = { tags: [...(current?.tags ?? []).filter((item) => item.id !== tag.id), tag], albums: current?.albums ?? [] };
        catalogCache = next;
        return next;
      });
      await addTag(tag);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setPending((count) => count - 1);
    }
  };

  const addAlbum = (album: Album) => run(
    (current) => ({ ...current, albums: [...current.albums.filter((item) => item.id !== album.id), album] }),
    (current) => ({ ...current, albums: current.albums.filter((item) => item.id !== album.id) }),
    () => invoke("immich_album", { id, albumId: album.id, add: true }));
  const removeAlbum = (album: Album) => run(
    (current) => ({ ...current, albums: current.albums.filter((item) => item.id !== album.id) }),
    (current) => ({ ...current, albums: [...current.albums, album] }),
    () => invoke("immich_album", { id, albumId: album.id, add: false }));
  const createAlbum = async (name: string) => {
    setPending((count) => count + 1);
    setNotice("");
    try {
      const album = await invoke<Album>("immich_create_album", { name, id });
      setDetails((current) => current && { ...current, albums: [...current.albums, album] });
      setCatalog((current) => {
        const next = { tags: current?.tags ?? [], albums: [...(current?.albums ?? []), album] };
        catalogCache = next;
        return next;
      });
    } catch (error) {
      setNotice(String(error));
    } finally {
      setPending((count) => count - 1);
    }
  };

  const tagOptions = (catalog?.tags ?? []).map((tag) => ({ id: tag.id, label: tag.value }));
  const albumOptions = (catalog?.albums ?? []).map((album) => ({ id: album.id, label: album.albumName, hint: `${album.assetCount}${album.shared ? " · shared" : ""}` }));
  const people = (asset.people ?? []).filter((person) => !person.isHidden);
  const named = people.filter((person) => person.name);
  const unnamed = people.length - named.length;
  const shownStars = hoveredStar || rating;
  const taken = exif.dateTimeOriginal ? new Date(exif.dateTimeOriginal).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  const facts: [string, string][] = ([
    ["Taken", taken],
    ["Camera", [exif.make, exif.model].filter(Boolean).join(" ")],
    ["Lens", exif.lensModel ?? ""],
    ["Exposure", [exif.fNumber && `ƒ/${exif.fNumber}`, exif.exposureTime && `${exif.exposureTime} s`, exif.iso && `ISO ${exif.iso}`, exif.focalLength && `${exif.focalLength} mm`].filter(Boolean).join(" · ")],
    ["Place", [exif.city, exif.state, exif.country].filter(Boolean).join(", ")],
    ["Size", [asset.width && asset.height ? `${asset.width} × ${asset.height}` : "", exif.fileSizeInByte ? `${(exif.fileSizeInByte / 1024 / 1024).toFixed(1)} MB` : ""].filter(Boolean).join(" · ")],
  ] as [string, string][]).filter(([, value]) => value);

  return <aside className="immich-panel" onKeyDown={stop} onPointerDown={stop} onWheel={stop}>
    {header}
    <div className="immich-content">
      {notice && <p className="immich-error" role="alert">{notice}</p>}
      <div className="immich-toggles">
        <button type="button" className={`immich-toggle favorite ${asset.isFavorite ? "on" : ""}`} aria-pressed={asset.isFavorite} onClick={() => setFavorite(!asset.isFavorite)}>
          <Heart size={15} fill={asset.isFavorite ? "currentColor" : "none"} /> Favorite
        </button>
        <button type="button" className={`immich-toggle ${archived ? "on" : ""}`} aria-pressed={archived} onClick={() => setArchived(!archived)}>
          <Archive size={15} /> {archived ? "Archived" : "Archive"}
        </button>
      </div>

      <Section title="Rating">
        <div className="immich-stars" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHoveredStar(0)}>
          {[1, 2, 3, 4, 5].map((stars) => <button key={stars} type="button" role="radio" aria-checked={rating === stars} aria-label={`${stars} star${stars > 1 ? "s" : ""}`}
            title={rating === stars ? "Clear the rating" : `${stars} star${stars > 1 ? "s" : ""}`} className={stars <= shownStars ? "lit" : ""}
            onMouseEnter={() => setHoveredStar(stars)} onClick={() => setRating(stars)}>
            <Star size={20} fill={stars <= shownStars ? "currentColor" : "none"} />
          </button>)}
          <small>{rating ? `${rating} of 5` : "Not rated"}</small>
        </div>
      </Section>

      <Section title="Description">
        <textarea value={description} placeholder="Add a description" rows={3} aria-label="Description"
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => void saveDescription()}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.blur(); }} />
      </Section>

      <Section title="Tags" icon={<TagIcon size={12} />}>
        <ChipPicker chosen={tags.map((tag) => ({ id: tag.id, label: tag.value }))} options={tagOptions} placeholder={catalog ? "Add a tag" : "Loading tags…"} createLabel="Create tag"
          disabled={!catalog} onAdd={(tagId) => { const tag = catalog?.tags.find((item) => item.id === tagId); if (tag) void addTag(tag); }}
          onRemove={(tagId) => { const tag = tags.find((item) => item.id === tagId); if (tag) void removeTag(tag); }}
          onCreate={(name) => void createTag(name)} />
      </Section>

      <Section title="Albums" icon={<Images size={12} />}>
        <ChipPicker chosen={albums.map((album) => ({ id: album.id, label: album.albumName }))} options={albumOptions} placeholder={catalog ? "Add to an album" : "Loading albums…"} createLabel="Create album"
          disabled={!catalog} onAdd={(albumId) => { const album = catalog?.albums.find((item) => item.id === albumId); if (album) void addAlbum(album); }}
          onRemove={(albumId) => { const album = albums.find((item) => item.id === albumId); if (album) void removeAlbum(album); }}
          onCreate={(name) => void createAlbum(name)} />
      </Section>

      {people.length > 0 && <Section title="People" icon={<UserRound size={12} />}>
        <div className="immich-chips">
          {named.map((person) => <span key={person.id} className="immich-chip readonly"><span>{person.name}</span></span>)}
          {unnamed > 0 && <span className="immich-muted">{named.length ? `+ ${unnamed} unnamed` : `${unnamed} unnamed`}</span>}
        </div>
      </Section>}

      {facts.length > 0 && <Section title="Details">
        <dl className="immich-details">{facts.map(([label, value]) => <div key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </Section>}
    </div>
  </aside>;
}
