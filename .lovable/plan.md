## Fix: prevent users from injecting job events for jobs they don't own

### Background
The current INSERT policy on `job_events` only checks `auth.uid() = user_id`. That lets any signed-in user write rows for any `airtable_job_id` and forge `actor_email`, `actor_name`, and `impersonated_accountant_id`.

In the app, all `job_events` inserts happen server-side via `supabaseAdmin` inside `updateJob` in `src/lib/jobs.functions.ts`, after admin/partner authorization checks. The service role bypasses RLS, so tightening the policy does not affect normal usage.

### Change
Drop the permissive INSERT policy and replace it with an admin-only one. Inserts from the app continue to work via the service role; non-admin authenticated clients can no longer insert directly.

### Migration
```sql
DROP POLICY IF EXISTS "Authenticated insert own job events" ON public.job_events;

CREATE POLICY "Admins insert job events"
ON public.job_events
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
```

### Then
Mark the `job_events_insert_any_user_id` finding as fixed.

No code changes required.