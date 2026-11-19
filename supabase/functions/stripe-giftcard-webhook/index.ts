import { handleWebhookRequest, makeDefaultStore } from '../_shared/stripe-giftcard.ts';

const env = (name: string) => Deno.env.get(name);

Deno.serve((req) => {
  const sedeId = (env('ASISTONTO_SEDE_ID') || env('BONOS_API_SEDE_ID') || '').trim();
  return handleWebhookRequest(req, env, makeDefaultStore(env, sedeId));
});
