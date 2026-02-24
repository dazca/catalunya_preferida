/**
 * @file WindRoseEditor: interactive polar chart for terrain slope aspect preferences.
 *
 * Renders an 8-direction wind-rose (N, NE, E, SE, S, SW, W, NW) where each
 * direction has a draggable petal whose radius represents the 0-1 preference
 * weight. Users drag petal tips to set how desirable each slope direction is.
 */
import { useCallback, useRef, useState } from 'react';
import type { AspectPreferences } from '../types/transferFunction';
import './WindRoseEditor.css';

interface WindRoseEditorProps {
  prefs: AspectPreferences;
  onChange: (prefs: AspectPreferences) => void;
}

const DIRECTIONS: (keyof AspectPreferences)[] = [
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW',
];

/** Angle in radians for each direction (0 = up / north, clockwise). */
const DIR_ANGLES: Record<string, number> = {
  N: -Math.PI / 2,
  NE: -Math.PI / 4,
  E: 0,
  SE: Math.PI / 4,
  S: Math.PI / 2,
  SW: (3 * Math.PI) / 4,
  W: Math.PI,
  NW: (-3 * Math.PI) / 4,
};

const SIZE = 160;
const CX = SIZE / 2;
const CY = SIZE / 2;
const MAX_R = 60; // Maximum petal radius
const MIN_R = 6;

/**
 * Convert a direction and value to SVG coordinates.
 */
function dirToXY(dir: string, value: number): [number, number] {
  const angle = DIR_ANGLES[dir];
  const r = MIN_R + value * (MAX_R - MIN_R);
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
}

/**
 * Build the closed SVG path for the petal polygon.
 */
function buildPetalPath(prefs: AspectPreferences): string {
  const points = DIRECTIONS.map((d) => dirToXY(d, prefs[d]));
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
}

export default function WindRoseEditor({ prefs, onChange }: WindRoseEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<keyof AspectPreferences | null>(null);

  const getDirValue = useCallback(
    (e: React.MouseEvent | MouseEvent): { dir: keyof AspectPreferences; value: number } | null => {
      const svg = svgRef.current;
      if (!svg || !dragging) return null;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Distance from center
      const dx = mx - CX;
      const dy = my - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const value = Math.max(0, Math.min(1, (dist - MIN_R) / (MAX_R - MIN_R)));
      return { dir: dragging, value: Math.round(value * 20) / 20 };
    },
    [dragging],
  );

  const handleMouseDown = useCallback(
    (dir: keyof AspectPreferences) => (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(dir);
    },
    [],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const result = getDirValue(e);
      if (result) {
        onChange({ ...prefs, [result.dir]: result.value });
      }
    },
    [getDirValue, prefs, onChange],
  );

  const handleMouseUp = useCallback(() => setDragging(null), []);

  // Ring radii for reference circles
  const rings = [0.25, 0.5, 0.75, 1.0];

  return (
    <svg
      ref={svgRef}
      className="wind-rose-editor"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Reference circles */}
      {rings.map((r) => (
        <circle
          key={r}
          cx={CX}
          cy={CY}
          r={MIN_R + r * (MAX_R - MIN_R)}
          className="wr-ring"
        />
      ))}

      {/* Direction axis lines */}
      {DIRECTIONS.map((d) => {
        const [ex, ey] = dirToXY(d, 1.0);
        return (
          <line
            key={`axis-${d}`}
            x1={CX}
            y1={CY}
            x2={ex}
            y2={ey}
            className="wr-axis"
          />
        );
      })}

      {/* Filled petal polygon */}
      <path d={buildPetalPath(prefs)} className="wr-petal" />

      {/* Direction labels */}
      {DIRECTIONS.map((d) => {
        const [lx, ly] = dirToXY(d, 1.18);
        return (
          <text
            key={`label-${d}`}
            x={lx}
            y={ly + 3}
            className={`wr-dir-label ${d === 'S' ? 'wr-south' : ''}`}
          >
            {d}
          </text>
        );
      })}

      {/* Draggable petal tip handles */}
      {DIRECTIONS.map((d) => {
        const [hx, hy] = dirToXY(d, prefs[d]);
        return (
          <circle
            key={`handle-${d}`}
            cx={hx}
            cy={hy}
            r={5}
            className={`wr-handle ${dragging === d ? 'active' : ''}`}
            onMouseDown={handleMouseDown(d)}
          />
        );
      })}

      {/* Center dot */}
      <circle cx={CX} cy={CY} r={3} className="wr-center" />
    </svg>
  );
}
