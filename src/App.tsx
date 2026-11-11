import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import BrowserView, { type StoreView } from "./Browser";
import Filmstrip, { type ViewportBox } from "./Filmstrip";
import type { AlbumView } from "./Albums";
import AlbumExportDialog from "./AlbumExportDialog";
import { albumExportRequest, type AlbumExportRequest } from "./albumExport";
import { taggedWith, type TagView } from "./Tags";
import type { DuplicateGroupView, DuplicateLevel, DuplicateProgress, Duplicates, DuplicateView } from "./Duplicates";
import { resolveDuplicateSelection, splitIgnoredDuplicateGroups, withoutDeletedDuplicates, type DuplicateDeletion } from "./duplicateActions";
import { SettingsDialog, type SettingsTab } from "./Settings";
import { usePreference } from "./preferences";
import Editor from "./Editor";
import { useStoreFaces } from "./useStoreFaces";
import { randomOrder } from "./randomOrder";
import { useServerBridge, type LoadRequest } from "./serverApi";
import { DEFAULT_GALLERY_ORDER, type Album, type DirectoryContents, type GalleryOrder, type ImageEntry, type PictureFacts, type Store, type StoreContents, type StoreStats } from "./types";
import { storage } from "./storage";
import { HiddenDialog, type HiddenStatus } from "./HiddenDialog";
import { matchesSmartAlbum, smartAlbumView, validSmartAlbums, type SmartAlbum } from "./smartAlbums";

// Immich's album covers are assets, whose file in the store folder is looked up once per session.
const immichCovers = new Map<string, string>();

/** Whether the open album shows what `added` holds: the album itself, one below it, or below a grouping album. */
const albumHolds = (albums: Album[], open: string, added: string) => {
  if (open === added) return true;
  const target = albums.find((album) => album.id === added);
  if (open.startsWith("path:")) {
    const prefix = open.slice(5).toLowerCase();
    const name = (target?.fullName ?? "").toLowerCase();
    return name === prefix || name.startsWith(`${prefix}/`);
  }
  for (let parent = target?.parentId, steps = 0; parent && steps < 100; steps += 1) {
    if (parent === open) return true;
    parent = albums.find((album) => album.id === parent)?.parentId;
  }
  return false;
};

/** The names a branch takes when its last part is renamed. */
const renamedTags = (tags: string[], name: string, leaf: string) => {
  const cut = name.lastIndexOf("/");
  const renamed = cut < 0 ? leaf.trim() : `${name.slice(0, cut)}/${leaf.trim()}`;
  return tags.map((tag) => (tag === name || tag.startsWith(`${name}/`) ? `${renamed}${tag.slice(name.length)}` : tag));
};

// A picture is matched by its place in the store's ab/cd/name layout, so an album still finds it when
// Immich writes the folders above it differently (another mount, another upload folder).
const layoutKey = (path: string) => path.split("/").slice(-3).join("/");

/** A picture tagged `location/outside` also carries `location`; only the whole names are carried over. */
const leafTags = (tags: string[] | undefined) => (tags ?? []).filter((tag) => !tags?.some((other) => other !== tag && other.startsWith(`${tag}/`)));

type LoadedImage = LoadRequest & { id: number };

