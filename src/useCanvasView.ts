import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type SetStateAction } from "react";

type Point = { x: number; y: number };

export function useCanvasView(viewport: RefObject<HTMLDivElement | null>, fitScale: number, brushSize: number, cursorEnabled: boolean) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const zoomValueRef = useRef<HTMLSpanElement>(null);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const [zoom, commitZoom] = useState(1);
  const frame = useRef<number | null>(null);
  const settle = useRef<number | undefined>(undefined);
  const bounds = useRef<DOMRect | null>(null);
  const cursor = useRef<Point | null>(null);
  const config = useRef({ fitScale, brushSize, cursorEnabled });
  // Where an animated zoom is heading; zoomRef and panRef are what is on screen, frame by frame.
  const targetZoom = useRef(1);
  const targetPan = useRef<Point>({ x: 0, y: 0 });
  const glide = useRef<{ frame: number; last: number } | null>(null);

  const paintView = useCallback(() => {
    const scale = config.current.fitScale * zoomRef.current;
    const pan = panRef.current;
    if (stageRef.current) {
      const transform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
      if (stageRef.current.style.transform !== transform) stageRef.current.style.transform = transform;
      if (stageRef.current.style.getPropertyValue("--image-scale") !== String(scale)) stageRef.current.style.setProperty("--image-scale", String(scale));
    }
    const percentage = `${Math.round(scale * 100)}%`;
    if (zoomLabelRef.current && zoomLabelRef.current.textContent !== `${percentage} zoom`) zoomLabelRef.current.textContent = `${percentage} zoom`;
    if (zoomValueRef.current && zoomValueRef.current.textContent !== percentage) zoomValueRef.current.textContent = percentage;
    if (cursorRef.current) {
      const point = cursor.current;
      cursorRef.current.style.visibility = point && config.current.cursorEnabled ? "visible" : "hidden";
      if (point) cursorRef.current.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
      const size = `${Math.max(3, config.current.brushSize * scale)}px`;
      cursorRef.current.style.width = size; cursorRef.current.style.height = size;
    }
  }, []);
  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paintView(); });
  }, [paintView]);
  const settleZoom = useCallback(() => {
    // The image and percentage update every frame; controls reconcile once the
    // gesture settles, rather than rerendering the whole editor per tick.
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => commitZoom(zoomRef.current), 100);
  }, []);
  // A pan moves the view and wherever a running zoom is heading alike, so dragging during a zoom keeps it.
  const setPan = useCallback((value: SetStateAction<Point>) => {
    const current = panRef.current;
    const next = typeof value === "function" ? value(current) : value;
    panRef.current = next;
    targetPan.current = glide.current
      ? { x: targetPan.current.x + next.x - current.x, y: targetPan.current.y + next.y - current.y }
      : next;
    schedule();
  }, [schedule]);
  const stopGlide = useCallback(() => {
    if (glide.current) cancelAnimationFrame(glide.current.frame);
    glide.current = null;
  }, []);
  const setZoom = useCallback((value: SetStateAction<number>) => {
    stopGlide();
    zoomRef.current = typeof value === "function" ? value(zoomRef.current) : value;
    targetZoom.current = zoomRef.current;
    targetPan.current = panRef.current;
    schedule();
    settleZoom();
  }, [schedule, settleZoom, stopGlide]);

  /**
   * Eases the view toward a zoom and pan over a few frames. Zoom and pan close the same share of their
   * distance each frame, so a point that zooming keeps in place stays in place all the way.
   */
  const glideTo = useCallback((nextZoom: number, nextPan: Point) => {
    targetZoom.current = nextZoom;
    targetPan.current = nextPan;
    if (glide.current) return;
    const step = (time: number) => {
      const state = glide.current;
      if (!state) return;
      const elapsed = Math.min(64, state.last ? time - state.last : 16);
      state.last = time;
      const share = 1 - Math.exp(-elapsed / 55);
      const zoom = zoomRef.current, pan = panRef.current;
      const done = Math.abs(targetZoom.current - zoom) / targetZoom.current < .002
        && Math.abs(targetPan.current.x - pan.x) < .5 && Math.abs(targetPan.current.y - pan.y) < .5;
      if (done) {
        zoomRef.current = targetZoom.current;
        panRef.current = targetPan.current;
        glide.current = null;
      } else {
        zoomRef.current = zoom + (targetZoom.current - zoom) * share;
        panRef.current = { x: pan.x + (targetPan.current.x - pan.x) * share, y: pan.y + (targetPan.current.y - pan.y) * share };
        state.frame = requestAnimationFrame(step);
      }
      paintView();
      settleZoom();
    };
    glide.current = { frame: requestAnimationFrame(step), last: 0 };
  }, [paintView, settleZoom]);

  /** Zooms toward a zoom level keeping one point in place: an offset from the viewport's middle. */
  const zoomAround = useCallback((nextZoom: number, anchor: Point = { x: 0, y: 0 }) => {
    const ratio = nextZoom / targetZoom.current;
    const pan = targetPan.current;
    glideTo(nextZoom, { x: anchor.x - ratio * (anchor.x - pan.x), y: anchor.y - ratio * (anchor.y - pan.y) });
  }, [glideTo]);
  const getViewportBounds = useCallback((refresh = false) => {
    if (refresh || !bounds.current) bounds.current = viewport.current?.getBoundingClientRect() ?? null;
    return bounds.current;
  }, [viewport]);
  const moveCursor = useCallback((clientX: number, clientY: number) => {
    const rect = getViewportBounds();
    cursor.current = rect ? { x: clientX - rect.left, y: clientY - rect.top } : null;
    schedule();
  }, [getViewportBounds, schedule]);
  const hideCursor = useCallback(() => { cursor.current = null; schedule(); }, [schedule]);

  useLayoutEffect(() => {
    config.current = { fitScale, brushSize, cursorEnabled };
    paintView();
  });
  useEffect(() => {
    const invalidate = () => { bounds.current = null; };
    const observer = new ResizeObserver(invalidate);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("scroll", invalidate, true);
    return () => {
      observer.disconnect(); window.removeEventListener("scroll", invalidate, true);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (glide.current) cancelAnimationFrame(glide.current.frame);
      window.clearTimeout(settle.current);
    };
  }, [viewport]);
  return { stageRef, cursorRef, zoomLabelRef, zoomValueRef, panRef, zoomRef, zoom, setPan, setZoom, glideTo, zoomAround, targetZoom, getViewportBounds, moveCursor, hideCursor };
}
