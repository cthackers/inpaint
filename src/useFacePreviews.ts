import { useCallback, useEffect, useRef, useState } from "react";
import { imageAction } from "./editorOperations";
import { adjacentFacePreview, FacePreviewSet, type FacePreview, type FacePreviewSettings, type PreviewProgress } from "./facePreviews";

export function useFacePreviews() {
  const session = useRef<FacePreviewSet | null>(null);
  const running = useRef(false);
  const autoSelect = useRef(false);
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FacePreview[]>([]);
  const [errors, setErrors] = useState<[string, string][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<PreviewProgress | null>(null);
  const discard = useCallback(() => {
    session.current?.dispose(); session.current = null;
    setActive(false); setResults([]); setErrors([]); setSelected(null); setProgress(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; session.current?.dispose(); session.current = null; };
  }, []);

  const start = async (baseline: string, settings: FacePreviewSettings, donors: string[], concurrency: 1 | 2 = 1) => {
    if (running.current || !baseline || !donors.length) return;
    running.current = true;
    stopRequested.current = false;
    setBusy(true); setActive(true);
    setProgress({ done: 0, total: new Set(donors).size, donor: donors[0] });
    if (!session.current) {
      session.current = new FacePreviewSet(baseline, settings, async (data, operation, lane) => {
        const result = await imageAction("face_preview", data, { ...operation, previewWorker: lane });
        if (!result.imageData) throw new Error("No replacement image was returned.");
        // Keep compressed image blobs instead of retaining both raw/restored base64 copies per face.
        const blob = await (await fetch(result.imageData)).blob();
        const src = URL.createObjectURL(blob);
        return { src, release: () => URL.revokeObjectURL(src) };
      });
    }
    const current = session.current;
    autoSelect.current = donors.length === 1 || current.results.size === 0;
    if (donors.length === 1) setSelected(current.results.has(donors[0]) ? donors[0] : null);
    const parallel = concurrency === 2 && new Set(donors).size > 1;
    try {
      // Complete first-use downloads in one process before starting the second worker.
      if (parallel) await imageAction("prepare_face_previews");
      if (session.current !== current || stopRequested.current) return;
      await current.generate(donors, (next) => {
        if (!mounted.current || session.current !== current) return;
        setProgress(next); setResults([...current.results.values()]); setErrors([...current.errors]);
        if (next.done && current.results.has(next.donor) && autoSelect.current) {
          autoSelect.current = false;
          setSelected(next.donor);
        }
      }, parallel ? 2 : 1);
    } catch (error) {
      if (mounted.current && session.current === current) setErrors([["Preview generation", String(error)]]);
    } finally {
      // The temporary worker owns a separate set of GPU models; release it when this batch drains.
      if (parallel) {
        try { await imageAction("release_face_previews"); }
        catch (error) { if (mounted.current && session.current === current) setErrors((previous) => [...previous, ["Preview cleanup", String(error)]]); }
      }
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { active, busy, results, errors, progress, selected, select: (donor: string | null) => { autoSelect.current = false; setSelected(donor); }, start, discard,
    move: (direction: -1 | 1) => { autoSelect.current = false; setSelected((current) => adjacentFacePreview(results, current, direction)); },
    stop: () => { stopRequested.current = true; session.current?.stop(); }, candidate: results.find((item) => item.donor === selected) };
}

export async function previewData(src: string): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("Cannot read the selected preview.");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Cannot read the selected preview."));
    reader.readAsDataURL(blob);
  });
}