export default function App() {
  const [rootPath, setRootPath] = useState<string | null>(() => storage.getItem("inpaint.root"));
  const [currentPath, setCurrentPath] = useState<string | null>(() => storage.getItem("inpaint.current"));
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [brushSize, setBrushSize] = usePreference("inpaint.brushSize", 54, (value) => value >= 3 && value <= 500);
  const galleryScrollPositions = useRef(new Map<string, number>());

  // Image stores: the gallery shows either a folder or every picture of one store.
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<string | null>(() => storage.getItem("inpaint.store"));
  const storeFaces = useStoreFaces(storeId);
  const [storeStats, setStoreStats] = useState<StoreStats | null>(null);
  const [storeProgress, setStoreProgress] = useState<{ done: number; total: number } | null>(null);
  const [storeError, setStoreError] = useState("");
  // The store on screen. Results for any other store arrive late and are dropped.
  const openStoreId = useRef<string | null>(null);
  const scanning = useRef(new Set<string>());
  // A scan that finishes while the editor is open waits, so the editor's picture list stays put.
  const editorOpen = useRef(false);
  const pendingScan = useRef<StoreContents | null>(null);
  const savedPaths = useRef(new Set<string>());
  // Pictures the drop box saved into the open store while the editor was open.
  const pendingAdded = useRef<ImageEntry[]>([]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);

  // Albums of the open store: ours from inpaint.db, or Immich's own for a compatible store. The chosen
  // album filters the gallery by path, so the pictures themselves are only listed once.
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumError, setAlbumError] = useState("");
  const [albumExport, setAlbumExport] = useState<AlbumExportRequest | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [smartAlbums, setSmartAlbums] = usePreference<SmartAlbum[]>("inpaint.smartAlbums", [], validSmartAlbums);
  const [smartAlbumId, setSmartAlbumId] = useState<string | null>(null);
  const selectedSmart = smartAlbums.find((album) => album.id === smartAlbumId && album.storeId === storeId);
  const [smartNow, setSmartNow] = useState(Date.now);
  useEffect(() => {
    if (!smartAlbums.some((album) => album.storeId === storeId && album.rules.addedDays)) return;
    const timer = window.setInterval(() => setSmartNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, [smartAlbums, storeId]);
  const [albumPaths, setAlbumPaths] = useState<Set<string> | null>(null);
  // The album's pictures as full paths, which for Immich may lie in an external library outside the store.
  const [albumFiles, setAlbumFiles] = useState<string[]>([]);
  // The store's tags: which pictures carry them, and the one the gallery is filtered by. Immich keeps
  // its own, so they are read from it in the background and kept in cache.db until read again.
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [tagsByPath, setTagsByPath] = useState<Record<string, string[]>>({});
  const [tagFilter, setTagFilter] = useState("");
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagProgress, setTagProgress] = useState<{ done: number; total: number } | null>(null);
  const [tagError, setTagError] = useState("");
  // Which albums each picture is in, for the album mark on its card.
  const [albumsByPath, setAlbumsByPath] = useState<Record<string, string[]>>({});
  // Duplicate pictures of the open store: the last search's groups, which picture of each is kept (the
  // default, unless clicked otherwise), and groups the user said are not duplicates, by store.
  const [duplicates, setDuplicates] = useState<Duplicates | null>(null);
  const duplicateRequest = useRef(0);
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateProgress | null>(null);
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicateNotice, setDuplicateNotice] = useState("");
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const duplicateResolving = useRef(false);
  const duplicateSearch = useRef<{ storeId: string; progress: DuplicateProgress; result: Duplicates | null; deleted: Set<string> } | null>(null);
  const duplicateSearchErrors = useRef(new Map<string, string>());
  const [keepChoices, setKeepChoices] = useState<Record<string, boolean>>({});
  const [duplicateLevel, setDuplicateLevel] = usePreference<DuplicateLevel>("inpaint.duplicateLevel", "normal", (value) => ["close", "normal", "loose"].includes(value));
  // Kept as `<store id>:<group key>`.
  const [notDuplicates, setNotDuplicates] = usePreference<string[]>("inpaint.notDuplicates", [], (value) => value.every((entry) => typeof entry === "string"));
  // The group the editor goes through instead of the gallery, by its key.
  const [editorGroup, setEditorGroup] = useState<string | null>(null);
  // Only the newest album request counts; answers to earlier clicks are dropped.
  const albumRequest = useRef(0);
  const albumIdRef = useRef<string | null>(null);
  albumIdRef.current = albumId;
  const albumsNow = useRef(albums);
  albumsNow.current = albums;
  // The gallery, and with it the editor, shows the pictures of the chosen album, or all of them.
  // Pictures of the chosen album or tag that Immich reads from an external library, outside the store
  // folder, so the store's own index does not list them.
  const [outside, setOutside] = useState<ImageEntry[]>([]);
  const outsideEntries = useRef(new Map<string, ImageEntry | null>());
  useEffect(() => {
    const store = stores.find((entry) => entry.id === storeId);
    const root = `${store?.path.replace(/\/+$/, "") ?? ""}/`;
    const wanted = !store?.immich ? []
      : tagFilter ? Object.keys(tagsByPath).filter((path) => !path.startsWith(root) && taggedWith(tagsByPath[path], tagFilter))
      : albumId && albumPaths ? albumFiles.filter((path) => !path.startsWith(root))
      : [];
    let active = true;
    const known = () => wanted.flatMap((path) => { const entry = outsideEntries.current.get(path); return entry ? [{ ...entry, storeId: store!.id }] : []; });
    setOutside(known());
    const missing = wanted.filter((path) => !outsideEntries.current.has(path));
    if (!missing.length) return;
    void (async () => {
      for (let at = 0; at < missing.length && active; at += 200) {
        const part = missing.slice(at, at + 200);
        const entries = await invoke<(ImageEntry | null)[]>("image_entries", { paths: part }).catch(() => part.map(() => null));
        part.forEach((path, index) => outsideEntries.current.set(path, entries[index]));
        if (active) setOutside(known());
      }
    })();
    return () => { active = false; };
  }, [stores, storeId, tagFilter, tagsByPath, albumId, albumPaths, albumFiles]);
  // The gallery's order and the pictures it leaves out; favourites and ratings come with the pictures'
  // facts, read for the open store or folder.
  const [order, setOrder] = usePreference<GalleryOrder>("inpaint.galleryOrder", DEFAULT_GALLERY_ORDER,
    (value) => ["modified", "added", "rating", "name", "random"].includes(value.by)
      && Number.isInteger(value.randomSeed) && value.randomSeed >= 0 && value.randomSeed <= 0xffffffff);
  const [facts, setFacts] = useState<Record<string, PictureFacts>>({});
  const factsRequest = useRef(0);
  const loadFacts = useCallback(async (storeId: string | null, folder: string | null, refresh: boolean) => {
    const request = ++factsRequest.current;
    if (!refresh) setFacts({});
    try {
      const found = await invoke<Record<string, PictureFacts>>("picture_facts", { storeId, folder, refresh });
      if (factsRequest.current === request) setFacts(found);
    } catch (error) {
      console.error(error);
    }
  }, []);
  const factsStore = stores.find((store) => store.id === storeId);
  const factsImmich = !!factsStore?.immich;
  useEffect(() => {
    if (storeId && !factsStore) return;
    const folder = storeId ? null : currentPath;
    if (!storeId && !folder) return;
    void (async () => {
      // Immich's answer is kept from the last reading, shown first, then read again.
      await loadFacts(storeId, folder, false);
      if (factsImmich) await loadFacts(storeId, null, true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, currentPath, !!factsStore, factsImmich, loadFacts]);
  const smartViews = useMemo(() => smartAlbums.filter((album) => album.storeId === storeId)
    .map((album) => smartAlbumView(album, images, tagsByPath, facts, smartNow)), [smartAlbums, storeId, images, tagsByPath, facts, smartNow]);
  const { shown, leftOut } = useMemo(() => {
    let inside = selectedSmart ? images.filter((image) => matchesSmartAlbum(image, selectedSmart.rules, tagsByPath[image.path], facts[image.path], smartNow))
      : tagFilter ? images.filter((image) => taggedWith(tagsByPath[image.path], tagFilter))
      : albumPaths ? images.filter((image) => albumPaths.has(layoutKey(image.path)))
      : images;
    if (outside.length && (tagFilter || albumPaths)) inside = [...inside, ...outside];
    // Leaving out pictures in albums, or tagged ones, only means something while every picture is shown.
    const everything = !!storeId && !tagFilter && !albumPaths && !selectedSmart;
    const filtered = inside.filter((image) =>
      (order.notFavorites || facts[image.path]?.favorite)
      && (order.tagged || tagFilter || selectedSmart || !tagsByPath[image.path]?.length)
      && (order.inAlbums || !everything || !albumsByPath[image.path]?.length));
    const added = (image: ImageEntry) => facts[image.path]?.addedMs ?? image.addedMs ?? image.modifiedMs;
    const key: (image: ImageEntry) => number = order.by === "added" ? added
      : order.by === "rating" ? (image) => facts[image.path]?.rating ?? 0
      : (image) => image.modifiedMs;
    const direction = order.descending ? -1 : 1;
    const sorted = order.by === "random" ? randomOrder(filtered, order.randomSeed) : filtered.sort((a, b) => order.by === "name"
      ? direction * a.name.localeCompare(b.name, undefined, { numeric: true })
      // Pictures that tie, such as those of one rating, stay newest first.
      : direction * (key(a) - key(b)) || b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name));
    return { shown: sorted, leftOut: inside.length - sorted.length };
  }, [images, albumPaths, tagFilter, tagsByPath, outside, order, facts, storeId, albumsByPath, selectedSmart, smartNow]);

  // Each group's pictures still in the store, the one to keep first: the biggest, then one with tags or
  // albums, then a favourite or the better rated, then the bigger file, then the older one.
  const duplicateGroups = useMemo(() => {
    if (!duplicates || !storeId) return [];
    const byPath = new Map(images.map((image) => [image.path, image]));
    const hidden = notDuplicates.filter((entry) => entry.startsWith(`${storeId}:`)).map((entry) => entry.slice(storeId.length + 1));
    const labelled = (path: string) => (tagsByPath[path]?.length || albumsByPath[path]?.length ? 1 : 0);
    const groups: DuplicateGroupView[] = [];
    for (const group of splitIgnoredDuplicateGroups(duplicates.groups, hidden)) {
      const key = group.pictures.map((picture) => picture.path).sort().join("\n");
      const present = group.pictures.filter((picture) => {
        const image = byPath.get(picture.path);
        return image && image.size === picture.size && image.modifiedMs === picture.modifiedMs;
      });
      if (present.length < 2) continue;
      const added = (path: string) => facts[path]?.addedMs ?? byPath.get(path)!.addedMs ?? byPath.get(path)!.modifiedMs;
      const ranked = [...present].sort((a, b) => b.width * b.height - a.width * a.height
        || labelled(b.path) - labelled(a.path)
        || Number(!!facts[b.path]?.favorite) - Number(!!facts[a.path]?.favorite)
        || (facts[b.path]?.rating ?? 0) - (facts[a.path]?.rating ?? 0)
        || byPath.get(b.path)!.size - byPath.get(a.path)!.size
        || added(a.path) - added(b.path));
      groups.push({
        key,
        similarity: group.similarity,
        members: ranked.map((picture, index) => ({
          image: byPath.get(picture.path)!,
          compared: picture,
          width: picture.width,
          height: picture.height,
          tags: leafTags(tagsByPath[picture.path]),
          albums: albumsByPath[picture.path] ?? [],
          keep: keepChoices[picture.path] ?? index === 0,
        })),
      });
    }
    return groups;
  }, [duplicates, storeId, images, notDuplicates, tagsByPath, albumsByPath, facts, keepChoices]);
  const openGroup = editorGroup ? duplicateGroups.find((group) => group.key === editorGroup) ?? null : null;
  // The editor goes through the open duplicate group, or else the gallery.
  const editorList = useMemo(() => (openGroup ? openGroup.members.map((member) => member.image) : shown), [openGroup, shown]);

  // Pictures sent to the API's /load endpoint, opened outside the folder list.
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [queuedLoad, setQueuedLoad] = useState<LoadedImage | null>(null);
  const loadCount = useRef(0);
  useServerBridge((request) => setQueuedLoad({ ...request, id: ++loadCount.current }));
  const folderEditorOpen = editorIndex !== null && !!editorList[editorIndex];
  useEffect(() => {
    // An open editor first asks about unsaved changes, then calls onReplace.
    if (!queuedLoad || loaded || folderEditorOpen) return;
    setLoaded(queuedLoad);
    setQueuedLoad(null);
  }, [queuedLoad, loaded, folderEditorOpen]);

  const leaveStore = useCallback(() => {
    openStoreId.current = null;
    pendingScan.current = null;
    pendingAdded.current = [];
    setStoreId(null);
    setStoreStats(null);
    setStoreProgress(null);
    setStoreError("");
    storage.removeItem("inpaint.store");
  }, []);

  const loadFolder = useCallback(async (path: string) => {
    leaveStore();
    setLoading(true);
    try {
      const contents = await invoke<DirectoryContents>("list_directory", { path });
      if (openStoreId.current) return;
      setCurrentPath(path);
      setImages(contents.images);
      storage.setItem("inpaint.current", path);
    } catch (error) {
      console.error(error);
      if (!openStoreId.current) setImages([]);
    } finally {
      if (!openStoreId.current) setLoading(false);
    }
  }, [leaveStore]);

  const scanStore = useCallback(async (id: string) => {
    setStoreProgress((current) => current ?? { done: 0, total: 0 });
    if (scanning.current.has(id)) return;
    scanning.current.add(id);
    setStoreError("");
    try {
      const contents = await invoke<StoreContents>("store_scan", { id });
      if (openStoreId.current !== id) return;
      setStoreStats(contents.stats);
      if (editorOpen.current) pendingScan.current = contents;
      else setImages(contents.images);
    } catch (error) {
      if (openStoreId.current === id) setStoreError(String(error));
    } finally {
      scanning.current.delete(id);
      if (openStoreId.current === id) {
        setStoreProgress(null);
        setLoading(false);
      }
    }
  }, []);

  // The last index is shown at once; a rescan then brings in pictures added since.
  const openStore = useCallback(async (id: string) => {
    openStoreId.current = id;
    pendingScan.current = null;
    pendingAdded.current = [];
    setStoreId(id);
    storage.setItem("inpaint.store", id);
    setImages([]);
    setStoreStats(null);
    setStoreProgress(null);
    setStoreError("");
    setLoading(true);
    try {
      const cached = await invoke<StoreContents | null>("store_cached", { id });
      if (cached && openStoreId.current === id) {
        setImages(cached.images);
        setStoreStats(cached.stats);
        setLoading(false);
      }
    } catch (error) {
      console.error(error);
    }
    if (openStoreId.current === id) await scanStore(id);
  }, [scanStore]);

  // Immich names an album's cover asset; its file in the store folder is looked up in the background.
  const resolveCovers = useCallback(async (store: Store, list: Album[]) => {
    for (const album of list) {
      if (!album.coverAssetId) continue;
      let path = immichCovers.get(album.coverAssetId);
      if (path === undefined) {
        path = await invoke<string | null>("immich_album_cover", { storeId: store.id, assetId: album.coverAssetId }).catch(() => "") ?? "";
        immichCovers.set(album.coverAssetId, path);
      }
      if (!path || openStoreId.current !== store.id) continue;
      const cover = path;
      setAlbums((current) => current.map((entry) => (entry.id === album.id ? { ...entry, coverPath: cover } : entry)));
    }
  }, []);

  const loadTags = useCallback(async (store: Store, refresh: boolean) => {
    setTagsLoading(true);
    setTagError("");
    try {
      const [names, byPath] = store.immich
        ? await Promise.all([
            invoke<string[]>("immich_tags", { storeId: store.id }),
            invoke<Record<string, string[]>>("immich_tag_index", { storeId: store.id, refresh }),
          ])
        : await (async () => {
            const byPath = await invoke<Record<string, string[]>>("store_tags", { storeId: store.id });
            const labels = await invoke<{ kind: string; name: string }[]>("labels_all");
            return [labels.filter((label) => label.kind === "tag").map((label) => label.name), byPath] as const;
          })();
      if (openStoreId.current !== store.id) return;
      // A tag known only from a picture still belongs in the tree.
      setTagNames([...new Set([...names, ...Object.values(byPath).flat()])]);
      setTagsByPath(byPath);
    } catch (error) {
      if (openStoreId.current === store.id) setTagError(String(error));
    } finally {
      if (openStoreId.current === store.id) {
        setTagsLoading(false);
        setTagProgress(null);
      }
    }
  }, []);

  const loadAlbumMarks = useCallback(async (store: Store, refresh = false) => {
    try {
      const index = store.immich
        ? await invoke<Record<string, string[]>>("immich_album_index", { storeId: store.id, refresh })
        : await invoke<Record<string, string[]>>("store_album_index", { storeId: store.id });
      if (openStoreId.current === store.id) setAlbumsByPath(index);
    } catch (error) {
      console.error(error);
    }
  }, []);

  const loadAlbums = useCallback(async (store: Store) => {
    setAlbumsLoading(true);
    try {
      const list = await invoke<Album[]>(store.immich ? "immich_albums" : "albums_list", { storeId: store.id });
      if (openStoreId.current !== store.id) return list;
      setAlbums(list);
      if (store.immich) void resolveCovers(store, list);
      // An album that is gone, deleted here or in Immich, stops filtering the gallery. The ref is set
      // here too: the render that would set it comes later, and the caller looks at it before that.
      if (albumIdRef.current && !list.some((album) => album.id === albumIdRef.current)) {
        albumIdRef.current = null;
        setAlbumId(null);
        setAlbumPaths(null);
      }
      return list;
    } catch (error) {
      if (openStoreId.current === store.id) setAlbumError(String(error));
      return [];
    } finally {
      if (openStoreId.current === store.id) setAlbumsLoading(false);
    }
  }, [resolveCovers]);

  const selectAlbum = useCallback(async (store: Store, id: string | null) => {
    setSmartAlbumId(null);
    const request = ++albumRequest.current;
    setAlbumId(id);
    // Choosing an album leaves whatever tag was chosen; the two never narrow each other.
    if (id) setTagFilter("");
    if (!id) {
      setAlbumPaths(null);
      return;
    }
    try {
      const paths = store.immich
        ? await invoke<string[]>("immich_album_pictures", { storeId: store.id, albumId: id })
        : await invoke<string[]>("album_pictures", { id });
      if (albumRequest.current === request) {
        setAlbumFiles(paths);
        setAlbumPaths(new Set(paths.map(layoutKey)));
      }
    } catch (error) {
      if (albumRequest.current !== request) return;
      setAlbumError(String(error));
      setAlbumPaths(new Set());
    }
  }, []);

  /** Runs one album change, then reads the albums and the open album again. */
  const changeAlbums = useCallback(async (store: Store, work: () => Promise<unknown>, marks?: (current: Record<string, string[]>) => Record<string, string[]>) => {
    setAlbumError("");
    try {
      await work();
    } catch (error) {
      setAlbumError(String(error));
    }
    const list = await loadAlbums(store);
    // Immich's marks take a search per album to read again, so a change that is known is applied here.
    if (marks && store.immich) setAlbumsByPath(marks);
    else void loadAlbumMarks(store, true);
    const open = albumIdRef.current;
    // Only an album that survived the change still filters the gallery.
    if (open && list.some((album) => album.id === open)) await selectAlbum(store, open);
  }, [loadAlbums, loadAlbumMarks, selectAlbum]);

  useEffect(() => {
    const searching = listen<DuplicateProgress & { storeId: string }>("duplicates-progress", ({ payload }) => {
      if (duplicateSearch.current?.storeId !== payload.storeId) return;
      duplicateSearch.current.progress = payload;
      if (payload.storeId === openStoreId.current) setDuplicateProgress(payload);
    });
    const matches = listen<{ storeId: string; result: Duplicates }>("duplicates-results", ({ payload }) => {
      if (duplicateSearch.current?.storeId !== payload.storeId) return;
      const result = withoutDeletedDuplicates(payload.result, duplicateSearch.current.deleted);
      duplicateSearch.current.result = result;
      if (payload.storeId === openStoreId.current) setDuplicates(result);
    });
    const reading = listen<{ id: string; done: number; total: number }>("tag-index", ({ payload }) => {
      if (payload.id === openStoreId.current) setTagProgress({ done: payload.done, total: payload.total });
    });
    const listening = listen<{ id: string; done: number; total: number }>("store-scan", ({ payload }) => {
      if (payload.id === openStoreId.current) {
        if (scanning.current.has(payload.id)) setStoreProgress({ done: payload.done, total: payload.total });
        setDuplicateProgress((current) => current?.stage === "scan" ? { stage: "scan", done: payload.done, total: payload.total } : current);
      }
    });
    const refreshed = listen<{ storeId: string; contents: StoreContents }>("store-index-updated", ({ payload }) => {
      if (payload.storeId !== openStoreId.current) return;
      setStoreStats(payload.contents.stats);
      if (editorOpen.current) pendingScan.current = payload.contents;
      else setImages(payload.contents.images);
    });
    return () => {
      void listening.then((unlisten) => unlisten());
      void reading.then((unlisten) => unlisten());
      void searching.then((unlisten) => unlisten());
      void matches.then((unlisten) => unlisten());
      void refreshed.then((unlisten) => unlisten());
    };
  }, []);

  // Pictures the drop box saves into the open store come first, as the newest.
  const addImages = useCallback((added: ImageEntry[]) => {
    setImages((current) => {
      const known = new Set(current.map((image) => image.path));
      const fresh = added.filter((image) => !known.has(image.path)).reverse();
      return fresh.length ? [...fresh, ...current] : current;
    });
    setStoreStats((stats) => stats && { ...stats, pictures: stats.pictures + added.length, bytes: added.reduce((sum, image) => sum + image.size, stats.bytes) });
  }, []);

  useEffect(() => {
    const listening = [
      listen<{ storeId: string; image: ImageEntry }>("store-added", ({ payload }) => {
        // A folder that is open shows a picture saved straight into it.
        const folder = payload.image.path.slice(0, payload.image.path.lastIndexOf("/"));
        const intoFolder = !openStoreId.current && !!currentPathNow.current && folder === currentPathNow.current.replace(/\/+$/, "");
        if (payload.storeId !== openStoreId.current && !intoFolder) return;
        if (editorOpen.current) pendingAdded.current.push(payload.image);
        else addImages([payload.image]);
      }),
      listen<{ storeId: string; albumId: string; paths: string[] }>("album-added", ({ payload }) => {
        const store = storesNow.current.find((item) => item.id === payload.storeId);
        if (!store || payload.storeId !== openStoreId.current) return;
        // The sidebar's counts and covers follow what the album gained.
        void loadAlbums(store);
        const open = albumIdRef.current;
        if (open && albumHolds(albumsNow.current, open, payload.albumId)) {
          setAlbumPaths((current) => new Set([...(current ?? []), ...payload.paths.map(layoutKey)]));
        }
        const album = albumsNow.current.find((item) => item.id === payload.albumId);
        if (store.immich && album) {
          const name = album.fullName || album.name;
          setAlbumsByPath((current) => {
            const next = { ...current };
            for (const path of payload.paths) next[path] = [...new Set([...(next[path] ?? []), name])].sort((a, b) => a.localeCompare(b));
            return next;
          });
        } else {
          void loadAlbumMarks(store);
        }
      }),
      // The tray and the drop box open the settings on their tab.
      listen<SettingsTab>("open-settings", ({ payload }) => setSettingsTab(payload)),
    ];
    return () => listening.forEach((promise) => void promise.then((unlisten) => unlisten()));
  }, [addImages, loadAlbumMarks, loadAlbums]);

  // Pictures dragged onto the window from other programs: into the album under the pointer, else the
  // album that is open, else the store.
  const [windowDrop, setWindowDrop] = useState<string | null>(null);
  const [dropMessage, setDropMessage] = useState("");
  useEffect(() => {
    const target = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-album-id]");
      const pointed = row?.dataset.albumId ?? "";
      if (pointed && !pointed.startsWith("path:")) return pointed;
      const open = albumIdRef.current;
      return open && !open.startsWith("path:") ? open : "";
    };
    const listening = [
      listen<{ x?: number; y?: number; left?: boolean }>("window-drag", ({ payload }) => {
        if (payload.left || payload.x === undefined || payload.y === undefined || !openStoreId.current) { setWindowDrop(null); return; }
        setWindowDrop(target(payload.x, payload.y));
      }),
      listen<{ token?: number; x?: number; y?: number; message?: string }>("window-drop", ({ payload }) => {
        setWindowDrop(null);
        if (payload.message) { setDropMessage(payload.message); return; }
        if (payload.token === undefined) return;
        const store = openStoreId.current;
        if (!store) {
          void invoke("window_drop_cancel", { token: payload.token });
          setDropMessage("Open a store to drop pictures into it.");
          return;
        }
        const albumId = target(payload.x ?? 0, payload.y ?? 0);
        setDropMessage("Saving…");
        void invoke<string>("window_drop", { token: payload.token, storeId: store, albumId })
          .then(setDropMessage)
          .catch((error) => setDropMessage(String(error)));
      }),
    ];
    return () => listening.forEach((promise) => void promise.then((unlisten) => unlisten()));
  }, []);

  // Hidden stores: listed only after the password, and left behind whenever they go away again.
  const [hiddenStatus, setHiddenStatus] = useState<HiddenStatus>({ passwordSet: false, revealed: false, timeoutMinutes: 10 });
  const [asking, setAsking] = useState(false);
  const hiddenNow = useRef(hiddenStatus);
  hiddenNow.current = hiddenStatus;
  const storesNow = useRef(stores);
  storesNow.current = stores;
  const loadedNow = useRef(loaded);
  loadedNow.current = loaded;
  const currentPathNow = useRef(currentPath);
  currentPathNow.current = currentPath;

  const followStores = useCallback(async () => {
    let list: Store[];
    try { list = await invoke<Store[]>("stores_list"); } catch { return; }
    const gone = storesNow.current.filter((store) => !list.some((kept) => kept.id === store.id));
    setStores(list);
    if (!gone.length) return;
    const inside = (path?: string | null) => !!path && gone.some((store) => path === store.path || path.startsWith(`${store.path.replace(/\/+$/, "")}/`));
    if (inside(loadedNow.current?.path)) setLoaded(null);
    const leavingStore = !!openStoreId.current && gone.some((store) => store.id === openStoreId.current);
    if (!leavingStore && !inside(currentPathNow.current)) return;
    editorOpen.current = false;
    setEditorIndex(null);
    setImages([]);
    if (list[0]) void openStore(list[0].id);
    else if (!leavingStore) { setCurrentPath(null); storage.removeItem("inpaint.current"); leaveStore(); }
    else if (currentPathNow.current && !inside(currentPathNow.current)) void loadFolder(currentPathNow.current);
    else leaveStore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void invoke<HiddenStatus>("hidden_status").then(setHiddenStatus).catch(() => {});
    const listening = listen<HiddenStatus>("hidden-changed", ({ payload }) => {
      setHiddenStatus(payload);
      void followStores();
    });
    const toggle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === "KeyH")) return;
      event.preventDefault();
      event.stopPropagation();
      if (hiddenNow.current.revealed) void invoke<HiddenStatus>("hidden_lock").then(setHiddenStatus).catch(() => {});
      else setAsking(true);
    };
    // Any use of the window puts off hiding again, told to the backend at most every 20 seconds.
    let told = 0;
    const used = () => {
      if (!hiddenNow.current.revealed || Date.now() - told < 20_000) return;
      told = Date.now();
      void invoke("hidden_activity").catch(() => {});
    };
    window.addEventListener("keydown", toggle, true);
    for (const name of ["pointerdown", "keydown", "wheel", "pointermove"]) window.addEventListener(name, used, { capture: true, passive: true });
    return () => {
      void listening.then((unlisten) => unlisten());
      window.removeEventListener("keydown", toggle, true);
      for (const name of ["pointerdown", "keydown", "wheel", "pointermove"]) window.removeEventListener(name, used, true);
    };
  }, [followStores]);

  useEffect(() => {
    // Restore the store or folder that was open last, once.
    const restore = (list: Store[]) => {
      const saved = storage.getItem("inpaint.store");
      if (saved && list.some((store) => store.id === saved)) void openStore(saved);
      else if (currentPath) void loadFolder(currentPath);
      else leaveStore();
    };
    void invoke<Store[]>("stores_list").then((list) => { setStores(list); restore(list); }).catch(() => restore([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose an image folder" });
    if (typeof selected !== "string") return;
    setRootPath(selected);
    storage.setItem("inpaint.root", selected);
    await loadFolder(selected);
  };

  // Folders are listed again; in a store only the saved pictures are, since a rescan takes a while.
  const refreshAfterEdit = async () => {
    editorOpen.current = false;
    const saved = [...savedPaths.current];
    savedPaths.current.clear();
    if (!openStoreId.current) {
      if (currentPath) void loadFolder(currentPath);
      return;
    }
    const pending = pendingScan.current;
    const added = pendingAdded.current;
    pendingScan.current = null;
    pendingAdded.current = [];
    if (pending) setImages(pending.images);
    if (added.length) addImages(added);
    if (!saved.length) return;
    try {
      const entries = await invoke<(ImageEntry | null)[]>("image_entries", { paths: saved });
      const updated = new Map(saved.map((path, index) => [path, entries[index]]));
      setImages((current) => current.flatMap((image) => {
        const entry = updated.get(image.path);
        return entry === undefined ? [image] : entry ? [entry] : [];
      }));
    } catch (error) {
      console.error(error);
    }
  };

  const activeStore = stores.find((store) => store.id === storeId) ?? null;
  useEffect(() => {
    if (albumId === null && albumPaths !== null) setAlbumPaths(null);
  }, [albumId, albumPaths]);

  // Albums are read again whenever another store opens, or one starts or stops using Immich's albums.
  const albumSource = activeStore ? `${activeStore.id}:${activeStore.immich}` : "";
  useEffect(() => {
    setSmartAlbumId(null);
    setAlbums([]);
    setAlbumId(null);
    setAlbumPaths(null);
    setAlbumError("");
    albumRequest.current += 1;
    setAlbumsByPath({});
    setTagNames([]);
    setTagsByPath({});
    setTagFilter("");
    setTagError("");
    setTagProgress(null);
    const searching = duplicateSearch.current;
    setDuplicates(searching?.storeId === storeId && searching.result ? withoutDeletedDuplicates(searching.result, searching.deleted) : null);
    setDuplicateProgress(duplicateSearch.current?.storeId === storeId ? duplicateSearch.current.progress : null);
    setDuplicateError(duplicateSearchErrors.current.get(storeId ?? "") ?? "");
    setDuplicateNotice("");
    setKeepChoices({});
    const request = ++duplicateRequest.current;
    if (activeStore) {
      const opened = activeStore.id;
      if (duplicateSearch.current?.storeId !== opened) void invoke<Duplicates | null>("duplicates_cached", { storeId: opened })
        .then((found) => { if (openStoreId.current === opened && duplicateRequest.current === request) setDuplicates(found); })
        .catch(() => {});
      void loadAlbums(activeStore);
      void loadAlbumMarks(activeStore);
      void loadTags(activeStore, false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumSource]);

  const createAlbum = async (store: Store, name: string, parentId: string, paths?: string[]) => {
    await changeAlbums(store, async () => {
      if (store.immich) {
        // Immich has no album tree of its own: an album inside another one carries its parent's path.
        const parent = albums.find((album) => album.id === parentId);
        const created = await invoke<{ id: string }>("immich_album_create", { storeId: store.id, name: parent ? `${parent.fullName}/${name}` : name });
        if (paths?.length) await invoke("immich_album_pictures_set", { storeId: store.id, albumId: created.id, paths, add: true });
      } else {
        const created = await invoke<Album>("album_create", { storeId: store.id, name, parentId });
        if (paths?.length) await invoke("album_add", { id: created.id, paths });
      }
    });
  };

  /** Renames an album, and for Immich the albums below it, whose names carry its path. */
  const renameAlbum = async (store: Store, album: Album, name: string) => {
    if (!store.immich) return invoke("album_rename", { id: album.id, name });
    const cut = album.fullName.lastIndexOf("/");
    const fullName = cut < 0 ? name : `${album.fullName.slice(0, cut)}/${name}`;
    if (!album.isVirtual) await invoke("immich_album_rename", { storeId: store.id, albumId: album.id, name: fullName });
    for (const below of albums) {
      if (below.isVirtual || !below.fullName.startsWith(`${album.fullName}/`)) continue;
      await invoke("immich_album_rename", { storeId: store.id, albumId: below.id, name: `${fullName}${below.fullName.slice(album.fullName.length)}` });
    }
  };

  const deleteAlbum = async (store: Store, album: Album) => {
    const inside = albums.some((entry) => entry.parentId === album.id) ? " and the albums inside it" : "";
    const question = store.immich
      ? `Delete the album "${album.name}" in Immich? Its pictures stay in Immich.`
      : `Delete the album "${album.name}"${inside}? Its pictures stay on disk.`;
    if (!await confirm(question, { title: "Delete album", kind: "warning" })) return;
    await changeAlbums(store, () => (store.immich ? invoke("immich_album_delete", { storeId: store.id, albumId: album.id }) : invoke("album_delete", { id: album.id })));
  };

  const setAlbumPictures = (store: Store, album: Album, paths: string[], add: boolean) =>
    changeAlbums(store, () => (store.immich
      ? invoke("immich_album_pictures_set", { storeId: store.id, albumId: album.id, paths, add })
      : invoke(add ? "album_add" : "album_remove", { id: album.id, paths })),
      (current) => {
        const name = album.fullName || album.name;
        const next = { ...current };
        for (const path of paths) {
          const names = (next[path] ?? []).filter((entry) => entry !== name);
          if (add) names.push(name);
          if (names.length) next[path] = names.sort((a, b) => a.localeCompare(b)); else delete next[path];
        }
        return next;
      });

  const tagView: TagView = {
    names: tagNames,
    byPath: tagsByPath,
    selected: tagFilter,
    loading: tagsLoading,
    progress: tagProgress,
    error: tagError,
    refreshable: !!activeStore?.immich,
    onSelect: (name) => {
      setSmartAlbumId(null);
      setTagFilter(name);
      if (name) {
        albumRequest.current += 1;
        setAlbumId(null);
        setAlbumPaths(null);
      }
    },
    onRefresh: () => { if (activeStore) { setTagProgress({ done: 0, total: 0 }); void loadTags(activeStore, true); } },
    onTagPictures: (paths, names) => { if (activeStore) void tagPictures(activeStore, paths, names); },
    onCreate: (parent, leaf) => { if (activeStore) void changeTags(activeStore, () => (activeStore.immich
      ? invoke("immich_tag_create", { storeId: activeStore.id, parent, leaf })
      : invoke("label_create", { kind: "tag", name: parent ? `${parent}/${leaf.trim()}` : leaf.trim() }))); },
    onRename: (name, leaf) => { if (activeStore) void changeTags(activeStore, () => (activeStore.immich
      ? invoke("immich_tag_rename", { storeId: activeStore.id, name, leaf })
      : invoke("tag_rename", { name, leaf })), (current) => renamedTags(current, name, leaf)); },
    onDelete: (name) => { if (activeStore) void deleteTag(activeStore, name); },
  };

  /** Adds tags to the pictures picked in the gallery, in our database or in Immich, one after another. */
  const tagPictures = async (store: Store, paths: string[], names: string[]) => {
    setTagError("");
    for (const name of names) {
    const tag = name.trim().replace(/^\/+|\/+$/g, "");
    if (!tag) continue;
    try {
      if (store.immich) await invoke("immich_tag_paths", { storeId: store.id, name: tag, paths, add: true });
      else await invoke("pictures_tag", { paths, name: tag, add: true });
      // Immich also puts the tags above it on the picture, so the marks show what it will show.
      const branch = tag.split("/").filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
      setTagsByPath((current) => {
        const next = { ...current };
        for (const path of paths) next[path] = [...new Set([...(next[path] ?? []), ...branch])];
        return next;
      });
      setTagNames((current) => [...new Set([...current, ...branch])]);
    } catch (error) {
      setTagError(String(error));
      return;
    }
    }
  };

  /** Runs one change to the tags, then reads the names again; the marks are patched meanwhile. */
  const changeTags = async (store: Store, work: () => Promise<unknown>, patch?: (tags: string[]) => string[]) => {
    setTagError("");
    try {
      await work();
      if (patch) {
        setTagsByPath((current) => Object.fromEntries(Object.entries(current).map(([path, tags]) => [path, patch(tags)])));
        setTagFilter((current) => (current ? patch([current])[0] ?? "" : ""));
      }
      const names = store.immich
        ? await invoke<string[]>("immich_tags", { storeId: store.id })
        : (await invoke<{ kind: string; name: string }[]>("labels_all")).filter((label) => label.kind === "tag").map((label) => label.name);
      if (openStoreId.current === store.id) setTagNames([...new Set([...names, ...Object.values(tagsByPath).flat()])]);
    } catch (error) {
      setTagError(String(error));
    }
  };

  const deleteTag = async (store: Store, name: string) => {
    const question = `Delete the tag "${name}" and the tags inside it? The pictures themselves stay where they are.`;
    if (!await confirm(question, { title: "Delete tag", kind: "warning" })) return;
    await changeTags(store, () => (store.immich ? invoke("immich_tag_delete", { storeId: store.id, name }) : invoke("tag_delete", { name })),
      (tags) => tags.filter((tag) => tag !== name && !tag.startsWith(`${name}/`)));
    setTagNames((current) => current.filter((tag) => tag !== name && !tag.startsWith(`${name}/`)));
    if (tagFilter === name || tagFilter.startsWith(`${name}/`)) setTagFilter("");
  };

  const searchDuplicates = async (store: Store) => {
    if (duplicateSearch.current || duplicateResolving.current) {
      setDuplicateError("A duplicate operation is already running. Return to its store to stop it.");
      return;
    }
    ++duplicateRequest.current;
    duplicateSearchErrors.current.delete(store.id);
    setDuplicates(null);
    setKeepChoices({});
    setDuplicateError("");
    setDuplicateNotice("");
    setDuplicateProgress({ stage: "scan", done: 0, total: 0 });
    const deleted = new Set<string>();
    duplicateSearch.current = { storeId: store.id, progress: { stage: "scan", done: 0, total: 0 }, result: null, deleted };
    try {
      const found = await invoke<Duplicates>("duplicates_search", { storeId: store.id, level: duplicateLevel });
      if (openStoreId.current !== store.id) return;
      setDuplicates(withoutDeletedDuplicates(found, deleted));
    } catch (error) {
      // A notification can still be queued when the command ends. Load the persisted
      // checkpoint as well, so Stop/error retains the most recent confirmed groups.
      try {
        const saved = await invoke<Duplicates | null>("duplicates_cached", { storeId: store.id });
        if (openStoreId.current === store.id && saved) setDuplicates(withoutDeletedDuplicates(saved, deleted));
      } catch { /* Keep the last live snapshot if the checkpoint cannot be read. */ }
      duplicateSearchErrors.current.set(store.id, String(error));
      if (openStoreId.current === store.id) setDuplicateError(String(error));
    } finally {
      duplicateSearch.current = null;
      if (openStoreId.current === store.id) setDuplicateProgress(null);
    }
  };

  const clearDuplicates = async (store: Store) => {
    const request = ++duplicateRequest.current;
    setDuplicateBusy(true);
    setDuplicateError("");
    try {
      await invoke("duplicates_clear", { storeId: store.id });
      if (openStoreId.current !== store.id || duplicateRequest.current !== request) return;
      setDuplicates(null);
      setKeepChoices({});
      setDuplicateNotice("");
      setEditorGroup(null);
    } catch (error) {
      if (openStoreId.current === store.id && duplicateRequest.current === request) setDuplicateError(String(error));
    } finally {
      setDuplicateBusy(false);
    }
  };

  /** Deletes the pictures marked in these groups, once their tags and albums are on the ones kept. */
  const resolveDuplicates = async (store: Store, groups: DuplicateGroupView[]) => {
    if (duplicateResolving.current) return;
    const doomed = groups.flatMap((group) => group.members.filter((member) => !member.keep).map((member) => member.image.path));
    if (!doomed.length) return;
    const whole = groups.filter((group) => group.members.every((member) => !member.keep)).length;
    const question = `Delete ${doomed.length.toLocaleString()} ${doomed.length === 1 ? "picture" : "pictures"} from ${groups.length.toLocaleString()} ${groups.length === 1 ? "group" : "groups"}?`
      + (whole ? ` ${whole.toLocaleString()} ${whole === 1 ? "group keeps" : "groups keep"} no picture at all.` : "")
      + (store.immich ? " They go to Immich's trash." : " They go to the trash.");
    duplicateResolving.current = true;
    setDuplicateBusy(true);
    setDuplicateError("");
    setDuplicateNotice("");
    try {
      if (!await confirm(question, { title: "Delete duplicates", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" })) return;
      const message = await resolveDuplicateSelection(store, groups, invoke, () => openStoreId.current === store.id,
        (paths, checks) => deletePictures(paths, checks));
      if (openStoreId.current === store.id) setDuplicateNotice(message);
    } catch (error) {
      if (openStoreId.current === store.id) setDuplicateError(String(error));
    } finally {
      duplicateResolving.current = false;
      setDuplicateBusy(false);
      if (openStoreId.current === store.id) {
        void loadTags(store, true);
        void loadAlbums(store);
        void loadAlbumMarks(store, true);
      }
    }
  };

  const duplicateView: DuplicateView = {
    result: duplicates,
    groups: duplicateGroups,
    progress: duplicateProgress,
    error: duplicateError,
    notice: duplicateNotice,
    busy: duplicateBusy || !!storeProgress,
    level: duplicateLevel,
    ignored: storeId ? notDuplicates.filter((entry) => entry.startsWith(`${storeId}:`)).length : 0,
    onLevel: setDuplicateLevel,
    onSearch: () => { if (activeStore) void searchDuplicates(activeStore); },
    onCancel: () => { if (activeStore) void invoke("duplicates_cancel", { storeId: activeStore.id }); },
    onClear: () => { if (activeStore) void clearDuplicates(activeStore); },
    onToggle: (path) => {
      const member = duplicateGroups.flatMap((group) => group.members).find((entry) => entry.image.path === path);
      if (member) setKeepChoices((current) => ({ ...current, [path]: !member.keep }));
    },
    onResolve: (groups) => { if (activeStore) void resolveDuplicates(activeStore, groups); },
    onIgnore: (group) => { if (storeId) setNotDuplicates((current) => [...current, `${storeId}:${group.members.map((member) => member.image.path).sort().join("\n")}`]); },
    onUnignore: () => { if (storeId) setNotDuplicates((current) => current.filter((entry) => !entry.startsWith(`${storeId}:`))); },
    onOpen: (group, index) => {
      editorOpen.current = true;
      setEditorGroup(group.key);
      setEditorIndex(index);
    },
    onNoticeClear: () => setDuplicateNotice(""),
  };

  const albumView: AlbumView = {
    storeId: activeStore?.id ?? "",
    windowDrop,
    albums: [...albums, ...smartViews],
    selected: smartViews.find((album) => album.id === smartAlbumId) ?? albums.find((album) => album.id === albumId) ?? null,
    tagNames,
    onSaveSmart: (id, name, rules) => {
      if (!activeStore) return;
      const key = id ?? `smart:${crypto.randomUUID()}`;
      setSmartAlbums((current) => id ? current.map((album) => album.id === id ? { ...album, name, rules } : album)
        : [...current, { id: key, name, rules, storeId: activeStore.id, createdMs: Date.now() }]);
      albumRequest.current += 1;
      setAlbumId(null); setAlbumPaths(null); setTagFilter(""); setSmartAlbumId(key); setSmartNow(Date.now());
    },
    loading: albumsLoading,
    error: albumError,
    immich: !!activeStore?.immich,
    onSelect: (id) => {
      if (id && smartViews.some((album) => album.id === id)) {
        albumRequest.current += 1;
        setAlbumId(null); setAlbumPaths(null); setTagFilter(""); setSmartAlbumId(id); setSmartNow(Date.now());
      } else if (activeStore) void selectAlbum(activeStore, id);
    },
    onCreate: (name, parentId, paths) => { if (activeStore) void createAlbum(activeStore, name, parentId, paths); },
    onExport: (album) => {
      if (!activeStore) return;
      setAlbumExport(albumExportRequest(album, activeStore, images, tagsByPath, facts));
    },
    onRename: (album, name) => {
      if (album.smartRules) setSmartAlbums((current) => current.map((item) => item.id === album.id ? { ...item, name } : item));
      else if (activeStore) void changeAlbums(activeStore, () => renameAlbum(activeStore, album, name));
    },
    onMove: (album, parentId) => { if (activeStore && !album.smartRules) void changeAlbums(activeStore, () => invoke("album_move", { id: album.id, parentId })); },
    onSetCover: (album, path) => { if (activeStore && !album.smartRules) void changeAlbums(activeStore, () => (activeStore.immich ? invoke("immich_album_set_cover", { storeId: activeStore.id, albumId: album.id, path }) : invoke("album_set_cover", { id: album.id, path }))); },
    onDelete: (album) => {
      if (album.smartRules) {
        setSmartAlbums((current) => current.filter((item) => item.id !== album.id));
        if (smartAlbumId === album.id) setSmartAlbumId(null);
      } else if (activeStore) void deleteAlbum(activeStore, album);
    },
    onAddPictures: (album, paths) => { if (activeStore && !album.smartRules) void setAlbumPictures(activeStore, album, paths, true); },
    onRemovePictures: (album, paths) => { if (activeStore && !album.smartRules) void setAlbumPictures(activeStore, album, paths, false); },
  };

  /** Deletes pictures from the gallery: Immich's trash inside a compatible store, the desktop's otherwise. */
  const deletePictures = async (paths: string[], checks?: Map<string, DuplicateDeletion>) => {
    const deletingStore = openStoreId.current;
    const gone = new Set<string>();
    let refused = "";
    for (const path of paths) {
      if (checks && openStoreId.current !== deletingStore) { refused = "The open store changed."; break; }
      try {
        const result = await invoke<{ deleted: boolean; message: string }>("delete_image", { path, permanent: false, ...checks?.get(path) });
        if (result.deleted) {
          gone.add(path);
          const searching = duplicateSearch.current;
          if (searching?.storeId === deletingStore) {
            searching.deleted.add(path);
          }
        }
        else refused = refused || result.message;
        if (checks && !result.deleted) break;
      } catch (error) {
        refused = refused || String(error);
        if (checks) break;
      }
    }
    const searching = duplicateSearch.current;
    if (searching?.storeId === deletingStore && searching.result && gone.size) {
      searching.result = withoutDeletedDuplicates(searching.result, searching.deleted);
    }
    if (gone.size && openStoreId.current === deletingStore) {
      const removed = images.filter((image) => gone.has(image.path));
      setDuplicates((current) => current && {
        ...current,
        groups: current.groups.map((group) => ({ ...group, pictures: group.pictures.filter((picture) => !gone.has(picture.path)) }))
          .filter((group) => group.pictures.length > 1),
      });
      setImages((current) => current.filter((image) => !gone.has(image.path)));
      pendingAdded.current = pendingAdded.current.filter((image) => !gone.has(image.path));
      if (pendingScan.current) pendingScan.current = { ...pendingScan.current, images: pendingScan.current.images.filter((image) => !gone.has(image.path)) };
      for (const path of gone) savedPaths.current.delete(path);
      if (openStoreId.current) {
        setStoreStats((stats) => stats && { ...stats, pictures: stats.pictures - removed.length, bytes: removed.reduce((rest, image) => rest - image.size, stats.bytes) });
      }
      setTagsByPath((current) => {
        const next = { ...current };
        for (const path of gone) delete next[path];
        return next;
      });
    }
    const kept = paths.length - gone.size;
    if (!gone.size) return refused || "Nothing was deleted.";
    return kept ? `${gone.size.toLocaleString()} deleted, ${kept.toLocaleString()} kept: ${refused}` : `${gone.size.toLocaleString()} ${gone.size === 1 ? "picture" : "pictures"} deleted.`;
  };

  // The editor and strip stay mounted while switching pictures, keeping their panels in place.
  const [stripOpen, setStripOpen] = usePreference("inpaint.filmstrip", false);
  const [viewportBox, setViewportBox] = useState<ViewportBox | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const editorNavigator = useRef<((index: number) => void) | null>(null);

  // A group whose copies were deleted or hidden elsewhere leaves nothing to go through.
  useEffect(() => {
    if (!editorGroup || openGroup) return;
    setEditorGroup(null);
    setEditorIndex(null);
    void refreshAfterEdit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorGroup, openGroup]);

  const navigate = (offset: number) => {
    setEditorIndex((current) => {
      if (current === null || !editorList.length) return current;
      return (current + offset + editorList.length) % editorList.length;
    });
  };

  const editorProps = {
    brushSize,
    onBrushSizeChange: setBrushSize,
    faceSwapSource: storeFaces.source,
    faceLibrary: storeFaces.paths,
    onFaceLibraryChange: storeFaces.setPaths,
    onFaceSwapSourceChange: storeFaces.selectSource,
    onFaceSwapSourceClear: storeFaces.clearSource,
    onSaved: (path: string) => { savedPaths.current.add(path); },
    immichStores: stores.filter((store) => store.immich),
    // After deleting, the editor moves on to the next picture, or back to the gallery after the last one.
    onDeleted: (path: string) => {
      const index = editorList.findIndex((image) => image.path === path);
      const removed = editorList[index];
      const withoutPath = (list: ImageEntry[]) => list.filter((image) => image.path !== path);
      // A duplicate group of one picture is no group any more, so the editor closes with it.
      const remaining = openGroup && editorList.length <= 2 ? [] : withoutPath(editorList);
      setImages(withoutPath(images));
      savedPaths.current.delete(path);
      pendingAdded.current = withoutPath(pendingAdded.current);
      if (pendingScan.current) pendingScan.current = { ...pendingScan.current, images: withoutPath(pendingScan.current.images) };
      if (removed && openStoreId.current) setStoreStats((stats) => stats && { ...stats, pictures: stats.pictures - 1, bytes: stats.bytes - removed.size });
      if (loaded || index < 0 || !remaining.length) {
        setLoaded(null);
        setEditorIndex(null);
        setEditorGroup(null);
        void refreshAfterEdit();
      } else {
        setEditorIndex(Math.min(index, remaining.length - 1));
      }
    },
    replaceRequested: queuedLoad !== null,
    onReplace: () => { setEditorIndex(null); setLoaded(queuedLoad); setQueuedLoad(null); },
    onReplaceCancel: () => setQueuedLoad(null),
  };

  const settingsDialog = <>
    {settingsTab && <SettingsDialog tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} stores={stores} revealed={hiddenStatus.revealed} />}
    {asking && <HiddenDialog passwordSet={hiddenStatus.passwordSet} onClose={() => setAsking(false)}
      onUnlocked={(status) => { setAsking(false); setHiddenStatus(status); void followStores(); }} />}
  </>;

  if (loaded) {
    return (
      <>
      <Editor
        {...editorProps}
        key={`loaded-${loaded.id}:${storeId ?? "folders"}`}
        image={{ name: loaded.name, path: loaded.path, extension: loaded.name.split(".").at(-1)?.toLowerCase() ?? "png", size: 0, modifiedMs: 0 }}
        initialData={loaded.data}
        index={0}
        total={1}
        onExit={() => {
          setLoaded(null);
          void refreshAfterEdit();
        }}
        onNavigate={() => {}}
      />
      {settingsDialog}
      </>
    );
  }

  if (editorIndex !== null && editorList[editorIndex]) {
    const current = editorList[editorIndex];
    const member = openGroup?.members.find((entry) => entry.image.path === current.path);
    return (
      <>
      <Editor
        {...editorProps}
        // One editor for the whole gallery: it opens each picture itself, keeping its panels in place.
        key={`gallery-editor:${storeId ?? "folders"}`}
        image={current}
        index={editorIndex}
        total={editorList.length}
        duplicate={member && { keep: member.keep, onToggle: () => duplicateView.onToggle(member.image.path) }}
        onExit={() => {
          setEditorIndex(null);
          setEditorGroup(null);
          void refreshAfterEdit();
          // Favourites and ratings may have changed in the editor.
          void loadFacts(openStoreId.current, openStoreId.current ? null : currentPath, true);
        }}
        onNavigate={navigate}
        stripOpen={stripOpen}
        onStripToggle={() => setStripOpen(!stripOpen)}
        onViewport={setViewportBox}
        onBusy={setEditorBusy}
        navigator={editorNavigator}
      />
      {stripOpen && editorList.length > 1 && viewportBox && <Filmstrip pictures={editorList} index={editorIndex} box={viewportBox} disabled={editorBusy}
        keeps={openGroup ? Object.fromEntries(openGroup.members.map((entry) => [entry.image.path, entry.keep])) : undefined}
        onJump={(target) => editorNavigator.current?.(target)} />}
      {settingsDialog}
      </>
    );
  }

  const storeView: StoreView = {
    stores,
    active: activeStore,
    revealed: hiddenStatus.revealed,
    albums: albumView,
    albumsByPath,
    windowDrop,
    dropMessage,
    onDropMessageClear: () => setDropMessage(""),
    tags: tagView,
    duplicates: duplicateView,
    stats: storeStats,
    progress: storeProgress,
    error: storeError,
    onOpen: (id) => void openStore(id),
    onCreated: (store) => {
      setStores((current) => [...current, store]);
      void openStore(store.id);
    },
    onChanged: (store) => setStores((current) => current.map((item) => item.id === store.id ? store : item)),
    onRemoved: () => {
      const removed = storeId;
      setStores((current) => current.filter((item) => item.id !== removed));
      setImages([]);
      if (currentPath) void loadFolder(currentPath);
      else leaveStore();
    },
    onRescan: () => { if (storeId) void scanStore(storeId); },
  };
  const viewKey = storeId && storeView.active ? `store:${storeId}${smartAlbumId || albumId ? `/album:${smartAlbumId || albumId}` : ""}${tagFilter ? `/tag:${tagFilter}` : ""}` : currentPath;

  return (
    <>
    <BrowserView
      rootPath={rootPath}
      currentPath={currentPath}
      images={shown}
      loading={loading}
      order={order}
      onOrder={setOrder}
      orderChoices={{ tagged: !!storeId && !tagFilter && !selectedSmart, inAlbums: !!storeId && !tagFilter && !albumId && !selectedSmart }}
      leftOut={leftOut}
      facts={facts}
      store={storeView}
      onOpenFolder={() => void chooseFolder()}
      onSelectFolder={(path) => void loadFolder(path)}
      onOpenSettings={() => setSettingsTab("server")}
      onDeletePictures={deletePictures}
      onEdit={(index) => {
        editorOpen.current = true;
        setEditorIndex(index);
      }}
      initialScrollTop={viewKey ? galleryScrollPositions.current.get(viewKey) ?? 0 : 0}
      onScrollPositionChange={(scrollTop) => {
        if (viewKey) galleryScrollPositions.current.set(viewKey, scrollTop);
      }}
    />
    {settingsDialog}
    {albumExport && <AlbumExportDialog request={albumExport} onClose={() => setAlbumExport(null)} />}
    </>
  );
}
