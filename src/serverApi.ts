import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { executeOperation, imageAction, loadImage, RESTORE_MODES, RESTORMER_MODES, type Adjustments, type Operation, type Plugin, type Rect } from "./editorOperations";
import { INPAINT_MODELS } from "./models";
import { FACE_SOURCE_PREFERENCE } from "./preferences";
import { storage } from "./storage";

/** A request forwarded by the local API server (src-tauri/src/server.rs). */
type ServerJob = {
  id: number;
  kind: "operation" | "workflow" | "load" | "operations" | "workflows" | "face-source";
  name?: string;
  options?: Record<string, unknown>;
  image?: string;
  mask?: string;
  donorPath?: string;
  backgroundPath?: string;
  sourcePath?: string | null;
  fileName?: string;
};
type JobReply = { ok: boolean; image?: string; data?: unknown; error?: string; status?: number };
export type LoadRequest = { data: string; path: string; name: string };
type Workflow = { id: string; name: string; steps: Operation[] };

/** A problem with the request itself, reported with an HTTP status other than 500. */
class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// `editor` reads the editor's current setting, used when a request leaves the option out.
type Field = (
  | { type: "number"; default: number; min: number; max: number; integer: boolean }
  | { type: "choice"; default: string; values: readonly string[]; aliases?: Record<string, string> }
  | { type: "text" | "color"; default: string }
  | { type: "boolean"; default: boolean }
  | { type: "rect"; default: Rect }
  | { type: "point"; default: null }
) & { editor?: () => unknown };
type Input = { name: "mask" | "donor" | "background"; required: boolean; description: string };
type Values = Record<string, unknown>;
type Spec = {
  summary: string;
  inputs?: Input[];
  fields: Record<string, Field>;
  run: (image: string, values: Values, job: ServerJob) => Promise<string | { data: unknown }>;
};

const range = (value: number, min: number, max: number, integer = false): Field => ({ type: "number", default: value, min, max, integer });
const choice = (value: string, values: readonly string[]): Field => ({ type: "choice", default: value, values });
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const run = (image: string, operation: Operation) => executeOperation(image, operation, image);

const INPAINT_IDS = INPAINT_MODELS.map((model) => model.id);
const BACKGROUND_MODELS = ["briaai/RMBG-1.4", "u2net", "u2net_human_seg", "briaai/RMBG-2.0"];
const UPSCALERS: Record<string, Plugin> = {
  "hat-sharper": "hat", RealESRGAN_x4plus: "realesrgan", "realesr-general-x4v3": "realesrgan", RealESRGAN_x4plus_anime_6B: "realesrgan", lanczos: "lanczos",
};
const TRANSFORMS = [
  ["flip-horizontal", "Flip horizontally"], ["flip-vertical", "Flip vertically"], ["rotate-left", "Rotate left 90°"], ["rotate-right", "Rotate right 90°"],
] as const;
const ADJUSTMENTS = ["contrast", "temperature", "saturation", "shadows", "highlights"] as const;

// The editor keeps its settings in Inpaint's preferences: choices as plain strings, everything else as JSON.
function savedText(key: string): string | undefined {
  try { return storage.getItem(key) ?? undefined; } catch { return undefined; }
}
function savedJson(key: string): unknown {
  const text = savedText(key);
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
}
function savedNumber(key: string, divisor = 1) {
  const text = savedText(key);
  return text !== undefined && Number.isFinite(Number(text)) ? Number(text) / divisor : undefined;
}
function savedPart(key: string, part: string) {
  const value = savedJson(key);
  return value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
}
const fromEditor = (field: Field, editor: () => unknown): Field => ({ ...field, editor });
const restorationStrength = () => savedNumber("inpaint.restorationStrength", 100);
const backgroundModel = () => savedText("inpaint.backgroundModel");

