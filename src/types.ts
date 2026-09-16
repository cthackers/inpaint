export type ImageEntry = {
  name: string;
  path: string;
  extension: string;
  size: number;
  modifiedMs: number;
  /** When the file was created here: for a store, when the picture was added. */
  addedMs?: number;
  /** The Immich-compatible store a picture of an external library was shown for. */
  storeId?: string;
};

export type FolderEntry = {
  name: string;
  path: string;
};

export type DirectoryContents = {
  folders: FolderEntry[];
  images: ImageEntry[];
};

export type Store = {
  id: string;
  name: string;
  path: string;
  immich: boolean;
  /** The store folder as Immich sees it, such as /data/upload/<user id>. */
  immichPath: string;
  /** This store's own Immich address and API key; empty means the ones in Settings. */
  immichUrl: string;
  immichKey: string;
  hidden: boolean;
};

export type StoreStats = {
  pictures: number;
  bytes: number;
  otherFiles: number;
  scannedMs: number;
  scanSeconds: number;
};

export type StoreContents = {
  images: ImageEntry[];
  stats: StoreStats;
};

/** An album of an image store: ours from `inpaint.db`, or one of Immich's for a compatible store. */
export type Album = {
  id: string;
  storeId: string;
  /** The album holding this one, empty at the top level. Always empty for Immich albums. */
  parentId: string;
  name: string;
  /** The whole name; for Immich albums the path the tree was read from, such as `Trips/Rome`. */
  fullName: string;
  /** An Immich album that is only a part of other names: it groups them and holds nothing itself. */
  isVirtual: boolean;
  /** The picture shown for the album, empty while an Immich cover is still being resolved. */
  coverPath: string;
  coverAssetId: string;
  /** Pictures added to the album itself, and including the albums inside it. */
  count: number;
  total: number;
  createdMs: number;
};

/** A picture's favourite and rating, and for Immich when it was uploaded. */
export type PictureFacts = { favorite: boolean; rating: number; addedMs?: number };

/** How the gallery orders pictures and which it leaves out. */
export type GalleryOrder = {
  by: "modified" | "added" | "rating" | "name";
  descending: boolean;
  /** Unticked, pictures that carry a tag are left out. */
  tagged: boolean;
  /** Unticked, pictures in any album are left out; only when every picture of a store is shown. */
  inAlbums: boolean;
  /** Unticked, only favourites are shown. */
  notFavorites: boolean;
};
export const DEFAULT_GALLERY_ORDER: GalleryOrder = { by: "modified", descending: true, tagged: true, inAlbums: true, notFavorites: true };
