export type ImageEntry = {
  name: string;
  path: string;
  extension: string;
  size: number;
  modifiedMs: number;
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