// Options left out of a request take the editor's current setting through `editor`; `default`
// is the editor's own default. GET /operations publishes this table with the values in effect.
const OPERATIONS: Record<string, Spec> = {
  inpaint: {
    summary: "Remove what the mask marks white.",
    inputs: [{ name: "mask", required: true, description: "Black and white image the size of the picture; white is removed." }],
    fields: {
      model: fromEditor(choice("lama", INPAINT_IDS), () => savedText("inpaint.model")),
      prompt: fromEditor({ type: "text", default: "" }, () => savedJson("inpaint.prompt")),
    },
    run: (image, v, job) => invoke<string>("run_inpaint", { imageData: image, maskData: job.mask, model: v.model, prompt: v.prompt }),
  },
  "face-swap": {
    summary: "Replace the largest face, or the face at target, with the largest face in the face source photo, then restore it with GFPGAN.",
    inputs: [{ name: "donor", required: false, description: "Photo with the face to use. Defaults to the face source photo selected in Inpaint." }],
    fields: {
      strength: fromEditor(range(1, 0, 1), restorationStrength),
      colorMatch: fromEditor(range(0, 0, 1), () => savedNumber("inpaint.faceColorMatch", 100)),
      target: { type: "point", default: null },
    },
    run: (image, v, job) => {
      const donor = job.donorPath || savedFaceSourcePath();
      if (!donor) throw new RequestError("Choose a face source photo in the Face swap section of Inpaint, or send \"donor\".");
      return run(image, {
        kind: "face", label: "Face replacement", donor, strength: v.strength as number,
        colorMatch: v.colorMatch as number, target: (v.target as [number, number] | null) ?? undefined,
      });
    },
  },
  "detect-faces": {
    summary: "Find faces. Returns boxes as [x, y, width, height] fractions; a box center works as face-swap's target.",
    fields: {},
    run: async (image) => ({ data: (await imageAction("detect_faces", image)).faces }),
  },
  "restore-faces": {
    summary: "Restore facial detail with GFPGAN 1.4.",
    fields: { strength: fromEditor(range(1, 0, 1), restorationStrength) },
    run: (image, v) => run(image, { kind: "plugin", label: "GFPGAN", plugin: "gfpgan", option: "gfpgan", scale: 1, denoise: .25, strength: v.strength as number }),
  },
  upscale: {
    summary: "Enlarge with Real-HAT, RealESRGAN, or Lanczos without AI. denoise applies to realesr-general-x4v3.",
    fields: {
      method: fromEditor(choice("hat-sharper", Object.keys(UPSCALERS)), () => savedText("inpaint.upscaleModel")),
      scale: fromEditor(range(2, 2, 4, true), () => savedNumber("inpaint.upscaleScale")),
      denoise: fromEditor(range(.25, 0, 1), () => savedNumber("inpaint.upscaleDenoise", 100)),
    },
    run: (image, v) => run(image, {
      kind: "plugin", label: "Upscale", plugin: UPSCALERS[v.method as string], option: v.method as string, scale: v.scale as number, denoise: v.denoise as number,
    }),
  },
  "restore-detail": {
    summary: "Restore detail at the same size. compressed: JPEG cleanup, then Real-ESRGAN detail; natural: JPEG cleanup, then Real-HAT detail; jpeg: cleanup only; noise; motion: motion blur.",
    fields: {
      // Restormer's former model names still work.
      model: fromEditor({ type: "choice", default: "compressed", values: RESTORE_MODES, aliases: RESTORMER_MODES }, () => savedText("inpaint.restoreMode")),
      strength: fromEditor(range(1, 0, 1), () => savedNumber("inpaint.restoreStrength", 100)),
    },
    run: (image, v) => run(image, {
      kind: "plugin", label: "Restore detail", plugin: "restore", option: v.model as string, scale: 1, denoise: 0, strength: v.strength as number,
    }),
  },
  "remove-background": {
    summary: "Make the background transparent.",
    fields: { model: fromEditor(choice(BACKGROUND_MODELS[0], BACKGROUND_MODELS), backgroundModel) },
    run: (image, v) => run(image, { kind: "plugin", label: "Remove background", plugin: "remove_bg", option: v.model as string, scale: 1, denoise: .25 }),
  },
  "replace-background": {
    summary: "Put a color, another image, or the blurred original behind the subject.",
    inputs: [{ name: "background", required: false, description: "The image for mode image. Defaults to the background image chosen in Inpaint." }],
    fields: {
      mode: fromEditor(choice("color", ["color", "image", "blur"]), () => savedText("inpaint.backgroundType")),
      color: fromEditor({ type: "color", default: "#ffffff" }, () => savedJson("inpaint.backgroundColor")),
      blur: fromEditor(range(20, 1, 100), () => savedJson("inpaint.backgroundBlur")),
      removeFirst: fromEditor({ type: "boolean", default: true }, () => savedJson("inpaint.removeFirst")),
      model: fromEditor(choice(BACKGROUND_MODELS[0], BACKGROUND_MODELS), backgroundModel),
    },
    run: (image, v, job) => {
      const saved = savedJson("inpaint.backgroundPath");
      const path = job.backgroundPath ?? (typeof saved === "string" ? saved : "");
      if (v.mode === "image" && !path) throw new RequestError("mode \"image\" needs a \"background\" image, or one chosen in Inpaint.");
      return run(image, {
        kind: "background", label: "Replace background", mode: v.mode as "color" | "image" | "blur", color: v.color as string,
        path, blur: v.blur as number, removeFirst: v.removeFirst as boolean, model: v.model as string,
      });
    },
  },
  "refine-edges": {
    summary: "Clean up the edges of a transparent cutout.",
    fields: {
      shrink: fromEditor(range(1, -16, 16, true), () => savedPart("inpaint.edges", "shrink")),
      soften: fromEditor(range(.5, 0, 10), () => savedPart("inpaint.edges", "soften")),
      decontaminate: fromEditor(range(.5, 0, 1), () => savedPart("inpaint.edges", "decontaminate")),
    },
    run: (image, v) => run(image, {
      kind: "refine_edges", label: "Refine edges", shrink: v.shrink as number, soften: v.soften as number, decontaminate: v.decontaminate as number,
    }),
  },
  outpaint: {
    summary: "Extend the canvas by pixels on each side and generate the new area. Set at least one side.",
    fields: {
      ...Object.fromEntries((["left", "top", "right", "bottom"] as const).map((side) => [side,
        fromEditor(range(side === "left" || side === "right" ? 128 : 0, 0, 4096, true), () => savedPart("inpaint.extension", side))])),
      model: fromEditor(choice("sdxl", INPAINT_IDS), () => savedPart("inpaint.extension", "model")),
      prompt: fromEditor({ type: "text", default: "" }, () => savedPart("inpaint.extension", "prompt")),
    },
    run: (image, v) => run(image, {
      kind: "outpaint", label: "Extend canvas", left: v.left as number, top: v.top as number, right: v.right as number,
      bottom: v.bottom as number, model: v.model as string, prompt: v.prompt as string,
    }),
  },
  adjust: {
    summary: "Color and lighting. Exposure is in EV; the others range from -100 to 100.",
    fields: Object.fromEntries(["exposure", ...ADJUSTMENTS].map((key) => [key,
      fromEditor(key === "exposure" ? range(0, -3, 3) : range(0, -100, 100), () => savedPart("inpaint.adjustments", key))])),
    run: (image, v) => run(image, {
      kind: "adjust", label: "Color and lighting", values: Object.fromEntries(["exposure", ...ADJUSTMENTS].map((key) => [key, v[key]])) as Adjustments,
    }),
  },
  crop: {
    summary: "Rotate by angle degrees, then keep rect: [x, y, width, height] as fractions of the image.",
    fields: { rect: { type: "rect", default: [0, 0, 1, 1] }, angle: range(0, -45, 45) },
    run: (image, v) => run(image, { kind: "crop", label: "Crop", rect: v.rect as Rect, angle: v.angle as number }),
  },
  ...Object.fromEntries(TRANSFORMS.map(([direction, label]): [string, Spec] => [direction, {
    summary: `${label}.`, fields: {}, run: (image) => run(image, { kind: "transform", label, direction }),
  }])),
};

