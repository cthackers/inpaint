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
  const setPan = useCallback((value: SetStateAction<Point>) => {
    panRef.current = typeof value === "function" ? value(panRef.current) : value;
    schedule();
  }, [schedule]);
  const setZoom = useCallback((value: SetStateAction<number>) => {
    zoomRef.current = typeof value === "function" ? value(zoomRef.current) : value;
    schedule();
    // The image and percentage update every frame; controls reconcile once the
    // wheel gesture settles, rather than rerendering the whole editor per tick.
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => commitZoom(zoomRef.current), 100);
  }, [schedule]);
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
      window.clearTimeout(settle.current);
    };
  }, [viewport]);
  return { stageRef, cursorRef, zoomLabelRef, zoomValueRef, panRef, zoomRef, zoom, setPan, setZoom, getViewportBounds, moveCursor, hideCursor };
}
