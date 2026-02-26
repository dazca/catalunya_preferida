/**
 * @file Party sentiment editor — multi-axis taxonomy for political parties.
 * Allows defining custom axes (left/right, independence, feminist, ecologist, etc.)
 * and assigning a 0–100 weight per party per axis.
 */
import { useState, useCallback, useMemo } from 'react';

export interface SentimentAxis {
  id: string;
  label: string;
}

export interface PartySentiment {
  /** Party identifier (normalised lowercase). */
  party: string;
  /** Axis values: axisId → 0–100. */
  axes: Record<string, number>;
}

export interface SentimentConfig {
  axes: SentimentAxis[];
  parties: PartySentiment[];
}

export const DEFAULT_AXES: SentimentAxis[] = [
  { id: 'left', label: 'Left-wing' },
  { id: 'independence', label: 'Pro-independence' },
  { id: 'feminist', label: 'Feminist' },
  { id: 'ecologist', label: 'Ecologist' },
  { id: 'populist', label: 'Populist' },
  { id: 'liberal', label: 'Liberal-economic' },
];

/** Known Catalan parties with default axis values. */
const DEFAULT_PARTIES: PartySentiment[] = [
  { party: 'erc',      axes: { left: 65, independence: 95, feminist: 60, ecologist: 50, populist: 30, liberal: 25 } },
  { party: 'jxcat',    axes: { left: 30, independence: 90, feminist: 30, ecologist: 25, populist: 35, liberal: 65 } },
  { party: 'cup',      axes: { left: 95, independence: 95, feminist: 90, ecologist: 85, populist: 50, liberal: 5 } },
  { party: 'psc',      axes: { left: 55, independence: 5,  feminist: 55, ecologist: 35, populist: 25, liberal: 40 } },
  { party: 'pp',       axes: { left: 10, independence: 2,  feminist: 10, ecologist: 10, populist: 25, liberal: 70 } },
  { party: 'vox',      axes: { left: 5,  independence: 0,  feminist: 2,  ecologist: 5,  populist: 85, liberal: 50 } },
  { party: 'comuns',   axes: { left: 80, independence: 40, feminist: 85, ecologist: 75, populist: 35, liberal: 10 } },
  { party: 'podem',    axes: { left: 85, independence: 35, feminist: 80, ecologist: 70, populist: 45, liberal: 8 } },
  { party: 'cs',       axes: { left: 35, independence: 3,  feminist: 25, ecologist: 15, populist: 40, liberal: 60 } },
  { party: 'cdc',      axes: { left: 25, independence: 80, feminist: 20, ecologist: 20, populist: 20, liberal: 75 } },
  { party: 'ciu',      axes: { left: 25, independence: 65, feminist: 20, ecologist: 20, populist: 15, liberal: 75 } },
  { party: 'pdecat',   axes: { left: 25, independence: 80, feminist: 25, ecologist: 20, populist: 15, liberal: 70 } },
  { party: 'icv',      axes: { left: 80, independence: 45, feminist: 75, ecologist: 85, populist: 20, liberal: 10 } },
  { party: 'sumar',    axes: { left: 75, independence: 20, feminist: 80, ecologist: 70, populist: 30, liberal: 15 } },
  { party: 'aliança',  axes: { left: 5,  independence: 95, feminist: 10, ecologist: 10, populist: 60, liberal: 55 } },
];

export const DEFAULT_SENTIMENT_CONFIG: SentimentConfig = {
  axes: DEFAULT_AXES,
  parties: DEFAULT_PARTIES,
};

interface Props {
  config: SentimentConfig;
  onChange: (config: SentimentConfig) => void;
}

const AXIS_COLORS = ['#6c5ce7', '#00b894', '#e84393', '#00cec9', '#fdcb6e', '#0984e3', '#e17055', '#a29bfe'];

