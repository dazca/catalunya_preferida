/**
 * @file Admin panel root — login gate, sidebar tabs, content panels.
 */
import { useState, useCallback } from 'react';
import TerrainTab from './tabs/TerrainTab';
import CataloniaTab from './tabs/CataloniaTab';
import IntegrityTab from './tabs/IntegrityTab';
import AboutTab from './tabs/AboutTab';
import './admin.css';

/* ── Lightweight auth ─────────────────────────────────────────────── */
const PASS_HASH = 'c9cb506b';

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

type TabId = 'terrain' | 'catalonia' | 'integrity' | 'about';

const TABS: { id: TabId; label: string }[] = [
  { id: 'terrain', label: 'Terrain Aspect' },
  { id: 'catalonia', label: 'Catalonia DEM' },
  { id: 'integrity', label: 'Data Integrity' },
  { id: 'about', label: 'About' },
];

export default function AdminApp() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('catmap_auth') === '1');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<TabId>('terrain');

  const login = useCallback(() => {
    if (simpleHash(pw) === PASS_HASH) {
      sessionStorage.setItem('catmap_auth', '1');
      setAuthed(true);
      setErr('');
    } else {
      setErr('Wrong password');
      setPw('');
    }
  }, [pw]);

  const logout = useCallback(() => {
    sessionStorage.removeItem('catmap_auth');
    setAuthed(false);
    setPw('');
    setErr('');
  }, []);

  /* Keyboard: Enter to submit */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') login();
    },
    [login],
  );

  /* ── Login gate ────────────────────────────────────────────────── */
  if (!authed) {
    return (
      <div className="adm-login-gate">
        <div className="adm-login-card">
          <div className="adm-login-logo">CatMap</div>
          <div className="adm-login-sub">Admin Panel</div>
          <input
            type="password"
            className="adm-login-pw"
            placeholder="Password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="adm-login-btn" onClick={login}>
            Enter
          </button>
          {err && <div className="adm-login-err">{err}</div>}
        </div>
      </div>
    );
  }

  /* ── Authenticated shell ───────────────────────────────────────── */
  return (
    <div className="adm-shell">
      <nav className="adm-sidebar">
        <div className="adm-sb-logo">
          CatMap <span className="adm-sb-tag">admin</span>
        </div>
        {TABS.map((t) => (
          <a
            key={t.id}
            href="#"
            className={`adm-sb-link ${tab === t.id ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              setTab(t.id);
            }}
          >
            {t.label}
          </a>
        ))}
        <div className="adm-sb-footer">
          <button className="adm-sb-logout" onClick={logout}>
            Logout
          </button>
        </div>
      </nav>

      <main className="adm-main">
        {tab === 'terrain' && <TerrainTab />}
        {tab === 'catalonia' && <CataloniaTab />}
        {tab === 'integrity' && <IntegrityTab />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
}
