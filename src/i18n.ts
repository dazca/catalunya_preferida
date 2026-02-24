/**
 * @file i18n – Catalan / English translation strings for the app UI.
 *
 * Usage:
 *   import { useT } from './i18n';
 *   const t = useT();
 *   t('sidebar.title') // 'Catalunya Preferida' or 'Preferred Catalonia'
 */
import { useAppStore } from './store';

export type Lang = 'ca' | 'en';

/** All translatable string keys. */
export interface Translations {
  // ── App shell ──────────────────────────────────────────────────────
  'app.title': string;
  'app.subtitle': string;
  'app.loading': string;
  'app.footer': string;

  // ── Sidebar tabs ───────────────────────────────────────────────────
  'tab.layers': string;
  'tab.map': string;
  'tab.presets': string;

  // ── Solo mode ──────────────────────────────────────────────────────
  'solo.prefix': string;
  'solo.exit': string;
  'solo.button.on': string;
  'solo.button.off': string;

  // ── Map tab ────────────────────────────────────────────────────────
  'map.section.overlays': string;
  'map.section.terrain': string;
  'map.section.settings': string;
  'map.section.analysis': string;
  'map.toggle.heatmap': string;
  'map.toggle.choropleth': string;
  'map.toggle.borders': string;
  'map.toggle.3d': string;
  'map.toggle.hillshade': string;
  'map.toggle.elevation': string;
  'map.slider.opacity': string;
  'map.slider.exaggeration': string;
  'map.btn.pointAnalysis': string;
  'map.btn.exitPointAnalysis': string;

  // ── Presets tab ────────────────────────────────────────────────────
  'presets.placeholder': string;
  'presets.save': string;
  'presets.empty': string;
  'presets.load': string;
  'presets.reset': string;

  // ── FilterPanel ────────────────────────────────────────────────────
  'fp.weight': string;

  // ── TF controls ───────────────────────────────────────────────────
  'tf.on': string;
  'tf.req': string;
  'tf.inv': string;

  // ── Layer labels ──────────────────────────────────────────────────
  'layer.terrain.label': string;
  'layer.terrain.desc': string;
  'layer.terrainSlope.label': string;
  'layer.terrainSlope.desc': string;
  'layer.terrainElevation.label': string;
  'layer.terrainElevation.desc': string;
  'layer.terrainAspect.label': string;
  'layer.terrainAspect.desc': string;
  'layer.votes.label': string;
  'layer.votes.desc': string;
  'layer.votesLeft.label': string;
  'layer.votesLeft.desc': string;
  'layer.votesRight.label': string;
  'layer.votesRight.desc': string;
  'layer.votesIndep.label': string;
  'layer.votesIndep.desc': string;
  'layer.votesUnionist.label': string;
  'layer.votesUnionist.desc': string;
  'layer.votesTurnout.label': string;
  'layer.votesTurnout.desc': string;
  'layer.transit.label': string;
  'layer.transit.desc': string;
  'layer.forest.label': string;
  'layer.forest.desc': string;
  'layer.soil.label': string;
  'layer.soil.desc': string;
  'layer.airQuality.label': string;
  'layer.airQuality.desc': string;
  'layer.airQualityPm10.label': string;
  'layer.airQualityPm10.desc': string;
  'layer.airQualityNo2.label': string;
  'layer.airQualityNo2.desc': string;
  'layer.crime.label': string;
  'layer.crime.desc': string;
  'layer.healthcare.label': string;
  'layer.healthcare.desc': string;
  'layer.schools.label': string;
  'layer.schools.desc': string;
  'layer.internet.label': string;
  'layer.internet.desc': string;
  'layer.noise.label': string;
  'layer.noise.desc': string;
  'layer.climate.label': string;
  'layer.climate.desc': string;
  'layer.climateTemp.label': string;
  'layer.climateTemp.desc': string;
  'layer.climateRainfall.label': string;
  'layer.climateRainfall.desc': string;
  'layer.rentalPrices.label': string;
  'layer.rentalPrices.desc': string;
  'layer.employment.label': string;
  'layer.employment.desc': string;
  'layer.amenities.label': string;
  'layer.amenities.desc': string;

