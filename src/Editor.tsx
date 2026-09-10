import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft, ArrowRight, Brush, Check, Eraser, LoaderCircle,
  ChevronDown, Eye, EyeOff, FlipHorizontal, FlipVertical, ImageOff, Maximize2, Play, Redo2, RotateCcw, RotateCw,
  Save, Scan, ScanFace, Sparkles, Tags, Trash2, Undo2, UserRound, X, ZoomIn, ZoomOut, Crop, History, Layers, Download, SlidersHorizontal,
} from "lucide-react";
import type { ImageEntry, Store } from "./types";
import ImmichPanel from "./ImmichPanel";
import Workspace, { type WorkspaceTab } from "./Workspace";
import { useEditHistory, type HistoryEntry } from "./useEditHistory";
import { adjustImage, neutralAdjustments, loadImage, blendImages, executeOperation, imageAction, type FaceBox, type Operation, type Rect } from "./editorOperations";
import AdvancedTools, { BackgroundEdgeTools, type BrushTool, type BrushSettings, type Edges, type Extension } from "./AdvancedTools";
import { INPAINT_MODELS, type InpaintModel } from "./models";
import FaceLibrary from "./FaceLibrary";
import { FACE_LIBRARY_PREFERENCE, usePreference, useSavedChoice } from "./preferences";
import ToolSection from "./ToolSection";
import { useCanvasView } from "./useCanvasView";
import { appendMaskHistory, applyMaskSnapshot, captureMaskRegion, emptySnapshot, snapshotMask, type MaskSnapshot } from "./maskHistory";
import { storage } from "./storage";

type EditorProps = {
  image: ImageEntry;
  index: number;
  total: number;
  brushSize: number;
  onBrushSizeChange: Dispatch<SetStateAction<number>>;
  faceSwapSource: FaceSwapSource | null;
  onFaceSwapSourceChange: (source: FaceSwapSource) => void;
  onFaceSwapSourceClear: () => void;
  onExit: () => void;
  onNavigate: (offset: number) => void;
  /** Image data to edit instead of reading image.path; an empty path makes Save ask where to save. */
  initialData?: string;
  /** Another picture is waiting to open; the editor settles unsaved changes, then calls onReplace. */
  replaceRequested?: boolean;
  onReplace?: () => void;
  onReplaceCancel?: () => void;
  /** Called with the path of every successful save. */
  onSaved?: (path: string) => void;
  /** Called after the picture was deleted. */
  onDeleted?: (path: string) => void;
  /** Image stores marked Immich compatible; their pictures get the Immich panel. */
  immichStores?: Store[];
};

export type FaceSwapSource = { path: string; data: string };

type Point = { x: number; y: number };
type PendingLeave = { kind: "exit" } | { kind: "navigate"; offset: number } | { kind: "replace" };

const IMAGE_TRANSFORMS = [
  { id: "flip-horizontal", label: "Flip horizontally", icon: FlipHorizontal },
  { id: "flip-vertical", label: "Flip vertically", icon: FlipVertical },
  { id: "rotate-left", label: "Rotate left 90°", icon: RotateCcw },
  { id: "rotate-right", label: "Rotate right 90°", icon: RotateCw },
] as const;
const UPSCALE_OPTIONS = [
  { id: "hat-sharper", plugin: "hat", name: "Real-HAT · Sharper", description: "Sharper AI reconstruction. Slower than RealESRGAN." },
  { id: "RealESRGAN_x4plus", plugin: "realesrgan", name: "RealESRGAN x4+ · Photos", description: "General-purpose photo restoration and upscaling." },
  { id: "realesr-general-x4v3", plugin: "realesrgan", name: "RealESRGAN General v3", description: "Lower denoising keeps more texture and grain." },
  { id: "RealESRGAN_x4plus_anime_6B", plugin: "realesrgan", name: "RealESRGAN Anime 6B", description: "For illustrations and anime." },
  { id: "lanczos", plugin: "lanczos", name: "Lanczos · No AI", description: "Standard resizing without AI reconstruction. No model needed." },
] as const;

// download: the weights a mode fetches on first use.
const RESTORE_OPTIONS = [
  { id: "compressed", name: "Compressed or soft photo", description: "Removes JPEG blocks, then adds detail with Real-ESRGAN. Best for pictures saved from the web.", download: "about 355 MB" },
  { id: "natural", name: "Natural detail", description: "Removes JPEG blocks, then adds finer, more natural detail with Real-HAT. Slower.", download: "about 290 MB, plus 170 MB for Real-HAT unless the upscaler already has it," },
  { id: "jpeg", name: "JPEG artifacts only", description: "Removes compression blocks and ringing without sharpening.", download: "about 290 MB" },
  { id: "noise", name: "Photo noise", description: "Removes grain and color noise from camera photos with SCUNet.", download: "about 70 MB" },
  { id: "motion", name: "Motion blur", description: "Reduces blur from camera shake or movement with Restormer.", download: "about 100 MB" },
] as const;

