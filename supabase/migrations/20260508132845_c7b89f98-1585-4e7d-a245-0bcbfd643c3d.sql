ALTER TABLE public.partner_profiles
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by uuid;

CREATE OR REPLACE FUNCTION public.get_partner_last_seen(_user_ids uuid[])
RETURNS TABLE(user_id uuid, last_seen_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT actor_user_id AS user_id, MAX(occurred_at) AS last_seen_at
  FROM public.activity_events
  WHERE event_type = 'partner_login'
    AND actor_user_id = ANY(_user_ids)
    AND public.has_role(auth.uid(), 'admin'::app_role)
  GROUP BY actor_user_id
$$;