  // ── FilterControls (terrain) ──────────────────────────────────────
  'fc.terrain.slope': string;
  'fc.terrain.elevation': string;
  'fc.terrain.aspect': string;

  // ── FilterControls (votes) ─────────────────────────────────────────
  'fc.votes.axis': string;
  'fc.votes.axis.lr': string;
  'fc.votes.axis.ind': string;
  'fc.votes.lr': string;
  'fc.votes.ind': string;
  'fc.votes.addTerm': string;

  // ── Vote metrics ────────────────────────────────────────────────────
  'vote.metric.left': string;
  'vote.metric.right': string;
  'vote.metric.indep': string;
  'vote.metric.union': string;
  'vote.metric.turnout': string;

  // ── Formula Bar ─────────────────────────────────────────────────────
  'fb.show': string;
  'fb.hide': string;
  'fb.addLayer': string;

  // ── FilterControls (other layers) ─────────────────────────────────
  'fc.transit.dist': string;
  'fc.forest.cover': string;
  'fc.airQuality.pm10': string;
  'fc.airQuality.no2': string;
  'fc.crime.rate': string;
  'fc.healthcare.dist': string;
  'fc.schools.dist': string;
  'fc.internet.fiber': string;
  'fc.climate.temp': string;
  'fc.climate.rain': string;
  'fc.rental.monthly': string;
  'fc.employment.unemployed': string;
  'fc.amenities.dist': string;

  // ── MunicipalityInfo ──────────────────────────────────────────────
  'mi.score': string;
  'mi.code': string;
  'mi.close': string;

  // ── PointAnalysisPanel ─────────────────────────────────────────────
  'pa.title': string;
  'pa.overall': string;
  'pa.close': string;
  'pa.noData': string;
  'pa.layerScores': string;
  'pa.rawValues': string;
  'pa.outside': string;
  'pa.dq': string;
}

