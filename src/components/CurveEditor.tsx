/**
 * @file CurveEditor: interactive SVG editor for transfer functions.
 *
 * Shows a graph with:
 *   - X axis: raw data value (with actual data range from DataStats)
 *   - Y axis: output score 0-1
 *   - Draggable handles for plateauEnd, decayEnd, floor
 *   - Curve shape matching the TF shape (sin/invsin/range/invrange)
 *   - Data distribution markers (min, p25, median, p75, max)
 *   - Shape selector, mandatory toggle
 */
import { useCallback, useRef, useState } from 'react';
import type { TransferFunction, DataStats, TfShape } from '../types/transferFunction';
import './CurveEditor.css';

interface CurveEditorProps {
  tf: TransferFunction;
  stats?: DataStats;
  /** Maximum x-axis value for the editor range */
  rangeMax: number;
  /** Unit label for the x-axis */
  unit: string;
  /** Callback when the TF is updated */
  onChange: (tf: TransferFunction) => void;
}

/** Editor dimensions */
const W = 280;
const H = 140;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/** Convert data-space x to SVG x */
function toSvgX(value: number, rangeMax: number): number {
  return PAD_L + (value / rangeMax) * PLOT_W;
}

/** Convert score (0-1) to SVG y */
function toSvgY(score: number): number {
  return PAD_T + (1 - score) * PLOT_H;
}

/** Convert SVG x to data-space value */
function fromSvgX(svgX: number, rangeMax: number): number {
  return Math.max(0, Math.min(rangeMax, ((svgX - PAD_L) / PLOT_W) * rangeMax));
}

/** Convert SVG y to score (0-1) */
function fromSvgY(svgY: number): number {
  return Math.max(0, Math.min(1, 1 - (svgY - PAD_T) / PLOT_H));
}

/**
 * Generate SVG path for the transfer function curve.
 */
function buildCurvePath(tf: TransferFunction, rangeMax: number): string {
  const { plateauEnd: M, decayEnd: N, floor, shape } = tf;
  const high = 1.0;
  const low = floor;
  const steps = 60;
  const points: string[] = [];

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * rangeMax;
    let y: number;

    const span = N - M;
    const t = Math.abs(span) < 1e-9 ? 0 : Math.max(0, Math.min(1, (x - M) / span));

    switch (shape) {
      case 'invsin':
        if (x <= M) y = low;
        else if (x >= N) y = high;
        else y = low + (high - low) * 0.5 * (1 - Math.cos(Math.PI * t));
        break;
      case 'range':
        if (x <= M) y = high;
        else if (x >= N) y = low;
        else y = high - (high - low) * t;
        break;
      case 'invrange':
        if (x <= M) y = low;
        else if (x >= N) y = high;
        else y = low + (high - low) * t;
        break;
      case 'sin':
      default:
        if (x <= M) y = high;
        else if (x >= N) y = low;
        else y = low + (high - low) * 0.5 * (1 + Math.cos(Math.PI * t));
        break;
    }

    const sx = toSvgX(x, rangeMax);
    const sy = toSvgY(y);
    points.push(`${i === 0 ? 'M' : 'L'}${sx.toFixed(1)},${sy.toFixed(1)}`);
  }

  return points.join(' ');
}

type DragTarget = 'plateauEnd' | 'decayEnd' | 'floor' | null;

