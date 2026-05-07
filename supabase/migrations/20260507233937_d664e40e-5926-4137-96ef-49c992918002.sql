
DROP POLICY IF EXISTS "Authenticated read tokens" ON public.client_tokens;
DROP POLICY IF EXISTS "Authenticated read job events" ON public.job_events;

CREATE POLICY "Admins read tokens"
ON public.client_tokens
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins read job events"
ON public.job_events
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));