const CA: Translations = {
  'app.title': 'Catalunya Preferida',
  'app.subtitle': 'Mapa de viure a Catalunya',
  'app.loading': 'Carregant les dades de Catalunya...',
  'app.footer': 'Dades: ICGC - Generalitat - IDESCAT - ACA',

  'tab.layers': 'Capes',
  'tab.map': 'Mapa',
  'tab.presets': 'Perfils',

  'solo.prefix': 'Solo:',
  'solo.exit': 'Surt del solo',
  'solo.button.on': 'Surt del modo solo',
  'solo.button.off': 'Mostrar nomes esta capa',

  'map.section.overlays': 'Capes visuals',
  'map.section.terrain': 'Terreny',
  'map.section.settings': 'Configuracio',
  'map.section.analysis': 'Analisi',
  'map.toggle.heatmap': 'Mapa de calor',
  'map.toggle.choropleth': 'Ombratge municipal',
  'map.toggle.borders': 'Limits',
  'map.toggle.3d': 'Relleu 3D',
  'map.toggle.hillshade': 'Ombratge del terreny',
  'map.toggle.elevation': "Tint d'elevacio",
  'map.slider.opacity': 'Opacitat del mapa de calor',
  'map.slider.exaggeration': 'Exageracio del terreny',
  'map.btn.pointAnalysis': '+  Analisi de punt',
  'map.btn.exitPointAnalysis': 'X  Sortir de l\'analisi de punt',

  'presets.placeholder': 'Nom del perfil...',
  'presets.save': 'Desa',
  'presets.empty': 'Encara no hi ha perfils. Configura les capes i desa un perfil.',
  'presets.load': 'Carrega',
  'presets.reset': 'Restableix els valors predeterminats',

  'fp.weight': 'Pes:',

  'tf.on': 'Act.',
  'tf.req': 'Req.',
  'tf.inv': 'Inv.',

  'layer.terrain.label': 'Terreny',
  'layer.terrain.desc': 'Pendent, orientacio, elevacio',
  'layer.terrainSlope.label': 'Pendent del terreny',
  'layer.terrainSlope.desc': 'Angle del pendent',
  'layer.terrainElevation.label': 'Elevacio del terreny',
  'layer.terrainElevation.desc': 'Altitud mitjana',
  'layer.terrainAspect.label': 'Orientacio del terreny',
  'layer.terrainAspect.desc': 'Direccio del pendent',
  'layer.votes.label': 'Sentiment electoral',
  'layer.votes.desc': 'Eix esquerra/dreta, independencia',
  'layer.votesLeft.label': 'Esquerres %',
  'layer.votesLeft.desc': 'Vot d\'esquerres',
  'layer.votesRight.label': 'Dretes %',
  'layer.votesRight.desc': 'Vot de dretes',
  'layer.votesIndep.label': 'Independentisme %',
  'layer.votesIndep.desc': 'Vot independentista',
  'layer.votesUnionist.label': 'Unionisme %',
  'layer.votesUnionist.desc': 'Vot unionista',
  'layer.votesTurnout.label': 'Participacio %',
  'layer.votesTurnout.desc': 'Participacio electoral',
  'layer.transit.label': 'Transport public',
  'layer.transit.desc': 'Proximitat a tren, metro, bus',
  'layer.forest.label': 'Cobertura forestal',
  'layer.forest.desc': 'Vegetacio i zones verdes',
  'layer.soil.label': "Sol i aquifers",
  'layer.soil.desc': 'Dades geologiques i d\'aigua',
  'layer.airQuality.label': "Qualitat de l'aire",
  'layer.airQuality.desc': 'NO2, PM10, PM2.5, O3',
  'layer.airQualityPm10.label': 'Particules PM10',
  'layer.airQualityPm10.desc': 'Qualitat de l\'aire PM10',
  'layer.airQualityNo2.label': 'Diòxid de nitrogen',
  'layer.airQualityNo2.desc': 'Nivells de NO₂',
  'layer.crime.label': 'Taxes de delictes',
  'layer.crime.desc': 'Delictes per 1000 habitants',
  'layer.healthcare.label': 'Sanitat',
  'layer.healthcare.desc': 'Hospitals i CAPs',
  'layer.schools.label': 'Escoles',
  'layer.schools.desc': 'Proximitat a centres educatius',
  'layer.internet.label': 'Internet',
  'layer.internet.desc': 'Cobertura de fibra i banda ampla',
  'layer.noise.label': 'Soroll',
  'layer.noise.desc': 'Nivells de contaminacio acustica',
  'layer.climate.label': 'Clima',
  'layer.climate.desc': 'Temperatura, pluja, vent',
  'layer.climateTemp.label': 'Temperatura',
  'layer.climateTemp.desc': 'Temperatura mitjana',
  'layer.climateRainfall.label': 'Precipitacio',
  'layer.climateRainfall.desc': 'Nivells de precipitacio',
  'layer.rentalPrices.label': 'Preus de lloguer',
  'layer.rentalPrices.desc': 'Lloguer mitja per municipi',
  'layer.employment.label': 'Ocupacio',
  'layer.employment.desc': 'Atur i renda',
  'layer.amenities.label': 'Equipaments',
  'layer.amenities.desc': 'Cultura, esports, lleure',

  'fc.terrain.slope': 'Pendent',
  'fc.terrain.elevation': 'Elevacio',
  'fc.terrain.aspect': "Orientacio del terreny",

  'fc.votes.axis': 'Eix',
  'fc.votes.axis.lr': 'Esquerra / Dreta',
  'fc.votes.axis.ind': 'Independencia / Unionisme',
  'fc.votes.lr': '% Esquerres',
  'fc.votes.ind': '% Independentisme',
  'fc.votes.addTerm': '+ Afegir metrica',

  'vote.metric.left': 'Esquerres %',
  'vote.metric.right': 'Dretes %',
  'vote.metric.indep': 'Independentisme %',
  'vote.metric.union': 'Unionisme %',
  'vote.metric.turnout': 'Participacio %',

  'fb.show': 'Formula',
  'fb.hide': 'Amaga',
  'fb.addLayer': 'Afegir capa',

  'fc.transit.dist': "Distancia a l'estacio",
  'fc.forest.cover': 'Cobertura forestal',
  'fc.airQuality.pm10': 'Particules PM10',
  'fc.airQuality.no2': 'Diòxid de nitrogen (NO2)',
  'fc.crime.rate': 'Taxa de delictes',
  'fc.healthcare.dist': "Distancia a l'hospital",
  'fc.schools.dist': "Distancia a l'escola",
  'fc.internet.fiber': 'Cobertura de fibra',
  'fc.climate.temp': 'Temperatura mitjana',
  'fc.climate.rain': 'Precipitacio',
  'fc.rental.monthly': 'Lloguer mensual',
  'fc.employment.unemployed': 'Atur',
  'fc.amenities.dist': "Distancia a l'equipament",

  'mi.score': 'Puntuacio composta',
  'mi.code': 'Codi:',
  'mi.close': 'Tanca',

  'pa.title': 'Analisi de punt',
  'pa.overall': 'Puntuacio global',
  'pa.close': 'Tanca',
  'pa.noData': 'Sense dades',
  'pa.layerScores': 'Puntuacions per capa',
  'pa.rawValues': 'Valors bruts',
  'pa.outside': 'Fora de Catalunya',
  'pa.dq': 'DQ',
};

