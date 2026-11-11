import type { Album, ImageEntry, PictureFacts } from "./types";

export type SmartRules = {
  tags: string[]; tagMatch: "all" | "any"; excludeTags: string[]; descendants: boolean;
  favorite: "any" | "yes" | "no"; minRating: number; maxRating: number;
  name: string; formats: string[]; addedDays: number;
};
export type SmartAlbum = { id: string; storeId: string; name: string; createdMs: number; rules: SmartRules };
export const defaultSmartRules: SmartRules = {
  tags: [], tagMatch: "all", excludeTags: [], descendants: true,
  favorite: "any", minRating: 0, maxRating: 5, name: "", formats: [], addedDays: 0,
};

export function validSmartAlbums(value: SmartAlbum[]): boolean {
  return value.every((album) => {
    const r = album?.rules;
    const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
    return typeof album?.id === "string" && typeof album.storeId === "string" && typeof album.name === "string"
      && Number.isFinite(album.createdMs) && r && strings(r.tags) && strings(r.excludeTags) && strings(r.formats)
      && ["all", "any"].includes(r.tagMatch) && ["any", "yes", "no"].includes(r.favorite)
      && typeof r.name === "string" && typeof r.descendants === "boolean"
      && Number.isFinite(r.minRating) && Number.isFinite(r.maxRating) && r.minRating >= 0 && r.maxRating <= 5 && r.minRating <= r.maxRating
      && Number.isFinite(r.addedDays) && r.addedDays >= 0;
  });
}

/** All categories must match; the tag category can match all or any selected tags. */
export function matchesSmartAlbum(image: ImageEntry, rules: SmartRules, tags: string[] = [], facts?: PictureFacts, now = Date.now()): boolean {
  const normalized = tags.map((tag) => tag.toLocaleLowerCase());
  const tagged = (tag: string) => {
    const key = tag.toLocaleLowerCase();
    return normalized.some((value) => value === key || (rules.descendants && value.startsWith(`${key}/`)));
  };
  if (rules.tags.length && !(rules.tagMatch === "all" ? rules.tags.every(tagged) : rules.tags.some(tagged))) return false;
  if (rules.excludeTags.some(tagged)) return false;
  if (rules.favorite !== "any" && !!facts?.favorite !== (rules.favorite === "yes")) return false;
  const rating = facts?.rating ?? 0;
  if (rating < rules.minRating || rating > rules.maxRating) return false;
  if (rules.name && !image.name.toLocaleLowerCase().includes(rules.name.toLocaleLowerCase())) return false;
  const format = (value: string) => value.toLowerCase().replace(/^jpeg$/, "jpg").replace(/^tiff$/, "tif");
  if (rules.formats.length && !rules.formats.some((value) => format(value) === format(image.extension))) return false;
  if (rules.addedDays) {
    const added = facts?.addedMs ?? image.addedMs ?? image.modifiedMs;
    if (added < now - rules.addedDays * 86400000 || added > now) return false;
  }
  return true;
}

export function smartAlbumView(album: SmartAlbum, images: ImageEntry[], tags: Record<string, string[]>, facts: Record<string, PictureFacts>, now: number): Album {
  let count = 0;
  let cover: ImageEntry | undefined;
  for (const image of images) {
    if (!matchesSmartAlbum(image, album.rules, tags[image.path], facts[image.path], now)) continue;
    count++;
    if (!cover || image.modifiedMs > cover.modifiedMs) cover = image;
  }
  return { ...album, smartRules: album.rules, parentId: "", fullName: album.name, isVirtual: false,
    coverPath: cover?.path ?? "", coverAssetId: "", count, total: count };
}
