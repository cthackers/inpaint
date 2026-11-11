import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { ChipPicker } from "./ImmichPanel";
import Select from "./Select";
import { defaultSmartRules, type SmartRules } from "./smartAlbums";

export default function SmartAlbumDialog({ initial, tags, immich, onSave, onClose }: {
  initial?: { name: string; smartRules?: SmartRules }; tags: string[]; immich: boolean;
  onSave: (name: string, rules: SmartRules) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [rules, setRules] = useState<SmartRules>(() => structuredClone(initial?.smartRules ?? defaultSmartRules));
  const update = <K extends keyof SmartRules>(key: K, value: SmartRules[K]) => setRules((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const pickTags = (key: "tags" | "excludeTags") => <ChipPicker
    popupClassName="smart-album-options"
    chosen={rules[key].map((tag) => ({ id: tag, label: tag }))} options={tags.map((tag) => ({ id: tag, label: tag }))}
    placeholder={key === "tags" ? "Add a required tag" : "Add an excluded tag"} createLabel="Match tag" disabled={false}
    onAdd={(tag) => update(key, [...new Set([...rules[key], tag])])}
    onRemove={(tag) => update(key, rules[key].filter((item) => item !== tag))}
    onCreate={(tag) => { if (tag.trim()) update(key, [...new Set([...rules[key], tag.trim()])]); }} />;

  return <div className="leave-dialog-backdrop">
    <form className="server-dialog smart-album-dialog" role="dialog" aria-modal="true" aria-labelledby="smart-album-title"
      onSubmit={(event) => { event.preventDefault(); if (name.trim() && rules.minRating <= rules.maxRating) { onSave(name.trim(), { ...rules, name: rules.name.trim() }); onClose(); } }}>
      <div className="server-dialog-heading"><strong id="smart-album-title"><Sparkles size={16} /> {initial ? "Edit smart album" : "New smart album"}</strong>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button></div>
      <div className="workspace-form">
        <label>Album name<input autoFocus required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <small>Pictures must match every rule below. Leave a rule empty to include everything in that category.</small>
        <label>Required tags<Select value={rules.tagMatch} onChange={(e) => update("tagMatch", e.target.value as SmartRules["tagMatch"])}>
          <option value="all">Match all of these tags</option><option value="any">Match any of these tags</option>
        </Select></label>
        {pickTags("tags")}
        <span>Exclude pictures with any of these tags</span>{pickTags("excludeTags")}
        <label className="check-label"><input type="checkbox" checked={rules.descendants} onChange={(e) => update("descendants", e.target.checked)} /> Include nested tags (Travel also matches Travel/Paris)</label>
        <label>Favorites<Select value={rules.favorite} onChange={(e) => update("favorite", e.target.value as SmartRules["favorite"])}>
          <option value="any">Any picture</option><option value="yes">Favorites only</option><option value="no">Not favorites</option>
        </Select></label>
        <div className="form-row">
          <label>Minimum rating<Select value={rules.minRating} onChange={(e) => update("minRating", +e.target.value)}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? `${n} stars` : "Unrated (0)"}</option>)}</Select></label>
          <label>Maximum rating<Select value={rules.maxRating} onChange={(e) => update("maxRating", +e.target.value)}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? `${n} stars` : "Unrated (0)"}</option>)}</Select></label>
        </div>
        {rules.minRating > rules.maxRating && <small role="alert">Minimum rating must not exceed maximum rating.</small>}
        <label>Filename contains<input value={rules.name} maxLength={200} onChange={(e) => update("name", e.target.value)} placeholder="Any filename" /></label>
        <fieldset className="smart-formats"><legend>File types (none selected = any)</legend>{["jpg", "png", "webp", "gif", "bmp", "tif"].map((format) =>
          <label key={format}><input type="checkbox" checked={rules.formats.includes(format)} onChange={(e) => update("formats", e.target.checked ? [...rules.formats, format] : rules.formats.filter((item) => item !== format))} />{format.toUpperCase()}</label>)}</fieldset>
        <label>Added within the last … days<input type="number" min={0} max={36500} step={1} value={rules.addedDays} onChange={(e) => update("addedDays", Math.max(0, Math.min(36500, +e.target.value)))} /></label>
        <small>0 means any date. Uses date added, or modified date when date added is unavailable. Smart albums stay in Inpaint and do not move your files.{immich && " For Immich, use Read tags in the Tags panel to refresh the tag index used by these rules."}</small>
      </div>
      <div className="leave-dialog-actions"><button type="button" className="leave-no" onClick={onClose}>Cancel</button><button type="submit" className="leave-yes" disabled={!name.trim() || rules.minRating > rules.maxRating}>{initial ? "Save rules" : "Create smart album"}</button></div>
    </form>
  </div>;
}
