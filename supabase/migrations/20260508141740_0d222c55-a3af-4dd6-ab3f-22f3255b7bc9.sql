
CREATE TABLE IF NOT EXISTS public.client_token_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_email text,
  actor_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS client_token_events_token_idx
  ON public.client_token_events (token, occurred_at DESC);

ALTER TABLE public.client_token_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read token events"
  ON public.client_token_events FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins manage token events"
  ON public.client_token_events FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
