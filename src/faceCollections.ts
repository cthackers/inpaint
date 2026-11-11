export const FACE_COLLECTIONS_PREFERENCE = "inpaint.faceCollections";
export type FaceCollection = { scope: string; paths: string[]; sourcePath: string };
type Preferences = { getItem: (key: string) => string | null };

export const faceScope = (storeId: string | null) => storeId ? `store:${storeId}` : "folders";

export function validFaceCollections(value: unknown): value is FaceCollection[] {
  return Array.isArray(value) && value.every((item) => item && typeof item.scope === "string"
    && typeof item.sourcePath === "string" && Array.isArray(item.paths) && item.paths.every((path: unknown) => typeof path === "string"))
    && new Set(value.map((item) => item.scope)).size === value.length;
}

/** Import the old shared choices once, into the store open at migration (or the folder workspace). */
export function readFaceCollections(preferences: Preferences, storeId: string | null): FaceCollection[] {
  const read = (key: string): unknown => {
    try { return JSON.parse(preferences.getItem(key) ?? "null"); } catch { return null; }
  };
  const saved = read(FACE_COLLECTIONS_PREFERENCE);
  if (validFaceCollections(saved)) return saved;
  const legacyPaths = read("inpaint.faceLibrary");
  const legacySource = read("inpaint.faceSourcePath");
  const sourcePath = typeof legacySource === "string" ? legacySource : "";
  const paths = [...new Set([...(Array.isArray(legacyPaths) ? legacyPaths.filter((path): path is string => typeof path === "string") : []), ...(sourcePath ? [sourcePath] : [])])];
  return paths.length ? [{ scope: faceScope(storeId), paths, sourcePath }] : [];
}

export const faceCollectionFor = (collections: FaceCollection[], scope: string): FaceCollection =>
  collections.find((item) => item.scope === scope) ?? { scope, paths: [], sourcePath: "" };

export function updateFaceCollection(collections: FaceCollection[], scope: string, update: (current: FaceCollection) => FaceCollection): FaceCollection[] {
  const next = { ...update(faceCollectionFor(collections, scope)), scope };
  return collections.some((item) => item.scope === scope)
    ? collections.map((item) => item.scope === scope ? next : item) : [...collections, next];
}
