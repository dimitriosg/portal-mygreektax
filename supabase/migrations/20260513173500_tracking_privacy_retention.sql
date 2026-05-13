UPDATE public.tracking_link_opens
SET
  ip = NULL,
  city = NULL,
  user_agent = NULL,
  device = NULL,
  browser = NULL,
  os = NULL,
  referrer = NULL,
  client_email = NULL
WHERE
  ip IS NOT NULL
  OR city IS NOT NULL
  OR user_agent IS NOT NULL
  OR device IS NOT NULL
  OR browser IS NOT NULL
  OR os IS NOT NULL
  OR referrer IS NOT NULL
  OR client_email IS NOT NULL;

UPDATE public.client_tokens
SET
  last_ip = NULL,
  last_user_agent = NULL
WHERE last_ip IS NOT NULL OR last_user_agent IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cleanup_tracking_link_opens(retention_days integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.tracking_link_opens
  WHERE opened_at < now() - make_interval(days => GREATEST(retention_days, 1));

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_tracking_link_opens(integer) FROM PUBLIC, anon, authenticated;
