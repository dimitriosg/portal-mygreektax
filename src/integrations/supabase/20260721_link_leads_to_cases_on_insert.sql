insert into clients (client_code, full_name, email, status, stage)
values ('CLT9999-ZZ', 'ZZ Trigger Test', 'dimitriosg2002+trgtest@gmail.com', 'Prospect', 'Potential');

select bc.case_serial_id, bc.case_number, bc.stage, bc.client_id, c.client_code
from brain_conversations bc join clients c on c.id = bc.client_id
where c.email = 'dimitriosg2002+trgtest@gmail.com';
-- expect: MGT-CS001-CLT9999, case_number 1, linked to the test client.

do $$
declare r record;
begin
  for r in select bc.id from brain_conversations bc join clients c on c.id = bc.client_id
           where c.email = 'dimitriosg2002+trgtest@gmail.com'
  loop perform public.delete_case(r.id); end loop;
  delete from clients where email = 'dimitriosg2002+trgtest@gmail.com';
end $$;
