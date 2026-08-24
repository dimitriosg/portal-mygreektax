
-- Create dedicated newsletter_subscribers table
CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               text NOT NULL UNIQUE,
    full_name           text,
    status              text NOT NULL DEFAULT 'pending',   -- pending | subscribed | unsubscribed | bounced | complained
    source              text,                               -- e.g. 'emailoctopus', 'manual', 'landing_page'
    client_id           uuid REFERENCES public.clients(id) ON DELETE SET NULL,
    emailoctopus_id     text,                               -- EO member ID for back-reference
    subscribed_at       timestamptz,
    unsubscribed_at     timestamptz,
    confirmed_at        timestamptz,
    last_synced_at      timestamptz,
    tags                text[],
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Index for fast email lookups (used by Make scenario)
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email ON public.newsletter_subscribers(email);
-- Index for client cross-reference
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_client_id ON public.newsletter_subscribers(client_id);
-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status ON public.newsletter_subscribers(status);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_subscribers_updated_at ON public.newsletter_subscribers;
CREATE TRIGGER trg_newsletter_subscribers_updated_at
  BEFORE UPDATE ON public.newsletter_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enable RLS
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
