import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, FolderOpen, Play, Plus, RefreshCw, Trash2, X, History, Layers, Images, Download, Cpu, SlidersHorizontal } from "lucide-react";
import { executeOperation, imageAction, type ActionResult, type ExportSettings, type Operation } from "./editorOperations";
import type { HistoryEntry } from "./useEditHistory";
import { usePreference } from "./preferences";
import ToolSection from "./ToolSection";

export type WorkspaceTab = "history" | "workflows" | "batch" | "export" | "memory";
type Workflow = { id: string; name: string; steps: Operation[] };
type BatchItem = { path: string; status: string; output?: string };
type Props = {
  tab: WorkspaceTab; onTab: (tab: WorkspaceTab) => void; onClose: () => void;
  data: string; name: string; dimensions: { width: number; height: number };
  history: HistoryEntry[]; position: number; onJump: (index: number) => void;
  suggestions: Operation[]; busy: boolean; onBusy: (value: boolean) => void;
  onMessage: (value: string) => void;
  onRun: (steps: Operation[], name: string) => Promise<void>;
};

function readSaved<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
}
const defaultExport: ExportSettings = { directory: "", format: "png", quality: 95, width: 0, height: 0, suffix: "_edited", matte: "#ffffff" };
const tabIcons = { history: History, workflows: Layers, batch: Images, export: Download, memory: Cpu };
const operationKey = (operation: Operation) => operation.kind === "plugin"
  ? (["hat", "lanczos", "realesrgan"].includes(operation.plugin) ? "upscale" : operation.plugin)
  : operation.kind === "transform" ? operation.direction : operation.kind;
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const memorySize = (bytes?: number) => bytes === undefined ? "Unavailable" : `${(bytes / 1024 ** 2).toFixed(0)} MB`;

