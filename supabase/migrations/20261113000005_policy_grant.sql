-- Fix for 20261113000004: the driver_profiles RLS policy calls _is_my_captain(), but that migration revoked
-- execute on all functions and did not re-grant this one, so any non-admin select on driver_profiles failed
-- with "permission denied for function _is_my_captain". The function only answers "is this captain assigned
-- to me right now?" for auth.uid(), so granting it to signed-in users exposes nothing.
grant execute on function public._is_my_captain(uuid) to authenticated;
