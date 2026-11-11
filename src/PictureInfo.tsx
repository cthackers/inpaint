import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Heart, Images, LoaderCircle, Star, Tag as TagIcon, UserRound, X } from "lucide-react";
import { ChipPicker, Section, type Option } from "./ImmichPanel";
import type { Album } from "./types";
import PictureFileActions from "./PictureFileActions";

type Label = { id: string; kind: "tag" | "person"; name: string; count: number };
type Details = {
  name: string; extension: string; size: number; modifiedMs: number; width: number; height: number;
  taken: string; make: string; model: string; lens: string; exposure: string; aperture: string; iso: string; focalLength: string;
};
type Info = {
  path: string; favorite: boolean; rating: number; description: string;
  tags: Label[]; people: Label[]; albums: Album[]; storeId: string; details: Details;
};

// The tags and people of the whole library, shared by the pictures opened in a session.
let labelCache: Label[] | null = null;

const bytes = (size: number) => (size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`);
const option = (label: Label): Option => ({ id: label.id, label: label.name, hint: label.count ? `${label.count}` : undefined });

/**
 * What Inpaint keeps about a picture of its own: favourite, rating, description, tags, people, the
 * albums holding it and the facts of the file. Pictures of Immich-compatible stores use `ImmichPanel`.
 */
export default function PictureInfo({ path, onClose }: { path: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [labels, setLabels] = useState<Label[] | null>(labelCache);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(0);
  const [description, setDescription] = useState("");
  const [hoveredStar, setHoveredStar] = useState(0);

  const read = async (): Promise<Info | null> => {
    const value = await invoke<Info>("picture_info", { path });
    setInfo(value);
    setDescription(value.description);
    return value;
  };

  useEffect(() => {
    let current = true;
    setInfo(null);
    void invoke<Info>("picture_info", { path })
      .then((value) => {
        if (!current) return;
        setInfo(value);
        setDescription(value.description);
        // Only a picture inside a store can be in an album.
        if (value.storeId) {
          void invoke<Album[]>("albums_list", { storeId: value.storeId })
            .then((list) => { if (current) setAlbums(list); })
            .catch((error) => { if (current) setNotice(String(error)); });
        }
      })
      .catch((error) => { if (current) setLoadError(String(error)); });
    void invoke<Label[]>("labels_all")
      .then((value) => { labelCache = value; if (current) setLabels(value); })
      .catch((error) => { if (current) setNotice(`Cannot list tags and people: ${String(error)}`); });
    return () => { current = false; };
  }, [path]);

  /** Runs one change, then reads the picture again so the panel shows what was saved. */
  const run = async (work: () => Promise<unknown>) => {
    setPending((count) => count + 1);
    setNotice("");
    try {
      await work();
      await read();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setPending((count) => count - 1);
    }
  };

  const refreshLabels = async () => {
    const value = await invoke<Label[]>("labels_all");
    labelCache = value;
    setLabels(value);
  };

  const setLabel = (id: string, add: boolean) => void run(() => invoke("picture_label", { path, labelId: id, add }).then(refreshLabels));
  const createLabel = (kind: "tag" | "person", name: string) => void run(async () => {
    const label = await invoke<Label>("label_create", { kind, name });
    await invoke("picture_label", { path, labelId: label.id, add: true });
    await refreshLabels();
  });
  const setAlbum = (albumId: string, add: boolean) => void run(async () => {
    await invoke(add ? "album_add" : "album_remove", { id: albumId, paths: [path] });
    if (info?.storeId) setAlbums(await invoke<Album[]>("albums_list", { storeId: info.storeId }));
  });
  const createAlbum = (name: string) => void run(async () => {
    if (!info?.storeId) return;
    const album = await invoke<Album>("album_create", { storeId: info.storeId, name, parentId: "" });
    await invoke("album_add", { id: album.id, paths: [path] });
    setAlbums(await invoke<Album[]>("albums_list", { storeId: info.storeId }));
  });

  const header = <div className="immich-heading">
    <strong>Info</strong>
    {pending > 0 && <LoaderCircle className="spin" size={14} aria-label="Saving" />}
    <span className="immich-heading-actions">
      <button type="button" className="icon-button" title="Close" aria-label="Close the panel" onClick={onClose}><X size={16} /></button>
    </span>
  </div>;
  // Keys typed here must not reach the editor's shortcuts, and pointer input must not paint on the canvas.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  if (!info) {
    return <aside className="immich-panel" onKeyDown={stop} onPointerDown={stop} onWheel={stop}>
      {header}
      {loadError ? <p className="immich-error">{loadError}</p> : <div className="immich-loading"><LoaderCircle className="spin" size={16} /> Reading the picture…</div>}
    </aside>;
  }

  const { details } = info;
  const shownStars = hoveredStar || info.rating;
  const chosenTags = info.tags.map((tag) => ({ id: tag.id, label: tag.name }));
  const chosenPeople = info.people.map((person) => ({ id: person.id, label: person.name }));
  const tagOptions = (labels ?? []).filter((label) => label.kind === "tag").map(option);
  const peopleOptions = (labels ?? []).filter((label) => label.kind === "person").map(option);
  const albumOptions: Option[] = albums.map((album) => ({ id: album.id, label: album.fullName || album.name, hint: album.total ? `${album.total}` : undefined }));
  const facts = ([
    ["Taken", details.taken],
    ["Camera", [details.make, details.model].filter(Boolean).join(" ")],
    ["Lens", details.lens],
    ["Exposure", [details.aperture && `ƒ/${details.aperture.replace("f/", "")}`, details.exposure, details.iso && `ISO ${details.iso}`, details.focalLength].filter(Boolean).join(" · ")],
    ["Size", [details.width && details.height ? `${details.width} × ${details.height}` : "", details.size ? bytes(details.size) : ""].filter(Boolean).join(" · ")],
    ["Modified", details.modifiedMs ? new Date(details.modifiedMs).toLocaleString() : ""],
  ] as [string, string][]).filter(([, value]) => value);

  return <aside className="immich-panel" onKeyDown={stop} onPointerDown={stop} onWheel={stop}>
    {header}
    <div className="immich-content">
      {notice && <p className="immich-error" role="alert">{notice}</p>}
      <div className="immich-toggles">
        <button type="button" className={`immich-toggle favorite ${info.favorite ? "on" : ""}`} aria-pressed={info.favorite}
          onClick={() => void run(() => invoke("picture_update", { path, favorite: !info.favorite }))}>
          <Heart size={15} fill={info.favorite ? "currentColor" : "none"} /> Favorite
        </button>
      </div>

      <Section title="Rating">
        <div className="immich-stars" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHoveredStar(0)}>
          {[1, 2, 3, 4, 5].map((stars) => <button key={stars} type="button" role="radio" aria-checked={info.rating === stars} aria-label={`${stars} star${stars > 1 ? "s" : ""}`}
            title={info.rating === stars ? "Clear the rating" : `${stars} star${stars > 1 ? "s" : ""}`} className={stars <= shownStars ? "lit" : ""}
            onMouseEnter={() => setHoveredStar(stars)}
            onClick={() => void run(() => invoke("picture_update", { path, rating: info.rating === stars ? 0 : stars }))}>
            <Star size={20} fill={stars <= shownStars ? "currentColor" : "none"} />
          </button>)}
          <small>{info.rating ? `${info.rating} of 5` : "Not rated"}</small>
        </div>
      </Section>

      <Section title="Description">
        <textarea value={description} placeholder="Add a description" rows={3} aria-label="Description"
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => { if (description !== info.description) void run(() => invoke("picture_update", { path, description })); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.blur(); }} />
      </Section>

      <Section title="Tags" icon={<TagIcon size={12} />}>
        <ChipPicker chosen={chosenTags} options={tagOptions} placeholder={labels ? "Add a tag" : "Loading tags…"} createLabel="Create tag" disabled={!labels}
          onAdd={(id) => setLabel(id, true)} onRemove={(id) => setLabel(id, false)} onCreate={(name) => createLabel("tag", name)} />
      </Section>

      <Section title="People" icon={<UserRound size={12} />}>
        <ChipPicker chosen={chosenPeople} options={peopleOptions} placeholder={labels ? "Add a person" : "Loading people…"} createLabel="Add person" disabled={!labels}
          onAdd={(id) => setLabel(id, true)} onRemove={(id) => setLabel(id, false)} onCreate={(name) => createLabel("person", name)} />
        <small className="immich-muted">Named by hand for now; face detection fills nothing in here yet.</small>
      </Section>

      <Section title="Albums" icon={<Images size={12} />}>
        {info.storeId
          ? <ChipPicker chosen={info.albums.map((album) => ({ id: album.id, label: album.fullName || album.name }))} options={albumOptions}
              placeholder="Add to an album" createLabel="Create album" disabled={false}
              onAdd={(id) => setAlbum(id, true)} onRemove={(id) => setAlbum(id, false)} onCreate={(name) => createAlbum(name)} />
          : <small className="immich-muted">Albums belong to an image store; this picture is outside one.</small>}
      </Section>

      <Section title="Details">
        <dl className="immich-details">
          <dt>File</dt><dd><PictureFileActions key={path} path={path} name={details.name} /></dd>
          {facts.map(([label, value]) => <div key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </Section>
    </div>
  </aside>;
}
