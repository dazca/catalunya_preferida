/**
 * @file ViewMenu — floating control panel for toggling map overlays
 *       (3D terrain, hillshade, elevation tint, heatmap, borders,
 *       choropleth) and adjusting terrain exaggeration / heatmap opacity.
 */
import { useAppStore } from '../store';
import type { ViewSettings } from '../store';
import './ViewMenu.css';

/** Single toggle row. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="vm-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="vm-toggle-label">{label}</span>
    </label>
  );
}

/** Inline range slider. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="vm-slider">
      <span className="vm-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="vm-slider-value">{value.toFixed(2)}</span>
    </div>
  );
}

export default function ViewMenu() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  const set = <K extends keyof ViewSettings>(key: K, val: ViewSettings[K]) =>
    setView({ [key]: val });

  return (
    <div className="view-menu">
      <h4 className="vm-title">View</h4>

      <div className="vm-section">
        <span className="vm-section-label">Terrain</span>
        <Toggle label="3D Relief" checked={view.show3dTerrain} onChange={(v) => set('show3dTerrain', v)} />
        <Toggle label="Hillshade" checked={view.showHillshade} onChange={(v) => set('showHillshade', v)} />
        <Toggle label="Elevation Tint" checked={view.showElevationTint} onChange={(v) => set('showElevationTint', v)} />
        {view.show3dTerrain && (
          <Slider
            label="Exaggeration"
            value={view.terrainExaggeration}
            min={0.5}
            max={3.0}
            step={0.1}
            onChange={(v) => set('terrainExaggeration', v)}
          />
        )}
      </div>

      <div className="vm-section">
        <span className="vm-section-label">Data</span>
        <Toggle label="Score Heatmap" checked={view.showHeatmap} onChange={(v) => set('showHeatmap', v)} />
        <Toggle label="Choropleth" checked={view.showChoropleth} onChange={(v) => set('showChoropleth', v)} />
        {view.showHeatmap && (
          <Slider
            label="Opacity"
            value={view.heatmapOpacity}
            min={0.1}
            max={1.0}
            step={0.05}
            onChange={(v) => set('heatmapOpacity', v)}
          />
        )}
      </div>

      <div className="vm-section">
        <span className="vm-section-label">Overlays</span>
        <Toggle label="Municipality Borders" checked={view.showBorders} onChange={(v) => set('showBorders', v)} />
      </div>
    </div>
  );
}
