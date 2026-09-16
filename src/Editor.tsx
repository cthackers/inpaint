import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft, ArrowRight, Brush, Check, Eraser, LoaderCircle,
  ChevronDown, Eye, EyeOff, FlipHorizontal, FlipVertical, ImageOff, Maximize2, Minimize2, Pause, Play, Redo2, RotateCcw, RotateCw,
  Save, Scan, ScanFace, Sparkles, Stamp, Tags, Trash2, Undo2, UserRound, X, ZoomIn, ZoomOut, Crop, History, Layers, Download, SlidersHorizontal, Images, Cpu, Gauge, ImagePlus, LayoutGrid, StickyNote,
} from "lucide-react";
import type { ImageEntry, Store } from "./types";
import ImmichPanel from "./ImmichPanel";
import PictureInfo from "./PictureInfo";
import AnnotationsPanel, { type Annotation } from "./Annotations";
import Workspace, { type WorkspaceCommand, type WorkspaceTab } from "./Workspace";
import { useEditHistory, type HistoryEntry } from "./useEditHistory";
import { adjustImage, neutralAdjustments, loadImage, blendImages, executeOperation, imageAction, RESIZE_FILTERS, WATERMARK_PROMPTS, watermarkPrompts, type ActionResult, type FaceBox, type Operation, type Rect, type ResizeFilter } from "./editorOperations";
import advancedSections, { BackgroundEdgeTools, type BrushTool, type BrushSettings, type Edges, type Extension } from "./AdvancedTools";
import { INPAINT_MODELS, type InpaintModel } from "./models";
import FaceLibrary from "./FaceLibrary";
import { FACE_LIBRARY_PREFERENCE, usePreference, useSavedChoice } from "./preferences";
import ToolSection, { SECTION_DRAG, type SectionEntry } from "./ToolSection";
import { comboOf, keyLabel, shortcutFor, SHORTCUTS, useShortcutKeys, type ShortcutId } from "./shortcuts";
import { useCanvasView } from "./useCanvasView";
import { appendMaskHistory, applyMaskSnapshot, captureMaskRegion, emptySnapshot, snapshotMask, type MaskSnapshot } from "./maskHistory";
import { storage } from "./storage";
import Select from "./Select";

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
  /** Whether the strip of pictures lies along the bottom; App draws it, outside this editor. */
  stripOpen?: boolean;
  onStripToggle?: () => void;
  /** Where the picture area is, for the strip, which lies along its bottom. */
  onViewport?: (box: { left: number; width: number; bottom: number }) => void;
  /** Whether an action or a save is running, which keeps the strip from moving to another picture. */
  onBusy?: (busy: boolean) => void;
  /** Filled with a way to open another picture, with the same questions as the arrows ask. */
  navigator?: MutableRefObject<((index: number) => void) | null>;
  /** The picture as it stood on screen when another one opens, so App can let it fade out. */
  onLeaving?: (snapshot: { src: string; rect: DOMRect }) => void;
  /** The picture has painted in place. */
  onShown?: () => void;
};

export type FaceSwapSource = { path: string; data: string };

type AnimationInfo = { frames: number; editable: boolean };
type Animation = { frames: string[]; delays: number[] };

type Point = { x: number; y: number };

/** The crop's handles, named by the sides they move. */
const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const MIN_CROP = .01;

/**
 * The crop after dragging a handle (or its inside, "move") by dx, dy, as fractions of the picture. With a
 * ratio (width over height, in those fractions) the crop keeps its shape: a corner follows the pointer's
 * width from the opposite corner, and a side grows the other dimension around its middle.
 */
function dragCrop(handle: string, [x, y, width, height]: Rect, dx: number, dy: number, ratio: number): Rect {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  if (handle === "move") return [clamp(x + dx, 0, 1 - width), clamp(y + dy, 0, 1 - height), width, height];
  let left = x, top = y, right = x + width, bottom = y + height;
  if (handle.includes("w")) left = clamp(x + dx, 0, right - MIN_CROP);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes("n")) top = clamp(y + dy, 0, bottom - MIN_CROP);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  if (!ratio) return [left, top, right - left, bottom - top];
  if (handle.length === 2) {
    // The corner opposite the handle stays put.
    const anchorX = handle.includes("w") ? x + width : x, anchorY = handle.includes("n") ? y + height : y;
    const roomX = handle.includes("w") ? anchorX : 1 - anchorX, roomY = handle.includes("n") ? anchorY : 1 - anchorY;
    // The side the pointer moved further decides the size.
    const byWidth = right - left, byHeight = (bottom - top) * ratio;
    const wanted = Math.abs(byWidth - width) >= Math.abs(byHeight - width) ? byWidth : byHeight;
    const newWidth = clamp(wanted, MIN_CROP, Math.min(roomX, roomY * ratio));
    const newHeight = newWidth / ratio;
    return [handle.includes("w") ? anchorX - newWidth : anchorX, handle.includes("n") ? anchorY - newHeight : anchorY, newWidth, newHeight];
  }
  const centerX = x + width / 2, centerY = y + height / 2;
  if (handle === "n" || handle === "s") {
    const room = Math.min(centerX, 1 - centerX) * 2;
    const newHeight = Math.min(bottom - top, room / ratio), newWidth = newHeight * ratio;
    return [centerX - newWidth / 2, handle === "n" ? bottom - newHeight : top, newWidth, newHeight];
  }
  const room = Math.min(centerY, 1 - centerY) * 2;
  const newWidth = Math.min(right - left, room * ratio), newHeight = newWidth / ratio;
  return [handle === "w" ? right - newWidth : left, centerY - newHeight / 2, newWidth, newHeight];
}
type PendingLeave = { kind: "exit" } | { kind: "navigate"; offset: number } | { kind: "replace" };

