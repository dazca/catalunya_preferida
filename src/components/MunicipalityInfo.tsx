/**
 * @file MunicipalityInfo: popup panel showing details of the selected municipality.
 */
import { useAppStore } from '../store';
import { useT } from '../i18n';
import './MunicipalityInfo.css';

interface MunicipalityInfoProps {
  scores: Record<string, number>;
  municipalityNames: Record<string, string>;
}

export default function MunicipalityInfo({ scores, municipalityNames }: MunicipalityInfoProps) {
  const { selectedMunicipality, selectMunicipality } = useAppStore();
  const t = useT();

  if (!selectedMunicipality) return null;

  const name = municipalityNames[selectedMunicipality] ?? selectedMunicipality;
  const score = scores[selectedMunicipality];

  return (
    <div className="municipality-info" data-testid="municipality-info">
      <button className="mi-close" onClick={() => selectMunicipality(null)} aria-label={t('mi.close')}>
        x
      </button>
      <h2 className="mi-name">{name}</h2>
      <div className="mi-score">
        <span className="mi-score-label">{t('mi.score')}</span>
        <span className="mi-score-value" style={{ color: score > 0.6 ? '#4caf50' : score > 0.3 ? '#ff9800' : '#f44336' }}>
          {score !== undefined ? `${(score * 100).toFixed(0)}%` : 'N/A'}
        </span>
      </div>
      <p className="mi-code">{t('mi.code')} {selectedMunicipality}</p>
    </div>
  );
}
