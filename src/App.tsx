import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BrowserView, { type StoreView } from "./Browser";
import { SettingsDialog, type SettingsTab } from "./Settings";
import { FACE_SOURCE_PREFERENCE, usePreference } from "./preferences";
import Editor, { type FaceSwapSource } from "./Editor";
import { useServerBridge, type LoadRequest } from "./serverApi";
import type { DirectoryContents, ImageEntry, Store, StoreContents, StoreStats } from "./types";
import { storage } from "./storage";

type LoadedImage = LoadRequest & { id: number };

export default function App() {
  const [rootPath, setRootPath] = useState<string | null>(() => storage.getItem("inpaint.root"));
  const [currentPath, setCurrentPath] = useState<string | null>(() => storage.getItem("inpaint.current"));
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [brushSize, setBrushSize] = usePreference("inpaint.brushSize", 54, (value) => value >= 3 && value <= 500);
  const [faceSwapSource, setFaceSwapSource] = useState<FaceSwapSource | null>(null);
  const [faceSourcePath, setFaceSourcePath] = usePreference(FACE_SOURCE_PREFERENCE, "");
  useEffect(() => {
    if (!faceSourcePath || faceSwapSource?.path === faceSourcePath) return;
    let active = true;
    void invoke<string>("read_image_data", { path: faceSourcePath }).then((data) => {
      if (active) setFaceSwapSource({ path: faceSourcePath, data });
    }).catch(() => { if (active) setFaceSourcePath(""); });
    return () => { active = false; };
  }, [faceSourcePath]);
  const galleryScrollPositions = useRef(new Map<string, number>());

  // Image stores: the gallery shows either a folder or every picture of one store.
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<string | null>(() => storage.getItem("inpaint.store"));
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

  // Pictures sent to the API's /load endpoint, opened outside the folder list.
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [queuedLoad, setQueuedLoad] = useState<LoadedImage | null>(null);
  const loadCount = useRef(0);
  useServerBridge((request) => setQueuedLoad({ ...request, id: ++loadCount.current }));
  const folderEditorOpen = editorIndex !== null && !!images[editorIndex];
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

  useEffect(() => {
    const listening = listen<{ id: string; done: number; total: number }>("store-scan", ({ payload }) => {
      if (payload.id === openStoreId.current && scanning.current.has(payload.id)) {
        setStoreProgress({ done: payload.done, total: payload.total });
      }
    });
    return () => { void listening.then((unlisten) => unlisten()); };
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
        if (payload.storeId !== openStoreId.current) return;
        if (editorOpen.current) pendingAdded.current.push(payload.image);
        else addImages([payload.image]);
      }),
      // The tray and the drop box open the settings on their tab.
      listen<SettingsTab>("open-settings", ({ payload }) => setSettingsTab(payload)),
    ];
    return () => listening.forEach((promise) => void promise.then((unlisten) => unlisten()));
  }, [addImages]);

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

  const navigate = (offset: number) => {
    setEditorIndex((current) => {
      if (current === null || !images.length) return current;
      return (current + offset + images.length) % images.length;
    });
  };

  const editorProps = {
    brushSize,
    onBrushSizeChange: setBrushSize,
    faceSwapSource,
    onFaceSwapSourceChange: (source: FaceSwapSource) => { setFaceSwapSource(source); setFaceSourcePath(source.path); },
    onFaceSwapSourceClear: () => { setFaceSwapSource(null); setFaceSourcePath(""); },
    onSaved: (path: string) => { savedPaths.current.add(path); },
    immichStores: stores.filter((store) => store.immich),
    // After deleting, the editor moves on to the next picture, or back to the gallery after the last one.
    onDeleted: (path: string) => {
      const index = images.findIndex((image) => image.path === path);
      const removed = images[index];
      const withoutPath = (list: ImageEntry[]) => list.filter((image) => image.path !== path);
      const remaining = withoutPath(images);
      setImages(remaining);
      savedPaths.current.delete(path);
      pendingAdded.current = withoutPath(pendingAdded.current);
      if (pendingScan.current) pendingScan.current = { ...pendingScan.current, images: withoutPath(pendingScan.current.images) };
      if (removed && openStoreId.current) setStoreStats((stats) => stats && { ...stats, pictures: stats.pictures - 1, bytes: stats.bytes - removed.size });
      if (loaded || index < 0 || !remaining.length) {
        setLoaded(null);
        setEditorIndex(null);
        void refreshAfterEdit();
      } else {
        setEditorIndex(Math.min(index, remaining.length - 1));
      }
    },
    replaceRequested: queuedLoad !== null,
    onReplace: () => { setEditorIndex(null); setLoaded(queuedLoad); setQueuedLoad(null); },
    onReplaceCancel: () => setQueuedLoad(null),
  };

  const settingsDialog = settingsTab && <SettingsDialog tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} stores={stores} />;

  if (loaded) {
    return (
      <>
      <Editor
        {...editorProps}
        key={`loaded-${loaded.id}`}
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

  if (editorIndex !== null && images[editorIndex]) {
    return (
      <>
      <Editor
        {...editorProps}
        key={images[editorIndex].path}
        image={images[editorIndex]}
        index={editorIndex}
        total={images.length}
        onExit={() => {
          setEditorIndex(null);
          void refreshAfterEdit();
        }}
        onNavigate={navigate}
      />
      {settingsDialog}
      </>
    );
  }

  const storeView: StoreView = {
    stores,
    active: stores.find((store) => store.id === storeId) ?? null,
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
  const viewKey = storeId && storeView.active ? `store:${storeId}` : currentPath;

  return (
    <>
    <BrowserView
      rootPath={rootPath}
      currentPath={currentPath}
      images={images}
      loading={loading}
      store={storeView}
      onOpenFolder={() => void chooseFolder()}
      onSelectFolder={(path) => void loadFolder(path)}
      onOpenSettings={() => setSettingsTab("server")}
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
    </>
  );
}
