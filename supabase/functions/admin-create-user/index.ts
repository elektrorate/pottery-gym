import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing server configuration' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing auth header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const accessToken = authHeader.slice(7).trim();
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });
  const { data: callerProfile, error: profileError } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profileError || callerProfile?.role !== 'super_admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { data: mfaVerified, error: mfaError } = await authClient.rpc('security_has_aal2');
  if (mfaError || mfaVerified !== true) return new Response(JSON.stringify({ error: 'Verifica tu segundo factor para continuar.', code: 'MFA_REQUIRED' }), {status:403, headers:{...corsHeaders,'Content-Type':'application/json'}});
  const userId = user.id;
  const body = await req.json();

  const { email, password, name, phone } = body || {};
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Missing fields' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (typeof password !== 'string' || password.length < 12) return new Response(JSON.stringify({error:'La contraseña debe tener al menos 12 caracteres.'}),{status:400,headers:{...corsHeaders,'Content-Type':'application/json'}});
  const {data: created, error: createError} = await adminClient.auth.admin.createUser({ email, password, email_confirm:true, user_metadata:{full_name:name || '', phone:phone || ''} });
  if (createError || !created.user) return new Response(JSON.stringify({error:'No se pudo crear el usuario. Comprueba los datos o si ya existe.'}),{status:400,headers:{...corsHeaders,'Content-Type':'application/json'}});
  const targetUserId = created.user.id;

  return new Response(JSON.stringify({ ok: true, userId: targetUserId }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