const IMAGE_TRANSFORMS = [
  { id: "flip-horizontal", label: "Flip horizontally", icon: FlipHorizontal },
  { id: "flip-vertical", label: "Flip vertically", icon: FlipVertical },
  { id: "rotate-left", label: "Rotate left 90°", icon: RotateCcw },
  { id: "rotate-right", label: "Rotate right 90°", icon: RotateCw },
] as const;
const UPSCALE_OPTIONS = [
  { id: "realwebphoto-dat2", plugin: "photo", name: "DAT2 · Natural photos", description: "Keeps the photo's own texture instead of smoothing it, and copes with JPEG compression. The best choice for most photos. 140 MB download." },
  { id: "nomos2-hq-atd", plugin: "photo", name: "ATD · Finest detail", description: "The most real detail, for clean sources such as PNG or camera exports. Sharpens JPEG artifacts, so use DAT2 for compressed pictures. 82 MB download." },
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

// How far the tools on the left were scrolled, kept while another picture opens.
let toolbarScroll = 0;
// Commands asked of the workspace by shortcuts, numbered so each one runs once.
let workspaceCommands = 0;
// The size of the picture opened last, which the next one shows until its own is known.
let lastDimensions = { width: 1, height: 1 };

type DockTab = WorkspaceTab | "info" | "annotations";

/** The panels of the dock on the right, in the order their tabs stand. */
const DOCK_TABS: { id: DockTab; label: string; icon: typeof History }[] = [
  { id: "info", label: "Info", icon: Tags },
  { id: "annotations", label: "Annotations", icon: StickyNote },
  { id: "history", label: "History", icon: History },
  { id: "workflows", label: "Workflows", icon: Layers },
  { id: "batch", label: "Batch", icon: Images },
  { id: "export", label: "Export", icon: Download },
  { id: "memory", label: "Memory", icon: Cpu },
];

export default function Editor({ image, index, total, brushSize, onBrushSizeChange, faceSwapSource, onFaceSwapSourceChange, onFaceSwapSourceClear, onExit, onNavigate, initialData, replaceRequested, onReplace, onReplaceCancel, onSaved, onDeleted, immichStores, stripOpen = false, onStripToggle, onViewport, onBusy, navigator, onLeaving, onShown }: EditorProps) {
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
  // An animated GIF keeps its frames as they came from disk. The first one is edited on screen, and Save
  // runs the same history on every other frame.
  const [animation, setAnimation] = useState<AnimationInfo | null>(null);
  const [animationPaused, setAnimationPaused] = useState(false);
  // The frames as they were when the picture opened; after a Save the file holds edited ones.
  const animationFrames = useRef<Animation | null>(null);
  // Starts at the last picture's size rather than 1 × 1, so the sizes shown in the panels change once,
  // from that picture to this one, instead of dropping to 1 × 1 while this one loads.
  const [dimensions, setDimensions] = useState(() => lastDimensions);
  useEffect(() => { lastDimensions = dimensions; }, [dimensions]);
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
  const [watermarkText, setWatermarkText] = usePreference("inpaint.watermarkPrompts", WATERMARK_PROMPTS.join(", "));
  const [watermarkMaxPercent, setWatermarkMaxPercent] = usePreference("inpaint.watermarkMaxPercent", 10, (value) => value >= 1 && value <= 100);
  const watermarkOperation: Operation = { kind: "watermark", label: `Remove watermarks · ${model.name}`, prompts: watermarkPrompts(watermarkText), maxPercent: watermarkMaxPercent, model: model.id, prompt };
  const [stageReady, setStageReady] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [restoreMode, setRestoreMode] = useSavedChoice<string>("inpaint.restoreMode", RESTORE_OPTIONS.map((option) => option.id));
  const [restoreStrength, setRestoreStrength] = useSavedChoice<number>("inpaint.restoreStrength", [100, ...Array.from({ length: 21 }, (_, i) => i * 5)]);
  const selectedRestore = RESTORE_OPTIONS.find((option) => option.id === restoreMode)!;
  const [upscaleModel, setUpscaleModel] = useSavedChoice<string>("inpaint.upscaleModel", UPSCALE_OPTIONS.map((option) => option.id));
  const [upscaleScale, setUpscaleScale] = useSavedChoice<number>("inpaint.upscaleScale", [2, 3, 4]);
  // Downscaling: the longest side the picture should have, and the filter that gets it there.
  const [downscaleLongest, setDownscaleLongest] = usePreference("inpaint.downscaleLongest", 2048, (value) => value >= 16 && value <= 32768);
  const [downscaleFilter, setDownscaleFilter] = useSavedChoice<ResizeFilter>("inpaint.downscaleFilter", RESIZE_FILTERS.map((filter) => filter.id));
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

  // The dock on the right shows one panel at a time, chosen in its vertical tabs; "" keeps it closed.
  const [dockTab, setDockTab] = useSavedChoice<DockTab | "">("inpaint.dockTab", ["", "history", "workflows", "batch", "export", "memory", "info", "annotations"]);
  const [workspaceCommand, setWorkspaceCommand] = useState<WorkspaceCommand>({ name: "run-workflow", count: 0 });
  const toolbar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (toolbar.current) toolbar.current.scrollTop = toolbarScroll;
  }, []);
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
  // A handle or the inside of the crop being dragged: which one, where the drag began, and the crop then.
  const cropDrag = useRef<{ handle: string; start: Point; rect: Rect } | null>(null);
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
  // Annotations: the picture's notes, whether they show, drawing a new one and the one being pointed at.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsVisible, setAnnotationsVisible] = usePreference("inpaint.annotationsVisible", true);
  const [annotating, setAnnotating] = useState(false);
  const noteStart = useRef<{ x: number; y: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [notePending, setNotePending] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [pointedNote, setPointedNote] = useState<string | null>(null);
  const [listedNote, setListedNote] = useState<string | null>(null);
  // Picking a point (a smart selection, or the source of the clone stamp or healing brush with Alt) shows a
  // crosshair instead of the brush circle.
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const note = (event: KeyboardEvent) => setAltHeld(event.altKey);
    const release = () => setAltHeld(false);
    window.addEventListener("keydown", note);
    window.addEventListener("keyup", note);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", note);
      window.removeEventListener("keyup", note);
      window.removeEventListener("blur", release);
    };
  }, []);
  const pickingPoint = brushTool === "smart" || ((brushTool === "clone" || brushTool === "heal") && (altHeld || !cloneSource));
  const { stageRef, cursorRef, zoomLabelRef, zoomValueRef, panRef, zoomRef, zoom, setPan, setZoom, glideTo, zoomAround, targetZoom, getViewportBounds, moveCursor, hideCursor } = useCanvasView(
    viewportRef, fitScale, brushSize, !!imageData && !working && !showOriginal && !compare && !cropMode && !selectingFace && !annotating && !pickingPoint,
  );
  const scale = fitScale * zoom;

  // The picture on screen, for the fade when another one opens.
  // "Loading image" only appears when a picture takes a while; a quick switch would just flash it.
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    setSlowLoad(false);
    if (imageData) return;
    const late = window.setTimeout(() => setSlowLoad(true), 450);
    return () => window.clearTimeout(late);
  }, [imageData]);
  const leavingSource = useRef("");
  leavingSource.current = imageData;
  const leaving = useRef(onLeaving);
  leaving.current = onLeaving;

  const clearMask = useCallback(() => {
    const canvas = maskRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setMaskDirty(false);
  }, []);

  // Another picture opens in the same editor, so the panels, the strip and the scroll stay put. What
  // belonged to the last picture is put back, and the picture on screen is handed over to fade out.
  const shownPath = useRef("");
  useEffect(() => {
    let active = true;
    const stage = stageRef.current;
    if (shownPath.current && shownPath.current !== image.path && stage && leavingSource.current) {
      leaving.current?.({ src: leavingSource.current, rect: stage.getBoundingClientRect() });
    }
    shownPath.current = image.path;
    history.reset("");
    setOriginalImageData("");
    setAnimation(null);
    animationFrames.current = null;
    setMessage("");
    clearMask();
    strokeSnapshot.current = null;
    drawing.current = false;
    autoApplyStroke.current = false;
    setFaces([]);
    setSelectingFace(false);
    setSelectedFace(null);
    setAssignments({});
    setCropMode(false);
    setCropRect([0, 0, 1, 1]);
    setCropAngle(0);
    cropStart.current = null;
    setSmartPoints([]);
    setCloneSource(null);
    retouchStroke.current = [];
    setCompare(false);
    setRestorationPreview(null);
    setColorPreview("");
    setAdjustmentActive(false);
    setDeleting(false);
    setAnnotations([]);
    setAnnotating(false);
    noteStart.current = null;
    setNoteDraft(null);
    setNotePending(false);
    setNoteText("");
    setPointedNote(null);
    setListedNote(null);
    if (image.path) {
      void invoke<Annotation[]>("annotations_list", { path: image.path })
        .then((notes) => { if (active) setAnnotations(notes); })
        .catch((error) => { if (active) setMessage(String(error)); });
    }
    setSavePath(/^(png|jpe?g|webp)$/.test(image.extension) ? image.path : "");
    // The GIF plays from its file; its frames are only read when Save edits them all.
    if (!initialData && image.extension === "gif" && image.path) {
      void invoke<AnimationInfo | null>("animation_info", { path: image.path })
        .then((info) => {
          if (!active || !info) return;
          setAnimation(info);
          if (info.editable) setSavePath(image.path);
        })
        .catch(() => undefined);
    }

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
      const note = animation?.editable && path === image.path
        ? await saveAnimation(path)
        : await invoke<string | null>("save_image", { path, imageData });
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
  }, [image.name, image.path, image.extension, savePath, imageData, saving, working, onSaved, animation, history.entries, history.position]);

  /** Runs the edits of the history, up to the one shown, on every frame, and writes the animation. */
  const saveAnimation = async (path: string) => {
    const steps = history.entries.slice(1, history.position + 1);
    const missing = steps.find((entry) => !entry.operation);
    if (missing) throw new Error(`“${missing.label}” cannot be repeated on the other frames`);
    setMessage("Reading the frames…");
    const source = animationFrames.current ?? await invoke<Animation | null>("read_animation", { path });
    if (!source) throw new Error("The picture is no longer animated");
    animationFrames.current = source;
    const frames = [imageData];
    for (let frame = 1; frame < source.frames.length; frame++) {
      let data = source.frames[frame];
      for (const [step, entry] of steps.entries()) {
        setMessage(steps.length > 1
          ? `Editing frame ${frame + 1} of ${source.frames.length} · ${step + 1}/${steps.length} ${entry.label}…`
          : `Editing frame ${frame + 1} of ${source.frames.length}…`);
        data = await executeOperation(data, entry.operation!, source.frames[frame]);
      }
      frames.push(data);
    }
    setMessage("Saving…");
    return invoke<string | null>("save_animation", { path, frames, delays: source.delays });
  };

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
      const operation: Operation = { kind: "inpaint", label: `Inpaint · ${model.name}`, mask: getBinaryMask(), model: model.id, prompt };
      commitEdit(await executeOperation(imageData, operation, originalImageData), operation.label, operation);
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

  useEffect(() => {
    if (!navigator) return;
    navigator.current = (target) => safeNavigate(target - index);
    return () => { navigator.current = null; };
  }, [navigator, safeNavigate, index]);
  useEffect(() => { onBusy?.(working || saving); }, [onBusy, working, saving]);
  const viewportReport = useRef(onViewport);
  viewportReport.current = onViewport;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const report = () => {
      const box = element.getBoundingClientRect();
      // While the strip is open the picture area stops above it; the strip lies in the margin below.
      const below = parseFloat(getComputedStyle(element).marginBottom) || 0;
      viewportReport.current?.({ left: box.left, width: box.width, bottom: box.bottom + below });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  // The picture area only moves when the panels beside it open, close or resize, which the observer sees.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockTab]);
  useEffect(() => { if (stageReady) onShown?.(); }, [stageReady, onShown]);


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

  const runImagePlugin = async (plugin: "gfpgan" | "realesrgan" | "remove_bg" | "face_swap" | "hat" | "lanczos" | "photo", option: string, pluginScale: number, label: string) => {
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
  const downscaleFilterInfo = RESIZE_FILTERS.find((filter) => filter.id === downscaleFilter) ?? RESIZE_FILTERS[0];
  const downscaleOperation: Operation = { kind: "resize", label: `Downscale to ${downscaleLongest} px · ${downscaleFilterInfo.name}`, longest: downscaleLongest, filter: downscaleFilter };
  const downscaleRatio = Math.min(1, downscaleLongest / Math.max(dimensions.width, dimensions.height));
  const downscaled = { width: Math.max(1, Math.round(dimensions.width * downscaleRatio)), height: Math.max(1, Math.round(dimensions.height * downscaleRatio)) };
  const suggestions: Operation[] = [
    downscaleOperation,
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
    watermarkOperation,
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

  /** Marks what watermark detection finds in the mask, to look over and change before removing it. */
  const findWatermarks = async () => {
    if (working || saving || !imageData) return;
    const prompts = watermarkPrompts(watermarkText);
    if (!prompts.length) { setMessage("Write what to look for, such as watermark."); return; }
    setWorking(true); setCropMode(false); setCompare(false); setShowOriginal(false); setSelectingFace(false);
    setMessage("Looking for watermarks…");
    try {
      const result = await imageAction("watermark", imageData, { mode: "detect", prompts, maxPercent: watermarkMaxPercent, model: model.id }) as ActionResult & { found: number; accepted: number };
      pushMaskUndo();
      await displaySelection(result.imageData);
      if (brushTool !== "paint" && brushTool !== "erase") setBrushTool("paint");
      const skipped = result.found - result.accepted;
      setMessage(result.accepted
        ? `Marked ${result.accepted} ${result.accepted === 1 ? "area" : "areas"}${skipped ? `, skipped ${skipped} larger than ${watermarkMaxPercent}%` : ""}. Paint or erase to correct it, then remove it with Space.`
        : skipped ? `Found only areas larger than ${watermarkMaxPercent}% of the picture. Raise the largest size to mark them.` : "No watermark found. Try other words, such as logo or text.");
    } catch (error) { setMessage(`Watermark detection failed: ${String(error)}`); }
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
      const operation: Operation = { kind: "retouch", label: brushTool === "clone" ? "Clone stamp" : "Healing brush", mode: brushTool, source: cloneSource, points, size: brushSize, hardness: brushSettings.hardness / 100, opacity: brushSettings.opacity / 100 };
      const result = await executeOperation(imageData, operation, originalImageData);
      const savedSource = cloneSource;
      commitEdit(result, operation.label, operation); setCloneSource(savedSource);
      setMessage("Retouch applied.");
    } catch (error) { clearMask(); setMessage(`Retouch failed: ${String(error)}`); }
    finally { setWorking(false); }
  };

  const fitImage = useCallback(() => glideTo(1, { x: 0, y: 0 }), [glideTo]);

  const transformImage = async (operation: typeof IMAGE_TRANSFORMS[number]["id"]) => {
    await performOperation({ kind: "transform", direction: operation, label: IMAGE_TRANSFORMS.find((item) => item.id === operation)!.label });
    fitImage();
  };

  const actualSize = useCallback(() => glideTo(1 / fitScale, { x: 0, y: 0 }), [fitScale, glideTo]);

  // Keys zoom around the middle of the view, from where a zoom already running is heading.
  const zoomIn = useCallback(() => zoomAround(Math.min(12, targetZoom.current * 1.2)), [zoomAround, targetZoom]);

  const zoomOut = useCallback(() => zoomAround(Math.max(.2, targetZoom.current / 1.2)), [zoomAround, targetZoom]);

  const toggleCrop = () => {
    if (!cropMode) {
      const ratio = cropRatio * dimensions.height / dimensions.width;
      const width = cropRatio ? Math.min(1, ratio) : 1, height = cropRatio ? Math.min(1, 1 / ratio) : 1;
      setCropRect([(1 - width) / 2, (1 - height) / 2, width, height]);
    }
    setCropMode(!cropMode); setSelectingFace(false); setCompare(false); setShowOriginal(false);
  };
  const cropUsable = cropRect[2] * dimensions.width >= 1 && cropRect[3] * dimensions.height >= 1;
  const applyCrop = () => {
    if (working || saving || !cropUsable) return;
    void performOperation({ kind: "crop", label: `Crop / straighten ${cropAngle}°`, rect: cropRect, angle: cropAngle });
  };
  const cancelCrop = () => { setCropMode(false); setCropAngle(0); };
  // What each shortcut does; the keys come from shortcuts.ts, where the user may change them.
  const keys = useShortcutKeys();
  const toolActions: Partial<Record<ShortcutId, () => void>> = {
    "tool.restore": () => { if (restoreStrength > 0) void performOperation(restoreOperation); },
    "tool.upscale": () => void runImagePlugin(selectedUpscaler.plugin, upscaleModel, upscaleScale, selectedUpscaler.name),
    "tool.downscale": () => {
      if (downscaleRatio >= 1) { setMessage(`The picture is already ${downscaleLongest} px or smaller.`); return; }
      void performOperation(downscaleOperation);
    },
    "tool.gfpgan": () => void runImagePlugin("gfpgan", "gfpgan", 1, "GFPGAN"),
    "tool.faceSwap": () => {
      if (!activeFaceSource) { setMessage("Choose a source photo in Face swap first."); return; }
      void runImagePlugin("face_swap", "", 1, "Face replacement + GFPGAN");
    },
    "tool.removeBackground": () => void runImagePlugin("remove_bg", backgroundModel, 1, "Background removal"),
    "tool.applyBackground": () => {
      if (backgroundType === "image" && !backgroundPath) { setMessage("Choose a background image first."); return; }
      void performOperation(backgroundOperation);
    },
    "tool.detectFaces": () => void detectFaces(),
    "tool.refineEdges": () => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges }),
    "tool.crop": toggleCrop,
    "tool.flipHorizontal": () => void transformImage("flip-horizontal"),
    "tool.flipVertical": () => void transformImage("flip-vertical"),
    "tool.rotateLeft": () => void transformImage("rotate-left"),
    "tool.rotateRight": () => void transformImage("rotate-right"),
  };
  // Panels and the workspace's big actions: the panel opens, and the action runs once it is there.
  const openPanel = (tab: DockTab) => setDockTab(openTab === tab ? "" : tab);
  const askWorkspace = (tab: WorkspaceTab, name: WorkspaceCommand["name"]) => {
    setDockTab(tab);
    // Counted across editors, since the workspace remembers the last one it carried out.
    workspaceCommands += 1;
    setWorkspaceCommand({ name, count: workspaceCommands });
  };
  const editorActions: Partial<Record<ShortcutId, () => void>> = {
    "panel.info": () => { if (image.path) openPanel("info"); },
    "panel.annotations": () => openPanel("annotations"),
    "panel.history": () => openPanel("history"),
    "panel.workflows": () => openPanel("workflows"),
    "panel.batch": () => openPanel("batch"),
    "panel.export": () => openPanel("export"),
    "panel.memory": () => openPanel("memory"),
    "panel.strip": () => { if (total > 1) onStripToggle?.(); },
    "workspace.runWorkflow": () => askWorkspace("workflows", "run-workflow"),
    "workspace.export": () => askWorkspace("export", "export"),
    "workspace.runBatch": () => askWorkspace("batch", "run-batch"),
    "editor.save": () => void save(),
    "editor.undo": () => undo(),
    "editor.redo": () => redo(),
    "editor.original": () => { setCompare(false); setSelectingFace(false); setCropMode(false); setShowOriginal((value) => !value); },
    "editor.previous": () => { if (!working) safeNavigate(-1); },
    "editor.next": () => { if (!working) safeNavigate(1); },
    "editor.first": () => { if (!working) safeNavigate(-index); },
    "editor.last": () => { if (!working) safeNavigate(total - index - 1); },
    "editor.fit": fitImage,
    "editor.actualSize": actualSize,
    "editor.zoomIn": zoomIn,
    "editor.zoomOut": zoomOut,
  };
  const keyOf = (id: ShortcutId) => keys[id] ? keyLabel(keys[id]) : "";

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
      const combo = comboOf(event);
      const shortcut = textEntry ? undefined : shortcutFor(keys, combo);
      // A tool runs with a key held down or not, but never over one already running or a stroke in progress.
      if (shortcut && toolActions[shortcut]) {
        event.preventDefault();
        if (!event.repeat && !working && !saving && !choosingFace && imageData && !drawing.current && !panning.current && !cropStart.current && !cropDrag.current) toolActions[shortcut]!();
        return;
      }
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || textEntry;
      if (drawing.current || panning.current || cropStart.current || cropDrag.current) return;
      // While cropping, Enter applies the crop and Esc leaves it.
      if (cropMode && !textEntry && (event.key === "Enter" || event.key === "Escape")) {
        event.preventDefault();
        if (event.key === "Escape") cancelCrop();
        else if (!event.repeat) applyCrop();
        return;
      }
      // In a list or a slider only keys with a modifier count, so choosing an option by letter still works.
      if (shortcut && editorActions[shortcut] && (!typing || /^(Ctrl|Alt|Meta)\+/.test(combo))) {
        event.preventDefault();
        if (!event.repeat || shortcut.startsWith("editor.zoom")) editorActions[shortcut]!();
        return;
      }
      if (typing) return;
      if (event.code === "Space") {
        if (event.repeat) return;
        spaceDown.current = true;
        hideCursor();
        spaceUsedForPan.current = false;
        event.preventDefault();
      }
      // The keys that always mean the same thing.
      if (event.key === "Escape" && (annotating || notePending)) {
        event.preventDefault();
        noteStart.current = null;
        setNoteDraft(null);
        setNotePending(false);
        setAnnotating(false);
        return;
      }
      if (event.key === "Escape") safeExit();
      if (event.key === "ArrowLeft" && !working) { event.preventDefault(); safeNavigate(-1); }
      if (event.key === "ArrowRight" && !working) { event.preventDefault(); safeNavigate(1); }
      if (combo === "Ctrl+Shift+Z" || combo === "Meta+Shift+Z") { event.preventDefault(); redo(); }
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
  }, [actualSize, fitImage, imageData, index, maskDirty, model, pendingLeave, prompt, redo, resolvePendingLeave, safeExit, safeNavigate, save, total, undo, working, saving, cropMode, selectingFace, compare, showOriginal, zoomIn, zoomOut, toolActions, editorActions, keys, onReplaceCancel, annotating, notePending, cropRect, cropAngle]);

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
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-crop-handle]")?.dataset.cropHandle : undefined;
      if (handle) {
        cropDrag.current = { handle, start: { x: point.x / dimensions.width, y: point.y / dimensions.height }, rect: cropRect };
        return;
      }
      cropStart.current = { x: Math.max(0, Math.min(1, point.x / dimensions.width)), y: Math.max(0, Math.min(1, point.y / dimensions.height)) };
      return;
    }
    if (annotating) {
      noteStart.current = { x: point.x / dimensions.width, y: point.y / dimensions.height };
      setNotePending(false);
      setNoteText("");
      setNoteDraft({ ...noteStart.current, width: 0, height: 0 });
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
      if (pointedNote) setPointedNote(null);
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
    if (noteStart.current) {
      const point = canvasPoint(event);
      if (!point) return;
      const start = noteStart.current;
      const x = Math.max(0, Math.min(1, point.x / dimensions.width));
      const y = Math.max(0, Math.min(1, point.y / dimensions.height));
      setNoteDraft({ x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
      return;
    }
    if (annotationsVisible && annotations.length && !drawing.current) {
      const point = canvasPoint(event);
      const x = point ? point.x / dimensions.width : -1, y = point ? point.y / dimensions.height : -1;
      // The smallest box under the pointer wins, so a note inside a larger one can still be read.
      const under = annotations
        .filter((note) => x >= note.x && x <= note.x + note.width && y >= note.y && y <= note.y + note.height)
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
      if ((under?.id ?? null) !== pointedNote) setPointedNote(under?.id ?? null);
    }
    if (cropMode && cropDrag.current) {
      const point = canvasPoint(event);
      if (!point) return;
      const { handle, start, rect } = cropDrag.current;
      setCropRect(dragCrop(handle, rect, point.x / dimensions.width - start.x, point.y / dimensions.height - start.y,
        cropRatio ? cropRatio * dimensions.height / dimensions.width : 0));
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
    cropDrag.current = null;
    if (noteStart.current) {
      noteStart.current = null;
      // A click, or a box too small to find again, is not a note.
      setNoteDraft((draft) => {
        const big = !!draft && draft.width * dimensions.width >= 6 && draft.height * dimensions.height >= 6 && event.type === "pointerup";
        setNotePending(big);
        return big ? draft : null;
      });
    }
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
      // A wheel notch is one step; a touchpad's small scrolls zoom in proportion, so they stay smooth too.
      const pixels = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      const factor = Math.abs(pixels) >= 50 ? (pixels < 0 ? 1.12 : 1 / 1.12) : Math.exp(-pixels * .0023);
      const nextZoom = Math.min(12, Math.max(0.2, targetZoom.current * factor));
      const viewport = getViewportBounds();
      if (!viewport || nextZoom === targetZoom.current) return;
      zoomAround(nextZoom, { x: event.clientX - viewport.left - viewport.width / 2, y: event.clientY - viewport.top - viewport.height / 2 });
    } else {
      const direction = event.deltaY < 0 ? 1 : -1;
      onBrushSizeChange((value) => Math.min(500, Math.max(3, value + direction * Math.max(2, value * 0.08))));
    }
  };

  // Pictures of Immich-compatible stores also get the Info panel, which reads their record in Immich.
  const immichStore = image.path ? immichStores?.find((store) => store.id === image.storeId || image.path.startsWith(`${store.path.replace(/\/+$/, "")}/`)) : undefined;
  // Every saved picture has an Info panel: Immich's record in a compatible store, ours everywhere else.
  const dockTabs = DOCK_TABS.filter((entry) => entry.id !== "info" || image.path);
  const openTab = dockTabs.some((entry) => entry.id === dockTab) ? dockTab : "";

  const saveNote = async () => {
    const draft = noteDraft;
    const text = noteText.trim();
    if (!draft || !text || !image.path) return;
    try {
      const note = await invoke<Annotation>("annotation_create", { path: image.path, ...draft, text });
      setAnnotations((current) => [...current, note]);
      setNoteDraft(null);
      setNotePending(false);
      setNoteText("");
    } catch (error) {
      setMessage(String(error));
    }
  };
  const editNote = async (id: string, text: string) => {
    try {
      await invoke("annotation_update", { id, text });
      setAnnotations((current) => current.map((note) => (note.id === id ? { ...note, text: text.trim() } : note)));
    } catch (error) {
      setMessage(String(error));
    }
  };
  const deleteNote = async (id: string) => {
    try {
      await invoke("annotation_delete", { id });
      setAnnotations((current) => current.filter((note) => note.id !== id));
    } catch (error) {
      setMessage(String(error));
    }
  };
  // Drawing a note only makes sense while its panel is open.
  useEffect(() => {
    if (openTab === "annotations") return;
    setAnnotating(false);
    noteStart.current = null;
    setNoteDraft(null);
    setNotePending(false);
    setListedNote(null);
  }, [openTab]);

  // The rail opens a tool wherever it sits, and dragging a heading or a rail button reorders them.
  const [toolOrder, setToolOrder] = usePreference<string[]>("inpaint.toolOrder", []);
  const [opened, setOpened] = useState({ id: "", count: 0 });
  const openSignal = (id: string) => (opened.id === id ? opened.count : 0);
  const sectionIds = useRef<string[]>([]);
  const moveSection = useCallback((moved: string, before: string) => {
    const ids = sectionIds.current;
    if (!ids.includes(moved) || !ids.includes(before)) return;
    const next = ids.filter((id) => id !== moved);
    next.splice(next.indexOf(before), 0, moved);
    setToolOrder(next);
  }, [setToolOrder]);
  const showSection = (id: string) => {
    setOpened((current) => ({ id, count: current.id === id ? current.count + 1 : 1 }));
    // The section opens on the next render, so the scroll waits for it to take its height.
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`tool-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })));
  };

  // The tools of the left panel: the rail lists them, and their headings drag into another order.
  const sectionEntries: SectionEntry[] = [
    { id: "comparison", title: "Comparison", icon: Eye, node: (
            <ToolSection id="comparison" title="Comparison" icon={Eye} openSignal={openSignal("comparison")} onMove={moveSection}>
              <button className={`plugin-run ${compare ? "active" : ""}`} disabled={working || saving} onClick={() => { setCompare(!compare); setShowOriginal(false); setCropMode(false); setSelectingFace(false); }}>Before / after slider</button>
              {compare && <><Select aria-label="Compare against" value={compareWith} onChange={(e) => setCompareWith(e.target.value)}><option value="previous">Before the current step</option><option value="original">Original image</option></Select><input aria-label="Comparison position" type="range" min="0" max="100" value={divider} onChange={(e) => setDivider(+e.target.value)} /><div className="plugin-description">Before on the left, after on the right. Zoom and pan are linked. Before fits the current frame.</div></>}
            </ToolSection>
    ) },
    ...advancedSections({ openSignal, onMove: moveSection, busy: operationWorking || previewBusy || saving, tool: brushTool, onTool: (tool) => { setBrushTool(tool); setCropMode(false); setCompare(false); setShowOriginal(false); setSelectingFace(false); }, brush: brushSettings, setBrush: setBrushSettings, size: brushSize, setSize: onBrushSizeChange, maskDirty: maskDirty, refineMask: () => void refineSelection(), resetPoints: () => setSmartPoints([]), pointCount: smartPoints.length, sourceSet: cloneSource !== null, adjustmentActive: adjustmentActive, adjustments: adjustments, onAdjust: setAdjustments, onStartAdjust: () => { setAdjustmentActive(true); setCompare(false); setCropMode(false); setShowOriginal(false); setSelectingFace(false); }, onApplyAdjust: () => void applyColorAdjustments(), onCancelAdjust: () => { setAdjustmentActive(false); setColorPreview(""); }, edges: edges, setEdges: setEdges, onEdges: () => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges }), extension: extension, setExtension: setExtension, onExtend: () => void performOperation({ kind: "outpaint", label: "Extend canvas", ...extension }), width: dimensions.width, height: dimensions.height }),
    ...(cropMode ? [{ id: "crop", title: "Crop and straighten", icon: Crop, node: (
            <ToolSection id="crop" title="Crop and straighten" icon={Crop} openSignal={openSignal("crop")} onMove={moveSection}>
              <Select aria-label="Crop aspect ratio" value={cropRatio} onChange={(e) => {
                const ratio = +e.target.value; setCropRatio(ratio);
                const normalized = ratio * dimensions.height / dimensions.width;
                const w = ratio ? Math.min(1, normalized) : 1, h = ratio ? Math.min(1, 1 / normalized) : 1;
                setCropRect([(1 - w) / 2, (1 - h) / 2, w, h]);
              }}><option value="0">Free crop</option><option value="1">Square · 1:1</option><option value={4 / 3}>Landscape · 4:3</option><option value={3 / 2}>Photo · 3:2</option><option value={16 / 9}>Wide · 16:9</option><option value={3 / 4}>Portrait · 3:4</option><option value={2 / 3}>Portrait · 2:3</option><option value={9 / 16}>Tall · 9:16</option></Select>
              <div className="denoise-control"><label htmlFor="straighten">Straighten <output>{cropAngle}°</output></label><input id="straighten" type="range" min="-15" max="15" step="0.1" value={cropAngle} onChange={(e) => setCropAngle(+e.target.value)} /></div>
              <div className="plugin-description">Drag on the image to choose the crop, then drag its edges, corners or inside to adjust it. Enter applies it, Esc cancels. Rotated corners become transparent.</div>
              <div className="plugin-figure">Output: {Math.round(cropRect[2] * dimensions.width)} × {Math.round(cropRect[3] * dimensions.height)} px</div>
              <button className="plugin-run" disabled={working || saving || !cropUsable} onClick={applyCrop}>Apply crop <kbd>Enter</kbd></button>
              <button className="plugin-run" disabled={working || saving} onClick={cancelCrop}>Cancel crop <kbd>Esc</kbd></button>
            </ToolSection>
    ) }] : []),
    { id: "watermarks", title: "Watermarks", icon: Stamp, node: (
            <ToolSection id="watermarks" title="Watermarks" icon={Stamp} openSignal={openSignal("watermarks")} onMove={moveSection}>
              <div className="denoise-control"><label htmlFor="watermark-prompts">Look for</label>
                <input id="watermark-prompts" className="prompt-input watermark-prompts" value={watermarkText} maxLength={400} disabled={operationWorking || saving}
                  onChange={(event) => setWatermarkText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void findWatermarks(); }}
                  placeholder={WATERMARK_PROMPTS.join(", ")} title="Phrases separated by commas; each one finds a mark" /></div>
              <div className="denoise-control"><label htmlFor="watermark-size">Largest watermark <output>{watermarkMaxPercent}%</output></label>
                <input id="watermark-size" type="range" min="1" max="60" value={watermarkMaxPercent} disabled={operationWorking || saving} onChange={(event) => setWatermarkMaxPercent(+event.target.value)} /></div>
              <div className="plugin-description">Florence-2 marks what it finds (1.5 GB download on first use). Look it over, then remove it with {model.name}. Larger areas are usually the subject, so they are skipped.</div>
              <button className="plugin-run" disabled={working || saving || !imageData} onClick={() => void findWatermarks()}>Find and mark</button>
              <button className="plugin-run" disabled={working || saving || !imageData || !watermarkOperation.prompts.length} onClick={() => void performOperation(watermarkOperation)}>Find and remove at once</button>
            </ToolSection>
    ) },
    { id: "restoration-strength", title: "Restoration strength", icon: Gauge, node: (
            <ToolSection id="restoration-strength" title="Restoration strength" icon={Gauge} openSignal={openSignal("restoration-strength")} onMove={moveSection}>
              <div className="denoise-control"><label htmlFor="restoration-strength">GFPGAN + face replacement <output>{restorationStrength}%</output></label><input id="restoration-strength" type="range" min="0" max="100" value={restorationStrength} disabled={operationWorking || saving} onChange={(e) => setRestorationStrength(+e.target.value)} /><div><span>Raw face</span><span>Restored face</span></div></div>
              <div className="plugin-description">Shared by both tools. {restorationPreview ? "Adjusts the last result instantly without rerunning the model." : "Applied to the next restoration or replacement."}</div>
            </ToolSection>
    ) },
    { id: "face-swap", title: "Face swap", icon: UserRound, node: (
            <ToolSection id="face-swap" title="Face swap" icon={UserRound} openSignal={openSignal("face-swap")} onMove={moveSection}>
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
              <button className="plugin-run" disabled={working || saving || !imageData} onClick={() => void detectFaces()}>Detect / choose a face{keyOf("tool.detectFaces") && <kbd className="action-shortcut">{keyOf("tool.detectFaces")}</kbd>}</button>
              {faces.length > 0 && <><Select aria-label="Target face" value={selectedFace?.id ?? "largest"} disabled={working || saving} onChange={(e) => { setSelectedFace(faces.find((face) => face.id === +e.target.value) ?? null); setSelectingFace(true); }}><option value="largest">Largest face</option>{faces.map((face) => <option key={face.id} value={face.id}>Face {face.id + 1}{assignments[face.id] ? " · assigned" : ""}</option>)}</Select><button className="plugin-run" disabled={working || saving} onClick={() => setSelectingFace(!selectingFace)}>{selectingFace ? "Hide face boxes" : "Show face boxes"}</button></>}
              <button
                className="plugin-run"
                onClick={() => void runImagePlugin("face_swap", "", 1, "Face replacement + GFPGAN")}
                disabled={!activeFaceSource || !imageData || working || saving || choosingFace}
              ><Play size={13} /> Replace{keyOf("tool.faceSwap") && <kbd className="action-shortcut">{keyOf("tool.faceSwap")}</kbd>}</button>
              <div className="plugin-description">{selectedFace ? `Replaces face ${selectedFace.id + 1}` : "Replaces the largest face"}, then restores it with GFPGAN. Select each face to assign a different source.</div>
              {Object.keys(assignments).length > 1 && <button className="plugin-run" disabled={working || saving} onClick={() => void runWorkflow(faces.filter((face) => assignments[face.id]).map((face) => ({ kind: "face", label: `Replace face ${face.id + 1}`, donor: assignments[face.id].path, strength: restorationStrength / 100, target: [face.box[0] + face.box[2] / 2, face.box[1] + face.box[3] / 2] })), "Replace assigned faces")}>Replace all assigned faces</button>}
            </ToolSection>
    ) },
    { id: "face-restoration", title: "Face restoration", icon: ScanFace, node: (
            <ToolSection id="face-restoration" title="Face restoration" icon={ScanFace} openSignal={openSignal("face-restoration")} onMove={moveSection}>
              <div className="plugin-description">Restore facial detail with GFPGAN 1.4.</div>
              <button
                className="plugin-run"
                onClick={() => void runImagePlugin("gfpgan", "gfpgan", 1, "GFPGAN")}
                disabled={working || saving}
              ><Play size={13} /> Run GFPGAN{keyOf("tool.gfpgan") && <kbd className="action-shortcut">{keyOf("tool.gfpgan")}</kbd>}</button>
            </ToolSection>
    ) },
    { id: "restore", title: "Restore detail", icon: Sparkles, node: (
            <ToolSection id="restore" title="Restore detail" icon={Sparkles} openSignal={openSignal("restore")} onMove={moveSection}>
              <Select aria-label="Restoration mode" value={restoreMode} onChange={(event) => setRestoreMode(event.target.value)} disabled={working || saving}>
                {RESTORE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </Select>
              <div className="plugin-description">{selectedRestore.description}</div>
              <div className="denoise-control"><label htmlFor="restore-strength">Restoration strength <output>{restoreStrength}%</output></label>
                <input id="restore-strength" type="range" min="0" max="100" step="5" value={restoreStrength} disabled={working || saving} onChange={(event) => setRestoreStrength(+event.target.value)} />
                <div><span>Original</span><span>Restored</span></div>
              </div>
              <div className="plugin-description">Keeps the picture's size and transparency. Strength applies on the next run. Downloads {selectedRestore.download} on first use.</div>
              <div className="plugin-figure">{dimensions.width} × {dimensions.height} px</div>
              <button className="plugin-run" disabled={!imageData || working || saving || restoreStrength === 0} onClick={() => void performOperation(restoreOperation)}><Play size={13} /> Restore detail{keyOf("tool.restore") && <kbd className="action-shortcut">{keyOf("tool.restore")}</kbd>}</button>
            </ToolSection>
    ) },
    { id: "upscale", title: "Upscale", icon: Maximize2, node: (
            <ToolSection id="upscale" title="Upscale" icon={Maximize2} openSignal={openSignal("upscale")} onMove={moveSection}>
              <Select aria-label="Upscaling method" value={upscaleModel} onChange={(event) => setUpscaleModel(event.target.value)} disabled={working || saving}>
                {UPSCALE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </Select>
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
              <Select aria-label="Upscale output factor" value={upscaleScale} onChange={(event) => setUpscaleScale(Number(event.target.value))} disabled={working || saving}>
                <option value={2}>Output scale · 2×</option>
                <option value={3}>Output scale · 3×</option>
                <option value={4}>Output scale · 4×</option>
              </Select>
              <button
                className="plugin-run"
                onClick={() => void runImagePlugin(selectedUpscaler.plugin, upscaleModel, upscaleScale, selectedUpscaler.name)}
                disabled={!imageData || working || saving}
              ><Play size={13} /> Upscale image{keyOf("tool.upscale") && <kbd className="action-shortcut">{keyOf("tool.upscale")}</kbd>}</button>
            </ToolSection>
    ) },
    { id: "downscale", title: "Downscale", icon: Minimize2, node: (
            <ToolSection id="downscale" title="Downscale" icon={Minimize2} openSignal={openSignal("downscale")} onMove={moveSection}>
              <Select aria-label="Downscaling filter" value={downscaleFilter} disabled={working || saving} onChange={(event) => setDownscaleFilter(event.target.value as ResizeFilter)}>
                {RESIZE_FILTERS.map((filter) => <option key={filter.id} value={filter.id}>{filter.name}</option>)}
              </Select>
              <div className="plugin-description">{downscaleFilterInfo.description} Plain resampling, no AI.</div>
              <label className="downscale-size">Longest side
                <input type="number" min={16} max={32768} step={1} value={downscaleLongest} disabled={working || saving}
                  onChange={(event) => { const value = Math.round(Number(event.target.value)); if (value >= 16 && value <= 32768) setDownscaleLongest(value); }} />
                <span>px</span>
              </label>
              <div className="downscale-presets">
                {[0.5, 0.25].map((part) => {
                  const value = Math.max(16, Math.round(Math.max(dimensions.width, dimensions.height) * part));
                  return <button key={part} type="button" disabled={working || saving} onClick={() => setDownscaleLongest(value)}>{part * 100}%</button>;
                })}
                {[3840, 2560, 1920, 1280].map((value) => <button key={value} type="button" className={downscaleLongest === value ? "active" : ""}
                  disabled={working || saving} onClick={() => setDownscaleLongest(value)}>{value}</button>)}
              </div>
              <div className="plugin-figure">{downscaleRatio < 1
                ? `${dimensions.width} × ${dimensions.height} → ${downscaled.width} × ${downscaled.height} px`
                : `Already ${dimensions.width} × ${dimensions.height} px`}</div>
              <button className="plugin-run" disabled={!imageData || working || saving || downscaleRatio >= 1} onClick={() => void performOperation(downscaleOperation)}>
                <Play size={13} /> Downscale{keyOf("tool.downscale") && <kbd className="action-shortcut">{keyOf("tool.downscale")}</kbd>}
              </button>
            </ToolSection>
    ) },
    { id: "remove-background", title: "Remove background", icon: ImageOff, node: (
            <ToolSection id="remove-background" title="Remove background" icon={ImageOff} openSignal={openSignal("remove-background")} onMove={moveSection}>
              <Select value={backgroundModel} onChange={(event) => setBackgroundModel(event.target.value)}>
                <option value="briaai/RMBG-1.4">BRIA RMBG 1.4 · No login</option>
                <option value="briaai/RMBG-2.0">BRIA RMBG 2.0 · Requires access</option>
                <option value="u2net">U²-Net · General</option>
                <option value="u2net_human_seg">U²-Net · People</option>
              </Select>
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
              ><Play size={13} /> Remove background{keyOf("tool.removeBackground") && <kbd className="action-shortcut">{keyOf("tool.removeBackground")}</kbd>}</button>
            
              <BackgroundEdgeTools refineKey={keyOf("tool.refineEdges")} openSignal={openSignal} onMove={moveSection} busy={operationWorking || previewBusy || saving} adjustmentActive={adjustmentActive} edges={edges} setEdges={setEdges} onEdges={() => void performOperation({ kind: "refine_edges", label: "Refine background edges", ...edges })} />
            </ToolSection>
    ) },
    { id: "replace-background", title: "Replace background", icon: ImagePlus, node: (
            <ToolSection id="replace-background" title="Replace background" icon={ImagePlus} openSignal={openSignal("replace-background")} onMove={moveSection}>
              <Select aria-label="Background replacement type" value={backgroundType} disabled={working || saving} onChange={(e) => setBackgroundType(e.target.value as typeof backgroundType)}><option value="color">Solid color</option><option value="image">Another image</option><option value="blur">Blur original background</option></Select>
              {backgroundType === "color" && <input aria-label="Background color" type="color" value={backgroundColor} disabled={working || saving} onChange={(e) => setBackgroundColor(e.target.value)} />}
              {backgroundType === "image" && <><button className="plugin-run" disabled={working || saving} onClick={async () => { try { const selected = await open({ title: "Choose background image", filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] }); if (typeof selected === "string") setBackgroundPath(selected); } catch (error) { setMessage(String(error)); } }}>Choose background image</button><div className="plugin-description path-text">{backgroundPath || "No background selected"}</div></>}
              {backgroundType === "blur" && <div className="denoise-control"><label htmlFor="background-blur">Blur <output>{backgroundBlur} px</output></label><input id="background-blur" type="range" min="1" max="100" value={backgroundBlur} disabled={working || saving} onChange={(e) => setBackgroundBlur(+e.target.value)} /></div>}
              <label className="check-label"><input type="checkbox" checked={removeFirst} disabled={working || saving} onChange={(e) => setRemoveFirst(e.target.checked)} /> Remove background first</label>
              <div className="plugin-description">Uses the selected removal model. Turn off removal if the image already has transparency.</div>
              <button className="plugin-run" disabled={working || saving || (backgroundType === "image" && !backgroundPath)} onClick={() => void performOperation(backgroundOperation)}>Apply background{keyOf("tool.applyBackground") && <kbd className="action-shortcut">{keyOf("tool.applyBackground")}</kbd>}</button>
            </ToolSection>
    ) },
  ];
  const placed = (id: string) => { const at = toolOrder.indexOf(id); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
  const ordered = [...sectionEntries].sort((a, b) => placed(a.id) - placed(b.id));
  sectionIds.current = ordered.map((section) => section.id);

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
          {image.path && <button className="icon-button danger" title="Delete this picture" aria-label="Delete this picture" disabled={working || saving || deleting} onClick={() => void deletePicture()}><Trash2 size={18} /></button>}
          <button className="save-button" onClick={() => void save()} disabled={(!dirty && !!savePath) || saving || working}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save
          </button>
          <button className="apply-button" onClick={() => void applyInpaint()} disabled={!maskDirty || working || saving || cropMode || selectingFace || compare || showOriginal}>
            {working ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
            {/* Both labels stay in the button, so it keeps one width while it works. */}
            <span className="apply-label">
              <span className={working ? "apply-hidden" : ""}><span>Remove object</span><kbd>Space</kbd></span>
              <span className={working ? "" : "apply-hidden"}>Working…</span>
            </span>
          </button>
        </div>
      </header>

      <div className="editor-body">
        <aside
          className="plugin-toolbar"
          ref={toolbar}
          onScroll={(event) => { toolbarScroll = event.currentTarget.scrollTop; }}
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

          {ordered.map((section) => <Fragment key={section.id}>{section.node}</Fragment>)}
        </aside>
        <nav className="tool-rail" aria-label="Tools">
          {ordered.map(({ id, title, icon: Icon }) => (
            <button key={id} title={title} aria-label={title} draggable
              onClick={() => showSection(id)}
              onDragStart={(event) => { event.dataTransfer.setData(SECTION_DRAG, id); event.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(event) => { if (event.dataTransfer.types.includes(SECTION_DRAG)) event.preventDefault(); }}
              onDrop={(event) => { const moved = event.dataTransfer.getData(SECTION_DRAG); if (moved && moved !== id) { event.preventDefault(); moveSection(moved, id); } }}>
              <Icon size={17} aria-hidden="true" />
            </button>
          ))}
        </nav>
      <div
        ref={viewportRef}
        className={`editor-viewport ${stripOpen && total > 1 ? "strip-open" : ""} ${panning.current ? "panning" : ""} ${cropMode || selectingFace || compare || annotating || pickingPoint ? "selection-mode" : ""}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onLostPointerCapture={pointerUp}
        onPointerLeave={hideCursor}
        onWheel={wheel}
        onContextMenu={(event) => event.preventDefault()}
      >
        {!imageData ? (slowLoad ? <div className="editor-loading"><span className="spinner" />Loading image</div> : null) : (
          <div
            ref={stageRef}
            className={`image-stage ${stageReady ? "" : "initializing"}`}
            style={{
              width: dimensions.width,
              height: dimensions.height,
              transform: `translate(-50%, -50%) translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${fitScale * zoomRef.current})`,
            }}
          >
            <div className="image-clip"><img src={imageData} style={cropMode ? { transform: `rotate(${cropAngle}deg)` } : undefined} onLoad={onImageLoad} draggable={false} alt={image.name} />{colorPreview && <img src={colorPreview} draggable={false} alt="Color adjustment preview" />}
              {animation && !animationPaused && history.position === 0 && !maskDirty && !cropMode && !compare && !showOriginal && !colorPreview && !selectingFace
                && <img className="animation-frame" src={`${convertFileSrc(image.path, "thumb")}?v=${image.size}-${image.modifiedMs}&original`} draggable={false} alt="" />}</div>
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
            {!cropMode && annotations.map((note) => {
              const pointedHere = pointedNote === note.id || listedNote === note.id;
              if (!annotationsVisible && listedNote !== note.id) return null;
              return <div key={note.id} className={`annotation ${pointedHere ? "active" : ""}`}
                style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%`, width: `${note.width * 100}%`, height: `${note.height * 100}%`, borderWidth: "calc(1px / var(--image-scale, 1))" }}>
                {pointedHere && <span style={{ fontSize: "calc(12px / var(--image-scale, 1))", padding: "calc(4px / var(--image-scale, 1)) calc(6px / var(--image-scale, 1))", borderRadius: "calc(4px / var(--image-scale, 1))" }}>{note.text}</span>}
              </div>;
            })}
            {noteDraft && <div className="annotation drafting"
              style={{ left: `${noteDraft.x * 100}%`, top: `${noteDraft.y * 100}%`, width: `${noteDraft.width * 100}%`, height: `${noteDraft.height * 100}%`, borderWidth: "calc(1px / var(--image-scale, 1))" }} />}
            {noteDraft && notePending && <form className="annotation-editor" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
              style={{ left: `${noteDraft.x * 100}%`, top: `${(noteDraft.y + noteDraft.height) * 100}%`, width: "calc(260px / var(--image-scale, 1))", fontSize: "calc(13px / var(--image-scale, 1))", marginTop: "calc(6px / var(--image-scale, 1))", padding: "calc(6px / var(--image-scale, 1))", borderRadius: "calc(7px / var(--image-scale, 1))" }}
              onSubmit={(event) => { event.preventDefault(); void saveNote(); }}>
              <textarea autoFocus value={noteText} placeholder="Write the note" rows={2} maxLength={2000}
                onChange={(event) => setNoteText(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void saveNote(); }
                  else if (event.key === "Escape") { event.preventDefault(); setNoteDraft(null); setNotePending(false); }
                }} />
              <small>Enter saves · Shift+Enter adds a line · Esc cancels</small>
            </form>}
            {cropMode && <div className="crop-outline" style={{ left: `${cropRect[0] * 100}%`, top: `${cropRect[1] * 100}%`, width: `${cropRect[2] * 100}%`, height: `${cropRect[3] * 100}%`, borderWidth: "calc(1px / var(--image-scale, 1))" }}><i /><i />
              <span className="crop-move" data-crop-handle="move" />
              {CROP_HANDLES.map((handle) => <span key={handle} className={`crop-handle ${handle}`} data-crop-handle={handle} />)}
            </div>}
            {selectingFace && faces.map((face) => <button key={face.id} className={`face-box ${selectedFace?.id === face.id ? "selected" : ""}`} style={{ left: `${face.box[0] * 100}%`, top: `${face.box[1] * 100}%`, width: `${face.box[2] * 100}%`, height: `${face.box[3] * 100}%`, borderWidth: "calc(2px / var(--image-scale, 1))" }} aria-label={`Select face ${face.id + 1}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => { setSelectedFace(face); setMessage(`Face ${face.id + 1} selected. Choose a source photo or press Replace.`); }}><span style={{ fontSize: "calc(12px / var(--image-scale, 1))" }}>Face {face.id + 1}{assignments[face.id] ? " · assigned" : ""}</span></button>)}
          </div>
        )}


        <div ref={cursorRef} className="brush-cursor" aria-hidden="true" />
        <button className={`nav-button previous ${total < 2 ? "gone" : ""}`} onClick={() => safeNavigate(-1)} disabled={total < 2 || working || saving} title="Previous image (Left arrow)"><ArrowLeft size={21} /></button>
        <button className={`nav-button strip ${stripOpen ? "active" : ""} ${total < 2 ? "gone" : ""}`} onClick={() => onStripToggle?.()} disabled={total < 2}
          aria-pressed={stripOpen} title={stripOpen ? "Hide the picture strip" : "Show the picture strip"}><LayoutGrid size={19} /></button>
        <button className={`nav-button next ${total < 2 ? "gone" : ""}`} onClick={() => safeNavigate(1)} disabled={total < 2 || working || saving} title="Next image (Right arrow)"><ArrowRight size={21} /></button>
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
            <div><kbd>← / →</kbd><span>Previous / next image</span></div>
            <div><kbd>Esc</kbd><span>Back to browser</span></div>
            {SHORTCUTS.filter((shortcut) => keys[shortcut.id]).map((shortcut) => <div key={shortcut.id}><kbd>{keyLabel(keys[shortcut.id])}</kbd><span>{shortcut.label}</span></div>)}
            <small>Change these in Settings · Shortcuts.</small>
            <div><kbd>Alt + click</kbd><span>Sample clone / healing source, or exclude smart selection</span></div>
          </div>
        </div>
        {animation && imageData && <button className={`animation-badge ${history.position > 0 ? "edited" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          disabled={history.position > 0}
          onClick={() => setAnimationPaused((paused) => !paused)}
          title={history.position > 0 ? (animation.editable ? `Edits are shown on the first frame. Save applies them to all ${animation.frames} frames.` : "This animation is too long to edit every frame, so Save keeps only the edited first frame, as a new picture.") : animationPaused ? "Play the animation" : "Pause the animation"}>
          {history.position > 0 || animationPaused ? <Play size={13} /> : <Pause size={13} />}
          <span>{history.position > 0 ? (animation.editable ? `Frame 1 of ${animation.frames} · Save edits every frame` : `Frame 1 of ${animation.frames} · Saved as a still`) : `GIF · ${animation.frames} frames`}</span>
        </button>}
        {message && <div className={`toast ${message.includes("failed") ? "error" : ""}`}>{message}</div>}
      </div>
        <div className="right-dock">
          {/* The tabs stand on the panel's edge, so every panel is one click away and none hides another. */}
          <nav className="dock-rail" aria-label="Side panels">
            {dockTabs.map(({ id, label, icon: Icon }) => (
              <button key={id} className={openTab === id ? "active" : ""} title={keyOf(`panel.${id}` as ShortcutId) ? `${label} (${keyOf(`panel.${id}` as ShortcutId)})` : label} aria-pressed={openTab === id}
                onClick={() => setDockTab(openTab === id ? "" : id)}>
                <Icon size={17} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </nav>
          {openTab === "info" && image.path && (immichStore
            ? <ImmichPanel key={image.path} path={image.path} storeId={immichStore.id} onClose={() => setDockTab("")} />
            : <PictureInfo key={image.path} path={image.path} onClose={() => setDockTab("")} />)}
          {openTab === "annotations" && <AnnotationsPanel annotations={annotations} available={!!image.path} visible={annotationsVisible} drawing={annotating}
            onVisible={setAnnotationsVisible} onDrawing={(on) => { setAnnotating(on); if (!on) { setNoteDraft(null); setNotePending(false); } }}
            onHover={setListedNote} onEdit={(id, text) => void editNote(id, text)} onDelete={(id) => void deleteNote(id)} onClose={() => setDockTab("")} />}
          {openTab && openTab !== "info" && openTab !== "annotations" && <Workspace tab={openTab} onClose={() => setDockTab("")} command={workspaceCommand}
            data={imageData} name={image.name} dimensions={dimensions} history={history.entries} position={history.position}
            onJump={jumpHistory} suggestions={suggestions} busy={working || saving} onBusy={setWorking} onMessage={setMessage} onRun={runWorkflow} />}
        </div>
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
