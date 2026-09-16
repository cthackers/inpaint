import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry } from "./types";

// One frame of the strip, mirrored by .filmstrip-frame in styles.css.
const FRAME_WIDTH = 110;
const FRAME_STEP = 116;
const FRAME_OVERSCAN = 4;

/** Where the editor's picture area is on screen, so the strip can lie along its bottom. */
export type ViewportBox = { left: number; width: number; bottom: number };

type Props = {
  pictures: ImageEntry[];
  index: number;
  box: ViewportBox;
  disabled: boolean;
  onJump: (index: number) => void;
};

/**
 * Every picture of the gallery along the bottom of the editor, with the open one in the middle.
 *
 * It lives outside the editor, which is built anew for each picture, so moving to another picture
 * scrolls this strip instead of building it again. A store holds tens of thousands of pictures, so only
 * the frames near the view exist.
 */
export default function Filmstrip({ pictures, index, box, disabled, onJump }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const first = Math.max(0, Math.floor(view.left / FRAME_STEP) - FRAME_OVERSCAN);
  const last = Math.min(pictures.length, Math.ceil((view.left + view.width) / FRAME_STEP) + FRAME_OVERSCAN);
  const placed = useRef(false);

  const read = useCallback(() => {
    const element = strip.current;
    if (element) setView({ left: element.scrollLeft, width: element.clientWidth });
  }, []);

  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [read]);

  // The open picture moves to the middle: at once when the strip appears, gliding when it changes.
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const target = Math.max(0, index * FRAME_STEP - (element.clientWidth - FRAME_WIDTH) / 2);
    element.scrollTo({ left: target, behavior: placed.current ? "smooth" : "auto" });
    placed.current = true;
    read();
  }, [index, box.width, read]);

  return <div className="filmstrip" ref={strip} onScroll={read}
    style={{ left: box.left, width: box.width, top: box.bottom - 100 }}
    onWheel={(event) => {
      // A mouse wheel scrolls the strip sideways, as its only direction.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
    }}>
    <div className="filmstrip-track" style={{ width: pictures.length * FRAME_STEP - (FRAME_STEP - FRAME_WIDTH) }}>
      {pictures.slice(first, last).map((picture, offset) => {
        const at = first + offset;
        return <button key={picture.path} className={`filmstrip-frame ${at === index ? "current" : ""}`} style={{ left: at * FRAME_STEP }}
          title={picture.name} disabled={disabled} onClick={() => { if (at !== index) onJump(at); }}>
          <img src={`${convertFileSrc(picture.path, "thumb")}?v=${picture.size}-${picture.modifiedMs}`} alt="" draggable={false} decoding="async" />
        </button>;
      })}
    </div>
  </div>;
}
