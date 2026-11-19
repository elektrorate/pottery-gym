import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabaseClient';
import ThemeToggle from './shared/ThemeToggle';
import './Login.css';

type LoginMode = 'login' | 'forgot-password';

const CoverIcon: React.FC<{name: 'mail' | 'lock' | 'eye' | 'arrow' | 'calendar' | 'people' | 'box'; className?: string}> = ({name, className}) => (
  <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'mail' && <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>}
    {name === 'lock' && <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>}
    {name === 'eye' && <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>}
    {name === 'arrow' && <path d="M4 12h16m-6-6 6 6-6 6"/>}
    {name === 'calendar' && <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>}
    {name === 'people' && <><circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2M20 4a4 4 0 0 1 0 7m3 10v-2a7 7 0 0 0-3-5M4 4a4 4 0 0 0 0 7m-3 10v-2a7 7 0 0 1 3-5"/></>}
    {name === 'box' && <><path d="m12 2 10 5.5v9L12 22 2 16.5v-9L12 2Zm0 11L2 7.5m10 5.5 10-5.5M12 13v9M7 4.75l10 5.5"/></>}
  </svg>
);


const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState<LoginMode>('login');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { login, session, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!session || !profile) return;

    const requestedPath = (location.state as { from?: { pathname: string } })?.from?.pathname;
    const destination = profile.role === 'super_admin' ? '/admin' : '/dashboard';
    const canReturnToRequestedPath = requestedPath
      && (profile.role === 'super_admin' ? requestedPath.startsWith('/admin') : !requestedPath.startsWith('/admin'));

    navigate(canReturnToRequestedPath ? requestedPath : destination, { replace: true });
  }, [session, profile, navigate, location.state]);

  const clearFeedback = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    clearFeedback();
    setIsLoading(true);

    const result = await login(email.trim().toLowerCase(), password);

    if (!result.success) {
      setErrorMessage(result.error || 'No se pudo iniciar sesión.');
    }

    setIsLoading(false);
  };

  const handlePasswordRecovery = async (event: React.FormEvent) => {
    event.preventDefault();
    clearFeedback();
    setIsLoading(true);

    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });

    if (error) {
      setErrorMessage('No se pudo enviar el correo. Inténtalo de nuevo dentro de unos minutos.');
    } else {
      setSuccessMessage('Si el correo pertenece a una cuenta autorizada, recibirás un enlace para crear una nueva contraseña.');
    }

    setIsLoading(false);
  };

  const changeMode = (nextMode: LoginMode) => {
    clearFeedback();
    setPassword('');
    setShowPassword(false);
    setMode(nextMode);
  };

  return (
    <main className="login-cover-page">
      <div className="login-cover-theme"><ThemeToggle /></div>
      <div className="login-cover-grid">
        <section className="login-cover-story" aria-labelledby="login-story-title">
          <div className="login-cover-story-content">
            <p className="login-cover-wordmark">Casa Rosier</p>
            <div className="login-cover-accent" />
            <h2 id="login-story-title">Gestiona tu<br />taller de cerámica</h2>
            <p className="login-cover-description">Clases, reservas, alumnos y piezas<br className="login-cover-desktop-break" /> en un solo lugar.</p>
            <ul className="login-cover-features" aria-label="Funciones del taller">
              <li><CoverIcon name="calendar" /><span>Clases y<br />reservas</span></li>
              <li><CoverIcon name="people" /><span>Alumnos</span></li>
              <li><CoverIcon name="box" /><span>Piezas y<br />cocciones</span></li>
            </ul>
          </div>
        </section>
        <section className="login-cover-panel" aria-labelledby="login-cover-title">
          <div className="login-cover-form-wrap">
            <header className="login-cover-header">
              <h1 id="login-cover-title">Sistema de gestión de taller cerámico</h1>
              <img src="/pottery-gym-logo.svg" alt="Pottery Gym" width="508" height="264" className="login-cover-logo" />
              {mode === 'forgot-password' && <div className="login-cover-recovery"><h2>Recupera tu acceso</h2><p>Escribe el correo asociado a tu cuenta y te enviaremos un enlace seguro.</p></div>}
            </header>
            <form onSubmit={mode === 'login' ? handleLogin : handlePasswordRecovery} className="login-cover-form" aria-busy={isLoading}>
              {errorMessage && <div role="alert" className="login-cover-feedback login-cover-feedback-error">{errorMessage}</div>}
              {successMessage && <div role="status" className="login-cover-feedback login-cover-feedback-success">{successMessage}</div>}
              <div className="login-cover-field">
                <label htmlFor="login-email">Correo electrónico</label>
                <div className="login-cover-input-wrap"><CoverIcon name="mail" /><input id="login-email" required disabled={isLoading} autoComplete="email" inputMode="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="tu@correo.com" /></div>
              </div>
              {mode === 'login' && <div className="login-cover-field">
                <label htmlFor="login-password">Contraseña</label>
                <div className="login-cover-input-wrap"><CoverIcon name="lock" /><input id="login-password" required disabled={isLoading} autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="••••••••" /><button className="login-cover-password-toggle" type="button" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} aria-controls="login-password" onClick={() => setShowPassword(value => !value)}><CoverIcon name="eye" /></button></div>
                <div className="login-cover-forgot"><button type="button" disabled={isLoading} onClick={() => changeMode('forgot-password')}>¿Olvidaste tu contraseña?</button></div>
              </div>}
              <button className="login-cover-submit" type="submit" disabled={isLoading}>
                {isLoading ? <><span className="login-cover-spinner" aria-hidden="true" />Procesando…</> : <>{mode === 'login' ? 'Iniciar sesión' : 'Enviar enlace'}<CoverIcon name="arrow" /></>}
              </button>
              {mode === 'forgot-password' && <button type="button" className="login-cover-back" disabled={isLoading} onClick={() => changeMode('login')}>Volver al inicio de sesión</button>}
            </form>
            <p className="login-cover-access">Acceso exclusivo para usuarios autorizados</p>
          </div>
        </section>
      </div>
    </main>
  );
};

export default Login;
