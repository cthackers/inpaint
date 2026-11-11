// INPAINT_EDITOR_TEST=tests/albumExport.tsx xvfb-run -a /usr/bin/python3 tests/webkit_editor_navigation.py
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import AlbumsPanel, { type AlbumView } from "../src/Albums";
import AlbumExportDialog from "../src/AlbumExportDialog";
import { albumExportRequest, type AlbumExportRequest } from "../src/albumExport";
import { defaultSmartRules } from "../src/smartAlbums";
import type { Album, Store } from "../src/types";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
const until = async (condition: () => unknown) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await wait(); }
  throw new Error("Timed out waiting for export UI");
};
const calls: { command: string; args: any }[] = [];
let folder: string | null = null;
let finishExport: (result: unknown) => void;
let callbackId = 0;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => ++callbackId,
  convertFileSrc: (path: string) => path,
  invoke: (command: string, args: any) => {
    calls.push({ command, args });
    if (command === "plugin:dialog|open") return Promise.resolve(folder);
    if (command === "album_pictures" || command === "immich_album_pictures") return Promise.resolve(["/store/one.gif", "/store/two.jpg"]);
    if (command === "export_pictures") return new Promise((resolve) => { finishExport = resolve; });
    return Promise.resolve();
  },
};
const store = { id: "store", immich: false } as Store;
const album: Album = { id: "trips", storeId: "store", name: "Trips", parentId: "", fullName: "Trips", isVirtual: false, coverPath: "", coverAssetId: "", count: 1, total: 2 };
const noop = () => {};
function Harness() {
  const [request, setRequest] = useState<AlbumExportRequest | null>(null);
  const view: AlbumView = {
    storeId: store.id, albums: [album], selected: null, loading: false, error: "", immich: false,
    onSelect: noop, onCreate: noop, onRename: noop, onMove: noop, onSetCover: noop, onDelete: noop,
    onAddPictures: noop, onRemovePictures: noop,
    onExport: (selected) => setRequest(albumExportRequest(selected, store, [], {}, {})),
  };
  return <><AlbumsPanel view={view} />{request && <AlbumExportDialog request={request} onClose={() => setRequest(null)} />}</>;
}
const root = createRoot(document.getElementById("root")!);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!;
const click = (node: HTMLButtonElement) => { check(node, "Missing button"); flushSync(() => node.click()); };

async function run() {
  // Resolve all album members even when the gallery has no visible pictures.
  check((await albumExportRequest(album, store, [], {}, {}).loadPaths()).length === 2, "Local export used visible images");
  await albumExportRequest(album, { ...store, immich: true }, [], {}, {}).loadPaths();
  const immich = calls.at(-1)!;
  check(immich.args.albumId === "path:Trips" && immich.args.includeUnavailable, "Immich export omitted descendants or unavailable files");
  const images = ["one", "two", "three"].map((name) => ({ path: `/${name}.jpg`, name, extension: "jpg", size: 1, modifiedMs: 0 }));
  const smart = { ...album, smartRules: { ...defaultSmartRules, tags: ["Travel"] } };
  const smartPaths = await albumExportRequest(smart, store, images, { "/one.jpg": ["Travel"], "/two.jpg": ["Travel/Paris"] }, {}).loadPaths();
  check(smartPaths.join() === "/one.jpg,/two.jpg", "Smart album did not export all matching pictures");

  flushSync(() => root.render(<Harness />));
  click(document.querySelector<HTMLButtonElement>('[aria-label="Actions for Trips"]')!);
  click(button("Export to folder…"));
  check(document.querySelector('[role="dialog"]'), "Album menu did not open export dialog");
  check(button("Export album").disabled, "Export allowed without a destination");
  click(button("Browse…"));
  await until(() => !button("Browse…").disabled);
  check(button("Export album").disabled, "Cancelling folder picker enabled export");
  check(!calls.some((call) => call.command === "export_pictures"), "Cancelling picker started a copy");
  folder = "/export destination";
  click(button("Browse…"));
  await until(() => !button("Export album").disabled);
  click(button("Export album"));
  await until(() => calls.some((call) => call.command === "export_pictures"));
  const copy = calls.find((call) => call.command === "export_pictures")!;
  check(copy.args.paths.length === 2 && copy.args.destination === folder, "Wrong export sources or folder");
  check(button("Export album").disabled && button("Cancel").disabled, "Export can be duplicated or hidden while running");
  flushSync(() => copy.args.onProgress.onmessage({ done: 1, total: 2 }));
  check(document.querySelector("progress")?.value === 1, "Progress did not update");
  finishExport!({ copied: 1, failures: [{ path: "/store/two.jpg", error: "Permission denied" }] });
  await until(() => !!button("Open folder"));
  check(document.body.textContent?.includes("1 picture exported."), "Missing completion count");
  check(document.body.textContent?.includes("/store/two.jpg") && document.body.textContent?.includes("Permission denied"), "Partial failure was hidden");
  click(button("Open folder"));
  check(calls.at(-1)?.command === "open_folder" && calls.at(-1)?.args.path === folder, "Open folder targeted the wrong destination");
  click(button("Close"));
  check(!document.querySelector('[role="dialog"]'), "Completed dialog did not close");
  root.unmount();
  return "PASS: album sources, menu, folder cancellation, progress, completion and partial failures";
}
run().then((result) => { (window as any).testResult = result; })
  .catch((error) => { (window as any).testResult = `FAIL: ${error}\n${error.stack ?? ""}`; });
