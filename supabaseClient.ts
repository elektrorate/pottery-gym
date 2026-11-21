import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables.');
}

// Keep the aal2 session in localStorage under the SDK's default key
// (`sb-<project-ref>-auth-token`). Do not switch this to sessionStorage:
// that storage dies with the tab, so every reload asks for the password again.
const browserAuthStorage = typeof window === 'undefined' ? undefined : window.localStorage;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { retry: false },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
    ...(browserAuthStorage ? { storage: browserAuthStorage } : {}),
  },
});
