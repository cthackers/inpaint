import type { Album, Store } from "./types";
import type { DuplicateGroupView, DuplicatePicture, Duplicates } from "./Duplicates";

type Call = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export type DuplicateDeletion = { expected: DuplicatePicture; keepers: DuplicatePicture[] };

/** A late worker snapshot must not put pictures deleted during this search back in the results. */
export function withoutDeletedDuplicates(result: Duplicates, deleted: ReadonlySet<string>): Duplicates {
  if (!deleted.size) return result;
  return { ...result, groups: result.groups.map((group) => ({
    ...group, pictures: group.pictures.filter((picture) => !deleted.has(picture.path)),
  })).filter((group) => group.pictures.length > 1) };
}

/** Remember rejected relationships even if a live group grows or splits later.
 * Subgroups still contain only verified pairs; new relationships remain reviewable.
 */
export function splitIgnoredDuplicateGroups(groups: Duplicates["groups"], ignored: string[]): Duplicates["groups"] {
  if (!ignored.length) return groups;
  const memberships = new Map<string, number[]>();
  ignored.forEach((key, id) => {
    for (const path of key.split("\n")) memberships.set(path, [...(memberships.get(path) ?? []), id]);
  });
  return groups.flatMap((group) => {
    const buckets: { pictures: DuplicatePicture[]; rejected: Set<number> }[] = [];
    for (const picture of group.pictures) {
      const rejected = memberships.get(picture.path) ?? [];
      let bucket = buckets.find((entry) => rejected.every((id) => !entry.rejected.has(id)));
      if (!bucket) { bucket = { pictures: [], rejected: new Set() }; buckets.push(bucket); }
      bucket.pictures.push(picture);
      rejected.forEach((id) => bucket.rejected.add(id));
    }
    return buckets.filter((bucket) => bucket.pictures.length > 1).map(({ pictures }) => ({ ...group, pictures }));
  });
}

function albumName(album: Album, albums: Album[], immich: boolean): string {
  if (immich) return album.fullName || album.name;
  const names = [album.name];
  const visited = new Set([album.id]);
  for (let parent = album.parentId; parent;) {
    const entry = albums.find((candidate) => candidate.id === parent);
    if (!entry || visited.has(entry.id)) throw new Error("Cannot resolve the album hierarchy. Nothing was deleted.");
    visited.add(entry.id);
    names.unshift(entry.name);
    parent = entry.parentId;
  }
  return names.join("/");
}

/** Re-read metadata and propagate every error before allowing any deletion. */
export async function resolveDuplicateSelection(
  store: Store, groups: DuplicateGroupView[], call: Call, stillCurrent: () => boolean,
  remove: (paths: string[], checks: Map<string, DuplicateDeletion>) => Promise<string>,
): Promise<string> {
  const checkCurrent = () => {
    if (!stillCurrent()) throw new Error("The open store changed. Duplicate deletion stopped.");
  };
  checkCurrent();
  const pictures = groups.flatMap((group) => group.members.map((member) => member.compared));
  await call("duplicates_validate", { pictures });
  const [tags, marks, albums] = await Promise.all([
    call<Record<string, string[]>>(store.immich ? "immich_tag_index" : "store_tags", { storeId: store.id, refresh: true }),
    call<Record<string, string[]>>(store.immich ? "immich_album_index" : "store_album_index", { storeId: store.id, refresh: true }),
    call<Album[]>(store.immich ? "immich_albums" : "albums_list", { storeId: store.id }),
  ]);
  checkCurrent();
  const tagsFor = new Map<string, Set<string>>();
  const albumsFor = new Map<string, Set<string>>();
  const checks = new Map<string, DuplicateDeletion>();
  for (const group of groups) {
    const keepers = group.members.filter((member) => member.keep);
    for (const member of group.members.filter((entry) => !entry.keep)) {
      checks.set(member.image.path, { expected: member.compared, keepers: keepers.map((entry) => entry.compared) });
      for (const keeper of keepers) {
        for (const tag of tags[member.image.path] ?? []) {
          if (!tags[keeper.image.path]?.includes(tag)) tagsFor.set(tag, (tagsFor.get(tag) ?? new Set()).add(keeper.image.path));
        }
        for (const name of marks[member.image.path] ?? []) {
          if (!marks[keeper.image.path]?.includes(name)) albumsFor.set(name, (albumsFor.get(name) ?? new Set()).add(keeper.image.path));
        }
      }
    }
  }
  // Resolve all names before making any changes; missing or ambiguous albums must never be skipped.
  const transfers = [...albumsFor].map(([name, paths]) => {
    const matches = albums.filter((album) => !album.isVirtual && albumName(album, albums, store.immich) === name);
    if (matches.length !== 1) throw new Error(`Cannot identify album "${name}". Nothing was deleted.`);
    return { album: matches[0], paths: [...paths] };
  });
  for (const [name, paths] of tagsFor) {
    checkCurrent();
    await call(store.immich ? "immich_tag_paths" : "pictures_tag", { storeId: store.id, paths: [...paths], name, add: true });
  }
  for (const { album, paths } of transfers) {
    checkCurrent();
    await call(store.immich ? "immich_album_pictures_set" : "album_add", { storeId: store.id, albumId: album.id, id: album.id, paths, add: true });
  }
  checkCurrent();
  await call("duplicates_validate", { pictures });
  checkCurrent();
  return remove([...checks.keys()], checks);
}
