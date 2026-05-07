
CREATE TABLE public.job_order_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope_key text NOT NULL,
  ordered_job_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_key)
);

ALTER TABLE public.job_order_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own job order"
ON public.job_order_preferences
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_job_order_user_scope ON public.job_order_preferences(user_id, scope_key);
