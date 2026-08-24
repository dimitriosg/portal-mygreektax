-- Allow the n8n_readonly role to resolve a client to its portal case URL.
-- Column-level grant only: id, client_id, archived_at, created_at,
-- case_serial_id. Message content (subject, customer_email, partner_email)
-- stays unreadable by this role.

grant select (id, client_id, archived_at, created_at, case_serial_id)
  on public.brain_conversations to n8n_readonly;

create policy n8n_readonly_select_brain_conversations
  on public.brain_conversations
  for select to n8n_readonly
  using (true);
