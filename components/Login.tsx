import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabaseClient';
import ThemeToggle from './shared/ThemeToggle';
import DiagonalPattern from './shared/DiagonalPattern';

type LoginMode = 'login' | 'forgot-password';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    setMode(nextMode);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-neutral-base p-4 font-sans md:p-8">
      <DiagonalPattern className="opacity-40" />
      <div className="absolute right-4 top-4 z-20 md:right-8 md:top-8"><ThemeToggle /></div>
      <div className="relative z-10 mx-auto grid min-h-[calc(100vh-2rem)] w-full max-w-5xl items-center gap-6 lg:grid-cols-[1fr_440px] lg:gap-16">
        <div className="hidden rounded-[30px] border border-brand/20 bg-brand-soft p-10 lg:block">
          <div className="relative min-h-[480px] overflow-hidden rounded-[22px] bg-brand p-9 text-white">
            <DiagonalPattern dark />
            <div className="relative z-10 flex h-full min-h-[420px] flex-col justify-between">
              <div>
                <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-2xl font-bold text-brand">R</div>
                <p className="eyebrow text-white/60">Casa Rosier</p>
                <h2 className="mt-4 max-w-sm text-[42px] font-bold leading-[0.98] tracking-tight">Tu taller, con más intención.</h2>
                <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-white/75">Organiza clases, alumnos y piezas desde un solo lugar, con la calma de un estudio bien ordenado.</p>
              </div>
              <div className="flex items-center gap-3 text-[12px] font-semibold text-white/70"><span className="h-2 w-2 rounded-full bg-white" /> Centro de operaciones</div>
            </div>
          </div>
        </div>

      <div className="mx-auto w-full max-w-[440px] rounded-[24px] border border-neutral-border bg-white p-6 soft-shadow animate-fade-in md:p-10">
        <div className="flex flex-col items-center">
        <div className="mb-8 flex w-full flex-col items-center text-center">
          <h1 className="text-[11px] font-semibold uppercase leading-relaxed tracking-[0.16em] text-neutral-textSec">Sistema de gestión de taller cerámico</h1>
          <div className="mt-5 w-full max-w-[290px] rounded-xl bg-[#FAFAFA] px-2 py-1">
            <img src="/pottery-gym-logo.svg" alt="Pottery Gym" width="508" height="264" className="h-auto w-full" />
          </div>
          {mode === 'forgot-password' && <>
            <h2 className="mt-5 text-lg font-semibold text-neutral-textMain">Recupera tu acceso</h2>
            <p className="mt-4 text-[14px] leading-relaxed text-neutral-textHelper">Escribe el correo asociado a tu cuenta y te enviaremos un enlace seguro.</p>
          </>}
        </div>

        <form onSubmit={mode === 'login' ? handleLogin : handlePasswordRecovery} className="w-full space-y-5 relative">
          {errorMessage && <div role="alert" className="rounded-[10px] bg-[#F8E1DA] border border-[#EFC9BE] px-4 py-3 text-[14px] text-[#9E3B2B]">{errorMessage}</div>}
          {successMessage && <div role="status" className="rounded-[10px] bg-[#DFF0E4] border border-[#BFDECB] px-4 py-3 text-[14px] text-[#20663B]">{successMessage}</div>}

          <div className="space-y-1.5">
            <label htmlFor="login-email" className="block text-[12px] font-semibold text-neutral-textSec">Correo electrónico</label>
            <input id="login-email" required autoComplete="email" inputMode="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full min-h-[48px] px-4 py-3 bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 rounded-[10px] text-[16px] outline-none transition-all placeholder:text-neutral-textHelper" placeholder="tu@correo.com" />
          </div>

          {mode === 'login' && (
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-[12px] font-semibold text-neutral-textSec">Contraseña</label>
              <input id="login-password" required autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full min-h-[48px] px-4 py-3 bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 rounded-[10px] text-[16px] outline-none transition-all placeholder:text-neutral-textHelper" placeholder="••••••••" />
              <div className="flex justify-end pt-1">
                <button type="button" onClick={() => changeMode('forgot-password')} className="text-[13px] font-medium text-neutral-textHelper hover:text-brand transition-colors">¿Olvidaste tu contraseña?</button>
              </div>
            </div>
          )}

          <button type="submit" disabled={isLoading} className="w-full min-h-[48px] py-3 bg-brand text-white rounded-[10px] font-semibold text-[15px] hover:bg-brand-hover active:scale-[0.99] transition-all flex items-center justify-center gap-3 mt-2 disabled:opacity-60 disabled:cursor-not-allowed">
            {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : mode === 'login' ? 'Iniciar sesión' : 'Enviar enlace'}
          </button>

          {mode === 'forgot-password' && (
            <button type="button" onClick={() => changeMode('login')} className="w-full min-h-[44px] py-2 text-[14px] font-medium text-neutral-textHelper hover:text-brand transition-colors">Volver al inicio de sesión</button>
          )}
        </form>

        <p className="mt-10 text-center text-[12px] text-neutral-textHelper">Acceso exclusivo para usuarios autorizados</p>
        </div>
      </div>
      </div>
    </div>
  );
};

export default Login;