export default function Workspace(props: Props) {
  const { tab, busy, data, name, onMessage } = props;
  const [workflows, setWorkflows] = useState<Workflow[]>(() => {
    const saved = readSaved<Workflow[]>("inpaint.workflows", []);
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.name === "string" && Array.isArray(item.steps)) : [];
  });
  const [draft, setDraft] = useState<Operation[]>([]);
  const [workflowName, setWorkflowName] = usePreference("inpaint.workflowName", "My workflow");
  const [selected, setSelected] = usePreference("inpaint.selectedWorkflow", "");
  const [selectedSuggestion, setSelectedSuggestion] = usePreference("inpaint.workflowOperation", "adjust");
  const suggestion = Math.max(0, props.suggestions.findIndex((item) => operationKey(item) === selectedSuggestion));
  const [settings, setSettings] = useState<ExportSettings>(() => ({ ...defaultExport, ...readSaved<Partial<ExportSettings>>("inpaint.export", {}) }));
  const [keepRatio, setKeepRatio] = usePreference("inpaint.exportKeepRatio", true);
  const [files, setFiles] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const cancelled = useRef(false);
  const [memory, setMemory] = useState<ActionResult | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [lastExport, setLastExport] = useState("");
  const workflow = workflows.find((item) => item.id === selected);

  useEffect(() => {
    try { localStorage.setItem("inpaint.export", JSON.stringify(settings)); }
    catch { onMessage("Export preferences could not be saved."); }
  }, [settings, onMessage]);

  const saveWorkflows = (items: Workflow[]) => {
    try {
      localStorage.setItem("inpaint.workflows", JSON.stringify(items));
      setWorkflows(items);
    } catch { onMessage("Could not save workflows: local storage is full."); }
  };
  const refreshMemory = async () => {
    if (busy || memoryBusy) return;
    setMemoryBusy(true); props.onBusy(true);
    try { setMemory(await imageAction("memory")); }
    catch (error) { onMessage(String(error)); }
    finally { setMemoryBusy(false); props.onBusy(false); }
  };
  useEffect(() => { if (tab === "memory") void refreshMemory(); }, [tab]);

  const unload = async (kind: string, key: string) => {
    setMemoryBusy(true); props.onBusy(true);
    try { setMemory(await imageAction("unload", undefined, { kind, key })); }
    catch (error) { onMessage(String(error)); }
    finally { setMemoryBusy(false); props.onBusy(false); }
  };
  const chooseDirectory = async () => {
    try {
      const path = await open({ directory: true, multiple: false, title: "Export folder", defaultPath: settings.directory || undefined });
      if (typeof path === "string") setSettings((old) => ({ ...old, directory: path }));
    } catch (error) { onMessage(String(error)); }
  };
  const updateDimension = (key: "width" | "height", value: number) => {
    setSettings((old) => ({ ...old, [key]: value, ...(keepRatio ? { [key === "width" ? "height" : "width"]: 0 } : {}) }));
  };
  const exportCurrent = async () => {
    props.onBusy(true);
    try {
      const result = await imageAction("export", data, { ...settings, name });
      setLastExport(result.path);
      onMessage(`Exported ${result.width} × ${result.height} px (${memorySize(result.bytes)}).`);
    } catch (error) { onMessage(`Export failed: ${String(error)}`); }
    finally { props.onBusy(false); }
  };
  const chooseFiles = async () => {
    try {
      const paths = await open({ title: "Choose pictures for batch processing", multiple: true, filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (!paths) return;
      const selectedPaths = typeof paths === "string" ? [paths] : paths;
      setFiles((old) => [...old, ...selectedPaths.filter((path) => !old.some((item) => item.path === path)).map((path) => ({ path, status: "Queued" }))]);
    } catch (error) { onMessage(String(error)); }
  };
  const runBatch = async () => {
    if (!workflow || !files.length || !settings.directory) return;
    const steps = structuredClone(workflow.steps);
    const exportOptions = { ...settings };
    cancelled.current = false;
    setBatchRunning(true); props.onBusy(true);
    const update = (index: number, status: string, output?: string) => setFiles((old) => old.map((item, i) => i === index ? { ...item, status, output } : item));
    setFiles((old) => old.map((item) => ({ path: item.path, status: "Queued" })));
    let completed = 0, failed = 0;
    try {
      for (let index = 0; index < files.length; index++) {
        if (cancelled.current) break;
        try {
          update(index, "Reading…");
          const original = await invoke<string>("read_image_data", { path: files[index].path });
          let result = original;
          for (let step = 0; step < steps.length; step++) {
            if (cancelled.current) break;
            update(index, `${step + 1}/${steps.length} · ${steps[step].label}`);
            result = await executeOperation(result, steps[step], original);
          }
          if (cancelled.current) { update(index, "Cancelled (not exported)"); break; }
          update(index, "Exporting…");
          const saved = await imageAction("export", result, { ...exportOptions, name: fileName(files[index].path) });
          completed++;
          update(index, "Complete", saved.path);
        } catch (error) { failed++; update(index, `Failed: ${String(error)}`); }
      }
      if (cancelled.current) setFiles((old) => old.map((item) => item.status === "Queued" ? { ...item, status: "Cancelled" } : item));
      onMessage(`Batch ${cancelled.current ? "stopped" : "finished"}: ${completed} exported, ${failed} failed.`);
    } finally { setBatchRunning(false); props.onBusy(false); }
  };
  const workflowPicker = <label>Saved workflow<select value={workflow?.id ?? ""} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
    <option value="">Choose a workflow…</option>{workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>;
  const exportControls = <ToolSection id="export-settings" title="Export settings" icon={SlidersHorizontal}><div className="workspace-form">
    <button disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={14} /> Choose export folder</button>
    <small className="path-text" title={settings.directory}>{settings.directory || "No folder selected"}</small>
    <div className="form-row"><label>Format<select value={settings.format} disabled={busy} onChange={(e) => setSettings({ ...settings, format: e.target.value as ExportSettings["format"] })}><option value="png">PNG · Lossless</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
      <label>Quality {settings.quality}%<input aria-label="Export quality" type="range" min="1" max="100" value={settings.quality} disabled={busy || settings.format === "png"} onChange={(e) => setSettings({ ...settings, quality: +e.target.value })} /></label></div>
    <label>Filename suffix<input value={settings.suffix} maxLength={100} disabled={busy} onChange={(e) => setSettings({ ...settings, suffix: e.target.value })} /></label>
    <label className="check-label"><input type="checkbox" checked={keepRatio} disabled={busy} onChange={(e) => { setKeepRatio(e.target.checked); if (e.target.checked) setSettings({ ...settings, height: 0 }); }} /> Keep aspect ratio</label>
    <div className="form-row"><label>Width (0 = automatic)<input type="number" min="0" max="32768" value={settings.width} disabled={busy} onChange={(e) => updateDimension("width", +e.target.value)} /></label>
      <label>Height (0 = automatic)<input type="number" min="0" max="32768" value={settings.height} disabled={busy} onChange={(e) => updateDimension("height", +e.target.value)} /></label></div>
    {settings.format === "jpeg" && <label>Transparency fill<input type="color" value={settings.matte} disabled={busy} onChange={(e) => setSettings({ ...settings, matte: e.target.value })} /></label>}
    <small>Zero in both dimensions keeps the edited size. Existing files are never overwritten; duplicate names receive a number.</small>
  </div></ToolSection>;

  return <aside className="workspace-drawer" aria-label="Editing workspace" onPointerDown={(e) => e.stopPropagation()} onPointerMove={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
    <div className="workspace-heading"><strong>Workspace</strong><button aria-label="Close workspace" disabled={busy} onClick={props.onClose}><X size={17} /></button></div>
    <nav>{(["history", "workflows", "batch", "export", "memory"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => props.onTab(item)}>{(() => { const Icon = tabIcons[item]; return <Icon size={15} aria-hidden="true" />; })()}{item}</button>)}</nav>
    <div className="workspace-content"><ToolSection key={tab} id={`workspace-${tab}`} title={tab[0].toUpperCase() + tab.slice(1)} icon={tabIcons[tab]}>
      {tab === "history" && <><p>Choose any step to return to it. A new edit replaces the steps after the selected one.</p><div className="history-list">{props.history.map((entry, index) => <button key={index} className={index === props.position ? "selected" : ""} disabled={busy} onClick={() => props.onJump(index)}><img src={entry.data} alt="" loading="lazy" decoding="async" /><span><strong>{index}. {entry.label}</strong>{index === props.position && <small>Current image</small>}</span></button>)}</div></>}
      {tab === "workflows" && <div className="workspace-form">
        {workflowPicker}
        <div className="form-row"><button disabled={busy || !workflow} onClick={() => { if (workflow) { setDraft(structuredClone(workflow.steps)); setWorkflowName(workflow.name); } }}>Edit a copy</button><button disabled={busy || !workflow} onClick={() => { saveWorkflows(workflows.filter((item) => item.id !== selected)); setSelected(""); }}><Trash2 size={13} /> Delete</button></div>
        {workflow && <><ol>{workflow.steps.map((step, i) => <li key={i}>{step.label}</li>)}</ol><button className="accent" disabled={busy || !data} onClick={() => void props.onRun(workflow.steps, workflow.name)}><Play size={14} /> Run on current image</button></>}
        <hr /><strong>Build a workflow</strong><p>Add operations using the current tool settings. Face replacement uses the largest face in each image. Source photos are saved as file paths.</p>
        <label>Operation<select disabled={busy} value={suggestion} onChange={(e) => setSelectedSuggestion(operationKey(props.suggestions[+e.target.value]))}>{props.suggestions.map((item, index) => <option key={index} value={index}>{item.label}</option>)}</select></label>
        <button disabled={busy || draft.length >= 32 || !props.suggestions[suggestion]} onClick={() => setDraft([...draft, structuredClone(props.suggestions[suggestion])])}><Plus size={14} /> Add step</button>
        <ol className="workflow-steps">{draft.map((step, index) => <li key={index}><span>{step.label}</span><button aria-label={`Move step ${index + 1} up`} disabled={busy || index === 0} onClick={() => setDraft((old) => { const next = [...old]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}><ArrowUp size={12} /></button><button aria-label={`Move step ${index + 1} down`} disabled={busy || index === draft.length - 1} onClick={() => setDraft((old) => { const next = [...old]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next; })}><ArrowDown size={12} /></button><button aria-label={`Remove step ${index + 1}`} disabled={busy} onClick={() => setDraft(draft.filter((_, i) => i !== index))}><X size={12} /></button></li>)}</ol>
        <label>Workflow name<input disabled={busy} maxLength={80} value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} /></label>
        <button disabled={busy || !draft.length || !workflowName.trim()} onClick={() => { const item = { id: crypto.randomUUID(), name: workflowName.trim(), steps: structuredClone(draft) }; saveWorkflows([...workflows, item]); setSelected(item.id); }}><Plus size={14} /> Save workflow</button>
      </div>}
      {tab === "export" && <><p>Current image: {props.dimensions.width} × {props.dimensions.height} px.</p>{exportControls}<button className="accent full-width" disabled={busy || !data || !settings.directory} onClick={() => void exportCurrent()}>Export a copy</button>{lastExport && <p className="path-text">Saved: {lastExport}</p>}</>}
      {tab === "batch" && <div className="workspace-form">{workflowPicker}<button disabled={busy} onClick={() => void chooseFiles()}><Plus size={14} /> Add pictures</button><small>Files are read from disk. Unsaved edits in the current editor are not included.</small>{exportControls}
        <div className="form-row"><button className="accent" disabled={busy || !workflow || !files.length || !settings.directory} onClick={() => void runBatch()}><Play size={14} /> Run {files.length} pictures</button>{batchRunning ? <button onClick={() => { cancelled.current = true; onMessage("Stopping after the current operation…"); }}>Stop</button> : <button disabled={busy || !files.length} onClick={() => setFiles([])}>Clear list</button>}</div>
        <small>Jobs run sequentially and reuse loaded models. Stop takes effect after the current operation.</small>
        <ul className="batch-list">{files.map((item) => <li key={item.path}><strong title={item.path}>{fileName(item.path)}</strong><small>{item.status}</small>{item.output && <small className="path-text">{item.output}</small>}</li>)}</ul>
      </div>}
      {tab === "memory" && <div className="workspace-form"><button disabled={busy || memoryBusy} onClick={() => void refreshMemory()}><RefreshCw size={14} /> Refresh</button>
        <p>Models stay loaded until you unload them or close the app. Unloading frees them for other applications; the next operation loads them again.</p>
        {memory && <><div className="memory-stats"><span>Worker RAM<strong>{memorySize(memory.memory.ram)}</strong></span><span>PyTorch GPU memory<strong>{memorySize(memory.memory.vram)}</strong></span></div><small>GPU figures cover PyTorch allocations; ONNX and driver allocations are not included.</small>
          {[...memory.models.map((key) => ({ kind: "model", key })), ...memory.plugins.map((key) => ({ kind: "plugin", key }))].map((item) => <div className="memory-row" key={`${item.kind}:${item.key}`}><span>{item.key}</span><button disabled={busy} onClick={() => void unload(item.kind, item.key)}>Unload</button></div>)}
          {!memory.models.length && !memory.plugins.length && <p>No models loaded.</p>}
          <button disabled={busy || (!memory.models.length && !memory.plugins.length)} onClick={() => void unload("plugin", "all")}>Unload all models</button></>}
      </div>}
    </ToolSection></div>
  </aside>;
}
