import { invoke } from "@tauri-apps/api/core";
import { matchesSmartAlbum } from "./smartAlbums";
import type { Album, ImageEntry, PictureFacts, Store } from "./types";

export type AlbumExportRequest = { name: string; loadPaths: () => Promise<string[]> };

/** Capture the album's unfiltered source, independent of gallery selection and display filters. */
export function albumExportRequest(album: Album, store: Store, images: ImageEntry[], tags: Record<string, string[]>, facts: Record<string, PictureFacts>): AlbumExportRequest {
  return { name: album.name, loadPaths: async () => {
    const rules = album.smartRules;
    if (rules) {
      const now = Date.now();
      return images.filter((image) => matchesSmartAlbum(image, rules, tags[image.path], facts[image.path], now)).map((image) => image.path);
    }
    return store.immich
      // A grouping prefix includes both this real album and all albums named beneath it.
      ? invoke<string[]>("immich_album_pictures", { storeId: store.id, albumId: `path:${album.fullName}`, includeUnavailable: true })
      : invoke<string[]>("album_pictures", { id: album.id });
  } };
}
