// Browser regression for the real editor, with disk reads and animation frames controlled.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Editor from "../src/Editor";

const reads = new Map<string, (data: string) => void>();
(window as any).__TAURI_INTERNALS__ = {
  invoke: (command: string, args: { path?: string }) => {
    if (command === "read_image_data") return new Promise<string>((resolve) => reads.set(args.path!, resolve));
    if (command === "picture_info") return Promise.reject("No metadata in this test");
    return Promise.resolve([]);
  },
  convertFileSrc: (path: string) => path,
};
const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
window.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
window.cancelAnimationFrame = (id) => { frames.delete(id); };
const step = () => {
  const pending = [...frames];
  frames.clear();
  flushSync(() => { for (const [, callback] of pending) callback(performance.now()); });
};
const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const until = async (condition: () => unknown) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await wait();
  }
  throw new Error("Timed out waiting for image decoding");
};
const png = (width: number, height: number, color: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color; context.fillRect(0, 0, width, height);
  return canvas.toDataURL();
};
const root = createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => { (window as any).testResult = `FAIL: ${String(error)}`; },
});
const noop = () => {};
const open = (path: string) => flushSync(() => root.render(<Editor
  image={{ path, name: path, extension: "png", size: 0, modifiedMs: 0 }}
  index={0} total={3} brushSize={20} onBrushSizeChange={noop}
  faceLibrary={[]} onFaceLibraryChange={noop} faceSwapSource={null} onFaceSwapSourceChange={noop} onFaceSwapSourceClear={noop}
  onExit={noop} onNavigate={noop}
/>));
const picture = () => document.querySelector<HTMLImageElement>(".image-clip > img");
const initializing = () => document.querySelector(".image-stage")?.classList.contains("initializing");

async function run() {
  const red = png(120, 80, "red"), blue = png(80, 160, "blue"), green = png(200, 60, "green");
  open("first.png");
  await until(() => reads.has("first.png"));
  reads.get("first.png")!(red);
  await until(() => picture()?.naturalWidth === 120);
  await wait();
  check(initializing(), "Image must wait for its fitted layout");
  step(); // Leave the second readiness callback pending while navigating.
  open("second.png");
  step(); // A stale callback must not reveal the next picture before it loads.
  reads.get("second.png")!(blue);
  await until(() => picture()?.naturalWidth === 80);
  await wait();
  check(initializing(), "Previous picture's callback revealed the next image too early");
  step(); step();
  check(!initializing(), "Loaded image was not revealed");
  check(document.querySelector<HTMLElement>(".image-stage")?.style.height === "160px", "Wrong fitted dimensions");

  open("slow.png");
  open("last.png");
  reads.get("last.png")!(green);
  await until(() => picture()?.naturalWidth === 200);
  step(); step();
  reads.get("slow.png")!(red);
  await wait();
  check(picture()?.src === green, "Late read replaced the selected image");
  check(document.querySelectorAll(".image-stage").length === 1, "Pictures overlap");
  root.unmount();
  step();
  return "PASS: rapid switches cancel stale frames; late reads cannot replace the current picture";
}

run().then((result) => { (window as any).testResult = result; })
  .catch((error) => { (window as any).testResult = `FAIL: ${error}\n${error.stack ?? ""}`; });
