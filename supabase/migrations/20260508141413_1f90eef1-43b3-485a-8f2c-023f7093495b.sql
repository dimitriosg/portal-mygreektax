
ALTER TABLE public.client_tokens
  ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_ip text,
  ADD COLUMN IF NOT EXISTS last_country text,
  ADD COLUMN IF NOT EXISTS last_user_agent text;

CREATE TABLE IF NOT EXISTS public.tracking_link_opens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  country text,
  city text,
  user_agent text,
  device text,
  browser text,
  os text,
  referrer text,
  airtable_job_id text,
  client_email text
);

CREATE INDEX IF NOT EXISTS tracking_link_opens_token_idx ON public.tracking_link_opens (token, opened_at DESC);
CREATE INDEX IF NOT EXISTS tracking_link_opens_job_idx ON public.tracking_link_opens (airtable_job_id, opened_at DESC);

ALTER TABLE public.tracking_link_opens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read tracking opens"
  ON public.tracking_link_opens FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins manage tracking opens"
  ON public.tracking_link_opens FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