export default function CurveEditor({
  tf,
  stats,
  rangeMax,
  unit,
  onChange,
}: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);

  const getSvgPoint = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    [],
  );

  const handleMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(target);
    },
    [],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const pt = getSvgPoint(e);

      if (dragging === 'plateauEnd') {
        const val = fromSvgX(pt.x, rangeMax);
        onChange({ ...tf, plateauEnd: Math.min(val, tf.decayEnd - rangeMax * 0.01) });
      } else if (dragging === 'decayEnd') {
        const val = fromSvgX(pt.x, rangeMax);
        onChange({ ...tf, decayEnd: Math.max(val, tf.plateauEnd + rangeMax * 0.01) });
      } else if (dragging === 'floor') {
        const val = fromSvgY(pt.y);
        onChange({ ...tf, floor: Math.round(val * 20) / 20 }); // Snap to 0.05
      }
    },
    [dragging, tf, rangeMax, onChange, getSvgPoint],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  // Handle positions
  const isInv = tf.shape === 'invsin' || tf.shape === 'invrange';
  const plateauX = toSvgX(tf.plateauEnd, rangeMax);
  const decayX = toSvgX(tf.decayEnd, rangeMax);
  const floorY = toSvgY(tf.floor);
  // For normal shapes, plateau handle at top (1.0) and decay at floor.
  // For inverted shapes, plateau handle at floor (low) and decay at top (1.0).
  const plateauHandleY = isInv ? floorY : toSvgY(1.0);
  const decayHandleY = isInv ? toSvgY(1.0) : floorY;

  // Shape cycling
  const SHAPES: TfShape[] = ['sin', 'invsin', 'range', 'invrange'];
  const SHAPE_LABELS: Record<TfShape, string> = { sin: 'SIN', invsin: 'INVSIN', range: 'RANGE', invrange: 'INVRANGE' };
  const cycleShape = useCallback(() => {
    const idx = SHAPES.indexOf(tf.shape ?? 'sin');
    const next = SHAPES[(idx + 1) % SHAPES.length];
    onChange({ ...tf, shape: next });
  }, [tf, onChange]);

  // Curve path
  const curvePath = buildCurvePath(tf, rangeMax);

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

  // X-axis ticks (5 evenly spaced)
  const xTicks = [0, 0.25, 0.5, 0.75, 1.0].map((f) => f * rangeMax);

  return (
    <svg
      ref={svgRef}
      className="curve-editor"
      viewBox={`0 0 ${W} ${H}`}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Background */}
      <rect
        x={PAD_L}
        y={PAD_T}
        width={PLOT_W}
        height={PLOT_H}
        className="ce-bg"
      />

      {/* Grid lines */}
      {yTicks.map((t) => (
        <line
          key={`gy-${t}`}
          x1={PAD_L}
          y1={toSvgY(t)}
          x2={PAD_L + PLOT_W}
          y2={toSvgY(t)}
          className="ce-grid"
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((t) => (
        <text
          key={`ly-${t}`}
          x={PAD_L - 4}
          y={toSvgY(t) + 3}
          className="ce-label ce-label-y"
        >
          {(t * 100).toFixed(0)}%
        </text>
      ))}

      <text
        x={10}
        y={PAD_T + PLOT_H / 2}
        className="ce-axis-title"
        transform={`rotate(-90 10 ${PAD_T + PLOT_H / 2})`}
      >
        Score
      </text>

      {/* X-axis labels */}
      {xTicks.map((v) => (
        <text
          key={`lx-${v}`}
          x={toSvgX(v, rangeMax)}
          y={H - 4}
          className="ce-label ce-label-x"
        >
          {v.toFixed(0)}
        </text>
      ))}

      <text
        x={PAD_L + PLOT_W / 2}
        y={H - 2}
        className="ce-axis-title ce-axis-title-x"
      >
        Value ({unit})
      </text>

      {/* Data distribution markers */}
      {stats && stats.count > 0 && (
        <g className="ce-stats">
          {/* Interquartile range bar */}
          <rect
            x={toSvgX(stats.p25, rangeMax)}
            y={PAD_T}
            width={Math.max(1, toSvgX(stats.p75, rangeMax) - toSvgX(stats.p25, rangeMax))}
            height={PLOT_H}
            className="ce-iqr"
          />
          {/* Median line */}
          <line
            x1={toSvgX(stats.median, rangeMax)}
            y1={PAD_T}
            x2={toSvgX(stats.median, rangeMax)}
            y2={PAD_T + PLOT_H}
            className="ce-median"
          />
          {/* Min/max markers */}
          <line
            x1={toSvgX(stats.min, rangeMax)}
            y1={PAD_T + PLOT_H - 6}
            x2={toSvgX(stats.min, rangeMax)}
            y2={PAD_T + PLOT_H}
            className="ce-minmax"
          />
          <line
            x1={toSvgX(stats.max, rangeMax)}
            y1={PAD_T + PLOT_H - 6}
            x2={toSvgX(stats.max, rangeMax)}
            y2={PAD_T + PLOT_H}
            className="ce-minmax"
          />
        </g>
      )}

      {/* Floor line */}
      <line
        x1={decayX}
        y1={floorY}
        x2={PAD_L + PLOT_W}
        y2={floorY}
        className="ce-floor-line"
      />

      {/* Curve */}
      <path d={curvePath} className="ce-curve" />

      {/* Vertical zone markers */}
      <line
        x1={plateauX}
        y1={PAD_T}
        x2={plateauX}
        y2={PAD_T + PLOT_H}
        className="ce-zone-line"
        strokeDasharray="4 2"
      />
      <line
        x1={decayX}
        y1={PAD_T}
        x2={decayX}
        y2={PAD_T + PLOT_H}
        className="ce-zone-line"
        strokeDasharray="4 2"
      />

      {/* Draggable handles */}
      <circle
        cx={plateauX}
        cy={plateauHandleY}
        r={6}
        className={`ce-handle ce-handle-plateau ${dragging === 'plateauEnd' ? 'active' : ''}`}
        onMouseDown={handleMouseDown('plateauEnd')}
      />
      <circle
        cx={decayX}
        cy={decayHandleY}
        r={6}
        className={`ce-handle ce-handle-decay ${dragging === 'decayEnd' ? 'active' : ''}`}
        onMouseDown={handleMouseDown('decayEnd')}
      />
      <rect
        x={PAD_L + PLOT_W - 10}
        y={floorY - 5}
        width={10}
        height={10}
        rx={2}
        className={`ce-handle ce-handle-floor ${dragging === 'floor' ? 'active' : ''}`}
        onMouseDown={handleMouseDown('floor')}
      />

      {/* Handle labels */}
      <text x={plateauX} y={plateauHandleY - 10} className="ce-handle-label">
        {tf.plateauEnd.toFixed(0)}{unit}
      </text>
      <text x={decayX} y={decayHandleY - 10} className="ce-handle-label">
        {tf.decayEnd.toFixed(0)}{unit}
      </text>
      <text x={PAD_L + PLOT_W + 2} y={floorY + 3} className="ce-handle-label ce-floor-label">
        {(tf.floor * 100).toFixed(0)}%
      </text>

      {/* Shape badge (clickable to cycle) */}
      <text
        x={PAD_L + 4} y={PAD_T + 12}
        className="ce-shape-badge"
        style={{ cursor: 'pointer' }}
        onClick={cycleShape}
      >
        {SHAPE_LABELS[tf.shape ?? 'sin']}
      </text>

      {/* Mandatory threshold marker */}
      {tf.mandatory && (
        <circle
          cx={decayX}
          cy={floorY}
          r={3.2}
          className="ce-required-dot"
        />
      )}
    </svg>
  );
}
