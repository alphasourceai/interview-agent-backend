create table if not exists public.request_rate_limits (
  route_name text not null,
  subject_key text not null,
  window_started_at timestamp with time zone not null default now(),
  count integer not null default 0,
  updated_at timestamp with time zone not null default now(),
  primary key (route_name, subject_key)
);

create or replace function public.check_and_increment_rate_limit(
  p_route_name text,
  p_subject_key text,
  p_window_ms integer,
  p_max_count integer
)
returns table (
  allowed boolean,
  count integer,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_row public.request_rate_limits%rowtype;
  v_window_end timestamptz;
  v_count integer := 0;
  v_max integer := greatest(coalesce(p_max_count, 0), 0);
begin
  loop
    select *
      into v_row
      from public.request_rate_limits
     where route_name = p_route_name
       and subject_key = p_subject_key
     for update;

    if found then
      if coalesce(p_window_ms, 0) <= 0
         or extract(epoch from (v_now - v_row.window_started_at)) * 1000 >= p_window_ms then
        update public.request_rate_limits
           set count = 1,
               window_started_at = v_now,
               updated_at = v_now
         where route_name = p_route_name
           and subject_key = p_subject_key
         returning * into v_row;
      else
        update public.request_rate_limits
           set count = v_row.count + 1,
               updated_at = v_now
         where route_name = p_route_name
           and subject_key = p_subject_key
         returning * into v_row;
      end if;
      exit;
    end if;

    begin
      insert into public.request_rate_limits (
        route_name,
        subject_key,
        window_started_at,
        count,
        updated_at
      ) values (
        p_route_name,
        p_subject_key,
        v_now,
        1,
        v_now
      )
      returning * into v_row;
      exit;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  v_count := coalesce(v_row.count, 0);
  allowed := v_count <= v_max;
  count := v_count;
  remaining := greatest(0, v_max - v_count);

  if allowed then
    retry_after_seconds := 0;
  elsif coalesce(p_window_ms, 0) <= 0 then
    retry_after_seconds := 0;
  else
    v_window_end := v_row.window_started_at + ((p_window_ms::text || ' milliseconds')::interval);
    retry_after_seconds := greatest(0, ceil(extract(epoch from (v_window_end - v_now)))::integer);
  end if;

  return next;
end;
$$;
