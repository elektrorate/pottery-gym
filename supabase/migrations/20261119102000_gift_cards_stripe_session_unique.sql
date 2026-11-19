-- Idempotencia extra para gift cards creadas por el webhook de Stripe:
-- además del código determinista (gift_cards_code_unique_idx), no puede haber
-- dos bonos de la misma sede con el mismo stripeSessionId.
-- No se aplica en producción en este PR (solo preparación).
create unique index if not exists gift_cards_stripe_session_id_uidx
  on public.gift_cards (sede_id, (external_metadata->>'stripeSessionId'))
  where coalesce(external_metadata->>'source', '') = 'stripe-webhook'
    and coalesce(external_metadata->>'stripeSessionId', '') <> '';
