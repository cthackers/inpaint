import { useCallback, useEffect, useState, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePreference } from "./preferences";
import { storage } from "./storage";
import { FACE_COLLECTIONS_PREFERENCE, faceCollectionFor, faceScope, readFaceCollections, updateFaceCollection, validFaceCollections, type FaceCollection } from "./faceCollections";

type Source = { path: string; data: string };

export function useStoreFaces(storeId: string | null) {
  const scope = faceScope(storeId);
  const [initial] = useState(() => readFaceCollections(storage, storeId));
  const [collections, setCollections] = usePreference(FACE_COLLECTIONS_PREFERENCE, initial, validFaceCollections);
  const collection = faceCollectionFor(collections, scope);
  const [decoded, setDecoded] = useState<(Source & { scope: string }) | null>(null);
  // Scope and path checks hide the old image immediately, even before effects run after a switch.
  const source = decoded?.scope === scope && decoded.path === collection.sourcePath ? decoded : null;
  const update = useCallback((change: (current: FaceCollection) => FaceCollection) => {
    setCollections((current) => updateFaceCollection(current, scope, change));
  }, [scope, setCollections]);

  useEffect(() => {
    const path = collection.sourcePath;
    if (!path || source) return;
    let active = true;
    void invoke<string>("read_image_data", { path }).then((data) => {
      if (active) setDecoded({ scope, path, data });
    }).catch(() => {
      if (active) update((current) => current.sourcePath === path ? { ...current, sourcePath: "" } : current);
    });
    return () => { active = false; };
  }, [scope, collection.sourcePath, source, update]);

  const selectSource = (value: Source) => {
    setDecoded({ ...value, scope });
    update((current) => ({ ...current, sourcePath: value.path,
      paths: current.paths.includes(value.path) ? current.paths : [value.path, ...current.paths] }));
  };
  const setPaths = useCallback((value: SetStateAction<string[]>) => {
    update((current) => ({ ...current, paths: typeof value === "function" ? value(current.paths) : value }));
  }, [update]);
  return { source, paths: collection.paths, setPaths, selectSource,
    clearSource: () => update((current) => ({ ...current, sourcePath: "" })) };
}
