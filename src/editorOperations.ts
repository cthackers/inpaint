import { invoke } from "@tauri-apps/api/core";

export type Plugin = "restormer" | "gfpgan" | "realesrgan" | "remove_bg" | "hat" | "lanczos";
export type Rect = [number, number, number, number];
export type Adjustments = { exposure: number; contrast: number; temperature: number; saturation: number; shadows: number; highlights: number };
export const neutralAdjustments: Adjustments = { exposure: 0, contrast: 0, temperature: 0, saturation: 0, shadows: 0, highlights: 0 };
export type Operation =
  | { kind: "plugin"; label: string; plugin: Plugin; option: string; scale: number; denoise: number; strength?: number }
  | { kind: "face"; label: string; donor: string; strength: number; target?: [number, number]; colorMatch?: number }
  | { kind: "adjust"; label: string; values: Adjustments }
  | { kind: "refine_edges"; label: string; shrink: number; soften: number; decontaminate: number }
  | { kind: "outpaint"; label: string; left: number; right: number; top: number; bottom: number; model: string; prompt: string }
  | { kind: "transform"; label: string; direction: "flip-horizontal" | "flip-vertical" | "rotate-left" | "rotate-right" }
  | { kind: "crop"; label: string; rect: Rect; angle: number }
  | { kind: "background"; label: string; mode: "color" | "image" | "blur"; color: string; path: string; blur: number; removeFirst: boolean; model: string };
export type FaceBox = { id: number; box: Rect };
export type ActionResult = { imageData: string; rawData: string; faces: FaceBox[]; models: string[]; plugins: string[]; memory: { ram?: number; vram?: number; reserved?: number }; path: string; width: number; height: number; bytes: number };
export type ExportSettings = { directory: string; format: "png" | "jpeg" | "webp"; quality: number; width: number; height: number; suffix: string; matte: string };
export const imageAction = (command: string, imageData?: string, options: object = {}, referenceData?: string) =>
  invoke<ActionResult>("image_action", { command, imageData: imageData ?? null, options, referenceData: referenceData ?? null });

export async function loadImage(data: string) {
  const image = new Image();
  image.src = data;
  await image.decode();
  return image;
}

function canvas(width: number, height: number) {
  if (width * height > 150_000_000) throw new Error("Image is too large (maximum 150 megapixels).");
  const element = document.createElement("canvas");
  element.width = width; element.height = height;
  const context = element.getContext("2d");
  if (!context) throw new Error("Cannot create image canvas.");
  return { element, context };
}

export async function blendImages(raw: string, restored: string, strength: number) {
  if (strength <= 0) return raw;
  if (strength >= 1) return restored;
  const [before, after] = await Promise.all([loadImage(raw), loadImage(restored)]);
  if (before.naturalWidth !== after.naturalWidth || before.naturalHeight !== after.naturalHeight) throw new Error("Restoration sizes do not match.");
  const { element, context } = canvas(before.naturalWidth, before.naturalHeight);
  context.drawImage(before, 0, 0);
  const source = context.getImageData(0, 0, element.width, element.height);
  context.clearRect(0, 0, element.width, element.height);
  context.drawImage(after, 0, 0);
  const result = context.getImageData(0, 0, element.width, element.height);
  for (let i = 0; i < source.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) result.data[i + channel] = Math.round(source.data[i + channel] * (1 - strength) + result.data[i + channel] * strength);
    result.data[i + 3] = source.data[i + 3];
  }
  context.putImageData(result, 0, 0);
  return element.toDataURL("image/png");
}

export async function executeOperation(data: string, operation: Operation, reference: string): Promise<string> {
  if (operation.kind === "adjust") return adjustImage(data, operation.values);
  if (operation.kind === "outpaint" || operation.kind === "refine_edges") return (await imageAction(operation.kind, data, operation)).imageData;
  if (operation.kind === "face") {
    return (await imageAction("face_preview", data, operation)).imageData;
  }
  if (operation.kind === "plugin") {
    if (operation.plugin === "restormer" && operation.strength === 0) return data;
    const result = await invoke<string>("run_plugin", { imageData: data, ...operation, sourceImageData: null });
    return operation.plugin === "gfpgan" ? blendImages(data, result, operation.strength ?? 1) : result;
  }
  if (operation.kind === "transform") {
    const source = await loadImage(data);
    const w = source.naturalWidth, h = source.naturalHeight;
    const rotate = operation.direction.startsWith("rotate");
    const { element, context } = canvas(rotate ? h : w, rotate ? w : h);
    switch (operation.direction) {
      case "flip-horizontal": context.setTransform(-1, 0, 0, 1, w, 0); break;
      case "flip-vertical": context.setTransform(1, 0, 0, -1, 0, h); break;
      case "rotate-left": context.setTransform(0, -1, 1, 0, 0, w); break;
      case "rotate-right": context.setTransform(0, 1, -1, 0, h, 0); break;
    }
    context.drawImage(source, 0, 0);
    return element.toDataURL("image/png");
  }
  if (operation.kind === "background" && operation.removeFirst) {
    data = await invoke<string>("run_plugin", { imageData: data, plugin: "remove_bg", option: operation.model, scale: 1, denoise: 0.25, sourceImageData: null });
  }
  return (await imageAction("edit", data, operation, reference)).imageData;
}

export async function adjustImage(data: string, values: Adjustments, maxSize?: number): Promise<string> {
  const image = await loadImage(data);
  const ratio = maxSize ? Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
  const { element, context } = canvas(Math.max(1, Math.round(image.naturalWidth * ratio)), Math.max(1, Math.round(image.naturalHeight * ratio)));
  context.drawImage(image, 0, 0, element.width, element.height);
  const pixels = context.getImageData(0, 0, element.width, element.height);
  const exposure = 2 ** values.exposure;
  const contrast = 1 + values.contrast / 100;
  const saturation = 1 + values.saturation / 100;
  const warmth = values.temperature / 500;
  for (let i = 0; i < pixels.data.length; i += 4) {
    let r = pixels.data[i] / 255 * exposure, g = pixels.data[i + 1] / 255 * exposure, b = pixels.data[i + 2] / 255 * exposure;
    const luma = Math.min(1, Math.max(0, .2126 * r + .7152 * g + .0722 * b));
    const tone = values.shadows / 100 * (1 - luma) ** 2 * .45 + values.highlights / 100 * luma ** 2 * .45;
    r = (r + tone + warmth - .5) * contrast + .5;
    g = (g + tone - .5) * contrast + .5;
    b = (b + tone - warmth - .5) * contrast + .5;
    const gray = .2126 * r + .7152 * g + .0722 * b;
    pixels.data[i] = (gray + (r - gray) * saturation) * 255;
    pixels.data[i + 1] = (gray + (g - gray) * saturation) * 255;
    pixels.data[i + 2] = (gray + (b - gray) * saturation) * 255;
  }
  context.putImageData(pixels, 0, 0);
  return element.toDataURL("image/png");
}