const EN: Translations = {
  'app.title': 'Preferred Catalonia',
  'app.subtitle': 'Catalonia Living Map',
  'app.loading': 'Loading Catalonia data...',
  'app.footer': 'Data: ICGC - Generalitat - IDESCAT - ACA',

  'tab.layers': 'Layers',
  'tab.map': 'Map',
  'tab.presets': 'Presets',

  'solo.prefix': 'Solo:',
  'solo.exit': 'Exit solo',
  'solo.button.on': 'Exit solo mode',
  'solo.button.off': 'Solo this layer',

  'map.section.overlays': 'Overlays',
  'map.section.terrain': 'Terrain',
  'map.section.settings': 'Settings',
  'map.section.analysis': 'Analysis',
  'map.toggle.heatmap': 'Score Heatmap',
  'map.toggle.choropleth': 'Municipality Fill',
  'map.toggle.borders': 'Borders',
  'map.toggle.3d': '3D Relief',
  'map.toggle.hillshade': 'Hillshade',
  'map.toggle.elevation': 'Elevation Tint',
  'map.slider.opacity': 'Heatmap opacity',
  'map.slider.exaggeration': 'Terrain exaggeration',
  'map.btn.pointAnalysis': '+  Point analysis',
  'map.btn.exitPointAnalysis': 'X  Exit point analysis',

  'presets.placeholder': 'Preset name...',
  'presets.save': 'Save',
  'presets.empty': 'No presets yet. Configure layers and save one above.',
  'presets.load': 'Load',
  'presets.reset': 'Reset all to defaults',

  'fp.weight': 'Weight:',

  'tf.on': 'On',
  'tf.req': 'Req',
  'tf.inv': 'Inv',

  'layer.terrain.label': 'Terrain',
  'layer.terrain.desc': 'Slope, aspect, elevation',
  'layer.terrainSlope.label': 'Terrain Slope',
  'layer.terrainSlope.desc': 'Slope angle',
  'layer.terrainElevation.label': 'Terrain Elevation',
  'layer.terrainElevation.desc': 'Average altitude',
  'layer.terrainAspect.label': 'Slope Orientation',
  'layer.terrainAspect.desc': 'Slope direction',
  'layer.votes.label': 'Vote Sentiment',
  'layer.votes.desc': 'Left/right, independence axis',
  'layer.votesLeft.label': 'Left-wing %',
  'layer.votesLeft.desc': 'Left-wing vote share',
  'layer.votesRight.label': 'Right-wing %',
  'layer.votesRight.desc': 'Right-wing vote share',
  'layer.votesIndep.label': 'Independence %',
  'layer.votesIndep.desc': 'Pro-independence vote share',
  'layer.votesUnionist.label': 'Unionist %',
  'layer.votesUnionist.desc': 'Unionist vote share',
  'layer.votesTurnout.label': 'Turnout %',
  'layer.votesTurnout.desc': 'Voter turnout',
  'layer.transit.label': 'Public Transit',
  'layer.transit.desc': 'Rail, metro, bus proximity',
  'layer.forest.label': 'Forest Cover',
  'layer.forest.desc': 'Vegetation and green areas',
  'layer.soil.label': 'Soil & Aquifers',
  'layer.soil.desc': 'Geological and water data',
  'layer.airQuality.label': 'Air Quality',
  'layer.airQuality.desc': 'NO2, PM10, PM2.5, O3',
  'layer.airQualityPm10.label': 'PM10 Particles',
  'layer.airQualityPm10.desc': 'PM10 air quality',
  'layer.airQualityNo2.label': 'Nitrogen Dioxide',
  'layer.airQualityNo2.desc': 'NO₂ levels',
  'layer.crime.label': 'Crime Rates',
  'layer.crime.desc': 'Offenses per 1000 inhabitants',
  'layer.healthcare.label': 'Healthcare',
  'layer.healthcare.desc': 'Hospitals and health centers',
  'layer.schools.label': 'Schools',
  'layer.schools.desc': 'Educational centers proximity',
  'layer.internet.label': 'Internet',
  'layer.internet.desc': 'Fiber and broadband coverage',
  'layer.noise.label': 'Noise',
  'layer.noise.desc': 'Noise pollution levels',
  'layer.climate.label': 'Climate',
  'layer.climate.desc': 'Temperature, rainfall, wind',
  'layer.climateTemp.label': 'Temperature',
  'layer.climateTemp.desc': 'Average temperature',
  'layer.climateRainfall.label': 'Rainfall',
  'layer.climateRainfall.desc': 'Precipitation levels',
  'layer.rentalPrices.label': 'Rental Prices',
  'layer.rentalPrices.desc': 'Average rent per municipality',
  'layer.employment.label': 'Employment',
  'layer.employment.desc': 'Unemployment and income',
  'layer.amenities.label': 'Amenities',
  'layer.amenities.desc': 'Culture, sports, leisure',

  'fc.terrain.slope': 'Slope',
  'fc.terrain.elevation': 'Elevation',
  'fc.terrain.aspect': 'Slope Orientation',

  'fc.votes.axis': 'Axis',
  'fc.votes.axis.lr': 'Left / Right',
  'fc.votes.axis.ind': 'Independence / Unionist',
  'fc.votes.lr': 'Left-wing %',
  'fc.votes.ind': 'Independence %',
  'fc.votes.addTerm': '+ Add metric',

  'vote.metric.left': 'Left-wing %',
  'vote.metric.right': 'Right-wing %',
  'vote.metric.indep': 'Independence %',
  'vote.metric.union': 'Unionist %',
  'vote.metric.turnout': 'Turnout %',

  'fb.show': 'Formula',
  'fb.hide': 'Hide',
  'fb.addLayer': 'Add layer',

  'fc.transit.dist': 'Distance to station',
  'fc.forest.cover': 'Forest cover',
  'fc.airQuality.pm10': 'PM10 particles',
  'fc.airQuality.no2': 'Nitrogen dioxide (NO2)',
  'fc.crime.rate': 'Crime rate',
  'fc.healthcare.dist': 'Distance to hospital',
  'fc.schools.dist': 'Distance to school',
  'fc.internet.fiber': 'Fiber coverage',
  'fc.climate.temp': 'Avg temperature',
  'fc.climate.rain': 'Rainfall',
  'fc.rental.monthly': 'Monthly rent',
  'fc.employment.unemployed': 'Unemployment',
  'fc.amenities.dist': 'Distance to amenity',

  'mi.score': 'Composite Score',
  'mi.code': 'Code:',
  'mi.close': 'Close',

  'pa.title': 'Point Analysis',
  'pa.overall': 'Overall Score',
  'pa.close': 'Close',
  'pa.noData': 'No data',
  'pa.layerScores': 'Layer Scores',
  'pa.rawValues': 'Raw Values',
  'pa.outside': 'Outside Catalonia',
  'pa.dq': 'DQ',
};

export const TRANSLATIONS: Record<Lang, Translations> = { ca: CA, en: EN };

/**
 * React hook that returns the translate function for the current language.
 * The returned function maps a key to the translation string.
 */
export function useT(): (key: keyof Translations) => string {
  const lang = useAppStore((s) => s.lang);
  const map = TRANSLATIONS[lang];
  return (key) => map[key];
}
