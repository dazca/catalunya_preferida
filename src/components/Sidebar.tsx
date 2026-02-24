/**
 * @file Sidebar - tabbed control panel for layers, map view and presets.
 */
import { useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import FilterPanel from './FilterPanel';
import './Sidebar.css';

type Tab = 'layers' | 'map' | 'presets';

/* -- Small pure presentation helpers ---------------------------------- */

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="ui-toggle-row">
      <span className="ui-toggle-label">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        className={`ui-switch ${checked ? 'on' : 'off'}`}
        onClick={() => onChange(!checked)}
      />
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const display = format ? format(value) : String(value);
  return (
    <div className="ui-slider-row">
      <span className="ui-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ui-slider-val">{display}</span>
    </div>
  );
}

/* -- Layers tab -------------------------------------------------------- */

function LayersTab() {
  const { layers, soloLayer, setSoloLayer } = useAppStore();
  const t = useT();

  return (
    <div className="tab-layers">
      {soloLayer && (
        <div className="solo-banner">
          <span className="solo-banner-dot" />
          <span>{t('solo.prefix')} <strong>{layers.find((l) => l.id === soloLayer)?.label}</strong></span>
          <button className="solo-banner-exit" onClick={() => setSoloLayer(null)}>
            {t('solo.exit')}
          </button>
        </div>
      )}
      <div className="layers-list">
        {layers.map((layer) => (
          <FilterPanel key={layer.id} layer={layer} />
        ))}
      </div>
    </div>
  );
}

/* -- Map tab ----------------------------------------------------------- */

function MapTab() {
  const { view, setView, pointAnalysisMode, togglePointAnalysisMode } = useAppStore();
  const t = useT();

  return (
    <div className="tab-map">
      <div className="map-section">
        <p className="map-section-title">{t('map.section.overlays')}</p>
        <Toggle label={t('map.toggle.heatmap')}      checked={view.showHeatmap}      onChange={(v) => setView({ showHeatmap: v })} />
        <Toggle label={t('map.toggle.choropleth')}   checked={view.showChoropleth}   onChange={(v) => setView({ showChoropleth: v })} />
        <Toggle label={t('map.toggle.borders')}      checked={view.showBorders}      onChange={(v) => setView({ showBorders: v })} />
      </div>

      <div className="map-section">
        <p className="map-section-title">{t('map.section.terrain')}</p>
        <Toggle label={t('map.toggle.3d')}           checked={view.show3dTerrain}    onChange={(v) => setView({ show3dTerrain: v })} />
        <Toggle label={t('map.toggle.hillshade')}    checked={view.showHillshade}    onChange={(v) => setView({ showHillshade: v })} />
        <Toggle label={t('map.toggle.elevation')}    checked={view.showElevationTint} onChange={(v) => setView({ showElevationTint: v })} />
      </div>

      <div className="map-section">
        <p className="map-section-title">{t('map.section.settings')}</p>
        <Slider
          label={t('map.slider.opacity')}
          value={view.heatmapOpacity}
          min={0.05} max={1} step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setView({ heatmapOpacity: v })}
        />
        <Slider
          label={t('map.slider.exaggeration')}
          value={view.terrainExaggeration}
          min={0.5} max={3} step={0.1}
          format={(v) => `${v.toFixed(1)}x`}
          onChange={(v) => setView({ terrainExaggeration: v })}
        />
      </div>

      <div className="map-section">
        <p className="map-section-title">{t('map.section.analysis')}</p>
        <button
          className={`map-analysis-btn ${pointAnalysisMode ? 'active' : ''}`}
          onClick={togglePointAnalysisMode}
        >
          {pointAnalysisMode ? t('map.btn.exitPointAnalysis') : t('map.btn.pointAnalysis')}
        </button>
      </div>
    </div>
  );
}

/* -- Presets tab ------------------------------------------------------- */

function PresetsTab() {
  const { presets, savePreset, loadPreset, deletePreset, resetToDefaults } = useAppStore();
  const [newName, setNewName] = useState('');
  const t = useT();

  const handleSave = () => {
    const name = newName.trim();
    if (!name) return;
    savePreset(name);
    setNewName('');
  };

  return (
    <div className="tab-presets">
      <div className="preset-save-row">
        <input
          className="preset-name-input"
          placeholder={t('presets.placeholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          maxLength={40}
        />
        <button className="preset-save-btn" onClick={handleSave} disabled={!newName.trim()}>
          {t('presets.save')}
        </button>
      </div>

      {presets.length === 0 ? (
        <p className="preset-empty">{t('presets.empty')}</p>
      ) : (
        <ul className="preset-list">
          {presets.map((p) => (
            <li key={p.name} className="preset-item">
              <span className="preset-item-name">{p.name}</span>
              <div className="preset-item-actions">
                <button className="preset-load-btn" onClick={() => loadPreset(p.name)}>{t('presets.load')}</button>
                <button className="preset-del-btn"  onClick={() => deletePreset(p.name)}>X</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="preset-divider" />

      <button className="preset-reset-btn" onClick={resetToDefaults}>
        {t('presets.reset')}
      </button>
    </div>
  );
}

/* -- Root component ---------------------------------------------------- */

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar, toggleLang, lang } = useAppStore();
  const [tab, setTab] = useState<Tab>('layers');
  const t = useT();

  return (
    <>
      <button
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? 'X' : '='}
      </button>

      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`} data-testid="sidebar">
        {/* Header */}
        <header className="sidebar-header">
          <div className="sidebar-brand">
            <span className="sidebar-brand-dot" />
            <div>
              <h1 className="sidebar-title">{t('app.title')}</h1>
              <p className="sidebar-subtitle">{t('app.subtitle')}</p>
            </div>
          </div>
          <button className="lang-toggle" onClick={toggleLang} title="Toggle language">
            {lang === 'ca' ? 'EN' : 'CA'}
          </button>
        </header>

        {/* Tab bar */}
        <nav className="sidebar-tabs">
          {(['layers', 'map', 'presets'] as Tab[]).map((tabId) => (
            <button
              key={tabId}
              className={`sidebar-tab ${tab === tabId ? 'active' : ''}`}
              onClick={() => setTab(tabId)}
            >
              {tabId === 'layers' ? t('tab.layers') : tabId === 'map' ? t('tab.map') : t('tab.presets')}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="sidebar-body">
          {tab === 'layers'  && <LayersTab />}
          {tab === 'map'     && <MapTab />}
          {tab === 'presets' && <PresetsTab />}
        </div>

        <footer className="sidebar-footer">
          <p>{t('app.footer')}</p>
        </footer>
      </aside>
    </>
  );
}