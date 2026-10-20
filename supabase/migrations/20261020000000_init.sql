-- Ski-Tippspiel: Datenbank für Spieler und Tipps.
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen. Am Ende wird der Gruppencode angezeigt.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

create table if not exists public.players (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  name_key        text not null unique,          -- lower(trim(name)) für eindeutige Namen
  pin_hash        text not null,
  token           uuid not null unique default gen_random_uuid(),
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

-- Wird von der GitHub-Automatisierung (service_role) aus den FIS-Daten befüllt.
create table if not exists public.races (
  id     text primary key,            -- z. B. "W-2026-10-24-GS"
  gender text not null check (gender in ('W','M')),
  disc   text not null check (disc in ('DH','SG','GS','SL')),
  place  text not null,
  start  timestamptz not null,
  wm     boolean not null default false,
  status text not null default 'scheduled'
);

create table if not exists public.tips (
  player_id  uuid not null references public.players(id) on delete cascade,
  kind       text not null check (kind in ('race','cup')),
  key        text not null,             -- Renn-ID oder Wertung wie "W_OVR", "M_GS"
  picks      text[] not null check (array_length(picks,1) = 3),
  updated_at timestamptz not null default now(),
  primary key (player_id, kind, key)
);

-- Kein direkter Zugriff: alles läuft über die Funktionen unten.
alter table public.app_config enable row level security;
alter table public.players    enable row level security;
alter table public.tips       enable row level security;
alter table public.races      enable row level security;
drop policy if exists races_read on public.races;
create policy races_read on public.races for select using (true);

-- Tippschluss: Rennen = Start, Wertung = Start des ersten Rennens dieser Wertung (ohne WM).
create or replace function public.tip_deadline(p_kind text, p_key text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select case
    when p_kind = 'race' then (select start from races where id = p_key)
    else (select min(start) from races r
          where r.gender = split_part(p_key,'_',1)
            and not r.wm and r.status <> 'cancelled'
            and (split_part(p_key,'_',2) = 'OVR' or r.disc = split_part(p_key,'_',2)))
  end
$$;

create or replace function public.player_from_token(p_token uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from players where token = p_token
$$;

-- Beitreten oder anmelden. Neuer Name braucht den Gruppencode, bestehender Name die PIN.
create or replace function public.join_or_login(p_code text, p_name text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text := lower(btrim(p_name));
  v_player players%rowtype;
begin
  if v_key = '' or length(v_key) > 30 then raise exception 'Bitte einen Namen mit höchstens 30 Zeichen.'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'Die PIN muss aus 4 Ziffern bestehen.'; end if;
  if upper(btrim(coalesce(p_code,''))) is distinct from (select upper(value) from app_config where key = 'join_code') then
    raise exception 'Der Gruppencode stimmt nicht.';
  end if;

  select * into v_player from players where name_key = v_key;
  if not found then
    insert into players(name, name_key, pin_hash)
    values (btrim(p_name), v_key, crypt(p_pin, gen_salt('bf')))
    returning * into v_player;
    return json_build_object('token', v_player.token, 'id', v_player.id, 'name', v_player.name, 'created', true);
  end if;

  if v_player.locked_until is not null and v_player.locked_until > now() then
    return json_build_object('error', 'Zu viele Fehlversuche. Versuche es in 15 Minuten nochmals.');
  end if;
  if v_player.pin_hash <> crypt(p_pin, v_player.pin_hash) then
    update players set failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' end
    where id = v_player.id;
    -- kein raise: sonst würde der Fehlversuch-Zähler zurückgerollt
    return json_build_object('error', 'Diesen Namen gibt es schon, und die PIN stimmt nicht.');
  end if;
  update players set failed_attempts = 0, locked_until = null where id = v_player.id;
  return json_build_object('token', v_player.token, 'id', v_player.id, 'name', v_player.name, 'created', false);
end $$;

create or replace function public.save_tip(p_token uuid, p_kind text, p_key text, p_picks text[])
returns json language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := player_from_token(p_token);
  v_deadline timestamptz := tip_deadline(p_kind, p_key);
begin
  if v_player is null then raise exception 'Bitte melde dich neu an.'; end if;
  if v_deadline is null then raise exception 'Dieses Rennen ist noch nicht im Kalender.'; end if;
  if now() >= v_deadline then raise exception 'Tippschluss ist vorbei.'; end if;
  if array_length(p_picks,1) <> 3 or exists (select 1 from unnest(p_picks) x where btrim(coalesce(x,'')) = '') then
    raise exception 'Bitte alle drei Plätze ausfüllen.';
  end if;
  insert into tips(player_id, kind, key, picks) values (v_player, p_kind, p_key, p_picks)
  on conflict (player_id, kind, key) do update set picks = excluded.picks, updated_at = now();
  return json_build_object('ok', true, 'deadline', v_deadline);
end $$;

-- Alle Spieler und alle sichtbaren Tipps: eigene immer, fremde erst nach Tippschluss.
create or replace function public.get_state(p_token uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_player uuid := player_from_token(p_token);
begin
  if v_player is null then raise exception 'Bitte melde dich neu an.'; end if;
  return json_build_object(
    'me', v_player,
    'players', (select coalesce(json_agg(json_build_object('id', id, 'name', name) order by name), '[]') from players),
    'tips', (select coalesce(json_agg(json_build_object('p', t.player_id, 'k', t.kind, 'key', t.key, 'picks', t.picks, 'at', t.updated_at)), '[]')
             from tips t
             where t.player_id = v_player or now() >= coalesce(tip_deadline(t.kind, t.key), 'infinity'))
  );
end $$;

revoke all on function public.tip_deadline(text,text) from public, anon;
revoke all on function public.player_from_token(uuid) from public, anon;
grant execute on function public.join_or_login(text,text,text) to anon;
grant execute on function public.save_tip(uuid,text,text,text[]) to anon;
grant execute on function public.get_state(uuid) to anon;

-- Gruppencode: wird zufällig erzeugt (das Repo ist öffentlich, darum steht er nicht hier).
-- Ändern: update public.app_config set value = 'MEINCODE' where key = 'join_code';
insert into public.app_config(key, value)
values ('join_code', upper(substr(md5(random()::text), 1, 6)))
on conflict (key) do nothing;

select value as gruppencode from public.app_config where key = 'join_code';
