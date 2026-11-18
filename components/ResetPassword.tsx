import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';

const ResetPassword: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isRecoverySession, setIsRecoverySession] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setIsRecoverySession(Boolean(data.session));
      setIsChecking(false);
    };

    checkSession();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        setIsRecoverySession(true);
        setIsChecking(false);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (password.length < 12) {
      setErrorMessage('La contraseña debe tener al menos 12 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setErrorMessage('Las contraseñas no coinciden.');
      return;
    }

    setIsSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setErrorMessage('No se pudo actualizar la contraseña. Solicita un enlace nuevo e inténtalo otra vez.');
      setIsSaving(false);
      return;
    }

    setSuccessMessage('Contraseña actualizada. Ya puedes iniciar sesión.');
    await supabase.auth.signOut({ scope: 'local' });
    setIsSaving(false);
    window.setTimeout(() => navigate('/login', { replace: true }), 1500);
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-neutral-base p-4 md:p-8 font-sans">
      <div className="w-full max-w-[440px] bg-white rounded-2xl p-6 md:p-10 border border-neutral-border soft-shadow animate-fade-in">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-brand rounded-2xl flex items-center justify-center text-white font-display font-bold text-2xl mx-auto mb-6">A</div>
          <p className="eyebrow mb-2">Acceso seguro</p>
           <h1 className="ui-page-title text-neutral-textMain">Nueva <span className="text-brand italic">contraseña</span></h1>
        </div>

        {isChecking ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-brand/20 border-t-brand rounded-full animate-spin" /></div>
        ) : !isRecoverySession ? (
          <div className="text-center space-y-5">
            <div role="alert" className="rounded-[10px] bg-[#FBEAD2] border border-[#EBD5AC] px-4 py-3 text-[14px] text-[#8A5517]">El enlace no es válido o ha caducado.</div>
            <button onClick={() => navigate('/login', { replace: true })} className="text-[14px] font-semibold text-brand hover:underline">Solicitar un enlace nuevo</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {errorMessage && <div role="alert" className="rounded-[10px] bg-[#F8E1DA] border border-[#EFC9BE] px-4 py-3 text-[14px] text-[#9E3B2B]">{errorMessage}</div>}
            {successMessage && <div role="status" className="rounded-[10px] bg-[#DFF0E4] border border-[#BFDECB] px-4 py-3 text-[14px] text-[#20663B]">{successMessage}</div>}
            <div className="space-y-1.5">
              <label htmlFor="new-password" className="block text-[12px] font-semibold text-neutral-textSec">Nueva contraseña</label>
              <input id="new-password" required minLength={8} autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full min-h-[48px] px-4 py-3 bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 rounded-[10px] text-[16px] outline-none transition-all" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm-password" className="block text-[12px] font-semibold text-neutral-textSec">Confirmar contraseña</label>
              <input id="confirm-password" required minLength={8} autoComplete="new-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="w-full min-h-[48px] px-4 py-3 bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 rounded-[10px] text-[16px] outline-none transition-all" />
            </div>
            <button type="submit" disabled={isSaving || Boolean(successMessage)} className="w-full min-h-[48px] py-3 bg-brand text-white rounded-[10px] font-semibold text-[15px] hover:bg-brand-hover disabled:opacity-60 transition-colors">{isSaving ? 'Actualizando…' : 'Guardar contraseña'}</button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
