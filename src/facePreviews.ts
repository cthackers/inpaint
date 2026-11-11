import type { Operation } from "./editorOperations";

export type FaceOperation = Extract<Operation, { kind: "face" }>;
export type FacePreview = { donor: string; src: string; operation: FaceOperation; release: () => void };
export type FacePreviewSettings = Pick<FaceOperation, "strength" | "colorMatch" | "target">;
export type PreviewProgress = { done: number; total: number; donor: string };

/** The original sits outside the candidate list; either direction enters the list at its nearest end. */
export function adjacentFacePreview(results: readonly Pick<FacePreview, "donor">[], selected: string | null, direction: -1 | 1): string | null {
  if (!results.length) return null;
  const at = results.findIndex((item) => item.donor === selected);
  const next = at < 0 ? (direction < 0 ? results.length - 1 : 0) : (at + direction + results.length) % results.length;
  return results[next].donor;
}

/** Every candidate starts with the exact same pixels and settings, never another candidate. */
export class FacePreviewSet {
  readonly results = new Map<string, FacePreview>();
  readonly errors = new Map<string, string>();
  private stopped = false;
  private disposed = false;
  private running = false;
  private readonly settings: FacePreviewSettings;
  readonly baseline: string;
  private readonly render: (data: string, operation: FaceOperation, lane: number) => Promise<{ src: string; release: () => void }>;

  constructor(baseline: string, settings: FacePreviewSettings,
    render: (data: string, operation: FaceOperation, lane: number) => Promise<{ src: string; release: () => void }>) {
    this.baseline = baseline;
    this.render = render;
    this.settings = structuredClone(settings);
  }

  async generate(donors: string[], changed: (progress: PreviewProgress) => void, concurrency: 1 | 2 = 1) {
    if (this.running || this.disposed) return;
    this.running = true;
    this.stopped = false;
    const unique = [...new Set(donors)];
    let next = 0, done = 0;
    const run = async (lane: number) => {
      while (next < unique.length && !this.stopped && !this.disposed) {
        const donor = unique[next++];
        changed({ done, total: unique.length, donor });
        if (!this.results.has(donor)) {
          const operation: FaceOperation = { kind: "face", label: `Face preview · ${donor.split("/").at(-1)}`, donor, ...this.settings };
          try {
            const result = await this.render(this.baseline, operation, lane);
            if (this.disposed) { result.release(); return; }
            this.results.set(donor, { ...result, donor, operation });
            this.errors.delete(donor);
          } catch (error) {
            if (this.disposed) return;
            this.errors.set(donor, String(error));
          }
        }
        changed({ done: ++done, total: unique.length, donor });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency === 2 ? 2 : 1, unique.length) }, (_, lane) => run(lane)));
    } finally { this.running = false; }
  }

  stop() { this.stopped = true; }
  dispose() {
    this.disposed = true;
    this.stop();
    for (const result of this.results.values()) result.release();
    this.results.clear();
    this.errors.clear();
  }
}
