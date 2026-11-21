import { createClient } from '@supabase/supabase-js';
import { createDurableAuthStorage } from './utils/durableAuthStorage';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables.');
}

// Keep the aal2 session under the SDK's default key (`sb-<project-ref>-auth-token`).
// localStorage is the live copy. A SameSite=Lax cookie with Max-Age of 30 days
// is written beside it so a hard reload can restore the session if localStorage
// is empty. Do not use sessionStorage: that dies with the tab.
const browserAuthStorage = typeof window === 'undefined' ? undefined : createDurableAuthStorage();

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
