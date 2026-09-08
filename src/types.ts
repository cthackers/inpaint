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
