import { Brush, SlidersHorizontal, Expand, WandSparkles } from "lucide-react";
import ToolSection from "./ToolSection";
import { neutralAdjustments, type Adjustments } from "./editorOperations";
import { INPAINT_MODELS } from "./models";
export type BrushTool = "paint" | "erase" | "smart" | "clone" | "heal";
export type BrushSettings = { hardness: number; opacity: number; feather: number; grow: number };
export type Edges = { shrink: number; soften: number; decontaminate: number };
export type Extension = { left: number; right: number; top: number; bottom: number; model: string; prompt: string };
type Props = {
  busy: boolean; tool: BrushTool; onTool: (tool: BrushTool) => void; brush: BrushSettings; setBrush: (value: BrushSettings) => void;
  size: number; setSize: (value: number) => void; maskDirty: boolean; refineMask: () => void; resetPoints: () => void; pointCount: number;
  sourceSet: boolean; adjustmentActive: boolean; adjustments: Adjustments; onAdjust: (value: Adjustments) => void; onStartAdjust: () => void; onApplyAdjust: () => void; onCancelAdjust: () => void;
  edges: Edges; setEdges: (value: Edges) => void; onEdges: () => void;
  extension: Extension; setExtension: (value: Extension) => void; onExtend: () => void; width: number; height: number;
};
function Slider({ label, value, onChange, min=0, max=100, step=1, disabled=false, suffix="%" }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; disabled?: boolean; suffix?: string }) {
  return <label className="advanced-slider"><span>{label}<output>{value}{suffix}</output></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(+e.target.value)} /></label>;
}
export default function AdvancedTools(p: Props) {
  return <>
    <ToolSection id="selection" title="Selection and retouching" icon={Brush} defaultOpen={true}><div className="advanced-content">
      <select aria-label="Brush tool" disabled={p.busy || p.adjustmentActive} value={p.tool} onChange={(e) => p.onTool(e.target.value as BrushTool)}><option value="paint">Paint selection</option><option value="erase">Erase selection</option><option value="smart">Smart selection · Click object</option><option value="clone">Clone stamp</option><option value="heal">Healing brush</option></select>
      <Slider label="Brush size" value={Math.round(p.size)} onChange={p.setSize} min={3} max={500} suffix=" px" disabled={p.busy} />
      <Slider label="Hardness" value={p.brush.hardness} onChange={(hardness) => p.setBrush({ ...p.brush, hardness })} disabled={p.busy} />
      <Slider label="Opacity" value={p.brush.opacity} onChange={(opacity) => p.setBrush({ ...p.brush, opacity })} min={1} disabled={p.busy} />
      {p.tool === "smart" && <><div className="plugin-description">Click to include an object. Alt-click to exclude an area. Switch to paint/erase to refine the mask. {p.pointCount} points.</div><button className="plugin-run" disabled={p.busy || !p.pointCount} onClick={p.resetPoints}>Start a new object selection</button></>}
      {(p.tool === "clone" || p.tool === "heal") && <div className="plugin-description">Alt-click to sample a source, then paint the destination. {p.sourceSet ? "Source selected." : "Choose a source point."} {p.tool === "heal" && "Healing matches local color and lighting."}</div>}
      <Slider label="Grow / shrink mask" value={p.brush.grow} onChange={(grow) => p.setBrush({ ...p.brush, grow })} min={-32} max={32} suffix=" px" disabled={p.busy} />
      <Slider label="Feather mask" value={p.brush.feather} onChange={(feather) => p.setBrush({ ...p.brush, feather })} max={32} suffix=" px" disabled={p.busy} />
      <button className="plugin-run" disabled={p.busy || !p.maskDirty} onClick={p.refineMask}>Refine selection edges</button>
    </div></ToolSection>
    <ToolSection id="color" title="Color and lighting" icon={SlidersHorizontal} defaultOpen={false}><div className="advanced-content">
      {!p.adjustmentActive ? <button className="plugin-run" disabled={p.busy} onClick={p.onStartAdjust}>Adjust with live preview</button> : <>
        {(Object.keys(p.adjustments) as (keyof Adjustments)[]).map((key) => <Slider key={key} label={key[0].toUpperCase() + key.slice(1)} value={p.adjustments[key]} min={key === "exposure" ? -3 : -100} max={key === "exposure" ? 3 : 100} step={key === "exposure" ? .1 : 1} suffix={key === "exposure" ? " EV" : ""} disabled={p.busy} onChange={(value) => p.onAdjust({ ...p.adjustments, [key]: value })} />)}
        <div className="plugin-description">Preview updates live. Apply renders at the full image resolution.</div>
        <button className="plugin-run" disabled={p.busy} onClick={() => p.onAdjust({ ...neutralAdjustments })}>Reset sliders</button>
        <button className="plugin-run" disabled={p.busy} onClick={p.onApplyAdjust}>Apply adjustments</button><button className="plugin-run" disabled={p.busy} onClick={p.onCancelAdjust}>Cancel adjustments</button>
      </>}
    </div></ToolSection>
    <ToolSection id="outpaint" title="Extend canvas · Outpaint" icon={Expand} defaultOpen={false}><div className="advanced-content">
      <select aria-label="Outpainting model" disabled={p.busy} value={p.extension.model} onChange={(e) => p.setExtension({ ...p.extension, model: e.target.value })}>{INPAINT_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
      <div className="outpaint-fields">{(["left", "right", "top", "bottom"] as const).map((side) => <label key={side}>{side} (px)<input aria-label={`Extend ${side}`} type="number" min="0" max="4096" value={p.extension[side]} disabled={p.busy} onChange={(e) => p.setExtension({ ...p.extension, [side]: Math.max(0, Math.min(4096, +e.target.value)) })} /></label>)}</div>
      <textarea aria-label="Outpainting prompt" disabled={p.busy} placeholder="Describe the new surroundings (SDXL)…" value={p.extension.prompt} onChange={(e) => p.setExtension({ ...p.extension, prompt: e.target.value })} />
      <div className="plugin-description">Output: {p.width + p.extension.left + p.extension.right} × {p.height + p.extension.top + p.extension.bottom} px. The existing image stays intact. SDXL follows the prompt; other models continue nearby textures.</div>
      <button className="plugin-run" disabled={p.busy || p.adjustmentActive || ![p.extension.left, p.extension.right, p.extension.top, p.extension.bottom].some(Boolean)} onClick={p.onExtend}>Generate extended image</button>
    </div></ToolSection>
  </>;
}

export function BackgroundEdgeTools(p: Pick<Props, "busy" | "adjustmentActive" | "edges" | "setEdges" | "onEdges">) {
  return (
    <ToolSection id="background-edges" title="Edge refinement" icon={WandSparkles} defaultOpen={false}><div className="advanced-content">
      <Slider label="Edge shrink / expand" value={p.edges.shrink} onChange={(shrink) => p.setEdges({ ...p.edges, shrink })} min={-8} max={8} suffix=" px" disabled={p.busy} />
      <Slider label="Edge softness" value={p.edges.soften} onChange={(soften) => p.setEdges({ ...p.edges, soften })} min={0} max={5} step={.1} suffix=" px" disabled={p.busy} />
      <Slider label="Remove color halos" value={Math.round(p.edges.decontaminate * 100)} onChange={(value) => p.setEdges({ ...p.edges, decontaminate: value / 100 })} disabled={p.busy} />
      <div className="plugin-description">Use after removing a background. Small adjustments preserve hair and fine edges.</div>
      <button className="plugin-run" disabled={p.busy || p.adjustmentActive} onClick={p.onEdges}>Refine cutout edges<kbd className="action-shortcut">Alt+E</kbd></button>
    </div></ToolSection>
  );
}
