/**
 * @file Synthetic terrain aspect verification tab.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { generateDEM, type TerrainShape } from '../terrainGen';
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

export default function TerrainTab() {
  const [gridSize, setGridSize] = useState(256);
  const [coneHeight, setConeHeight] = useState(500);
  const [coneRadius, setConeRadius] = useState(80);
  const [shape, setShape] = useState<TerrainShape>('cone');
  const [prefAz, setPrefAz] = useState(180);
  const [prefStr, setPrefStr] = useState(100);
  const [slopeW, setSlopeW] = useState(0);
  const [stats, setStats] = useState<OctantStat[]>([]);
  const [asserts, setAsserts] = useState<Assertion[]>([]);

  const cvElev = useRef<HTMLCanvasElement>(null);
  const cvAspect = useRef<HTMLCanvasElement>(null);
  const cvSuit = useRef<HTMLCanvasElement>(null);
  const cv3d = useRef<HTMLCanvasElement>(null);

  const generate = useCallback(() => {
    const N = Math.min(1024, Math.max(64, gridSize));
    const dem = generateDEM(shape, N, coneHeight, coneRadius);
    const { aspect, slope } = computeAspectSlope(dem, N);
    const suit = computeSuitability(aspect, slope, N, prefAz, prefStr / 100, slopeW / 100);

    const maxE = Math.max(...dem) || 1;
    if (cvElev.current) {
      renderGrid(cvElev.current, dem, N, (v) => {
        const t = v / maxE;
        const c = Math.round(26 + t * 198);
        return [c, c, c + Math.round(t * 20)];
      });
    }
    if (cvAspect.current) renderGrid(cvAspect.current, aspect, N, aspectColor);
    if (cvSuit.current) renderGrid(cvSuit.current, suit, N, suitColor);
    if (cv3d.current) renderOblique(cv3d.current, dem, suit, N);

    const s = analyzeOctants(aspect, suit, N);
    const a = runAssertions(s, prefAz);
    setStats(s);
    setAsserts(a);
  }, [gridSize, coneHeight, coneRadius, shape, prefAz, prefStr, slopeW]);

  // Auto-generate on mount
  useEffect(() => {
    generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h1 className="adm-title">Terrain Aspect Orientation Test</h1>
      <p className="adm-desc">
        Synthetic DEM with known slope orientations. Verify that the preferred-azimuth
        scoring tints south-facing slopes green (high) and north-facing red (low).
      </p>

      <div className="adm-controls">
        <div className="adm-cg">
          <label>Grid</label>
          <input type="number" value={gridSize} min={64} max={1024} step={64} onChange={(e) => setGridSize(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Height</label>
          <input type="number" value={coneHeight} min={50} max={2000} step={50} onChange={(e) => setConeHeight(+e.target.value)} />
        </div>
        <div className="adm-cg">
          <label>Radius %</label>
          <input type="range" value={coneRadius} min={20} max={100} onChange={(e) => setConeRadius(+e.target.value)} />
          <span className="adm-cv">{coneRadius}%</span>
        </div>
        <div className="adm-cg">
          <label>Shape</label>
          <select value={shape} onChange={(e) => setShape(e.target.value as TerrainShape)}>
            <option value="cone">Cone</option>
            <option value="ridge_ns">Ridge N-S</option>
            <option value="ridge_ew">Ridge E-W</option>
            <option value="pyramid">Pyramid</option>
            <option value="hemisphere">Hemisphere</option>
            <option value="noise_peaks">Noisy Peaks</option>
          </select>
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
        <button className="adm-btn" onClick={generate}>Generate &amp; Test</button>
      </div>

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
