import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../../supabaseClient';

const MfaGate: React.FC<{children: React.ReactNode; userId: string; onLogout: () => Promise<void>}> = ({children, userId, onLogout}) => {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void (async () => {
      const [assurance, factors] = await Promise.all([supabase.auth.mfa.getAuthenticatorAssuranceLevel(), supabase.auth.mfa.listFactors()]);
      if (!active) return;
      if (assurance.error || factors.error) { setError('No se pudo comprobar el segundo factor. Vuelve a intentarlo.'); setLoading(false); return; }
      setReady(assurance.data.currentLevel === 'aal2');
      setFactorId(factors.data.totp.find(f => f.status === 'verified')?.id ?? null);
      setLoading(false);
    })().catch(() => { if (active) { setError('No se pudo comprobar el segundo factor.'); setLoading(false); } });
    return () => { active = false; mounted.current = false; };
  }, [userId]);
  const enroll = async () => {
    setBusy(true); setError(null);
    try {
      // Only remove stale, unverified TOTP enrollments. Never remove a verified factor.
      const listed = await supabase.auth.mfa.listFactors();
      if (listed.error) throw listed.error;
      const verified = listed.data.totp.find(f => f.status === 'verified');
      if (verified) { if (mounted.current) setFactorId(verified.id); return; }
      for (const f of listed.data.all.filter(f => f.factor_type === 'totp' && f.status === 'unverified')) {
        const removed = await supabase.auth.mfa.unenroll({factorId:f.id}); if (removed.error) throw removed.error;
      }
      const result = await supabase.auth.mfa.enroll({factorType:'totp', friendlyName:'Pottery Gym', issuer:'Pottery Gym'});
      if (result.error) throw result.error;
      if (!mounted.current) return;
      setFactorId(result.data.id); setQr(result.data.totp.qr_code); setSecret(result.data.totp.secret);
    } catch { if (mounted.current) setError('No se pudo preparar el autenticador. Reintenta o contacta con el responsable de acceso.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault(); if (!factorId || !/^\d{6}$/.test(code)) return;
    setBusy(true); setError(null);
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({factorId,code});
      if (result.error) throw result.error;
      if (!mounted.current) return;
      setSecret(null); setQr(null); setCode('');
      // Reload authorized data with the upgraded session; never retain AAL1 caches.
      window.location.reload();
    } catch { if (mounted.current) setError('Código incorrecto o caducado. Introduce el código actual de tu autenticador.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (ready) return <>{children}</>;
  return <main className="min-h-screen flex items-center justify-center bg-neutral-base p-6"><section className="w-full max-w-md rounded-2xl border border-neutral-border bg-neutral-surface p-8 text-neutral-textMain">
    <h1 className="text-xl font-semibold">Protege tu acceso</h1>
    <p className="mt-3 text-sm text-neutral-textSec">El acceso administrativo requiere un segundo factor con una aplicación autenticadora. Conserva una copia segura de tu autenticador. Si pierdes el acceso, el responsable de Supabase deberá verificar tu identidad para recuperarlo.</p>
    {loading ? <p role="status" className="mt-4">Comprobando seguridad…</p> : <>
      {!factorId && <button type="button" disabled={busy} onClick={enroll} className="mt-5 rounded-lg bg-brand px-4 py-3 text-white disabled:opacity-50">Configurar autenticador</button>}
      {qr && <div className="mt-5"><img src={qr.startsWith('data:') ? qr : 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qr)} alt="Código QR para configurar el autenticador" className="mx-auto h-52 w-52 bg-white"/>
        <details className="mt-3 text-sm"><summary>Introducir clave manualmente</summary><p className="mt-2 break-all select-all font-mono">{secret}</p></details></div>}
      {factorId && <form onSubmit={verify} className="mt-5"><label htmlFor="mfa-code" className="block text-sm">Código de seis dígitos</label><input id="mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} className="mt-2 w-full rounded-lg border border-neutral-border bg-neutral-surface px-4 py-3"/><button disabled={busy || code.length!==6} className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-white disabled:opacity-50">Verificar y continuar</button></form>}
    </>}
    {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    {!loading && error && !factorId && <button type="button" className="mt-3 underline" onClick={()=>window.location.reload()}>Reintentar comprobación</button>}
    <button type="button" disabled={busy} onClick={()=>void onLogout()} className="mt-5 block text-sm underline">Cerrar sesión</button>
  </section></main>;
}

export default MfaGate;
