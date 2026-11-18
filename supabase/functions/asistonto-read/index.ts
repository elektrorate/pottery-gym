import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleRead } from '../_shared/asistonto-api.ts';

const makeClient = (url: string, key: string) => createClient(url, key, { auth: { persistSession: false } });
Deno.serve((req) => handleRead(req, (name) => Deno.env.get(name), makeClient));
