ALTER TABLE public.client_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS regenerated_from_token text REFERENCES public.client_tokens(token) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS client_tokens_active_job_idx
  ON public.client_tokens (airtable_job_id, created_at DESC)
  WHERE revoked_at IS NULL;
