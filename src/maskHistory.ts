// Copy only touched tiles before painting. Canvas-to-canvas copies avoid PNG
// encoding/readback on the input thread, and small strokes need little memory.
const TILE = 256;
const HISTORY_BYTES = 128 * 1024 * 1024;
type Tile = { x: number; y: number; width: number; height: number; data: HTMLCanvasElement | null };
export type MaskSnapshot = { dirty: boolean; tiles: Map<string, Tile> };
export const emptySnapshot = (dirty: boolean): MaskSnapshot => ({ dirty, tiles: new Map() });

function copyTile(canvas: HTMLCanvasElement, tile: Omit<Tile, "data">, dirty: boolean): Tile {
  if (!dirty) return { ...tile, data: null };
  const data = document.createElement("canvas");
  data.width = tile.width; data.height = tile.height;
  data.getContext("2d")!.drawImage(canvas, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
  return { ...tile, data };
}

export function captureMaskRegion(snapshot: MaskSnapshot, canvas: HTMLCanvasElement, left: number, top: number, right: number, bottom: number) {
  const endX = Math.min(canvas.width, Math.ceil(right)), endY = Math.min(canvas.height, Math.ceil(bottom));
  for (let y = Math.max(0, Math.floor(top / TILE) * TILE); y < endY; y += TILE) {
    for (let x = Math.max(0, Math.floor(left / TILE) * TILE); x < endX; x += TILE) {
      const key = `${x},${y}`;
      if (!snapshot.tiles.has(key)) snapshot.tiles.set(key, copyTile(canvas, {
        x, y, width: Math.min(TILE, canvas.width - x), height: Math.min(TILE, canvas.height - y),
      }, snapshot.dirty));
    }
  }
}

export function snapshotMask(canvas: HTMLCanvasElement | null, dirty: boolean, region?: MaskSnapshot): MaskSnapshot {
  const snapshot = emptySnapshot(dirty);
  if (!canvas) return snapshot;
  if (region) {
    for (const [key, tile] of region.tiles) snapshot.tiles.set(key, copyTile(canvas, tile, dirty));
  } else {
    // Bulk mask operations replace the whole surface, so their undo does too.
    snapshot.tiles.set("full", copyTile(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, dirty));
  }
  return snapshot;
}

export function applyMaskSnapshot(canvas: HTMLCanvasElement, snapshot: MaskSnapshot) {
  const context = canvas.getContext("2d")!;
  for (const tile of snapshot.tiles.values()) {
    context.clearRect(tile.x, tile.y, tile.width, tile.height);
    if (tile.data) context.drawImage(tile.data, tile.x, tile.y);
  }
}

export function appendMaskHistory(items: MaskSnapshot[], snapshot: MaskSnapshot) {
  const next = [...items, snapshot];
  let bytes = 0;
  for (let i = next.length - 1; i >= 0; i--) {
    for (const tile of next[i].tiles.values()) if (tile.data) bytes += tile.width * tile.height * 4;
    // Retain at least one undo even for a very large bulk selection.
    if (i < next.length - 1 && (bytes > HISTORY_BYTES || next.length - i > 60)) return next.slice(i + 1);
  }
  return next;
}
