DROP POLICY IF EXISTS "Authenticated insert own job events" ON public.job_events;

CREATE POLICY "Admins insert job events"
ON public.job_events
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));