// Run with INPAINT_EDITOR_TEST=tests/editorFacePreviews.tsx xvfb-run -a /usr/bin/python3 tests/webkit_editor_navigation.py
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Editor from "../src/Editor";
import { storage } from "../src/storage";

const png = (color: string) => {
  const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
  const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 120, 80);
  return canvas.toDataURL();
};
const original = png("red"), blue = png("blue"), green = png("green");
const pending: { donor: string; lane: number; finish: (result: object) => void }[] = [];
let prepare: (() => void) | null = null, holdPreparation = false, releases = 0, exited = 0, inpainted = 0;
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: any = {}) => {
    if (command === "read_image_data" || command === "read_thumbnail_data") return original;
    if (command === "animation_info") return null;
    if (command === "picture_info") throw Error("No metadata in this test");
    if (command === "run_inpaint") { inpainted++; return original; }
    if (command === "image_action") {
      if (args.command === "prepare_face_previews" && holdPreparation) await new Promise<void>(resolve => { prepare = resolve; });
      if (args.command === "face_preview") return new Promise(resolve => pending.push({donor: args.options.donor, lane: args.options.previewWorker, finish: resolve}));
      if (args.command === "release_face_previews") releases++;
      return {};
    }
    return [];
  }, convertFileSrc: () => original,
};
storage.setItem("inpaint.facePreviewConcurrency", "2");
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
const until = async (condition: () => unknown) => {
  for (let i = 0; i < 150; i++) { if (condition()) return; await wait(); }
  throw Error("Timed out: " + condition.toString());
};
const press = (key: string, code: string, target: EventTarget = window, extra = {}) => {
  for (const type of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, {key, code, bubbles: true, cancelable: true, ...extra}));
};
const start = () => press("p", "KeyP", window, {altKey: true});
const bar = () => document.querySelector('[aria-label="Face previews"]');
const candidate = () => document.querySelector<HTMLImageElement>('img[alt^="Face preview:"]');
const picture = () => document.querySelector<HTMLImageElement>(".image-clip > img");
const noop = () => {};
const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<Editor image={{path:"test.png",name:"test.png",extension:"png",size:0,modifiedMs:0}}
  index={0} total={1} brushSize={20} onBrushSizeChange={noop} faceLibrary={["one.png","two.png","three.png","four.png"]}
  onFaceLibraryChange={noop} faceSwapSource={null} onFaceSwapSourceChange={noop} onFaceSwapSourceClear={noop}
  onExit={() => exited++} onNavigate={noop} />));

async function run() {
  await until(() => picture()?.naturalWidth === 120);
  await wait(); start();
  await until(() => pending.length === 2);
  check(pending[0].lane !== pending[1].lane, "Requests must use independent workers");
  pending[1].finish({imageData: blue});
  await until(() => pending.length === 3 && candidate()?.alt.includes("two.png"));
  const next = document.querySelector<HTMLButtonElement>('[aria-label="Next face preview"]')!;
  next.focus(); press(" ", "Space", next);
  await until(() => !bar() && picture()?.src === blue);
  check(inpainted === 0, "Space must not apply the mask too");
  pending[0].finish({imageData: green}); pending[2].finish({imageData: green});
  await until(() => releases === 1);
  check(pending.length === 3, "Apply must stop queued candidates");
  check(picture()?.src === blue, "Late results must not overwrite the chosen preview");

  // Escape must reach the editor even when the saved-faces popover is open.
  pending.length = 0; await wait(); start();
  await until(() => pending.length === 2);
  document.querySelector<HTMLButtonElement>(".face-library-trigger")!.click();
  await until(() => document.querySelector('[role="dialog"][aria-label="Saved faces"]'));
  press("Escape", "Escape");
  await until(() => !bar() && !document.querySelector('[role="dialog"][aria-label="Saved faces"]'));
  check(exited === 0, "Escape should close comparison, not leave editor");
  check(picture()?.src === blue, "Discard must keep the baseline");
  pending.forEach(item => item.finish({imageData: green}));
  await until(() => releases === 2);
  check(pending.length === 2, "Discard must stop queued candidates");

  // Stopping during model preparation must never start any swaps afterwards.
  pending.length = 0; holdPreparation = true; await wait(); start();
  await until(() => prepare !== null && bar());
  const stop = [...bar()!.querySelectorAll("button")].find(button => button.textContent === "Stop generation")!;
  stop.click(); prepare!();
  await until(() => releases === 3);
  check(pending.length === 0, "Stop during preparation must cancel the queue");
  press("Escape", "Escape"); await until(() => !bar());
  check(exited === 0 && inpainted === 0, "Preview shortcuts must not trigger editor actions");
  root.unmount();
  (window as any).testResult = "PASS: parallel requests, Space apply while running/focused, Esc closes both panels, cancellation and late-result cleanup";
}
run().catch(error => { (window as any).testResult = `FAIL: ${String(error)}`; });
