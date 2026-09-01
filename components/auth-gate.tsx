'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { LogOut, ShieldCheck, UserPlus, Users, X } from 'lucide-react';

type User = {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'editor';
};

type ManagedUser = User & {
  totpEnabled: boolean;
  status: 'active' | 'disabled';
  lastLoginAt: number | null;
};

type SessionPayload = {
  required: boolean;
  configured: boolean;
  authenticated: boolean;
  user: User | null;
  error?: string;
};

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'password' | 'totp' | 'enroll' | 'recovery'>('password');
  const [challenge, setChallenge] = useState('');
  const [secret, setSecret] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [usersOpen, setUsersOpen] = useState(false);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [newUser, setNewUser] = useState({ displayName: '', email: '', password: '' });

  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      const payload = await response.json() as SessionPayload;
      setSession(payload);
    } catch {
      setSession({ required: true, configured: false, authenticated: false, user: null });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshSession(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshSession]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, code: mode === 'totp' ? code : '' }),
      });
      const payload = await response.json() as {
        ok?: boolean;
        error?: string;
        totpRequired?: boolean;
        enrollmentRequired?: boolean;
        challenge?: string;
        secret?: string;
        uri?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'Giriş yapılamadı.');
      if (payload.enrollmentRequired && payload.challenge && payload.secret && payload.uri) {
        setChallenge(payload.challenge);
        setSecret(payload.secret);
        setQrCode(await QRCode.toDataURL(payload.uri, { width: 240, margin: 1, errorCorrectionLevel: 'M' }));
        setCode('');
        setMode('enroll');
        return;
      }
      if (payload.totpRequired) {
        setMode('totp');
        setCode('');
        return;
      }
      setPassword('');
      setCode('');
      await refreshSession();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Giriş yapılamadı.');
    } finally {
      setBusy(false);
    }
  }

  async function completeEnrollment(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/totp/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code }),
      });
      const payload = await response.json() as { error?: string; recoveryCodes?: string[] };
      if (!response.ok) throw new Error(payload.error || 'Doğrulama kurulamadı.');
      setRecoveryCodes(payload.recoveryCodes || []);
      setPassword('');
      setCode('');
      setMode('recovery');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Doğrulama kurulamadı.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setSession((current) => current ? { ...current, authenticated: false, user: null } : current);
    setMode('password');
    setUsersOpen(false);
  }

  async function openUsers() {
    setUsersOpen(true);
    const response = await fetch('/api/auth/users', { cache: 'no-store' });
    const payload = await response.json() as { users?: ManagedUser[] };
    setUsers(payload.users || []);
  }

  async function addUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      const payload = await response.json() as { error?: string; users?: ManagedUser[] };
      if (!response.ok) throw new Error(payload.error || 'Kullanıcı oluşturulamadı.');
      setUsers(payload.users || []);
      setNewUser({ displayName: '', email: '', password: '' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Kullanıcı oluşturulamadı.');
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return <main className="auth-shell"><div className="auth-card auth-loading">Deepbrief hazırlanıyor…</div></main>;
  }

  if (!session.required) return <>{children}</>;

  if (!session.configured) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <ShieldCheck size={34} />
          <h1>Güvenli erişim yapılandırılmalı</h1>
          <p><code>AUTH_SECRET</code>, <code>AUTH_BOOTSTRAP_EMAIL</code> ve <code>AUTH_BOOTSTRAP_PASSWORD</code> değerlerini girip servisi yeniden başlat.</p>
        </section>
      </main>
    );
  }

  if (!session.authenticated && mode === 'recovery') {
    return (
      <main className="auth-shell">
        <section className="auth-card auth-recovery">
          <ShieldCheck size={38} />
          <h1>Kurtarma kodlarını kaydet</h1>
          <p>Her kod yalnızca bir kez kullanılabilir. Bu liste daha sonra yeniden gösterilmez.</p>
          <div className="recovery-grid">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div>
          <button type="button" className="auth-primary" onClick={async () => {
            await navigator.clipboard.writeText(recoveryCodes.join('\n'));
          }}>Kodları kopyala</button>
          <button type="button" className="auth-secondary" onClick={() => void refreshSession()}>Kaydettim, stüdyoya geç</button>
        </section>
      </main>
    );
  }

  if (!session.authenticated) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-mark"><ShieldCheck size={25} /></div>
          <h1>{mode === 'enroll' ? 'Authenticator kurulumu' : 'Deepbrief Studio'}</h1>
          <p>{mode === 'enroll'
            ? 'QR kodunu authenticator uygulamanla tara ve üretilen altı haneli kodu gir.'
            : mode === 'totp' ? 'Authenticator kodunu veya kurtarma kodlarından birini gir.' : 'Yetkili hesabınla giriş yap.'}</p>
          {mode === 'enroll' ? (
            <form onSubmit={completeEnrollment} className="auth-form">
              {/* Data URL is generated locally; image optimization would add no value. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qrCode ? <img className="auth-qr" src={qrCode} alt="TOTP QR kodu" /> : null}
              <label>Manuel kurulum anahtarı<input value={secret} readOnly /></label>
              <label>Altı haneli kod<input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required /></label>
              {error ? <div className="auth-error">{error}</div> : null}
              <button className="auth-primary" disabled={busy || code.length !== 6}>{busy ? 'Kontrol ediliyor…' : 'Doğrula ve etkinleştir'}</button>
            </form>
          ) : (
            <form onSubmit={submitLogin} className="auth-form">
              <label>E-posta<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={mode === 'totp'} /></label>
              <label>Parola<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={mode === 'totp'} /></label>
              {mode === 'totp' ? <label>Doğrulama veya kurtarma kodu<input value={code} onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 24))} autoComplete="one-time-code" autoFocus required /></label> : null}
              {error ? <div className="auth-error">{error}</div> : null}
              <button className="auth-primary" disabled={busy}>{busy ? 'Kontrol ediliyor…' : mode === 'totp' ? 'Doğrula' : 'Giriş yap'}</button>
              {mode === 'totp' ? <button type="button" className="auth-link" onClick={() => { setMode('password'); setCode(''); }}>Geri dön</button> : null}
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <>
      <div className="auth-account-bar">
        <span><ShieldCheck size={15} /> {session.user?.displayName}</span>
        {session.user?.role === 'owner' ? <button type="button" onClick={() => void openUsers()} title="Kullanıcılar"><Users size={16} /></button> : null}
        <button type="button" onClick={() => void logout()} title="Çıkış"><LogOut size={16} /></button>
      </div>
      {children}
      {usersOpen ? (
        <div className="auth-modal-backdrop" role="presentation">
          <section className="auth-users-modal" role="dialog" aria-modal="true" aria-label="Kullanıcı yönetimi">
            <button type="button" className="auth-modal-close" onClick={() => setUsersOpen(false)}><X size={19} /></button>
            <h2>Kullanıcılar</h2>
            <p>En fazla üç hesap. Yeni kullanıcı ilk girişinde TOTP kurar.</p>
            <div className="auth-user-list">{users.map((item) => (
              <div key={item.id}><strong>{item.displayName}</strong><span>{item.email} · {item.role} · {item.totpEnabled ? 'TOTP açık' : 'kurulum bekliyor'}</span></div>
            ))}</div>
            {users.length < 3 ? (
              <form className="auth-form" onSubmit={addUser}>
                <h3><UserPlus size={18} /> Hesap ekle</h3>
                <label>Ad<input value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} required /></label>
                <label>E-posta<input type="email" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} required /></label>
                <label>Geçici parola<input type="password" minLength={12} value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} required /></label>
                {error ? <div className="auth-error">{error}</div> : null}
                <button className="auth-primary" disabled={busy}>{busy ? 'Oluşturuluyor…' : 'Editör hesabı oluştur'}</button>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
