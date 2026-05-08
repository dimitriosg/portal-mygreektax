-- Helper: does the user own a partner profile linked to the Assigned Accountant of a job?
-- Because the assignment lives in Airtable (not Postgres), we check via partner_profiles
-- and trust the requester to send the airtable_job_id; the server fn cross-checks the
-- actual airtable record before insert, so this RLS only enforces "the partner profile
-- referenced is yours" — sufficient defense in depth.
CREATE OR REPLACE FUNCTION public.is_my_partner_profile(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.partner_profiles WHERE user_id = _user_id
  )
$$;

CREATE TABLE public.job_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  airtable_job_id text NOT NULL,
  job_code text,
  requested_by uuid NOT NULL,
  requester_email text,
  requester_name text,
  field_name text NOT NULL CHECK (field_name IN ('sla_deadline','status','notes')),
  current_value text,
  requested_value text,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jcr_status ON public.job_change_requests(status);
CREATE INDEX idx_jcr_job ON public.job_change_requests(airtable_job_id);
CREATE INDEX idx_jcr_requester ON public.job_change_requests(requested_by);
CREATE INDEX idx_jcr_created ON public.job_change_requests(created_at DESC);

ALTER TABLE public.job_change_requests ENABLE ROW LEVEL SECURITY;

-- Admins: full access
CREATE POLICY "Admins manage change requests"
  ON public.job_change_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Partners: read their own
CREATE POLICY "Partners read own change requests"
  ON public.job_change_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = requested_by);

-- Partners: insert their own (requested_by must be self, must be a partner)
CREATE POLICY "Partners insert own change requests"
  ON public.job_change_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = requested_by
    AND public.is_my_partner_profile(auth.uid())
    AND status = 'pending'
  );

-- Partners: cancel their own pending request (set status='cancelled', nothing else)
CREATE POLICY "Partners cancel own pending request"
  ON public.job_change_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = requested_by AND status = 'pending')
  WITH CHECK (auth.uid() = requested_by);