export default function SentimentEditor({ config, onChange }: Props) {
  const [newAxisLabel, setNewAxisLabel] = useState('');
  const [newPartyName, setNewPartyName] = useState('');
  const [sortAxis, setSortAxis] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(true);

  const addAxis = useCallback(() => {
    const label = newAxisLabel.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (config.axes.find((a) => a.id === id)) return;
    const axes = [...config.axes, { id, label }];
    const parties = config.parties.map((p) => ({
      ...p,
      axes: { ...p.axes, [id]: 50 },
    }));
    onChange({ axes, parties });
    setNewAxisLabel('');
  }, [newAxisLabel, config, onChange]);

  const removeAxis = useCallback(
    (axisId: string) => {
      const axes = config.axes.filter((a) => a.id !== axisId);
      const parties = config.parties.map((p) => {
        const a = { ...p.axes };
        delete a[axisId];
        return { ...p, axes: a };
      });
      onChange({ axes, parties });
    },
    [config, onChange],
  );

  const addParty = useCallback(() => {
    const party = newPartyName.trim().toLowerCase();
    if (!party || config.parties.find((p) => p.party === party)) return;
    const axes: Record<string, number> = {};
    for (const a of config.axes) axes[a.id] = 50;
    onChange({ ...config, parties: [...config.parties, { party, axes }] });
    setNewPartyName('');
  }, [newPartyName, config, onChange]);

  const removeParty = useCallback(
    (party: string) => {
      onChange({ ...config, parties: config.parties.filter((p) => p.party !== party) });
    },
    [config, onChange],
  );

  const setAxisValue = useCallback(
    (party: string, axisId: string, value: number) => {
      const parties = config.parties.map((p) =>
        p.party === party ? { ...p, axes: { ...p.axes, [axisId]: value } } : p,
      );
      onChange({ ...config, parties });
    },
    [config, onChange],
  );

  const sortedParties = useMemo(() => {
    if (!sortAxis) return config.parties;
    return [...config.parties].sort((a, b) => {
      const va = a.axes[sortAxis] ?? 0;
      const vb = b.axes[sortAxis] ?? 0;
      return sortDesc ? vb - va : va - vb;
    });
  }, [config.parties, sortAxis, sortDesc]);

  const handleSort = (axisId: string) => {
    if (sortAxis === axisId) {
      setSortDesc(!sortDesc);
    } else {
      setSortAxis(axisId);
      setSortDesc(true);
    }
  };

  const resetDefaults = () => onChange(DEFAULT_SENTIMENT_CONFIG);

  return (
    <div className="adm-di-card adm-di-card-wide">
      <h4>Party Sentiment Editor</h4>
      <small style={{ color: '#8d95ad', marginBottom: 6, display: 'block' }}>
        Assign a 0–100% weight per party per axis. Custom axes can be added. Values are persisted and used for vote consistency checks.
      </small>

      {/* Axis management */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: '0.78em', color: '#8d95ad' }}>Axes:</span>
        {config.axes.map((axis, i) => (
          <span
            key={axis.id}
            style={{
              background: (AXIS_COLORS[i % AXIS_COLORS.length]) + '22',
              color: AXIS_COLORS[i % AXIS_COLORS.length],
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: '0.78em',
              display: 'inline-flex',
              gap: 4,
              alignItems: 'center',
            }}
          >
            {axis.label}
            <button
              onClick={() => removeAxis(axis.id)}
              style={{
                background: 'none', border: 'none', color: '#d63031', cursor: 'pointer',
                fontSize: '0.9em', padding: 0, lineHeight: 1,
              }}
              title="Remove axis"
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          placeholder="New axis…"
          value={newAxisLabel}
          onChange={(e) => setNewAxisLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAxis()}
          style={{
            background: '#232730', color: '#e0e0e0', border: '1px solid #2d3440',
            borderRadius: 4, padding: '2px 6px', fontSize: '0.78em', width: 100,
          }}
        />
        <button className="adm-btn-secondary" style={{ padding: '2px 8px', fontSize: '0.78em' }} onClick={addAxis}>
          + Axis
        </button>
      </div>

      {/* Party table */}
      <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
        <table className="adm-stats-table" style={{ width: '100%', fontSize: '0.75em' }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', top: 0, background: '#181b21', zIndex: 2 }}>Party</th>
              {config.axes.map((axis, i) => (
                <th
                  key={axis.id}
                  style={{
                    position: 'sticky', top: 0, background: '#181b21', zIndex: 2,
                    cursor: 'pointer', color: AXIS_COLORS[i % AXIS_COLORS.length],
                    userSelect: 'none',
                  }}
                  onClick={() => handleSort(axis.id)}
                  title="Click to sort"
                >
                  {axis.label}
                  {sortAxis === axis.id ? (sortDesc ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
              <th style={{ position: 'sticky', top: 0, background: '#181b21', zIndex: 2 }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedParties.map((p) => (
              <tr key={p.party}>
                <td style={{ fontWeight: 600, textTransform: 'uppercase' }}>{p.party}</td>
                {config.axes.map((axis, i) => {
                  const val = p.axes[axis.id] ?? 0;
                  const col = AXIS_COLORS[i % AXIS_COLORS.length];
                  return (
                    <td key={axis.id} style={{ padding: '2px 4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={val}
                          onChange={(e) => setAxisValue(p.party, axis.id, Number(e.target.value))}
                          style={{ width: 60, accentColor: col }}
                        />
                        <span
                          style={{
                            minWidth: 28,
                            textAlign: 'right',
                            color: val > 70 ? col : val < 30 ? '#d63031' : '#aab1c7',
                            fontWeight: 600,
                            fontSize: '0.95em',
                          }}
                        >
                          {val}
                        </span>
                      </div>
                    </td>
                  );
                })}
                <td>
                  <button
                    onClick={() => removeParty(p.party)}
                    style={{
                      background: 'none', border: 'none', color: '#d63031',
                      cursor: 'pointer', fontSize: '0.85em',
                    }}
                    title="Remove party"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add party + actions */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Add party…"
          value={newPartyName}
          onChange={(e) => setNewPartyName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addParty()}
          style={{
            background: '#232730', color: '#e0e0e0', border: '1px solid #2d3440',
            borderRadius: 4, padding: '4px 8px', fontSize: '0.82em', width: 140,
          }}
        />
        <button className="adm-btn-secondary" style={{ padding: '4px 10px', fontSize: '0.8em' }} onClick={addParty}>
          + Party
        </button>
        <div style={{ flex: 1 }} />
        <button className="adm-btn-secondary" style={{ padding: '4px 10px', fontSize: '0.8em' }} onClick={resetDefaults}>
          Reset defaults
        </button>
      </div>
    </div>
  );
}
