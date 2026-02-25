/**
 * @file Real Catalonia Pyrenees DEM fetch & analysis tab.
 * Includes retry with exponential backoff for 429 errors.
 */
import { useState, useRef, useCallback } from 'react';
import { fetchElevationGrid } from '../cataloniaFetcher';
import {
  computeAspectSlope,
  computeSuitability,
  renderGrid,
  renderOblique,
  suitColor,
  aspectColor,
  analyzeOctants,
  runAssertions,
  azLabel,
} from '../geoCore';
import { CompassSVG, AssertionsBox } from '../components/Shared';
import type { OctantStat, Assertion } from '../geoCore';

const PRESETS = {
  pyrenees: { latMin: 42.55, latMax: 42.75, lonMin: 0.9, lonMax: 1.2, label: 'Catalan Pyrenees' },
  montserrat: { latMin: 41.58, latMax: 41.63, lonMin: 1.81, lonMax: 1.86, label: 'Montserrat' },
  delta: { latMin: 40.70, latMax: 40.78, lonMin: 0.70, lonMax: 0.85, label: 'Ebro Delta' },
} as const;
type PresetKey = keyof typeof PRESETS;

export default function CataloniaTab() {
  const [preset, setPreset] = useState<PresetKey>('pyrenees');
  const [latMin, setLatMin] = useState<number>(PRESETS.pyrenees.latMin);
  const [latMax, setLatMax] = useState<number>(PRESETS.pyrenees.latMax);
  const [lonMin, setLonMin] = useState<number>(PRESETS.pyrenees.lonMin);
  const [lonMax, setLonMax] = useState<number>(PRESETS.pyrenees.lonMax);
  const [resolution, setResolution] = useState(24);
  const [prefAz, setPrefAz] = useState(180);
  const [prefStr, setPrefStr] = useState(100);
  const [slopeW, setSlopeW] = useState(0);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState<OctantStat[]>([]);
  const [asserts, setAsserts] = useState<Assertion[]>([]);

  const cvElev = useRef<HTMLCanvasElement>(null);
  const cvAspect = useRef<HTMLCanvasElement>(null);
  const cvSuit = useRef<HTMLCanvasElement>(null);
  const cv3d = useRef<HTMLCanvasElement>(null);

  const applyPreset = useCallback((k: PresetKey) => {
    setPreset(k);
    const p = PRESETS[k];
    setLatMin(p.latMin);
    setLatMax(p.latMax);
    setLonMin(p.lonMin);
    setLonMax(p.lonMax);
  }, []);

  const fetchAndAnalyze = useCallback(async () => {
    setLoading(true);
    setError('');
    setProgress('Preparing grid…');
    setStats([]);
    setAsserts([]);
    try {
      const { dem: elevations, N } = await fetchElevationGrid(
        latMin, latMax, lonMin, lonMax, resolution,
        (done, tot) => setProgress(`Fetching ${done}/${tot} points…`),
        (msg) => setProgress(msg),
      );
      setProgress('Computing aspect & slope…');
      const { aspect, slope } = computeAspectSlope(elevations, N);
      const suit = computeSuitability(aspect, slope, N, prefAz, prefStr / 100, slopeW / 100);

      setProgress('Rendering…');
      const maxE = Math.max(...elevations) || 1;
      if (cvElev.current) {
        renderGrid(cvElev.current, elevations, N, (v) => {
          const t = Math.max(0, v) / maxE;
          const c = Math.round(26 + t * 198);
          return [c, c, c + Math.round(t * 20)];
        });
      }
      if (cvAspect.current) renderGrid(cvAspect.current, aspect, N, aspectColor);
      if (cvSuit.current) renderGrid(cvSuit.current, suit, N, suitColor);
      if (cv3d.current) renderOblique(cv3d.current, elevations, suit, N);

      const s = analyzeOctants(aspect, suit, N);
      const a = runAssertions(s, prefAz);
      setStats(s);
      setAsserts(a);
      setProgress(`Done — ${N}×${N} grid, ${N * N} points`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress('');
    } finally {
      setLoading(false);
    }
  }, [latMin, latMax, lonMin, lonMax, resolution, prefAz, prefStr, slopeW]);

  return (
    <div>
      <h1 className="adm-title">Catalonia Real DEM</h1>
      <p className="adm-desc">
        Fetch real elevation data from Open-Meteo and verify aspect scoring.
        Rate-limit retries with exponential backoff are built-in.
      </p>

      <div className="adm-controls">
        <div className="adm-cg">
          <label>Preset</label>
          <select value={preset} onChange={(e) => applyPreset(e.target.value as PresetKey)}>
            {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
              <option key={k} value={k}>{PRESETS[k].label}</option>
            ))}
          </select>
        </div>
        <div className="adm-cg">
          <label>Lat min</label>
          <input type="number" step={0.01} value={latMin} onChange={(e) => setLatMin(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Lat max</label>
          <input type="number" step={0.01} value={latMax} onChange={(e) => setLatMax(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Lon min</label>
          <input type="number" step={0.01} value={lonMin} onChange={(e) => setLonMin(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Lon max</label>
          <input type="number" step={0.01} value={lonMax} onChange={(e) => setLonMax(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Resolution (pts)</label>
          <input type="number" value={resolution} min={20} max={300} step={10} onChange={(e) => setResolution(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Pref. Azimuth</label>
          <input type="range" value={prefAz} min={0} max={359} onChange={(e) => setPrefAz(+e.target.value)} />
          <span className="adm-cv">{azLabel(prefAz)}</span>
        </div>
        <div className="adm-cg">
          <label>Pref. Strength</label>
          <input type="range" value={prefStr} min={0} max={100} onChange={(e) => setPrefStr(+e.target.value)} />
          <span className="adm-cv">{prefStr}%</span>
        </div>
        <div className="adm-cg">
          <label>Slope Weight</label>
          <input type="range" value={slopeW} min={0} max={100} onChange={(e) => setSlopeW(+e.target.value)} />
          <span className="adm-cv">{slopeW}%</span>
        </div>
        <button className="adm-btn" onClick={fetchAndAnalyze} disabled={loading}>
          {loading ? 'Fetching…' : 'Fetch & Analyze'}
        </button>
      </div>

      {progress && <div className="adm-progress">{progress}</div>}
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-map-grid">
        <div className="adm-panel">
          <div className="adm-panel-title">Elevation (DEM)</div>
          <canvas ref={cvElev} width={256} height={256} />
          <div className="adm-legend"><span>Low</span><div className="adm-leg-bar adm-leg-elev" /><span>High</span></div>
        </div>
        <div className="adm-panel">
          <div className="adm-panel-title">Aspect (facing direction)</div>
          <div className="adm-compass-wrap">
            <canvas ref={cvAspect} width={256} height={256} />
            <CompassSVG />
          </div>
          <div className="adm-legend"><span>N 0°</span><div className="adm-leg-bar adm-leg-aspect" /><span>N 360°</span></div>
        </div>
        <div className="adm-panel">
          <div className="adm-panel-title">Suitability Score</div>
          <div className="adm-compass-wrap">
            <canvas ref={cvSuit} width={256} height={256} />
            <CompassSVG />
          </div>
          <div className="adm-legend"><span>Bad (0)</span><div className="adm-leg-bar adm-leg-suit" /><span>Good (1)</span></div>
        </div>
        <div className="adm-panel adm-panel-wide">
          <div className="adm-panel-title">Oblique View (north → south)</div>
          <canvas ref={cv3d} width={512} height={300} />
          <div className="adm-legend"><span>Bad</span><div className="adm-leg-bar adm-leg-suit" /><span>Good</span></div>
        </div>
      </div>

      {stats.length > 0 && (
        <AssertionsBox title="Octant Analysis & Assertions" stats={stats} assertions={asserts} />
      )}
    </div>
  );
}
