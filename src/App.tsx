import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import BrowserView from "./Browser";
import { usePreference } from "./preferences";
import Editor, { type FaceSwapSource } from "./Editor";
import type { DirectoryContents, ImageEntry } from "./types";

export default function App() {
  const [rootPath, setRootPath] = useState<string | null>(() => localStorage.getItem("inpaint.root"));
  const [currentPath, setCurrentPath] = useState<string | null>(() => localStorage.getItem("inpaint.current"));
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [brushSize, setBrushSize] = usePreference("inpaint.brushSize", 54, (value) => value >= 3 && value <= 500);
  const [faceSwapSource, setFaceSwapSource] = useState<FaceSwapSource | null>(null);
  const [faceSourcePath, setFaceSourcePath] = usePreference("inpaint.faceSourcePath", "");
  useEffect(() => {
    if (!faceSourcePath || faceSwapSource?.path === faceSourcePath) return;
    let active = true;
    void invoke<string>("read_image_data", { path: faceSourcePath }).then((data) => {
      if (active) setFaceSwapSource({ path: faceSourcePath, data });
    }).catch(() => { if (active) setFaceSourcePath(""); });
    return () => { active = false; };
  }, [faceSourcePath]);
  const galleryScrollPositions = useRef(new Map<string, number>());

  const loadFolder = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const contents = await invoke<DirectoryContents>("list_directory", { path });
      setCurrentPath(path);
      setImages(contents.images);
      localStorage.setItem("inpaint.current", path);
    } catch (error) {
      console.error(error);
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentPath) void loadFolder(currentPath);
  // Only restore the initial persisted folder once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose an image folder" });
    if (typeof selected !== "string") return;
    setRootPath(selected);
    localStorage.setItem("inpaint.root", selected);
    await loadFolder(selected);
  };

  const navigate = (offset: number) => {
    setEditorIndex((current) => {
      if (current === null || !images.length) return current;
      return (current + offset + images.length) % images.length;
    });
  };

  if (editorIndex !== null && images[editorIndex]) {
    return (
      <Editor
        key={images[editorIndex].path}
        image={images[editorIndex]}
        index={editorIndex}
        total={images.length}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        faceSwapSource={faceSwapSource}
        onFaceSwapSourceChange={(source) => { setFaceSwapSource(source); setFaceSourcePath(source.path); }}
        onExit={() => {
          setEditorIndex(null);
          if (currentPath) void loadFolder(currentPath);
        }}
        onNavigate={navigate}
      />
    );
  }

  return (
    <BrowserView
      rootPath={rootPath}
      currentPath={currentPath}
      images={images}
      loading={loading}
      onOpenFolder={() => void chooseFolder()}
      onSelectFolder={(path) => void loadFolder(path)}
      onEdit={setEditorIndex}
      initialScrollTop={currentPath ? galleryScrollPositions.current.get(currentPath) ?? 0 : 0}
      onScrollPositionChange={(scrollTop) => {
        if (currentPath) galleryScrollPositions.current.set(currentPath, scrollTop);
      }}
    />
  );
}
