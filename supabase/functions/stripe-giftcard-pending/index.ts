import { handlePendingRequest, makeDefaultStore } from '../_shared/stripe-giftcard.ts';

const env = (name: string) => Deno.env.get(name);

Deno.serve((req) => handlePendingRequest(req, env, makeDefaultStore));
