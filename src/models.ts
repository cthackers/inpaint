export type InpaintModel = {
  id: "lama" | "mat" | "zits" | "migan" | "sdxl";
  name: string;
  tag: string;
  download: string;
  description: string;
};

export const INPAINT_MODELS: InpaintModel[] = [
  {
    id: "lama",
    name: "LaMa",
    tag: "All-rounder",
    download: "197 MB",
    description: "Fastest general choice. Best for people, blemishes, and objects over natural textures.",
  },
  {
    id: "mat",
    name: "MAT",
    tag: "Large areas",
    download: "On demand",
    description: "Best for wide masks, landscapes, and interiors where the broader scene must be reconstructed.",
  },
  {
    id: "zits",
    name: "ZITS",
    tag: "Structure",
    download: "On demand",
    description: "Best for architecture, fences, horizons, and continuing straight or structural lines.",
  },
  {
    id: "migan",
    name: "MIGAN",
    tag: "Quick repair",
    download: "On demand",
    description: "A fast 512px crop model for small or medium objects on uncomplicated photo backgrounds.",
  },
  {
    id: "sdxl",
    name: "SDXL Inpainting",
    tag: "Generative",
    download: "Large download",
    description: "Slowest but most imaginative. Best when a large or semantic region needs genuinely new detail.",
  },
];
