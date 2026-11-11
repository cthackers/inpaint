/** A stable random rank per file: metadata refreshes and filtering must not reshuffle the gallery. */
function rank(path: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < path.length; index++) {
    hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function randomOrder<T extends { path: string }>(images: readonly T[], seed: number): T[] {
  return images.map((image) => ({ image, rank: rank(image.path, seed) }))
    .sort((a, b) => a.rank - b.rank || (a.image.path < b.image.path ? -1 : a.image.path > b.image.path ? 1 : 0))
    .map(({ image }) => image);
}

export function nextShuffleSeed(previous: number): number {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  return seed === previous ? (previous + 1) >>> 0 : seed;
}
