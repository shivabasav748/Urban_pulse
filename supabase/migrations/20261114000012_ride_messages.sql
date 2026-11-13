-- 0012: rider <-> captain chat during a live trip (14 Nov 2026). Forward-only; new table only.
-- Only the ride's rider and the trip's assigned captain can read or send, and only while the trip is accepted/arriving/ongoing.
-- No phone numbers are stored or shared (masked calling needs a telephony provider; out of scope for the demo).

create table public.ride_messages (
  id bigint generated always as identity primary key,
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 300),
  at timestamptz not null default now()
);
create index ride_messages_ride on public.ride_messages(ride_id, id);
alter table public.ride_messages enable row level security;

-- private helper: is the caller this ride's rider or its assigned captain (any status; used for reading history)?
create function public._ride_party(p_ride uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rides r where r.id = p_ride and (r.rider_id = auth.uid() or r.driver_id = auth.uid()))
$$;
revoke execute on function public._ride_party(uuid) from public, anon;
grant execute on function public._ride_party(uuid) to authenticated;

create policy ride_messages_read on public.ride_messages for select to authenticated using (public._ride_party(ride_id));
-- no insert/update/delete policies: writes only through send_ride_message

create function public.send_ride_message(p_ride uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rides;
begin
  select * into r from public.rides where id = p_ride;
  if r.id is null or auth.uid() is null or (r.rider_id <> auth.uid() and r.driver_id is distinct from auth.uid()) then raise exception 'forbidden'; end if;
  if r.status not in ('accepted', 'arriving', 'ongoing') then raise exception 'validation: chat is open only during a trip'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 300 then raise exception 'validation: message must be 1-300 characters'; end if;
  insert into public.ride_messages(ride_id, sender, body) values (p_ride, auth.uid(), btrim(p_body));
end $$;
revoke execute on function public.send_ride_message(uuid, text) from public, anon;
grant execute on function public.send_ride_message(uuid, text) to authenticated;

grant select on public.ride_messages to authenticated;
alter publication supabase_realtime add table public.ride_messages;