function readField(key: string, field: Field, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return field.default;
  switch (field.type) {
    case "number": {
      const number = typeof value === "string" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isFinite(number) || number < field.min || number > field.max || (field.integer && !Number.isInteger(number))) {
        throw new RequestError(`${key} must be ${field.integer ? "a whole number" : "a number"} from ${field.min} to ${field.max}.`);
      }
      return number;
    }
    case "choice": {
      const named = typeof value === "string" ? field.aliases?.[value] ?? value : value;
      if (typeof named !== "string" || !field.values.includes(named)) throw new RequestError(`${key} must be one of: ${field.values.join(", ")}.`);
      return named;
    }
    case "text":
      if (typeof value !== "string" || value.length > 2000) throw new RequestError(`${key} must be text of at most 2000 characters.`);
      return value;
    case "color":
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new RequestError(`${key} must be a color such as #ffffff.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new RequestError(`${key} must be true or false.`);
      return value;
    case "rect":
    case "point": {
      const size = field.type === "rect" ? 4 : 2;
      if (!Array.isArray(value) || value.length !== size || !value.every((item) => typeof item === "number" && item >= 0 && item <= 1)) {
        throw new RequestError(`${key} must be ${size} numbers from 0 to 1.`);
      }
      return value;
    }
  }
}

function readValues(name: string, spec: Spec, options: Record<string, unknown>): Values {
  const unknown = Object.keys(options).filter((key) => !owns(spec.fields, key));
  if (unknown.length) throw new RequestError(`Unknown option for ${name}: ${unknown.join(", ")}. GET /operations lists the options.`);
  return Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, readField(key, field, options[key] ?? editorValue(key, field))]));
}

// The editor's current setting, or undefined when it has none or it no longer fits the option.
function editorValue(key: string, field: Field): unknown {
  const value = field.editor?.();
  if (value === undefined || value === null) return undefined;
  try { return readField(key, field, value); } catch { return undefined; }
}

function savedWorkflows(): Workflow[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem("inpaint.workflows") ?? "[]");
    return Array.isArray(saved) ? saved.filter((item): item is Workflow => !!item && typeof item.name === "string" && Array.isArray(item.steps)) : [];
  } catch { return []; }
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// The face swap source chosen in the editor, which App stores as a preference.
function savedFaceSourcePath(): string {
  try {
    const saved: unknown = JSON.parse(storage.getItem(FACE_SOURCE_PREFERENCE) ?? "\"\"");
    return typeof saved === "string" ? saved : "";
  } catch { return ""; }
}

async function faceSource() {
  const path = savedFaceSourcePath();
  if (!path) return null;
  try {
    const image = await loadImage(await invoke<string>("read_image_data", { path }));
    const scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { path, name: path.split("/").at(-1) ?? path, preview: canvas.toDataURL("image/jpeg", .8) };
  } catch {
    // The photo was moved or deleted; face swap cannot use it either.
    return null;
  }
}

function requireImage(job: ServerJob) {
  if (!job.image) throw new RequestError("Send an image.");
  return job.image;
}

async function runServerJob(job: ServerJob, onLoad: (request: LoadRequest) => void): Promise<JobReply> {
  switch (job.kind) {
    case "operations":
      return { ok: true, data: Object.entries(OPERATIONS).map(([name, spec]) => ({ name, path: `/${name}`, summary: spec.summary, inputs: spec.inputs ?? [],
        // "default" is the value in effect now; the editor function itself is dropped when sent.
        options: Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, { ...field, default: editorValue(key, field) ?? field.default }])) })) };
    case "workflows":
      return { ok: true, data: savedWorkflows().map((workflow) => ({ id: workflow.id, name: workflow.name, path: `/workflow/${slug(workflow.name)}`, steps: workflow.steps.map((step) => step.label) })) };
    case "face-source":
      return { ok: true, data: await faceSource() };
    case "load":
      onLoad({ data: requireImage(job), path: job.sourcePath ?? "", name: job.fileName || "image.png" });
      return { ok: true };
    case "operation": {
      const name = job.name ?? "";
      if (!owns(OPERATIONS, name)) throw new RequestError(`Unknown operation "${name}". GET /operations lists them.`, 404);
      const spec = OPERATIONS[name];
      const values = readValues(name, spec, job.options ?? {});
      const provided = { mask: !!job.mask, donor: !!job.donorPath, background: !!job.backgroundPath };
      const missing = (spec.inputs ?? []).find((input) => input.required && !provided[input.name]);
      if (missing) throw new RequestError(`${name} needs "${missing.name}": ${missing.description}`);
      const result = await spec.run(requireImage(job), values, job);
      return typeof result === "string" ? { ok: true, image: result } : { ok: true, data: result.data };
    }
    case "workflow": {
      const requested = job.name ?? "";
      const workflow = savedWorkflows().find((item) => item.id === requested || item.name.toLowerCase() === requested.toLowerCase() || slug(item.name) === slug(requested));
      if (!workflow) throw new RequestError(`No saved workflow "${requested}". GET /workflows lists them.`, 404);
      const original = requireImage(job);
      let current = original;
      for (const step of workflow.steps) current = await executeOperation(current, step, original);
      return { ok: true, image: current };
    }
  }
}

async function handleJob(id: number, onLoad: (request: LoadRequest) => void) {
  // Another listener, such as one from a React StrictMode remount, may have taken the job already.
  const job = await invoke<ServerJob | null>("server_take_job", { id });
  if (!job) return;
  let reply: JobReply;
  try {
    reply = await runServerJob(job, onLoad);
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error), status: error instanceof RequestError ? error.status : 500 };
  }
  await invoke("server_job_result", { id, reply }).catch(() => {});
}

/** Runs jobs from the local API server while the app is mounted. */
export function useServerBridge(onLoad: (request: LoadRequest) => void) {
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    void invoke("server_bridge", { ready: true });
    const listening = listen<{ id: number }>("server-job", ({ payload }) => void handleJob(payload.id, (request) => onLoadRef.current(request)));
    return () => {
      void invoke("server_bridge", { ready: false });
      void listening.then((unlisten) => unlisten());
    };
  }, []);
}
