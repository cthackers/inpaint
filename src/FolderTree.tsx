import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { FolderEntry } from "./types";

type FolderNodeProps = {
  folder: FolderEntry;
  selectedPath: string;
  onSelect: (path: string) => void;
  expandedFolders: Set<string>;
  onSetOpen: (path: string, open: boolean) => void;
  depth?: number;
  initiallyOpen?: boolean;
};

function FolderNode({ folder, selectedPath, onSelect, expandedFolders, onSetOpen, depth = 0, initiallyOpen = false }: FolderNodeProps) {
  const [children, setChildren] = useState<FolderEntry[] | null>(null);
  const selectedBranch = selectedPath === folder.path || selectedPath.startsWith(`${folder.path}/`);
  const open = initiallyOpen || selectedBranch || expandedFolders.has(folder.path);

  useEffect(() => {
    if (!open || children !== null) return;
    invoke<FolderEntry[]>("list_folders", { path: folder.path })
      .then(setChildren)
      .catch(() => setChildren([]));
  }, [children, folder.path, open]);

  const selected = selectedPath === folder.path;
  return (
    <div className="folder-node">
      <div
        className={`folder-row ${selected ? "selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 15 }}
        onClick={() => onSelect(folder.path)}
        onDoubleClick={() => onSetOpen(folder.path, !open)}
      >
        <button
          className={`tree-toggle ${open ? "open" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onSetOpen(folder.path, !open);
          }}
          aria-label={open ? "Collapse folder" : "Expand folder"}
        >
          <ChevronRight size={13} />
        </button>
        {open ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span title={folder.path}>{folder.name}</span>
      </div>
      {open && children?.map((child) => (
        <FolderNode
          key={child.path}
          folder={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          expandedFolders={expandedFolders}
          onSetOpen={onSetOpen}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default FolderNode;
