import { createDomainReadBackend, createDomainReadHandler } from '../_shared/domain-read-api.ts';

Deno.serve(createDomainReadHandler(createDomainReadBackend({
  supabaseOrigin: Deno.env.get('SUPABASE_URL'),
  anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
  audit: event => console.info(JSON.stringify(event))
})));
