import { supabase } from '../supabaseClient';
import { clearMfaTrust } from './mfaTrust';

const LOCAL_SIGN_OUT_TIMEOUT_MS = 1200;
const SUPABASE_KEY_PREFIX = 'sb-';
const SUPABASE_AUTH_KEY_SUFFIX = '-auth-token';

const clearStoredSupabaseSession = () => {
  if (typeof window === 'undefined') return;

  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith(SUPABASE_KEY_PREFIX) && key.endsWith(SUPABASE_AUTH_KEY_SUFFIX)) {
          storage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.warn('Could not clear local auth cache:', error);
  }
};

export const logoutAndRedirect = async (redirectTo: string = '/login') => {
  try {
    await Promise.race([
      supabase.auth.signOut({ scope: 'local' }).then(() => undefined),
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, LOCAL_SIGN_OUT_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.error('Error during logout:', error);
  } finally {
    clearMfaTrust();
    clearStoredSupabaseSession();
    if (typeof window !== 'undefined') {
      window.location.replace(redirectTo);
    }
  }
};