export default function Editor({ image, index, total, brushSize, onBrushSizeChange, faceSwapSource, onFaceSwapSourceChange, onFaceSwapSourceClear, onExit, onNavigate, initialData, replaceRequested, onReplace, onReplaceCancel, onSaved, onDeleted, immichStores }: EditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const panning = useRef(false);
  const lastPoint = useRef<Point | null>(null);
  const lastPointer = useRef<Point | null>(null);
  const spaceDown = useRef(false);
  const spaceUsedForPan = useRef(false);
  const autoApplyStroke = useRef(false);
  const stageReadyFrame = useRef<number | null>(null);
  const leaveResolving = useRef(false);

  const history = useEditHistory();
  const imageData = history.data;
  const dirty = history.dirty;
  const [originalImageData, setOriginalImageData] = useState("");
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [maskDirty, commitMaskDirty] = useState(false);
  const maskDirtyRef = useRef(false);
  const setMaskDirty = useCallback((value: boolean) => { maskDirtyRef.current = value; commitMaskDirty(value); }, []);
  const strokeSnapshot = useRef<MaskSnapshot | null>(null);
  const brushStamp = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const [maskUndo, setMaskUndo] = useState<MaskSnapshot[]>([]);
  const [maskRedo, setMaskRedo] = useState<MaskSnapshot[]>([]);
  const [operationWorking, setWorking] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [adjustmentActive, setAdjustmentActive] = useState(false);
  const working = operationWorking || previewBusy || adjustmentActive;
  const [saving, setSaving] = useState(false);
  const [choosingFace, setChoosingFace] = useState(false);
  const [message, setMessage] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [model, setModel] = useState<InpaintModel>(() => {
    const saved = storage.getItem("inpaint.model");
    return INPAINT_MODELS.find((option) => option.id === saved) ?? INPAINT_MODELS[0];
  });
  const [prompt, setPrompt] = usePreference("inpaint.prompt", "");
  const [stageReady, setStageReady] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [restoreMode, setRestoreMode] = useSavedChoice<string>("inpaint.restoreMode", RESTORE_OPTIONS.map((option) => option.id));
  const [restoreStrength, setRestoreStrength] = useSavedChoice<number>("inpaint.restoreStrength", [100, ...Array.from({ length: 21 }, (_, i) => i * 5)]);
  const selectedRestore = RESTORE_OPTIONS.find((option) => option.id === restoreMode)!;
  const [upscaleModel, setUpscaleModel] = useSavedChoice<string>("inpaint.upscaleModel", UPSCALE_OPTIONS.map((option) => option.id));
  const [upscaleScale, setUpscaleScale] = useSavedChoice<number>("inpaint.upscaleScale", [2, 3, 4]);
  const [upscaleDenoise, setUpscaleDenoise] = useSavedChoice<number>("inpaint.upscaleDenoise", [25, ...Array.from({ length: 21 }, (_, index) => index * 5)]);
  const selectedUpscaler = UPSCALE_OPTIONS.find((option) => option.id === upscaleModel)!;
  const [backgroundModel, setBackgroundModel] = useSavedChoice<string>("inpaint.backgroundModel", [
    "briaai/RMBG-1.4", "u2net", "u2net_human_seg", "briaai/RMBG-2.0",
  ]);
  const [hfToken, setHfToken] = useState("");
  const [hfTokenSaved, setHfTokenSaved] = useState(false);
  const [hfAccessOpen, setHfAccessOpen] = useState(false);
  const [hfTokenBusy, setHfTokenBusy] = useState(false);
  const [confirmTokenRemoval, setConfirmTokenRemoval] = useState(false);
  useEffect(() => {
    void invoke<boolean>("hf_token_status").then((saved) => { setHfTokenSaved(saved); }).catch(() => {});
  }, []);

  const saveHfToken = async (remove = false) => {
    if (hfTokenBusy || working || saving) return;
    setHfTokenBusy(true);
    try {
      await invoke("save_hf_token", { token: remove ? "" : hfToken });
      setHfToken(""); setHfTokenSaved(!remove); setHfAccessOpen(false); setConfirmTokenRemoval(false);
      setMessage(remove ? "Saved access token removed." : "Token saved. You can retry BRIA 2.0 now.");
    } catch (error) { setMessage(`Token update failed: ${String(error)}`); }
    finally { setHfTokenBusy(false); }
  };

  const [workspaceOpen, setWorkspaceOpen] = usePreference("inpaint.workspaceOpen", false);
  const [workspaceTab, setWorkspaceTab] = useSavedChoice<WorkspaceTab>("inpaint.workspaceTab", ["history", "workflows", "batch", "export", "memory"]);
  const [compare, setCompare] = useState(false);
  const [divider, setDivider] = usePreference("inpaint.divider", 50, (value) => value >= 0 && value <= 100);
  const [compareWith, setCompareWith] = useSavedChoice<string>("inpaint.compareWith", ["previous", "original"]);
  const [restorationStrength, setRestorationStrength] = useSavedChoice<number>("inpaint.restorationStrength", [100, ...Array.from({ length: 101 }, (_, i) => i)]);
  const [restorationPreview, setRestorationPreview] = useState<{ raw: string; restored: string; operation: Operation; position: number } | null>(null);
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [selectingFace, setSelectingFace] = useState(false);
  const [selectedFace, setSelectedFace] = useState<FaceBox | null>(null);
  const [assignments, setAssignments] = useState<Record<number, FaceSwapSource>>({});
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<Rect>([0, 0, 1, 1]);
  const [cropRatio, setCropRatio] = useSavedChoice<number>("inpaint.cropRatio", [0, 1, 4/3, 3/2, 16/9, 3/4, 2/3, 9/16]);
  const [cropAngle, setCropAngle] = useState(0);
  const cropStart = useRef<Point | null>(null);
  const [backgroundType, setBackgroundType] = useSavedChoice<"color" | "image" | "blur">("inpaint.backgroundType", ["color", "image", "blur"]);
  const [backgroundColor, setBackgroundColor] = usePreference("inpaint.backgroundColor", "#ffffff");
  const [backgroundPath, setBackgroundPath] = usePreference("inpaint.backgroundPath", "");
  const [backgroundBlur, setBackgroundBlur] = usePreference("inpaint.backgroundBlur", 20);
  const [removeFirst, setRemoveFirst] = usePreference("inpaint.removeFirst", true);
  const [brushTool, setBrushTool] = useSavedChoice<BrushTool>("inpaint.brushTool", ["paint", "erase", "smart", "clone", "heal"]);
  const [brushSettings, setBrushSettings] = usePreference<BrushSettings>("inpaint.brushSettings", { hardness: 80, opacity: 100, feather: 2, grow: 0 });
  const [smartPoints, setSmartPoints] = useState<number[][]>([]);
  const [cloneSource, setCloneSource] = useState<[number, number] | null>(null);
  const retouchStroke = useRef<number[][]>([]);
  const [adjustments, setAdjustments] = usePreference("inpaint.adjustments", { ...neutralAdjustments });
  const [colorPreview, setColorPreview] = useState("");
  const [edges, setEdges] = usePreference<Edges>("inpaint.edges", { shrink: 1, soften: .5, decontaminate: .5 });
  const [extension, setExtension] = usePreference<Extension>("inpaint.extension", { left: 128, right: 128, top: 0, bottom: 0, model: "sdxl", prompt: "" });
  const [faceColorMatch, setFaceColorMatch] = useSavedChoice<number>("inpaint.faceColorMatch", [0, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 5)]);
  const activeFaceSource = selectedFace ? assignments[selectedFace.id] ?? faceSwapSource : faceSwapSource;
  const [faceLibrary, setFaceLibrary] = usePreference<string[]>(FACE_LIBRARY_PREFERENCE, [], (paths) => paths.every((path) => typeof path === "string"));
  // Every face photo chosen joins the saved faces, newest first.
  useEffect(() => {
    const path = faceSwapSource?.path;
    if (path) setFaceLibrary((saved) => (saved.includes(path) ? saved : [path, ...saved]));
  }, [faceSwapSource?.path]);
  const [deleting, setDeleting] = useState(false);
  const [immichOpen, setImmichOpen] = usePreference("inpaint.immichPanel", true);
  const { stageRef, cursorRef, zoomLabelRef, zoomValueRef, panRef, zoomRef, zoom, setPan, setZoom, getViewportBounds, moveCursor, hideCursor } = useCanvasView(
    viewportRef, fitScale, brushSize, !!imageData && !working && !showOriginal && !compare && !cropMode && !selectingFace,
  );
  const scale = fitScale * zoom;

  const clearMask = useCallback(() => {
    const canvas = maskRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setMaskDirty(false);
  }, []);

  useEffect(() => {
    let active = true;
    history.reset("");
    setOriginalImageData("");
    setMessage("");

    setMaskUndo([]);
    setMaskRedo([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    zoomRef.current = 1;
    setStageReady(false);
    setShowOriginal(false);
    setPendingLeave(null);
    (initialData ? Promise.resolve(initialData) : invoke<string>("read_image_data", { path: image.path }))
      .then((data) => {
        if (!active) return;
        history.reset(data);
        setOriginalImageData(data);
      })
      .catch((error) => active && setMessage(String(error)));
    return () => { active = false; };
  }, [image.path, initialData]);

  useEffect(() => () => {
    if (stageReadyFrame.current !== null) cancelAnimationFrame(stageReadyFrame.current);
  }, []);

  const updateFit = useCallback((width: number, height: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const availableWidth = Math.max(100, viewport.clientWidth - 72);
    const availableHeight = Math.max(100, viewport.clientHeight - 72);
    setFitScale(Math.min(availableWidth / width, availableHeight / height, 1));
  }, []);

  useEffect(() => {
    const onResize = () => updateFit(dimensions.width, dimensions.height);
    const observer = new ResizeObserver(onResize);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [dimensions, updateFit]);

  const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    setDimensions({ width, height });
    const canvas = maskRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.clearRect(0, 0, width, height);
    }
    setMaskDirty(false);
    updateFit(width, height);
    if (!stageReady) {
      // Wait until the fitted dimensions have painted before enabling transform
      // transitions; otherwise the first layout animates in from the raw size.
      stageReadyFrame.current = requestAnimationFrame(() => {
        stageReadyFrame.current = requestAnimationFrame(() => {
          setStageReady(true);
          stageReadyFrame.current = null;
        });
      });
    }
  };

  const maskSnapshot = (region?: MaskSnapshot) => snapshotMask(maskRef.current, maskDirtyRef.current, region);
  const pushMaskUndo = () => {
    const snapshot = maskSnapshot();
    setMaskUndo((items) => appendMaskHistory(items, snapshot)); setMaskRedo([]);
  };
  const restoreMask = useCallback((snapshot: MaskSnapshot) => {
    if (maskRef.current) applyMaskSnapshot(maskRef.current, snapshot);
    setMaskDirty(snapshot.dirty);
  }, [setMaskDirty]);

  const resetEditTools = useCallback(() => {
    clearMask(); setMaskUndo([]); setMaskRedo([]);
    setRestorationPreview(null); setFaces([]); setSelectedFace(null); setAssignments({});
    setSelectingFace(false); setCropMode(false); setCropRect([0, 0, 1, 1]); setCropAngle(0);
    setShowOriginal(false);
    setSmartPoints([]); setCloneSource(null); setColorPreview(""); setAdjustmentActive(false);
  }, [clearMask]);

  const commitEdit = (data: string, label: string, operation?: Operation) => {
    resetEditTools(); history.commit(data, label, operation);
  };
  const jumpHistory = useCallback((position: number) => {
    if (working || saving) return;
    resetEditTools(); history.jump(position);
  }, [working, saving, resetEditTools, history.jump]);
  const undo = useCallback(() => {
    if (working || saving) return;
    if (maskUndo.length) {
      const previous = maskUndo.at(-1)!;
      setMaskUndo((items) => items.slice(0, -1));
      const inverse = maskSnapshot(previous);
      setMaskRedo((items) => appendMaskHistory(items, inverse)); restoreMask(previous);
    } else if (history.canUndo) jumpHistory(history.position - 1);
  }, [history.canUndo, history.position, jumpHistory, maskUndo, restoreMask, saving, working]);
  const redo = useCallback(() => {
    if (working || saving) return;
    if (maskRedo.length) {
      const next = maskRedo.at(-1)!;
      setMaskRedo((items) => items.slice(0, -1));
      const inverse = maskSnapshot(next);
      setMaskUndo((items) => appendMaskHistory(items, inverse)); restoreMask(next);
    } else if (history.canRedo) jumpHistory(history.position + 1);
  }, [history.canRedo, history.position, jumpHistory, maskRedo, restoreMask, saving, working]);

  useEffect(() => {
    if (!restorationPreview || restorationPreview.position !== history.position) return;
    let cancelled = false;
    setPreviewBusy(true);
    const timeout = window.setTimeout(() => {
      void blendImages(restorationPreview.raw, restorationPreview.restored, restorationStrength / 100)
        .then((result) => {
          if (cancelled) return;
          const operation = { ...restorationPreview.operation, strength: restorationStrength / 100 };
          history.revise(result, `${operation.label} · ${restorationStrength}% restoration`, operation);
        })
        .catch((error) => { if (!cancelled) setMessage(`Preview failed: ${String(error)}`); })
        .finally(() => { if (!cancelled) setPreviewBusy(false); });
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [restorationStrength, restorationPreview, history.position, history.revise]);

  useEffect(() => {
    if (!adjustmentActive) return;
    let active = true;
    const timer = setTimeout(() => { void adjustImage(imageData, adjustments, 1600).then((result) => { if (active) setColorPreview(result); }).catch((error) => { if (active) setMessage(String(error)); }); }, 70);
    return () => { active = false; clearTimeout(timer); };
  }, [adjustmentActive, adjustments, imageData]);

  // Pictures that did not come from disk, and GIF, BMP or TIFF pictures that Save cannot write,
  // have no path until the first Save chooses one.
  const writable = /^(png|jpe?g|webp)$/.test(image.extension);
  const [savePath, setSavePath] = useState(writable ? image.path : "");
  const displayName = savePath ? savePath.split("/").at(-1) ?? image.name : image.name;
  const save = useCallback(async (): Promise<boolean> => {
    if (!imageData || saving || working) return false;
    let path = savePath;
    if (!path) {
      try {
        const suggested = (image.path || image.name).replace(/\.(gif|bmp|tiff?)$/i, ".png");
        const chosen = await saveDialog({ title: "Save image", defaultPath: suggested, filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] });
        if (!chosen) return false;
        const extension = /^(png|jpe?g|webp)$/.test(image.extension) ? image.extension : "png";
        path = /\.(png|jpe?g|webp)$/i.test(chosen) ? chosen : `${chosen}.${extension}`;
      } catch (error) {
        setMessage(`Save failed: ${String(error)}`);
        return false;
      }
    }
    setSaving(true);
    setMessage("Saving…");
    try {
      // Pictures of Immich-compatible image stores come back with a note about Immich.
      const note = await invoke<string | null>("save_image", { path, imageData });
      setSavePath(path);
      history.markSaved();
      onSaved?.(path);
      setMessage(note ? `Saved. ${note}` : "Saved");
      window.setTimeout(() => setMessage(""), note ? 6000 : 1600);
      return true;
    } catch (error) {
      setMessage(`Save failed: ${String(error)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [image.name, image.path, image.extension, savePath, imageData, saving, working, onSaved]);

  const getBinaryMask = () => {
    const source = maskRef.current!;
    const output = document.createElement("canvas");
    output.width = source.width;
    output.height = source.height;
    const context = output.getContext("2d")!;
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, output.width, output.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const selected = Math.min(255, Math.round(pixels.data[offset + 3] / .48));
      pixels.data[offset] = selected;
      pixels.data[offset + 1] = selected;
      pixels.data[offset + 2] = selected;
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return output.toDataURL("image/png");
  };

  const applyInpaint = async (force = false) => {
    if ((!maskDirty && !force) || working || saving || !imageData || cropMode || selectingFace || compare || showOriginal) return;
    setWorking(true);
    try {
      const loadedModels = await invoke<string[]>("loaded_models");
      setMessage(loadedModels.includes(model.id)
        ? `Removing selection with ${model.name}…`
        : `Loading ${model.name}…`);
      const result = await invoke<string>("run_inpaint", {
        imageData,
        maskData: getBinaryMask(),
        model: model.id,
        prompt,
      });
      commitEdit(result, `Inpaint · ${model.name}`);
      setMessage(`Object removed with ${model.name}`);
      window.setTimeout(() => setMessage(""), 1600);
    } catch (error) {
      setMessage(`Inpaint failed: ${String(error)}`);
    } finally {
      setWorking(false);
    }
  };

  const safeExit = useCallback(() => {
    if (working || saving) return;
    if (dirty) setPendingLeave({ kind: "exit" });
    else onExit();
  }, [dirty, onExit, saving, working]);

  const safeNavigate = useCallback((offset: number) => {
    if (offset === 0 || working || saving) return;
    if (dirty) setPendingLeave({ kind: "navigate", offset });
    else onNavigate(offset);
  }, [dirty, onNavigate, saving, working]);

  const replaceHandled = useRef(false);
  useEffect(() => {
    if (!replaceRequested) { replaceHandled.current = false; return; }
    if (replaceHandled.current || working || saving || pendingLeave) return;
    replaceHandled.current = true;
    if (dirty) setPendingLeave({ kind: "replace" });
    else onReplace?.();
  }, [replaceRequested, working, saving, pendingLeave, dirty, onReplace]);

  const finishPendingLeave = useCallback((pending: PendingLeave) => {
    if (pending.kind === "exit") onExit();
    else if (pending.kind === "replace") onReplace?.();
    else onNavigate(pending.offset);
  }, [onExit, onNavigate, onReplace]);

  const resolvePendingLeave = useCallback(async (saveChanges: boolean) => {
    if (!pendingLeave || leaveResolving.current) return;
    leaveResolving.current = true;
    if (saveChanges && !await save()) {
      leaveResolving.current = false;
      return;
    }
    const action = pendingLeave;
    setPendingLeave(null);
    leaveResolving.current = false;
    finishPendingLeave(action);
  }, [finishPendingLeave, pendingLeave, save]);

  const chooseFacePhoto = async () => {
    if (working || saving || choosingFace) return;
    setChoosingFace(true);
    try {
      const selected = await open({
        title: "Select face source photo",
        multiple: false,
        directory: false,
        defaultPath: activeFaceSource?.path,
        filters: [{ name: "Photos", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof selected !== "string") return;
      const data = await invoke<string>("read_image_data", { path: selected });
      const source = { path: selected, data };
      onFaceSwapSourceChange(source);
      if (selectedFace) setAssignments((old) => ({ ...old, [selectedFace.id]: source }));
    } catch (error) {
      setMessage(`Photo selection failed: ${String(error)}`);
    } finally {
      setChoosingFace(false);
    }
  };

  // Clears the photo shown in the picker: the selected face's own source, otherwise the shared one.
  const clearFacePhoto = () => {
    if (selectedFace && assignments[selectedFace.id]) {
      setAssignments((old) => Object.fromEntries(Object.entries(old).filter(([id]) => Number(id) !== selectedFace.id)));
    } else {
      onFaceSwapSourceClear();
    }
  };

  // A saved face becomes the face source, and the selected face's source when one is selected.
  const chooseSavedFace = (path: string, preview: string) => {
    const source = { path, data: preview };
    onFaceSwapSourceChange(source);
    if (selectedFace) setAssignments((old) => ({ ...old, [selectedFace.id]: source }));
  };

  const removeSavedFace = (path: string) => {
    setFaceLibrary((saved) => saved.filter((item) => item !== path));
    setAssignments((old) => Object.fromEntries(Object.entries(old).filter(([, source]) => source.path !== path)));
    if (faceSwapSource?.path === path) onFaceSwapSourceClear();
  };

  const addFacePhotos = async () => {
    try {
      const selected = await open({ title: "Add face photos", multiple: true, directory: false, filters: [{ name: "Photos", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
      if (paths.length) setFaceLibrary((saved) => [...paths.filter((path) => !saved.includes(path)), ...saved]);
    } catch (error) {
      setMessage(`Photo selection failed: ${String(error)}`);
    }
  };

  const deletePicture = async () => {
    if (!image.path || working || saving || deleting) return;
    const name = image.path.split("/").at(-1) ?? image.path;
    const unsaved = dirty ? " Your unsaved edits are lost too." : "";
    if (!await confirm(`Delete ${name}? It goes to the trash, or to Immich's trash in an Immich-compatible store.${unsaved}`, { title: "Delete picture", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" })) return;
    setDeleting(true);
    setMessage("Deleting…");
    try {
      const result = await invoke<{ deleted: boolean; message: string }>("delete_image", { path: image.path, permanent: false });
      if (!result.deleted) {
        const permanently = await confirm(`${result.message} Delete ${name} permanently instead? This cannot be undone.`, { title: "Delete permanently", kind: "warning", okLabel: "Delete permanently", cancelLabel: "Keep it" });
        if (!permanently) { setMessage(""); return; }
        await invoke("delete_image", { path: image.path, permanent: true });
      }
      onDeleted?.(image.path);
    } catch (error) {
      setMessage(`Delete failed: ${String(error)}`);
    } finally {
      setDeleting(false);
    }
  };

  const performOperation = async (operation: Operation) => {
    if (working || saving || !imageData) return;
    setWorking(true); setShowOriginal(false);
    setMessage(`Running ${operation.label}…`);
    try {
      if (operation.kind === "face" || (operation.kind === "plugin" && operation.plugin === "gfpgan")) {
        let raw = imageData, restored: string;
        if (operation.kind === "face") {
          const result = await imageAction("face_preview", imageData, { ...operation, strength: 1 });
          raw = result.rawData; restored = result.imageData;
        } else {
          restored = await executeOperation(imageData, { ...operation, strength: 1 }, originalImageData);
        }
        const result = await blendImages(raw, restored, restorationStrength / 100);
        const nextPosition = history.position + 1;
        const previousFaces = faces, previousSelection = selectedFace, previousAssignments = assignments;
        commitEdit(result, `${operation.label} · ${restorationStrength}% restoration`, operation);
        // Face coordinates remain valid after replacement, allowing separate donors per face.
        if (operation.kind === "face") { setFaces(previousFaces); setSelectedFace(previousSelection); setAssignments(previousAssignments); }
        setRestorationPreview({ raw, restored, operation, position: nextPosition });
      } else {
        commitEdit(await executeOperation(imageData, operation, originalImageData), operation.label, operation);
      }
      setMessage(`${operation.label} complete.`);
    } catch (error) { setMessage(`${operation.label} failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  // Replaces the selected face, or the largest one, with the face in the photo at `donor`.
  const replaceFace = async (donor: string) => {
    const box = selectedFace?.box;
    await performOperation({ kind: "face", label: "Face replacement", donor,
      strength: restorationStrength / 100, colorMatch: faceColorMatch / 100, target: box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : undefined });
  };

  const runImagePlugin = async (plugin: "gfpgan" | "realesrgan" | "remove_bg" | "face_swap" | "hat" | "lanczos", option: string, pluginScale: number, label: string) => {
    if (plugin === "face_swap") {
      if (!activeFaceSource || choosingFace) return;
      await replaceFace(activeFaceSource.path);
    } else {
      await performOperation({ kind: "plugin", plugin, option, scale: pluginScale, label, denoise: upscaleDenoise / 100, strength: restorationStrength / 100 });
    }
  };

  const detectFaces = async () => {
    if (working || saving || !imageData) return;
    setWorking(true); setMessage("Detecting faces…"); setCropMode(false); setCompare(false); setShowOriginal(false);
    try {
      const result = await imageAction("detect_faces", imageData);
      setFaces(result.faces); setSelectedFace(null); setAssignments({}); setSelectingFace(true);
      setMessage(result.faces.length ? "Click a face to select it, then choose its source photo." : "No faces found in this picture.");
    } catch (error) { setMessage(`Face detection failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const runWorkflow = async (steps: Operation[], label: string) => {
    if (working || saving || !imageData) return;
    setWorking(true);
    const results: HistoryEntry[] = [];
    let current = imageData;
    try {
      for (let i = 0; i < steps.length; i++) {
        setMessage(`${label} · ${i + 1}/${steps.length}: ${steps[i].label}…`);
        current = await executeOperation(current, steps[i], originalImageData);
        results.push({ data: current, label: steps[i].label, operation: steps[i] });
      }
      resetEditTools(); history.commitMany(results);
      setMessage(`${label} complete.`);
    } catch (error) { setMessage(`${label} failed: ${String(error)}. The image was not changed.`); }
    finally { setWorking(false); }
  };

  const backgroundOperation: Operation = { kind: "background", label: `Background · ${backgroundType}`, mode: backgroundType,
    color: backgroundColor, path: backgroundPath, blur: backgroundBlur, removeFirst, model: backgroundModel };
  const restoreOperation: Operation = { kind: "plugin", plugin: "restore", option: restoreMode,
    scale: 1, denoise: 0, strength: restoreStrength / 100, label: `Restore detail · ${selectedRestore.name} · ${restoreStrength}%` };
  const suggestions: Operation[] = [
    restoreOperation,
    { kind: "adjust", label: "Color and lighting", values: adjustments },
    { kind: "refine_edges", label: "Refine background edges", ...edges },
    { kind: "outpaint", label: "Extend canvas", ...extension },
    { kind: "plugin", plugin: "gfpgan", option: "gfpgan", scale: 1, denoise: 0.25, strength: restorationStrength / 100, label: `GFPGAN · ${restorationStrength}%` },
    { kind: "plugin", plugin: selectedUpscaler.plugin, option: upscaleModel, scale: upscaleScale, denoise: upscaleDenoise / 100, label: `${selectedUpscaler.name} · ${upscaleScale}×` },
    { kind: "plugin", plugin: "remove_bg", option: backgroundModel, scale: 1, denoise: 0.25, label: `Remove background · ${backgroundModel}` },
    backgroundOperation,
    ...IMAGE_TRANSFORMS.map(({ id, label }) => ({ kind: "transform" as const, direction: id, label })),
    { kind: "crop", label: "Crop and straighten", rect: cropRect, angle: cropAngle },
  ];
  if (faceSwapSource) suggestions.unshift({ kind: "face", label: `Face replace · ${restorationStrength}% restoration`, donor: faceSwapSource.path, strength: restorationStrength / 100, colorMatch: faceColorMatch / 100 });

  const applyColorAdjustments = async () => {
    if (operationWorking) return;
    setWorking(true);
    try {
      const operation: Operation = { kind: "adjust", label: "Color and lighting", values: adjustments };
      commitEdit(await executeOperation(imageData, operation, originalImageData), operation.label, operation);
      setMessage("Color adjustments applied.");
    } catch (error) { setMessage(`Adjustments failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const displaySelection = async (data: string) => {
    const source = await loadImage(data);
    const canvas = maskRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    let selected = false;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const value = pixels.data[i]; selected ||= value > 0;
      pixels.data[i] = 255; pixels.data[i + 1] = 73; pixels.data[i + 2] = 54; pixels.data[i + 3] = Math.round(value * .48);
    }
    context.putImageData(pixels, 0, 0); setMaskDirty(selected);
  };

  const smartSelect = async (point: Point, exclude: boolean) => {
    setWorking(true); setMessage("Selecting object…");
    const points = [...smartPoints, [point.x / dimensions.width, point.y / dimensions.height, exclude ? 0 : 1]];
    try {
      const result = await imageAction("select", imageData, { points });
      pushMaskUndo();
      await displaySelection(result.imageData); setSmartPoints(points); setMessage("Selection ready. Paint or erase to refine it, then remove the object.");
    } catch (error) { setMessage(`Selection failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const refineSelection = async () => {
    if (working || !maskDirty) return;
    setWorking(true);
    try {
      const result = await imageAction("mask_edit", getBinaryMask(), { grow: brushSettings.grow, feather: brushSettings.feather });
      pushMaskUndo();
      await displaySelection(result.imageData); setMessage("Selection edges refined.");
    } catch (error) { setMessage(`Mask refinement failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const finishRetouch = async (points: number[][]) => {
    setWorking(true);
    try {
      const result = await imageAction("retouch", imageData, { mode: brushTool, source: cloneSource, points, size: brushSize, hardness: brushSettings.hardness / 100, opacity: brushSettings.opacity / 100 });
      const savedSource = cloneSource;
      commitEdit(result.imageData, brushTool === "clone" ? "Clone stamp" : "Healing brush"); setCloneSource(savedSource);
      setMessage("Retouch applied.");
    } catch (error) { clearMask(); setMessage(`Retouch failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const fitImage = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const transformImage = async (operation: typeof IMAGE_TRANSFORMS[number]["id"]) => {
    await performOperation({ kind: "transform", direction: operation, label: IMAGE_TRANSFORMS.find((item) => item.id === operation)!.label });
    fitImage();
  };

  const actualSize = useCallback(() => {
    const nextZoom = 1 / fitScale;
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    setPan({ x: 0, y: 0 });
  }, [fitScale]);

  const zoomIn = useCallback(() => {
    setZoom((value) => {
      const nextZoom = Math.min(12, value * 1.2);
      zoomRef.current = nextZoom;
      return nextZoom;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((value) => {
      const nextZoom = Math.max(.2, value / 1.2);
      zoomRef.current = nextZoom;
      return nextZoom;
    });
  }, []);

  const toggleCrop = () => {
    if (!cropMode) {
      const ratio = cropRatio * dimensions.height / dimensions.width;
      const width = cropRatio ? Math.min(1, ratio) : 1, height = cropRatio ? Math.min(1, 1 / ratio) : 1;
      setCropRect([(1 - width) / 2, (1 - height) / 2, width, height]);
    }
    setCropMode(!cropMode); setSelectingFace(false); setCompare(false); setShowOriginal(false);
  };
  const actionShortcuts = [
    { key: "t", label: "Restore detail", run: () => { if (restoreStrength > 0) void performOperation(restoreOperation); } },
    { key: "u", label: "Upscale image", run: () => void runImagePlugin(selectedUpscaler.plugin, upscaleModel, upscaleScale, selectedUpscaler.name) },
    { key: "f", label: "Restore faces · GFPGAN", run: () => void runImagePlugin("gfpgan", "gfpgan", 1, "GFPGAN") },
    { key: "r", label: "Replace selected / largest face", run: () => {
      if (!activeFaceSource) { setMessage("Choose a source photo in Face swap first."); return; }
      void runImagePlugin("face_swap", "", 1, "Face replacement + GFPGAN");
    } },
    { key: "b", label: "Remove background", run: () => void runImagePlugin("remove_bg", backgroundModel, 1, "Background removal") },
    { key: "g", label: "Apply replacement background", run: () => {
      if (backgroundType === "image" && !backgroundPath) { setMessage("Choose a background image first."); return; }
      void performOperation(backgroundOperation);
    } },
    { key: "d", label: "Detect / choose a face", run: () => void detectFaces() },
    { key: "e", label: "Refine background edges", run: () => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges }) },
    { key: "c", label: "Toggle crop / straighten", run: toggleCrop },
    { key: "h", label: "Flip horizontally", run: () => void transformImage("flip-horizontal") },
    { key: "v", label: "Flip vertically", run: () => void transformImage("flip-vertical") },
    { key: "[", label: "Rotate left", run: () => void transformImage("rotate-left") },
    { key: "]", label: "Rotate right", run: () => void transformImage("rotate-right") },
  ];

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (pendingLeave) {
        if (event.key === "Enter" || event.key.toLowerCase() === "y") {
          event.preventDefault();
          void resolvePendingLeave(true);
        } else if (event.key.toLowerCase() === "n") {
          event.preventDefault();
          void resolvePendingLeave(false);
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (pendingLeave.kind === "replace") onReplaceCancel?.();
          setPendingLeave(null);
        }
        return;
      }
      const target = event.target;
      const textEntry = target instanceof HTMLTextAreaElement
        || (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "color", "button"].includes(target.type))
        || (target instanceof HTMLElement && target.isContentEditable);
      if (!textEntry && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const action = actionShortcuts.find((item) => item.key === event.key.toLowerCase());
        if (action) {
          event.preventDefault();
          if (!event.repeat && !working && !saving && !choosingFace && imageData && !drawing.current && !panning.current && !cropStart.current) action.run();
          return;
        }
      }
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || textEntry;
      if (typing || drawing.current || panning.current || cropStart.current) return;
      if (event.code === "Space") {
        if (event.repeat) return;
        spaceDown.current = true;
        hideCursor();
        spaceUsedForPan.current = false;
        event.preventDefault();
      }
      if (event.key === "Escape") safeExit();
      const plainKey = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (plainKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setCompare(false); setSelectingFace(false); setCropMode(false);
        setShowOriginal((value) => !value);
      }
      if ((event.key === "ArrowLeft" || (plainKey && event.key.toLowerCase() === "a")) && !working) {
        event.preventDefault();
        safeNavigate(-1);
      }
      if ((event.key === "ArrowRight" || (plainKey && event.key.toLowerCase() === "d")) && !working) {
        event.preventDefault();
        safeNavigate(1);
      }
      if (plainKey && event.key === "Home" && !working) {
        event.preventDefault();
        safeNavigate(-index);
      }
      if (plainKey && event.key === "End" && !working) {
        event.preventDefault();
        safeNavigate(total - index - 1);
      }
      if (event.code === "NumpadMultiply") {
        event.preventDefault();
        fitImage();
      }
      if (event.code === "NumpadDivide") {
        event.preventDefault();
        actualSize();
      }
      if (event.code === "NumpadAdd") {
        event.preventDefault();
        zoomIn();
      }
      if (event.code === "NumpadSubtract") {
        event.preventDefault();
        zoomOut();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (pendingLeave) return;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if (typing) return;
      if (event.code === "Space") {
        const shouldApply = spaceDown.current && !spaceUsedForPan.current && !drawing.current && !panning.current && !event.altKey && !event.ctrlKey && !event.metaKey;
        spaceDown.current = false;
        spaceUsedForPan.current = false;
        event.preventDefault();
        if (shouldApply) void applyInpaint();
      }
    };
    const blur = () => {
      spaceDown.current = false; spaceUsedForPan.current = false;
      hideCursor();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [actualSize, fitImage, imageData, index, maskDirty, model, pendingLeave, prompt, redo, resolvePendingLeave, safeExit, safeNavigate, save, total, undo, working, saving, cropMode, selectingFace, compare, showOriginal, zoomIn, zoomOut, actionShortcuts, onReplaceCancel]);

  const canvasPoint = (event: { clientX: number; clientY: number }): Point | null => {
    const bounds = getViewportBounds();
    if (!bounds || !maskRef.current) return null;
    const currentScale = fitScale * zoomRef.current;
    return {
      x: (event.clientX - bounds.left - bounds.width / 2 - panRef.current.x) / currentScale + dimensions.width / 2,
      y: (event.clientY - bounds.top - bounds.height / 2 - panRef.current.y) / currentScale + dimensions.height / 2,
    };
  };

  const drawLine = (from: Point, to: Point) => {
    const canvas = maskRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const radius = brushSize / 2;
    if (strokeSnapshot.current) captureMaskRegion(strokeSnapshot.current, canvas,
      Math.min(from.x, to.x) - radius - 1, Math.min(from.y, to.y) - radius - 1,
      Math.max(from.x, to.x) + radius + 1, Math.max(from.y, to.y) + radius + 1);
    const erasing = brushTool === "erase";
    const key = `${brushSize}:${brushSettings.hardness}:${brushSettings.opacity}:${erasing}`;
    if (brushStamp.current?.key !== key) {
      const stamp = document.createElement("canvas");
      stamp.width = stamp.height = Math.ceil(brushSize) + 2;
      const ctx = stamp.getContext("2d")!, center = stamp.width / 2;
      const alpha = brushSettings.opacity / 100 * (erasing ? 1 : .48);
      const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius);
      gradient.addColorStop(0, `rgba(255,73,54,${alpha})`);
      gradient.addColorStop(Math.min(.99, brushSettings.hardness / 100), `rgba(255,73,54,${alpha})`);
      gradient.addColorStop(1, `rgba(255,73,54,${brushSettings.hardness === 100 ? alpha : 0})`);
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(center, center, radius, 0, Math.PI * 2); ctx.fill();
      brushStamp.current = { key, canvas: stamp };
    }
    const stamp = brushStamp.current.canvas;
    context.save();
    context.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * .25)));
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps, y = from.y + (to.y - from.y) * i / steps;
      context.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
    }
    context.restore();
  };

  const isPaintingSurface = (event: React.SyntheticEvent) => (
    event.target === event.currentTarget
    || (event.target instanceof Element && event.target.closest(".image-stage") !== null)
  );

  const pointerDown = (event: React.PointerEvent) => {
    if (!isPaintingSurface(event) || working || saving || showOriginal || pendingLeave) return;
    if (event.button !== 0 && event.button !== 1) return;
    getViewportBounds(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (event.button === 1 || (event.button === 0 && spaceDown.current)) {
      panning.current = true;
      viewportRef.current?.classList.add("panning"); hideCursor();
      if (spaceDown.current) spaceUsedForPan.current = true;
      return;
    }
    if (event.button !== 0) return;
    if (selectingFace || compare) return;
    const point = canvasPoint(event);
    if (!point) return;
    if (!cropMode && (point.x < 0 || point.y < 0 || point.x >= dimensions.width || point.y >= dimensions.height)) return;
    point.x = Math.max(0, Math.min(dimensions.width - 1, point.x)); point.y = Math.max(0, Math.min(dimensions.height - 1, point.y));
    if (cropMode) {
      cropStart.current = { x: Math.max(0, Math.min(1, point.x / dimensions.width)), y: Math.max(0, Math.min(1, point.y / dimensions.height)) };
      return;
    }
    if (brushTool === "smart") { void smartSelect(point, event.altKey); return; }
    if (brushTool === "clone" || brushTool === "heal") {
      if (event.altKey) { setCloneSource([point.x / dimensions.width, point.y / dimensions.height]); setMessage("Source selected. Paint where you want to apply it."); return; }
      if (!cloneSource) { setMessage("Alt-click a source point first."); return; }
      retouchStroke.current = [[point.x / dimensions.width, point.y / dimensions.height]];
    }
    drawing.current = true;
    autoApplyStroke.current = event.shiftKey && brushTool === "paint";
    lastPoint.current = point;
    strokeSnapshot.current = emptySnapshot(maskDirtyRef.current);
    setMaskRedo([]);
    drawLine(point, point);
    setMaskDirty(true);
  };

  const pointerMove = (event: React.PointerEvent) => {
    if (!drawing.current && !panning.current && !isPaintingSurface(event)) {
      hideCursor();
      return;
    }
    if (!panning.current && !spaceDown.current) moveCursor(event.clientX, event.clientY);
    else hideCursor();
    if (panning.current && lastPointer.current) {
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      setPan((value) => ({ x: value.x + dx, y: value.y + dy }));
      lastPointer.current = { x: event.clientX, y: event.clientY };
      return;
    }
    if (cropMode && cropStart.current) {
      const point = canvasPoint(event);
      if (!point) return;
      const start = cropStart.current;
      const x = Math.max(0, Math.min(1, point.x / dimensions.width));
      const y = Math.max(0, Math.min(1, point.y / dimensions.height));
      let width = Math.abs(x - start.x), height = Math.abs(y - start.y);
      if (cropRatio) {
        const ratio = cropRatio * dimensions.height / dimensions.width;
        const maxWidth = x >= start.x ? 1 - start.x : start.x;
        const maxHeight = y >= start.y ? 1 - start.y : start.y;
        width = Math.min(width || height * ratio, maxWidth, maxHeight * ratio);
        height = width / ratio;
      }
      setCropRect([x >= start.x ? start.x : start.x - width, y >= start.y ? start.y : start.y - height, width, height]);
      return;
    }
    if (!drawing.current || !lastPoint.current) return;
    const point = canvasPoint(event);
    if (!point) return;
    point.x = Math.max(0, Math.min(dimensions.width - 1, point.x)); point.y = Math.max(0, Math.min(dimensions.height - 1, point.y));
    if (brushTool === "clone" || brushTool === "heal") retouchStroke.current.push([point.x / dimensions.width, point.y / dimensions.height]);
    drawLine(lastPoint.current, point);
    lastPoint.current = point;
  };

  const pointerUp = (event: React.PointerEvent) => {
    if (drawing.current && event.type === "pointerup") pointerMove(event);
    cropStart.current = null;
    const completedSnapshot = strokeSnapshot.current;
    strokeSnapshot.current = null;
    if (completedSnapshot) setMaskUndo((items) => appendMaskHistory(items, completedSnapshot));
    const shouldRetouch = event.type === "pointerup" && drawing.current && (brushTool === "clone" || brushTool === "heal");
    const shouldAutoApply = event.type === "pointerup" && drawing.current && autoApplyStroke.current;
    drawing.current = false;
    panning.current = false;
    viewportRef.current?.classList.remove("panning");
    autoApplyStroke.current = false;
    lastPoint.current = null;
    lastPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (shouldAutoApply) window.setTimeout(() => void applyInpaint(true), 0);
    if (shouldRetouch) { const points = [...retouchStroke.current]; retouchStroke.current = []; void finishRetouch(points); }
  };

  const wheel = (event: React.WheelEvent) => {
    if (!isPaintingSurface(event)) return;
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) {
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const currentZoom = zoomRef.current;
      const nextZoom = Math.min(12, Math.max(0.2, currentZoom * factor));
      const ratio = nextZoom / currentZoom;
      const viewport = getViewportBounds();
      if (viewport && ratio !== 1) {
        const anchorX = event.clientX - viewport.left - viewport.width / 2;
        const anchorY = event.clientY - viewport.top - viewport.height / 2;
        setPan((value) => ({
          x: anchorX - ratio * (anchorX - value.x),
          y: anchorY - ratio * (anchorY - value.y),
        }));
      }
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    } else {
      const direction = event.deltaY < 0 ? 1 : -1;
      onBrushSizeChange((value) => Math.min(500, Math.max(3, value + direction * Math.max(2, value * 0.08))));
    }
  };

  // Pictures of Immich-compatible stores get the Immich panel, which takes turns with the workspace drawer.
  const immichStore = image.path ? immichStores?.find((store) => image.path.startsWith(`${store.path.replace(/\/+$/, "")}/`)) : undefined;
  const immichVisible = !!immichStore && immichOpen && !workspaceOpen;

  return (
    <div className="editor-shell">
      <header className="editor-bar">
        <div className="editor-left">
          <button className="icon-button" onClick={safeExit} title="Back to browser (Esc)"><X size={19} /></button>
          <div className="file-heading">
            <strong title={savePath || image.name}>{displayName}</strong>
            <span className="file-details">
              <span>{index + 1} of {total}</span>
              {!savePath && <span title="Save asks where to store this picture">{image.path ? `${image.extension.toUpperCase()} · saved as a new file` : "Not on disk"}</span>}
              {stageReady && <>
                <span title="Current output resolution">{dimensions.width} × {dimensions.height} px</span>
                <span ref={zoomLabelRef} title="Actual display zoom">{Math.round(scale * 100)}% zoom</span>
              </>}
              {dirty && <span>Unsaved</span>}
            </span>
          </div>
        </div>
        <div className="editor-tools">
          <div className="model-picker-wrap">
            <button
              className={`model-picker ${modelMenuOpen ? "active" : ""}`}
              onClick={() => setModelMenuOpen((open) => !open)}
              title="Choose inpainting model"
            >
              <Sparkles size={15} />
              <span>{model.name}</span>
              <ChevronDown size={14} />
            </button>
            {modelMenuOpen && (
              <div className="model-menu">
                <div className="model-menu-heading">
                  <strong>Inpainting model</strong>
                  <span>Models download into this project on first use.</span>
                </div>
                {INPAINT_MODELS.map((option) => (
                  <button
                    key={option.id}
                    className={`model-option ${option.id === model.id ? "selected" : ""}`}
                    onClick={() => {
                      setModel(option);
                      storage.setItem("inpaint.model", option.id);
                      setModelMenuOpen(false);
                    }}
                  >
                    <span className="model-option-top">
                      <strong>{option.name}</strong>
                      <span>{option.tag}</span>
                    </span>
                    <span className="model-description">{option.description}</span>
                    <span className="model-download">{option.download}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {model.id === "sdxl" && (
            <input
              className="prompt-input"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Optional guidance…"
              title="Describe what SDXL should generate inside the mask"
            />
          )}
          <div className="tool-cluster">
            <Brush size={16} /><span>{Math.round(brushSize)} px</span>
          </div>
          <button className="icon-button" onClick={undo} disabled={working || saving || (!maskUndo.length && !history.canUndo)} title="Undo (Ctrl+Z)"><Undo2 size={18} /></button>
          <button className="icon-button" onClick={redo} disabled={working || saving || (!maskRedo.length && !history.canRedo)} title="Redo (Ctrl+Shift+Z)"><Redo2 size={18} /></button>
          <button className="icon-button" onClick={() => { pushMaskUndo(); clearMask(); }} disabled={!maskDirty || working || saving} title="Clear mask"><Eraser size={18} /></button>
          <span className="bar-divider" />
          <div className="transform-tools" role="group" aria-label="Flip, rotate and crop image">
            {IMAGE_TRANSFORMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className="icon-button"
                onClick={() => void transformImage(id)}
                disabled={!imageData || working || saving || pendingLeave !== null}
                title={`${label} (Alt+${id === "flip-horizontal" ? "H" : id === "flip-vertical" ? "V" : id === "rotate-left" ? "[" : "]"})`}
                aria-label={label}
              ><Icon size={18} /></button>
            ))}
            <button className="icon-button" disabled={working || saving} title="Crop and straighten (Alt+C)" aria-label="Crop and straighten" onClick={toggleCrop}><Crop size={18} /></button>
          </div>
          <span className="bar-divider" />
          <button className="icon-button" onClick={zoomOut} title="Zoom out (Numpad −)"><ZoomOut size={18} /></button>
          <span ref={zoomValueRef} className="zoom-value">{Math.round(scale * 100)}%</span>
          <button className="icon-button" onClick={zoomIn} title="Zoom in (Numpad +)"><ZoomIn size={18} /></button>
          <button className="icon-button" onClick={fitImage} title="Fit and center (Numpad *)"><Scan size={17} /></button>
        </div>
        <div className="editor-actions">
          {immichStore && <button className={`icon-button ${immichVisible ? "active" : ""}`} title="Immich: favorite, rating, tags and albums" aria-label="Immich panel" aria-pressed={immichVisible}
            onClick={() => { if (immichVisible) { setImmichOpen(false); } else { setImmichOpen(true); setWorkspaceOpen(false); } }}><Tags size={18} /></button>}
          <button className="icon-button" title="Edit history" aria-label="Edit history" onClick={() => { setWorkspaceTab("history"); setWorkspaceOpen(true); }}><History size={18} /></button>
          <button className="icon-button" title="Workflows and batch processing" aria-label="Workflows and batch processing" onClick={() => { setWorkspaceTab("workflows"); setWorkspaceOpen(true); }}><Layers size={18} /></button>
          <button className="icon-button" title="Export a copy" aria-label="Export a copy" onClick={() => { setWorkspaceTab("export"); setWorkspaceOpen(true); }}><Download size={18} /></button>
          {image.path && <button className="icon-button danger" title="Delete this picture" aria-label="Delete this picture" disabled={working || saving || deleting} onClick={() => void deletePicture()}><Trash2 size={18} /></button>}
          <button className="save-button" onClick={() => void save()} disabled={(!dirty && !!savePath) || saving || working}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save
          </button>
          <button className="apply-button" onClick={() => void applyInpaint()} disabled={!maskDirty || working || saving || cropMode || selectingFace || compare || showOriginal}>
            {working ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
            {working ? "Working…" : <><span>Remove object</span><kbd>Space</kbd></>}
          </button>
        </div>
      </header>

      <div className="editor-body">
        <aside
          className="plugin-toolbar"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <button
            className={`compare-original ${showOriginal ? "active" : ""}`}
            onClick={() => { setCompare(false); setSelectingFace(false); setCropMode(false); setShowOriginal((value) => !value); }}
            disabled={!originalImageData}
            title="Toggle original image (O)"
          >
            {showOriginal ? <EyeOff size={16} /> : <Eye size={16} />}
            <span>{showOriginal ? "Show edited" : "Show original"}</span><kbd>O</kbd>
          </button>

          <ToolSection id="comparison" title="Comparison" icon={Eye}>
            <button className={`plugin-run ${compare ? "active" : ""}`} disabled={working || saving} onClick={() => { setCompare(!compare); setShowOriginal(false); setCropMode(false); setSelectingFace(false); }}>Before / after slider</button>
            {compare && <><select aria-label="Compare against" value={compareWith} onChange={(e) => setCompareWith(e.target.value)}><option value="previous">Before the current step</option><option value="original">Original image</option></select><input aria-label="Comparison position" type="range" min="0" max="100" value={divider} onChange={(e) => setDivider(+e.target.value)} /><div className="plugin-description">Before on the left, after on the right. Zoom and pan are linked. Before fits the current frame.</div></>}
          </ToolSection>

          <AdvancedTools busy={operationWorking || previewBusy || saving} tool={brushTool} onTool={(tool) => { setBrushTool(tool); setCropMode(false); setCompare(false); setShowOriginal(false); setSelectingFace(false); }}
            brush={brushSettings} setBrush={setBrushSettings} size={brushSize} setSize={onBrushSizeChange} maskDirty={maskDirty} refineMask={() => void refineSelection()} resetPoints={() => setSmartPoints([])} pointCount={smartPoints.length}
            sourceSet={cloneSource !== null} adjustmentActive={adjustmentActive} adjustments={adjustments} onAdjust={setAdjustments}
            onStartAdjust={() => { setAdjustmentActive(true); setCompare(false); setCropMode(false); setShowOriginal(false); setSelectingFace(false); }} onApplyAdjust={() => void applyColorAdjustments()} onCancelAdjust={() => { setAdjustmentActive(false); setColorPreview(""); }}
            edges={edges} setEdges={setEdges} onEdges={() => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges })}
            extension={extension} setExtension={setExtension} onExtend={() => void performOperation({ kind: "outpaint", label: "Extend canvas", ...extension })} width={dimensions.width} height={dimensions.height} />

          {cropMode && <ToolSection id="crop" title="Crop and straighten" icon={Crop}>
            <select aria-label="Crop aspect ratio" value={cropRatio} onChange={(e) => {
              const ratio = +e.target.value; setCropRatio(ratio);
              const normalized = ratio * dimensions.height / dimensions.width;
              const w = ratio ? Math.min(1, normalized) : 1, h = ratio ? Math.min(1, 1 / normalized) : 1;
              setCropRect([(1 - w) / 2, (1 - h) / 2, w, h]);
            }}><option value="0">Free crop</option><option value="1">Square · 1:1</option><option value={4 / 3}>Landscape · 4:3</option><option value={3 / 2}>Photo · 3:2</option><option value={16 / 9}>Wide · 16:9</option><option value={3 / 4}>Portrait · 3:4</option><option value={2 / 3}>Portrait · 2:3</option><option value={9 / 16}>Tall · 9:16</option></select>
            <div className="denoise-control"><label htmlFor="straighten">Straighten <output>{cropAngle}°</output></label><input id="straighten" type="range" min="-15" max="15" step="0.1" value={cropAngle} onChange={(e) => setCropAngle(+e.target.value)} /></div>
            <div className="plugin-description">Drag on the image to choose the crop. Output: {Math.round(cropRect[2] * dimensions.width)} × {Math.round(cropRect[3] * dimensions.height)} px. Rotated corners become transparent.</div>
            <button className="plugin-run" disabled={working || saving || cropRect[2] * dimensions.width < 1 || cropRect[3] * dimensions.height < 1} onClick={() => void performOperation({ kind: "crop", label: `Crop / straighten ${cropAngle}°`, rect: cropRect, angle: cropAngle })}>Apply crop</button>
            <button className="plugin-run" disabled={working || saving} onClick={() => { setCropMode(false); setCropAngle(0); }}>Cancel crop</button>
          </ToolSection>}

          <ToolSection id="restoration-strength" title="Restoration strength" icon={SlidersHorizontal}>
            <div className="denoise-control"><label htmlFor="restoration-strength">GFPGAN + face replacement <output>{restorationStrength}%</output></label><input id="restoration-strength" type="range" min="0" max="100" value={restorationStrength} disabled={operationWorking || saving} onChange={(e) => setRestorationStrength(+e.target.value)} /><div><span>Raw face</span><span>Restored face</span></div></div>
            <div className="plugin-description">Shared by both tools. {restorationPreview ? "Adjusts the last result instantly without rerunning the model." : "Applied to the next restoration or replacement."}</div>
          </ToolSection>

          <ToolSection id="face-swap" title="Face swap" icon={UserRound}>
            <div className="denoise-control"><label htmlFor="face-color-match">Match face color <output>{faceColorMatch}%</output></label><input id="face-color-match" type="range" min="0" max="100" step="5" value={faceColorMatch} disabled={working || saving} onChange={(e) => setFaceColorMatch(+e.target.value)} /><div className="plugin-description">Matches brightness and skin tone to the target photo on the next replacement.</div></div>
            <div className="face-source-row">
            <button
              className="face-photo-picker"
              onClick={() => void chooseFacePhoto()}
              disabled={working || saving || choosingFace}
              aria-label={activeFaceSource ? "Change face source photo" : "Select photo"}
              title={activeFaceSource ? `Change source: ${activeFaceSource.path}` : "Select a photo with the face to use"}
            >
              {activeFaceSource && <img src={activeFaceSource.data} alt="Selected face source" />}
              <span>{choosingFace ? "Loading…" : activeFaceSource ? "Change photo" : "Select photo"}</span>
            </button>
            {faceLibrary.length > 0 && <FaceLibrary paths={faceLibrary} activePath={activeFaceSource?.path} busy={working || saving || choosingFace}
              onUse={chooseSavedFace} onApply={(path) => void replaceFace(path)} onRemove={removeSavedFace} onAdd={() => void addFacePhotos()} />}
            </div>
            {activeFaceSource && <button className="plugin-run" onClick={clearFacePhoto} disabled={working || saving || choosingFace}><X size={13} /> Clear photo</button>}
            <button className="plugin-run" disabled={working || saving || !imageData} onClick={() => void detectFaces()}>Detect / choose a face<kbd className="action-shortcut">Alt+D</kbd></button>
            {faces.length > 0 && <><select aria-label="Target face" value={selectedFace?.id ?? "largest"} disabled={working || saving} onChange={(e) => { setSelectedFace(faces.find((face) => face.id === +e.target.value) ?? null); setSelectingFace(true); }}><option value="largest">Largest face</option>{faces.map((face) => <option key={face.id} value={face.id}>Face {face.id + 1}{assignments[face.id] ? " · assigned" : ""}</option>)}</select><button className="plugin-run" disabled={working || saving} onClick={() => setSelectingFace(!selectingFace)}>{selectingFace ? "Hide face boxes" : "Show face boxes"}</button></>}
            <button
              className="plugin-run"
              onClick={() => void runImagePlugin("face_swap", "", 1, "Face replacement + GFPGAN")}
              disabled={!activeFaceSource || !imageData || working || saving || choosingFace}
            ><Play size={13} /> Replace<kbd className="action-shortcut">Alt+R</kbd></button>
            <div className="plugin-description">{selectedFace ? `Replaces face ${selectedFace.id + 1}` : "Replaces the largest face"}, then restores it with GFPGAN. Select each face to assign a different source.</div>
            {Object.keys(assignments).length > 1 && <button className="plugin-run" disabled={working || saving} onClick={() => void runWorkflow(faces.filter((face) => assignments[face.id]).map((face) => ({ kind: "face", label: `Replace face ${face.id + 1}`, donor: assignments[face.id].path, strength: restorationStrength / 100, target: [face.box[0] + face.box[2] / 2, face.box[1] + face.box[3] / 2] })), "Replace assigned faces")}>Replace all assigned faces</button>}
          </ToolSection>

          <ToolSection id="face-restoration" title="Face restoration" icon={ScanFace}>
            <div className="plugin-description">Restore facial detail with GFPGAN 1.4.</div>
            <button
              className="plugin-run"
              onClick={() => void runImagePlugin("gfpgan", "gfpgan", 1, "GFPGAN")}
              disabled={working || saving}
            ><Play size={13} /> Run GFPGAN<kbd className="action-shortcut">Alt+F</kbd></button>
          </ToolSection>

          <ToolSection id="restore" title="Restore detail" icon={Sparkles}>
            <select aria-label="Restoration mode" value={restoreMode} onChange={(event) => setRestoreMode(event.target.value)} disabled={working || saving}>
              {RESTORE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <div className="plugin-description">{selectedRestore.description}</div>
            <div className="denoise-control"><label htmlFor="restore-strength">Restoration strength <output>{restoreStrength}%</output></label>
              <input id="restore-strength" type="range" min="0" max="100" step="5" value={restoreStrength} disabled={working || saving} onChange={(event) => setRestoreStrength(+event.target.value)} />
              <div><span>Original</span><span>Restored</span></div>
            </div>
            <div className="plugin-description">Keeps {dimensions.width} × {dimensions.height} px and transparency. Strength applies on the next run. Downloads {selectedRestore.download} on first use.</div>
            <button className="plugin-run" disabled={!imageData || working || saving || restoreStrength === 0} onClick={() => void performOperation(restoreOperation)}><Play size={13} /> Restore detail<kbd className="action-shortcut">Alt+T</kbd></button>
          </ToolSection>

          <ToolSection id="upscale" title="Upscale" icon={Maximize2}>
            <select aria-label="Upscaling method" value={upscaleModel} onChange={(event) => setUpscaleModel(event.target.value)} disabled={working || saving}>
              {UPSCALE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <div className="plugin-description">{selectedUpscaler.description}</div>
            {upscaleModel === "realesr-general-x4v3" && (
              <div className="denoise-control">
                <label htmlFor="upscale-denoise">Denoising <output>{upscaleDenoise}%</output></label>
                <input
                  id="upscale-denoise"
                  type="range" min={0} max={100} step={5}
                  value={upscaleDenoise}
                  onChange={(event) => setUpscaleDenoise(Number(event.target.value))}
                  disabled={working || saving}
                />
                <div><span>Keep texture</span><span>Remove noise</span></div>
              </div>
            )}
            <select aria-label="Upscale output factor" value={upscaleScale} onChange={(event) => setUpscaleScale(Number(event.target.value))} disabled={working || saving}>
              <option value={2}>Output scale · 2×</option>
              <option value={3}>Output scale · 3×</option>
              <option value={4}>Output scale · 4×</option>
            </select>
            <button
              className="plugin-run"
              onClick={() => void runImagePlugin(selectedUpscaler.plugin, upscaleModel, upscaleScale, selectedUpscaler.name)}
              disabled={!imageData || working || saving}
            ><Play size={13} /> Upscale image<kbd className="action-shortcut">Alt+U</kbd></button>
          </ToolSection>

          <ToolSection id="remove-background" title="Remove background" icon={ImageOff}>
            <select value={backgroundModel} onChange={(event) => setBackgroundModel(event.target.value)}>
              <option value="briaai/RMBG-1.4">BRIA RMBG 1.4 · No login</option>
              <option value="briaai/RMBG-2.0">BRIA RMBG 2.0 · Requires access</option>
              <option value="u2net">U²-Net · General</option>
              <option value="u2net_human_seg">U²-Net · People</option>
            </select>
            {backgroundModel === "briaai/RMBG-2.0" && <>
              <div className="hf-token-links">
                {hfTokenSaved && <small>Access token saved</small>}
                <button className="text-link" disabled={working || saving || hfTokenBusy} onClick={() => { setHfAccessOpen(!hfAccessOpen); setConfirmTokenRemoval(false); }}>{hfAccessOpen ? "Close access settings" : hfTokenSaved ? "Change token" : "Set up model access"}</button>
                {hfTokenSaved && !confirmTokenRemoval && <button className="text-link token-remove" disabled={working || saving || hfTokenBusy} onClick={() => setConfirmTokenRemoval(true)}>Remove saved token</button>}
                {confirmTokenRemoval && <div className="token-confirm"><small>Remove the saved token?</small><button className="text-link" disabled={working || saving || hfTokenBusy} onClick={() => void saveHfToken(true)}>Yes, remove</button><button className="text-link" disabled={hfTokenBusy} onClick={() => setConfirmTokenRemoval(false)}>Cancel</button></div>}
              </div>
              {hfAccessOpen && <div className="hf-access">
                <div className="plugin-description">BRIA 2.0 is gated. Your Hugging Face account must have access before the token can download it.</div>
                <button className="plugin-run" onClick={() => void invoke("open_model_access", { tokens: false }).catch((e) => setMessage(String(e)))}>1. Open model access page</button>
                <button className="plugin-run" onClick={() => void invoke("open_model_access", { tokens: true }).catch((e) => setMessage(String(e)))}>2. Create a read token</button>
                <input type="password" autoComplete="off" aria-label="Hugging Face read token" placeholder={hfTokenSaved ? "Enter a replacement token" : "hf_…"} value={hfToken} onChange={(e) => setHfToken(e.target.value)} disabled={working || saving || hfTokenBusy} />
                <button className="plugin-run" disabled={working || saving || hfTokenBusy || !hfToken.trim()} onClick={() => void saveHfToken()}>3. Save token</button>
                <div className="plugin-description">Stored locally with access restricted to your Linux user. Never included in workflows or exports.</div>
              </div>}
            </>}
            <div className="plugin-description">Transparency requires PNG or WebP.</div>
            <button
              className="plugin-run"
              onClick={() => void runImagePlugin("remove_bg", backgroundModel, 1, "Background removal")}
              disabled={working || saving}
            ><Play size={13} /> Remove background<kbd className="action-shortcut">Alt+B</kbd></button>
          
            <BackgroundEdgeTools busy={operationWorking || previewBusy || saving} adjustmentActive={adjustmentActive} edges={edges} setEdges={setEdges} onEdges={() => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges })} />
          </ToolSection>
          <ToolSection id="replace-background" title="Replace background" icon={ImageOff}>
            <select aria-label="Background replacement type" value={backgroundType} disabled={working || saving} onChange={(e) => setBackgroundType(e.target.value as typeof backgroundType)}><option value="color">Solid color</option><option value="image">Another image</option><option value="blur">Blur original background</option></select>
            {backgroundType === "color" && <input aria-label="Background color" type="color" value={backgroundColor} disabled={working || saving} onChange={(e) => setBackgroundColor(e.target.value)} />}
            {backgroundType === "image" && <><button className="plugin-run" disabled={working || saving} onClick={async () => { try { const selected = await open({ title: "Choose background image", filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] }); if (typeof selected === "string") setBackgroundPath(selected); } catch (error) { setMessage(String(error)); } }}>Choose background image</button><div className="plugin-description path-text">{backgroundPath || "No background selected"}</div></>}
            {backgroundType === "blur" && <div className="denoise-control"><label htmlFor="background-blur">Blur <output>{backgroundBlur} px</output></label><input id="background-blur" type="range" min="1" max="100" value={backgroundBlur} disabled={working || saving} onChange={(e) => setBackgroundBlur(+e.target.value)} /></div>}
            <label className="check-label"><input type="checkbox" checked={removeFirst} disabled={working || saving} onChange={(e) => setRemoveFirst(e.target.checked)} /> Remove background first</label>
            <div className="plugin-description">Uses the selected removal model. Turn off removal if the image already has transparency.</div>
            <button className="plugin-run" disabled={working || saving || (backgroundType === "image" && !backgroundPath)} onClick={() => void performOperation(backgroundOperation)}>Apply background<kbd className="action-shortcut">Alt+G</kbd></button>
          </ToolSection>
          <button className="plugin-run" onClick={() => { setWorkspaceTab("memory"); setWorkspaceOpen(true); }}><Layers size={15} /> Loaded models / memory</button>
        </aside>
      <div
        ref={viewportRef}
        className={`editor-viewport ${panning.current ? "panning" : ""} ${cropMode || selectingFace || compare ? "selection-mode" : ""}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onLostPointerCapture={pointerUp}
        onPointerLeave={hideCursor}
        onWheel={wheel}
        onContextMenu={(event) => event.preventDefault()}
      >
        {!imageData ? <div className="editor-loading"><span className="spinner" />Loading image</div> : (
          <div
            ref={stageRef}
            className={`image-stage ${stageReady ? "" : "initializing"}`}
            style={{
              width: dimensions.width,
              height: dimensions.height,
              transform: `translate(-50%, -50%) translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${fitScale * zoomRef.current})`,
            }}
          >
            <div className="image-clip"><img src={imageData} style={cropMode ? { transform: `rotate(${cropAngle}deg)` } : undefined} onLoad={onImageLoad} draggable={false} alt={image.name} />{colorPreview && <img src={colorPreview} draggable={false} alt="Color adjustment preview" />}</div>
            {originalImageData && (
              <img
                className={`original-image ${showOriginal ? "visible" : ""}`}
                src={originalImageData}
                draggable={false}
                alt={`Original ${image.name}`}
              />
            )}
            {compare && <>
              <img className="comparison-image" src={compareWith === "original" ? originalImageData : history.entries[Math.max(0, history.position - 1)]?.data} style={{ clipPath: `inset(0 ${100 - divider}% 0 0)` }} alt="Before" draggable={false} />
              <div className="comparison-line" style={{ left: `${divider}%`, width: "calc(2px / var(--image-scale, 1))" }} />
              <input className="comparison-drag" aria-label="Before and after divider" type="range" min="0" max="100" value={divider} onChange={(e) => setDivider(+e.target.value)} onPointerDown={(e) => { if (e.button === 0 && !spaceDown.current) e.stopPropagation(); else e.preventDefault(); }} />
            </>}
            <canvas ref={maskRef} className={showOriginal || compare || cropMode || selectingFace || adjustmentActive ? "hidden-mask" : ""} />
            {cloneSource && (brushTool === "clone" || brushTool === "heal") && <span className="clone-source" style={{ left: `${cloneSource[0] * 100}%`, top: `${cloneSource[1] * 100}%`, fontSize: "calc(24px / var(--image-scale, 1))" }}>+</span>}
            {brushTool === "smart" && smartPoints.map((point, index) => <span key={index} className={`selection-point ${point[2] ? "include" : "exclude"}`} style={{ left: `${point[0] * 100}%`, top: `${point[1] * 100}%`, width: "calc(9px / var(--image-scale, 1))", height: "calc(9px / var(--image-scale, 1))", borderWidth: "calc(1px / var(--image-scale, 1))" }} />)}
            {cropMode && <div className="crop-outline" style={{ left: `${cropRect[0] * 100}%`, top: `${cropRect[1] * 100}%`, width: `${cropRect[2] * 100}%`, height: `${cropRect[3] * 100}%`, borderWidth: "calc(1px / var(--image-scale, 1))" }}><i /><i /></div>}
            {selectingFace && faces.map((face) => <button key={face.id} className={`face-box ${selectedFace?.id === face.id ? "selected" : ""}`} style={{ left: `${face.box[0] * 100}%`, top: `${face.box[1] * 100}%`, width: `${face.box[2] * 100}%`, height: `${face.box[3] * 100}%`, borderWidth: "calc(2px / var(--image-scale, 1))" }} aria-label={`Select face ${face.id + 1}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => { setSelectedFace(face); setMessage(`Face ${face.id + 1} selected. Choose a source photo or press Replace.`); }}><span style={{ fontSize: "calc(12px / var(--image-scale, 1))" }}>Face {face.id + 1}{assignments[face.id] ? " · assigned" : ""}</span></button>)}
          </div>
        )}


        <div ref={cursorRef} className="brush-cursor" aria-hidden="true" />
        <button className="nav-button previous" onClick={() => safeNavigate(-1)} disabled={total < 2 || working || saving} title="Previous image (Left arrow)"><ArrowLeft size={21} /></button>
        <button className="nav-button next" onClick={() => safeNavigate(1)} disabled={total < 2 || working || saving} title="Next image (Right arrow)"><ArrowRight size={21} /></button>
        <div className="shortcut-help">
          <button className="shortcut-help-button" aria-label="Show keyboard shortcuts">?</button>
          <div className="shortcut-tooltip" role="tooltip">
            <strong>Controls</strong>
            <div><kbd>Left drag</kbd><span>Paint mask</span></div>
            <div><kbd>Wheel</kbd><span>Zoom around cursor</span></div>
            <div><kbd>Ctrl + Wheel</kbd><span>Brush size</span></div>
            <div><kbd>Space + drag / Middle drag</kbd><span>Pan</span></div>
            <div><kbd>Shift + paint</kbd><span>Paint and remove</span></div>
            <div><kbd>Space</kbd><span>Remove masked object</span></div>
            <div><kbd>Ctrl + Z / Ctrl + Shift + Z</kbd><span>Undo / redo</span></div>
            <div><kbd>← / → or A / D</kbd><span>Previous / next image</span></div>
            <div><kbd>Home / End</kbd><span>First / last image</span></div>
            <div><kbd>Numpad * / Numpad /</kbd><span>Fit / actual size</span></div>
            <div><kbd>Numpad + / Numpad −</kbd><span>Zoom in / out</span></div>
            <div><kbd>Ctrl + S</kbd><span>Overwrite image</span></div>
            <div><kbd>O</kbd><span>Toggle original / edited</span></div>
            <div><kbd>Esc</kbd><span>Back to browser</span></div>
            <strong>Actions · current tool settings</strong>
            {actionShortcuts.map((action) => <div key={action.key}><kbd>Alt + {action.key.toUpperCase()}</kbd><span>{action.label}</span></div>)}
            <div><kbd>Alt + click</kbd><span>Sample clone / healing source, or exclude smart selection</span></div>
          </div>
        </div>
        {message && <div className={`toast ${message.includes("failed") ? "error" : ""}`}>{message}</div>}
      </div>
        {workspaceOpen && <Workspace tab={workspaceTab} onTab={setWorkspaceTab} onClose={() => setWorkspaceOpen(false)}
          data={imageData} name={image.name} dimensions={dimensions} history={history.entries} position={history.position}
          onJump={jumpHistory} suggestions={suggestions} busy={working || saving} onBusy={setWorking} onMessage={setMessage} onRun={runWorkflow} />}
        {immichVisible && immichStore && <ImmichPanel key={image.path} path={image.path} onClose={() => setImmichOpen(false)} />}
      </div>
      {pendingLeave && (
        <div className="leave-dialog-backdrop" role="presentation">
          <div className="leave-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title">
            <strong id="leave-dialog-title">Save changes to {displayName}?</strong>
            <p>{pendingLeave.kind === "replace" ? "Another picture was sent to the editor. " : ""}Your edits have not been saved{savePath ? " to the original file" : ""}.</p>
            <div className="leave-dialog-actions">
              <button className="leave-no" onClick={() => void resolvePendingLeave(false)} disabled={saving}>
                Don’t save <kbd>N</kbd>
              </button>
              <button className="leave-yes" onClick={() => void resolvePendingLeave(true)} disabled={saving} autoFocus>
                {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                Save <kbd>Y / Enter</kbd>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
