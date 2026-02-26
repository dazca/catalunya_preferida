/**
 * @file Political axis registry.
 *
 * **To add a new ideological axis**, add ONE entry to POLITICAL_AXES below.
 * The entire UI (layer menu, scorer, variable grids, formula engine, i18n)
 * derives from this registry automatically — no other file needs changes.
 *
 * Each axis represents a weighted combination of party vote percentages.
 * The axis score for a municipality is:
 *   Σ(partyPct_i × weight_i)   where weight_i ∈ [0, 1]
 * giving a 0–100 range (0 = no alignment, 100 = full alignment).
 */

import type { LayerId } from '../types';
import type { LayerTransferConfig } from '../types/transferFunction';
import { defaultTf } from '../types/transferFunction';

/* ── Types ─────────────────────────────────────────────────────────── */

export interface PoliticalAxis {
  /** Unique key — layerId will be `axis_${id}`. Keep it camelCase. */
  id: string;
  /** Emoji icon for the layer list. */
  icon: string;
  /** Catalan label. */
  labelCA: string;
  /** English label. */
  labelEN: string;
  /** Catalan description. */
  descCA: string;
  /** English description. */
  descEN: string;
  /**
   * Mapping of canonical party key → weight (0–1).
   * Unlisted parties contribute 0 to the axis score.
   * Party keys must match those in VoteSentiment.partyPcts
   * (e.g. 'ERC', 'CUP', 'PSC', 'PP', etc.)
   */
  partyWeights: Record<string, number>;
}

/* ── Registry ──────────────────────────────────────────────────────── */

export const POLITICAL_AXES: readonly PoliticalAxis[] = [
  {
    id: 'leftWing',
    icon: '✊',
    labelCA: 'Esquerres',
    labelEN: 'Left Wing',
    descCA: 'Sentiment d\'esquerres ponderat per partits',
    descEN: 'Left-wing sentiment weighted by party vote share',
    partyWeights: {
      CUP: 0.95, PODEM: 0.9, COMUNS: 0.85, ERC: 0.7, PSC: 0.6,
      PDeCAT: 0.2, JUNTS: 0.2, Cs: 0.15, PP: 0.1, VOX: 0.0,
    },
  },
  {
    id: 'proIndependence',
    icon: '🎗️',
    labelCA: 'Independentisme',
    labelEN: 'Pro-Independence',
    descCA: 'Sentiment independentista ponderat per partits',
    descEN: 'Pro-independence sentiment weighted by party vote share',
    partyWeights: {
      ERC: 0.95, CUP: 0.95, JUNTS: 0.95, PDeCAT: 0.85, CiU: 0.7,
      COMUNS: 0.3, PODEM: 0.2, PSC: 0.0, PP: 0.0, VOX: 0.0, Cs: 0.0,
    },
  },
  {
    id: 'feminist',
    icon: '♀️',
    labelCA: 'Feminisme',
    labelEN: 'Feminist',
    descCA: 'Sentiment feminista ponderat per partits',
    descEN: 'Feminist sentiment weighted by party vote share',
    partyWeights: {
      CUP: 0.95, COMUNS: 0.9, PODEM: 0.85, ERC: 0.7, PSC: 0.6,
      JUNTS: 0.3, PDeCAT: 0.2, Cs: 0.15, PP: 0.1, VOX: 0.0,
    },
  },
  {
    id: 'ecologist',
    icon: '🌿',
    labelCA: 'Ecologisme',
    labelEN: 'Ecologist',
    descCA: 'Sentiment ecologista ponderat per partits',
    descEN: 'Ecologist sentiment weighted by party vote share',
    partyWeights: {
      CUP: 0.9, COMUNS: 0.9, PODEM: 0.85, ERC: 0.6, PSC: 0.4,
      JUNTS: 0.2, PDeCAT: 0.15, Cs: 0.1, PP: 0.05, VOX: 0.0,
    },
  },
  {
    id: 'populist',
    icon: '📢',
    labelCA: 'Populisme',
    labelEN: 'Populist',
    descCA: 'Sentiment populista ponderat per partits',
    descEN: 'Populist sentiment weighted by party vote share',
    partyWeights: {
      VOX: 0.85, CUP: 0.8, PODEM: 0.7, COMUNS: 0.5, JUNTS: 0.3,
      ERC: 0.3, PP: 0.3, PSC: 0.2, Cs: 0.2, PDeCAT: 0.1,
    },
  },
  {
    id: 'liberalEconomic',
    icon: '📈',
    labelCA: 'Liberalisme econòmic',
    labelEN: 'Liberal-Economic',
    descCA: 'Sentiment liberal-econòmic ponderat per partits',
    descEN: 'Liberal-economic sentiment weighted by party vote share',
    partyWeights: {
      Cs: 0.8, PP: 0.75, PDeCAT: 0.7, JUNTS: 0.65, VOX: 0.5,
      PSC: 0.3, ERC: 0.25, COMUNS: 0.1, PODEM: 0.1, CUP: 0.0,
    },
  },
];

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Derive LayerId from an axis id. */
export function axisLayerId(axisId: string): LayerId {
  return `axis_${axisId}` as LayerId;
}

/** Extract axis id from a LayerId (strips 'axis_' prefix). */
export function axisIdFromLayerId(layerId: string): string | null {
  return layerId.startsWith('axis_') ? layerId.slice(5) : null;
}

/** Check if a LayerId is an axis layer. */
export function isAxisLayer(layerId: string): boolean {
  return layerId.startsWith('axis_');
}

/** Find an axis definition by its id. */
export function getAxis(axisId: string): PoliticalAxis | undefined {
  return POLITICAL_AXES.find(a => a.id === axisId);
}

/**
 * Compute the axis score for a municipality from its party percentages.
 *
 * Formula:  Σ(partyPct_i × weight_i)
 * Result is 0–100 (%).
 */
export function computeAxisScore(
  axis: PoliticalAxis,
  partyPcts: Record<string, number>,
): number {
  let sum = 0;
  for (const [party, weight] of Object.entries(axis.partyWeights)) {
    sum += (partyPcts[party] ?? 0) * weight;
  }
  return Math.round(sum * 100) / 100;
}

/** Get all axis LayerIds. */
export function getAllAxisLayerIds(): LayerId[] {
  return POLITICAL_AXES.map(a => axisLayerId(a.id));
}

/**
 * Build default axisConfigs record from the registry.
 * Each axis gets a simple 0–100 sinusoidal TF.
 */
export function buildDefaultAxisConfigs(): Record<string, LayerTransferConfig> {
  const configs: Record<string, LayerTransferConfig> = {};
  for (const axis of POLITICAL_AXES) {
    configs[axis.id] = { enabled: true, tf: defaultTf(0, 100, 'sin', 0) };
  }
  return configs;
}
