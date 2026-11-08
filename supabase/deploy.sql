-- =====================================================================
-- RANKZERO — SCRIPT DE DEPLOY MESTRE (idempotente)
-- =====================================================================
-- Rode este arquivo INTEIRO no SQL Editor do Supabase a cada deploy.
-- Ele nunca apaga tabelas nem dados (sem "drop table"): só cria o que
-- falta ("if not exists"), atualiza funções/triggers pro estado mais
-- recente ("create or replace") e realinha políticas de RLS (drop
-- policy if exists + create policy, o que também não apaga dados).
-- É seguro rodar quantas vezes precisar, inclusive em todo deploy.
--
-- Este arquivo substitui schema.sql / 002_progressao.sql /
-- 003_boss_fixes_and_guild_invites.sql como fonte única de verdade —
-- eles ficam só como histórico. Ele também inclui pedaços que só
-- existiam no banco ao vivo e nunca tinham sido versionados aqui:
-- hunter_name/tag/last_seen em profiles, subtitle/reward_xp/reward_text
-- em boss_raids, current/completed em daily_missions, a tabela
-- friendships inteira, e global_bosses/global_boss_hits/
-- apply_global_boss_damage (o "Boss Igris" global de 30 dias).
-- =====================================================================

create extension if not exists "uuid-ossp";

-- =====================================================================
-- 1. TABELAS — baseline (se o banco for novo, cria do zero já completo)
-- =====================================================================

create table if not exists public.profiles (
    id uuid references auth.users(id) on delete cascade primary key,
    name text,
    full_name text,
    username text,
    email text,
    website text,
    avatar_url text,
    theme text,
    rank text default 'E',
    class text not null default 'colosso',
    second_class text,
    title text,
    level integer not null default 1,
    xp integer not null default 0,
    str integer not null default 0,
    agi integer not null default 0,
    vit integer not null default 0,
    free_points integer not null default 0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now())
);

create table if not exists public.workouts (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    letter text,
    title text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.machines (
    id uuid default uuid_generate_v4() primary key,
    workout_id uuid references public.workouts(id) on delete cascade not null,
    name text not null,
    kind text,
    position integer default 0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.exercises (
    id uuid default uuid_generate_v4() primary key,
    machine_id uuid references public.machines(id) on delete cascade not null,
    name text not null,
    position integer default 0,
    target_sets integer not null default 3,
    target_reps integer not null default 10,
    target_weight numeric not null default 0,
    target_minutes integer not null default 20,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.weight_logs (
    id uuid default uuid_generate_v4() primary key,
    exercise_id uuid references public.exercises(id) on delete cascade not null,
    weight numeric,
    reps integer,
    duration_min numeric,
    logged_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.boss_raids (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    name text not null,
    max_hp numeric not null,
    current_hp numeric not null,
    status text not null default 'active',
    deadline timestamp with time zone,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.combat_log (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    boss_id uuid references public.boss_raids(id) on delete set null,
    exercise_id uuid references public.exercises(id) on delete set null,
    damage numeric not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.daily_missions (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    mission_date date not null,
    title text not null,
    description text,
    target numeric,
    unit text,
    xp_reward integer,
    is_completed boolean default false,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    unique (user_id, mission_date, title)
);

-- =====================================================================
-- 2. COLUNAS adicionadas depois (ad-hoc no banco ao vivo ou em migrações
--    anteriores) — "add column if not exists" cobre tanto quem já tem
--    quanto quem está criando o banco do zero agora.
-- =====================================================================

alter table public.profiles add column if not exists hunter_name text;
alter table public.profiles add column if not exists tag text;
alter table public.profiles add column if not exists last_seen timestamp with time zone;
alter table public.profiles add column if not exists total_checkins integer default 0;
alter table public.profiles add column if not exists last_checkin_date date;

alter table public.boss_raids add column if not exists subtitle text;
alter table public.boss_raids add column if not exists reward_xp integer not null default 0;
alter table public.boss_raids add column if not exists reward_text text;

-- current/completed: usados pela tela de Missões (progresso + conclusão).
-- is_completed fica mantida só por compatibilidade, sem uso pelo frontend.
alter table public.daily_missions add column if not exists current numeric not null default 0;
alter table public.daily_missions add column if not exists completed boolean not null default false;

-- nome sem espaço (ver validateUsername em src/lib/rpg.js)
update public.profiles
   set hunter_name = regexp_replace(trim(hunter_name), '\s+', '_', 'g')
 where hunter_name is not null and hunter_name ~ '\s';

alter table public.profiles drop constraint if exists chk_hunter_name_no_space;
alter table public.profiles
  add constraint chk_hunter_name_no_space check (hunter_name is null or hunter_name !~ '\s');

-- =====================================================================
-- 3. BACKFILL — gera tag (4 dígitos) e nome padrão pra qualquer perfil
--    que ainda não tenha (contas antigas criadas antes dessas colunas
--    existirem, ou criadas pelo fallback de "usuário antigo" no app).
--    Idempotente: só mexe em quem está nulo/vazio, não roda de novo
--    em quem já tem.
-- =====================================================================

do $$
declare
  r record;
  v_tag text;
begin
  for r in select p.id from public.profiles p where p.tag is null or btrim(p.tag) = '' loop
    loop
      v_tag := lpad((floor(random() * 10000))::int::text, 4, '0');
      exit when not exists (select 1 from public.profiles where tag = v_tag);
    end loop;
    update public.profiles set tag = v_tag where id = r.id;
  end loop;
end $$;

update public.profiles p
   set name = coalesce(nullif(btrim(p.name), ''), split_part(u.email, '@', 1), 'Caçador')
  from auth.users u
 where u.id = p.id and (p.name is null or btrim(p.name) = '');

alter table public.profiles drop constraint if exists uniq_profiles_tag;
alter table public.profiles add constraint uniq_profiles_tag unique (tag);

-- =====================================================================
-- 4. GUILDAS, RAID EM EQUIPE, MONSTRO DIÁRIO, BOSSES PERIÓDICOS,
--    CONVITES DE GUILDA, AMIZADES E BOSS GLOBAL (IGRIS)
-- =====================================================================

create table if not exists public.guilds (
    id uuid default uuid_generate_v4() primary key,
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.guild_members (
    guild_id uuid references public.guilds(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    joined_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (guild_id, user_id)
);

create table if not exists public.global_boss_raids (
    id uuid default uuid_generate_v4() primary key,
    guild_id uuid references public.guilds(id) on delete cascade not null,
    name text not null,
    max_hp numeric not null,
    current_hp numeric not null,
    status text not null default 'active',
    deadline timestamp with time zone,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.daily_monsters (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    monster_date date not null default current_date,
    name text not null,
    max_hp numeric not null,
    current_hp numeric not null,
    status text not null default 'active',
    weak_vs text,
    bonus_mult numeric not null default 1.2,
    boss_level integer,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    unique (user_id, monster_date)
);
alter table public.daily_monsters add column if not exists weak_vs text;
alter table public.daily_monsters add column if not exists bonus_mult numeric not null default 1.2;
alter table public.daily_monsters add column if not exists boss_level integer;

create table if not exists public.periodic_bosses (
    id uuid default uuid_generate_v4() primary key,
    kind text not null check (kind in ('quinzenal', 'campanha90')),
    cycle_key text not null,
    name text not null,
    subtitle text,
    max_hp numeric not null,
    current_hp numeric not null,
    reward_xp integer not null default 0,
    status text not null default 'active',
    deadline timestamp with time zone,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    unique (kind, cycle_key)
);

create table if not exists public.periodic_boss_hits (
    id uuid default uuid_generate_v4() primary key,
    boss_id uuid references public.periodic_bosses(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    damage numeric not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.raid_members (
    raid_id uuid references public.boss_raids(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    joined_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (raid_id, user_id)
);

create table if not exists public.guild_invites (
    id uuid default uuid_generate_v4() primary key,
    guild_id uuid references public.guilds(id) on delete cascade not null,
    inviter_id uuid references public.profiles(id) on delete cascade not null,
    invitee_id uuid references public.profiles(id) on delete cascade not null,
    status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    responded_at timestamp with time zone
);
create unique index if not exists uniq_guild_invite_pending
  on public.guild_invites (guild_id, invitee_id)
  where (status = 'pending');

-- Pedidos de amizade (nunca tinha sido versionado — só existia no banco ao vivo)
create table if not exists public.friendships (
    id uuid default uuid_generate_v4() primary key,
    requester_id uuid references public.profiles(id) on delete cascade not null,
    addressee_id uuid references public.profiles(id) on delete cascade not null,
    status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    check (requester_id <> addressee_id),
    unique (requester_id, addressee_id)
);

-- Convite para treinar junto (amigo vê "fulano quer treinar com você" e aceita/recusa)
create table if not exists public.training_invites (
    id uuid default uuid_generate_v4() primary key,
    inviter_id uuid references public.profiles(id) on delete cascade not null,
    invitee_id uuid references public.profiles(id) on delete cascade not null,
    status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    responded_at timestamp with time zone,
    check (inviter_id <> invitee_id)
);
create index if not exists idx_training_invites_invitee on public.training_invites (invitee_id, status, created_at desc);
create index if not exists idx_training_invites_inviter on public.training_invites (inviter_id, status, created_at desc);

-- Boss Global "Igris" (evento de servidor único, renovado manualmente/por
-- ciclo — nunca tinha sido versionado, só existia no banco ao vivo)
create table if not exists public.global_bosses (
    id uuid default uuid_generate_v4() primary key,
    name text not null,
    subtitle text,
    max_hp numeric not null,
    current_hp numeric not null,
    reward_xp integer not null default 0,
    reward_text text,
    status text not null default 'active',
    started_at timestamp with time zone default timezone('utc'::text, now()) not null,
    deadline timestamp with time zone
);

create table if not exists public.global_boss_hits (
    id uuid default uuid_generate_v4() primary key,
    boss_id uuid references public.global_bosses(id) on delete cascade not null,
    user_id uuid references public.profiles(id) on delete cascade not null,
    damage numeric not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Garante que sempre exista um Boss Global ativo (só insere se não houver
-- nenhum ativo — não reseta um que já esteja em andamento).
insert into public.global_bosses (name, subtitle, max_hp, current_hp, reward_xp, reward_text, status)
select 'IGRIS, O CAVALEIRO VERMELHO', 'MONARCA DO FERRO - NÍVEL 50', 500000, 500000, 5000, 'Armadura S-Rank + Rank Up', 'active'
where not exists (select 1 from public.global_bosses where status = 'active');

-- =====================================================================
-- 5. FUNÇÕES
-- =====================================================================

-- Curva de XP por nível — espelha xpToNext() em src/lib/rpg.js
create or replace function public.fn_xp_to_next(p_level integer)
returns integer as $$
begin
    return 1000 + p_level * 400;
end;
$$ language plpgsql immutable;

-- Pontos de atributo por classe/nível — espelha POINTS_BY_CLASS em src/lib/rpg.js
create or replace function public.fn_points_for_level(p_class text, p_level integer)
returns table(d_str integer, d_agi integer, d_vit integer) as $$
begin
  if p_level % 10 = 0 then
    case p_class
      when 'colosso'  then return query select 2, 1, 2;
      when 'ladino'   then return query select 1, 3, 1;
      when 'guardiao' then return query select 2, 1, 2;
      else                 return query select 2, 1, 2;
    end case;
  else
    case p_class
      when 'colosso'  then return query select 2, 0, 1;
      when 'ladino'   then return query select 1, 2, 0;
      when 'guardiao' then return query select 1, 0, 2;
      else                 return query select 2, 0, 1;
    end case;
  end if;
end;
$$ language plpgsql immutable;

-- Cria o profile automaticamente no cadastro, já com nome e tag (#0000)
-- preenchidos — sem isso, a busca por nome#tag nunca encontra ninguém
-- recém-criado (tag ficava null pra sempre).
create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_tag text;
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'name'), ''),
    nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(split_part(new.email, '@', 1), ''),
    'Caçador'
  );

  loop
    v_tag := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from public.profiles where tag = v_tag);
  end loop;

  insert into public.profiles (id, name, email, tag, class, level, xp, str, agi, vit, free_points, rank)
  values (new.id, v_name, new.email, v_tag, 'colosso', 1, 0, 0, 0, 0, 0, 'E')
  on conflict (id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Aplica dano num boss periódico (quinzenal/90 dias) de forma atômica
create or replace function public.apply_periodic_boss_damage(p_boss_id uuid, p_user_id uuid, p_damage numeric)
returns void as $$
begin
  update public.periodic_bosses
     set current_hp = greatest(current_hp - p_damage, 0)
   where id = p_boss_id and status = 'active';

  update public.periodic_bosses
     set status = 'defeated'
   where id = p_boss_id and current_hp <= 0 and status = 'active';

  insert into public.periodic_boss_hits (boss_id, user_id, damage) values (p_boss_id, p_user_id, p_damage);
end;
$$ language plpgsql security definer;

-- Aplica dano no Boss Global "Igris" (evento de servidor único)
create or replace function public.apply_global_boss_damage(p_user_id uuid, p_damage numeric)
returns void as $$
declare
  v_boss public.global_bosses%rowtype;
begin
  select * into v_boss from public.global_bosses where status = 'active' order by started_at desc limit 1;
  if not found then return; end if;

  update public.global_bosses set current_hp = greatest(current_hp - p_damage, 0) where id = v_boss.id;
  update public.global_bosses set status = 'defeated' where id = v_boss.id and current_hp <= 0;

  insert into public.global_boss_hits (boss_id, user_id, damage) values (v_boss.id, p_user_id, p_damage);
end;
$$ language plpgsql security definer;

-- Aceitar convite de guilda = grava em guild_members + marca o convite como
-- aceito, numa transação só (e limpa outros convites pendentes da mesma guilda).
create or replace function public.accept_guild_invite(p_invite_id uuid)
returns void as $$
declare
  v_invite guild_invites%rowtype;
begin
  select * into v_invite from public.guild_invites where id = p_invite_id and status = 'pending';
  if not found then
    raise exception 'Convite não encontrado ou já respondido';
  end if;
  if v_invite.invitee_id <> auth.uid() then
    raise exception 'Este convite não é seu';
  end if;

  insert into public.guild_members (guild_id, user_id)
  values (v_invite.guild_id, v_invite.invitee_id)
  on conflict (guild_id, user_id) do nothing;

  update public.guild_invites set status = 'accepted', responded_at = now() where id = p_invite_id;

  update public.guild_invites
     set status = 'declined', responded_at = now()
   where guild_id = v_invite.guild_id and invitee_id = v_invite.invitee_id and status = 'pending';
end;
$$ language plpgsql security definer;

-- TRIGGER PRINCIPAL: aplica XP, level up, e dano no monstro diário
-- (com bônus de classe), no boss solo/raid, no boss da guilda e nos
-- bosses periódicos (quinzenal/90 dias) simultaneamente.
create or replace function public.fn_apply_weight_log() returns trigger as $$
declare
  v_uid         uuid;
  v_dmg         numeric;
  v_daily_dmg   numeric;
  v_gain        integer;
  v_pts         record;
  v_profile     profiles%rowtype;
  v_daily       daily_monsters%rowtype;
  v_solo_boss   boss_raids%rowtype;
  v_guild_boss  global_boss_raids%rowtype;
  v_guild_id    uuid;
  v_periodic    periodic_bosses%rowtype;
begin
  select w.user_id into v_uid
  from exercises e
  join machines m on m.id = e.machine_id
  join workouts w on w.id = m.workout_id
  where e.id = new.exercise_id;

  if v_uid is null then return new; end if;

  if new.duration_min is not null then
    v_dmg := new.duration_min * 25;
  else
    v_dmg := coalesce(new.weight,0) * greatest(coalesce(new.reps,1),1);
  end if;

  v_gain := greatest(round(v_dmg / 40), 5);

  select * into v_profile from profiles where id = v_uid;

  if v_profile.last_checkin_date is null or v_profile.last_checkin_date < current_date then
      update profiles
      set xp = xp + v_gain,
          total_checkins = total_checkins + 1,
          last_checkin_date = current_date
      where id = v_uid;
  else
      update profiles set xp = xp + v_gain where id = v_uid;
  end if;

  loop
    select * into v_profile from profiles where id = v_uid;
    exit when v_profile.xp < fn_xp_to_next(v_profile.level);

    select * into v_pts from fn_points_for_level(v_profile.class, v_profile.level + 1);

    update profiles set
      xp = xp - fn_xp_to_next(level),
      level = level + 1,
      str = str + v_pts.d_str,
      agi = agi + v_pts.d_agi,
      vit = vit + v_pts.d_vit
    where id = v_uid;
  end loop;

  -- Combate 1: Monstro Diário — aplica bônus fixo se a classe do caçador
  -- for a fraqueza do boss do dia (weak_vs), senão dano normal.
  select * into v_daily from daily_monsters where user_id = v_uid and monster_date = current_date and status = 'active' limit 1;
  if found then
    if v_daily.weak_vs is not null and v_daily.weak_vs = v_profile.class then
      v_daily_dmg := round(v_dmg * coalesce(v_daily.bonus_mult, 1.2));
    else
      v_daily_dmg := v_dmg;
    end if;
    update daily_monsters set current_hp = greatest(current_hp - v_daily_dmg, 0) where id = v_daily.id;
    update daily_monsters set status = 'defeated' where id = v_daily.id and current_hp <= 0;
  end if;

  -- Combate 2: Boss Solo (dungeon / invocável / mini-boss)
  select * into v_solo_boss from boss_raids where user_id = v_uid and status = 'active' limit 1;
  if found then
    update boss_raids set current_hp = greatest(current_hp - v_dmg, 0) where id = v_solo_boss.id;
    update boss_raids set status = 'defeated' where id = v_solo_boss.id and current_hp <= 0;
    insert into combat_log (user_id, boss_id, exercise_id, damage) values (v_uid, v_solo_boss.id, new.exercise_id, v_dmg);
  else
    insert into combat_log (user_id, boss_id, exercise_id, damage) values (v_uid, null, new.exercise_id, v_dmg);
  end if;

  -- Combate 3: Boss Global da Guilda
  select guild_id into v_guild_id from guild_members where user_id = v_uid limit 1;
  if v_guild_id is not null then
    select * into v_guild_boss from global_boss_raids where guild_id = v_guild_id and status = 'active' limit 1;
    if found then
      update global_boss_raids set current_hp = greatest(current_hp - v_dmg, 0) where id = v_guild_boss.id;
      update global_boss_raids set status = 'defeated' where id = v_guild_boss.id and current_hp <= 0;
    end if;
  end if;

  -- Combate 4: Bosses Periódicos (Quinzenal e Campanha de 90 dias) — cooperativos
  for v_periodic in
    select * from periodic_bosses
     where status = 'active'
       and (deadline is null or deadline > now())
       and kind in ('quinzenal', 'campanha90')
  loop
    perform public.apply_periodic_boss_damage(v_periodic.id, v_uid, v_dmg);
  end loop;

  -- Combate 5: Boss Global "Igris" (evento de servidor único)
  perform public.apply_global_boss_damage(v_uid, v_dmg);

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_weight_log_insert on public.weight_logs;
create trigger on_weight_log_insert
  after insert on public.weight_logs
  for each row execute procedure public.fn_apply_weight_log();

-- =====================================================================
-- 6. RLS (ROW LEVEL SECURITY)
-- =====================================================================

-- --- profiles -----------------------------------------------------
-- IMPORTANTE: antes disto, a única política era "using (auth.uid() = id)"
-- pra TUDO (select/insert/update/delete) — ou seja, cada caçador só
-- conseguia ENXERGAR o próprio perfil. Isso quebrava a busca por
-- nome#tag, a lista de amigos, os convites de guilda e qualquer outra
-- tela que precisa mostrar o nome/avatar de outro caçador. Separamos em
-- políticas por operação: leitura é pública pra quem está logado,
-- escrita continua restrita ao próprio perfil.
alter table public.profiles enable row level security;
drop policy if exists "Acesso total ao proprio perfil" on public.profiles;
drop policy if exists "Ver todos os perfis" on public.profiles;
create policy "Ver todos os perfis" on public.profiles for select to authenticated using (true);
drop policy if exists "Criar proprio perfil" on public.profiles;
create policy "Criar proprio perfil" on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists "Editar proprio perfil" on public.profiles;
create policy "Editar proprio perfil" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "Apagar proprio perfil" on public.profiles;
create policy "Apagar proprio perfil" on public.profiles for delete to authenticated using (auth.uid() = id);

alter table public.workouts enable row level security;
drop policy if exists "Acesso total aos proprios treinos" on public.workouts;
create policy "Acesso total aos proprios treinos" on public.workouts for all to authenticated using (auth.uid() = user_id);

alter table public.machines enable row level security;
drop policy if exists "Acesso total as maquinas" on public.machines;
create policy "Acesso total as maquinas" on public.machines for all to authenticated using (true);

alter table public.exercises enable row level security;
drop policy if exists "Acesso total aos exercicios" on public.exercises;
create policy "Acesso total aos exercicios" on public.exercises for all to authenticated using (true);

alter table public.weight_logs enable row level security;
drop policy if exists "Acesso total aos logs de peso" on public.weight_logs;
create policy "Acesso total aos logs de peso" on public.weight_logs for all to authenticated using (true);

alter table public.daily_missions enable row level security;
drop policy if exists "Acesso total as proprias missoes" on public.daily_missions;
create policy "Acesso total as proprias missoes" on public.daily_missions for all to authenticated using (auth.uid() = user_id);

alter table public.boss_raids enable row level security;
drop policy if exists "Acesso total aos proprios bosses" on public.boss_raids;
create policy "Acesso total aos proprios bosses" on public.boss_raids for all to authenticated using (auth.uid() = user_id);

alter table public.combat_log enable row level security;
drop policy if exists "Acesso total ao proprio log de combate" on public.combat_log;
create policy "Acesso total ao proprio log de combate" on public.combat_log for all to authenticated using (auth.uid() = user_id);

alter table public.guilds enable row level security;
drop policy if exists "Ver todas as guildas" on public.guilds;
create policy "Ver todas as guildas" on public.guilds for select to authenticated using (true);
drop policy if exists "Criar guilda" on public.guilds;
create policy "Criar guilda" on public.guilds for insert to authenticated with check (true);

alter table public.guild_members enable row level security;
drop policy if exists "Ver membros da guilda" on public.guild_members;
create policy "Ver membros da guilda" on public.guild_members for select to authenticated using (true);
drop policy if exists "Entrar/Sair da guilda" on public.guild_members;
create policy "Entrar/Sair da guilda" on public.guild_members for all to authenticated using (auth.uid() = user_id);

alter table public.global_boss_raids enable row level security;
drop policy if exists "Acesso ao boss da própria guilda" on public.global_boss_raids;
create policy "Acesso ao boss da própria guilda" on public.global_boss_raids
  for all to authenticated
  using (exists (select 1 from public.guild_members where guild_members.guild_id = global_boss_raids.guild_id and guild_members.user_id = auth.uid()));

alter table public.daily_monsters enable row level security;
drop policy if exists "Acesso total aos proprios monstros diários" on public.daily_monsters;
create policy "Acesso total aos proprios monstros diários" on public.daily_monsters for all to authenticated using (auth.uid() = user_id);

alter table public.periodic_bosses enable row level security;
drop policy if exists "Ver bosses periodicos" on public.periodic_bosses;
create policy "Ver bosses periodicos" on public.periodic_bosses for select to authenticated using (true);

alter table public.periodic_boss_hits enable row level security;
drop policy if exists "Ver hits de boss periodico" on public.periodic_boss_hits;
create policy "Ver hits de boss periodico" on public.periodic_boss_hits for select to authenticated using (true);
drop policy if exists "Registrar hit proprio" on public.periodic_boss_hits;
create policy "Registrar hit proprio" on public.periodic_boss_hits for insert to authenticated with check (auth.uid() = user_id);

alter table public.raid_members enable row level security;
drop policy if exists "Ver membros da raid" on public.raid_members;
create policy "Ver membros da raid" on public.raid_members for select to authenticated using (true);
drop policy if exists "Entrar na raid" on public.raid_members;
create policy "Entrar na raid" on public.raid_members for insert to authenticated with check (auth.uid() = user_id);

alter table public.guild_invites enable row level security;
drop policy if exists "Ver meus convites" on public.guild_invites;
create policy "Ver meus convites" on public.guild_invites
  for select to authenticated
  using (auth.uid() = invitee_id or auth.uid() = inviter_id);
drop policy if exists "Enviar convite (membro da guilda)" on public.guild_invites;
create policy "Enviar convite (membro da guilda)" on public.guild_invites
  for insert to authenticated
  with check (
    auth.uid() = inviter_id
    and exists (select 1 from public.guild_members gm where gm.guild_id = guild_invites.guild_id and gm.user_id = auth.uid())
  );
drop policy if exists "Responder meu convite" on public.guild_invites;
create policy "Responder meu convite" on public.guild_invites
  for update to authenticated
  using (auth.uid() = invitee_id)
  with check (auth.uid() = invitee_id);

alter table public.training_invites enable row level security;
drop policy if exists "Ver meus convites de treino" on public.training_invites;
create policy "Ver meus convites de treino" on public.training_invites
  for select to authenticated
  using (auth.uid() = invitee_id or auth.uid() = inviter_id);
drop policy if exists "Enviar convite de treino" on public.training_invites;
create policy "Enviar convite de treino" on public.training_invites
  for insert to authenticated
  with check (auth.uid() = inviter_id and inviter_id <> invitee_id);
drop policy if exists "Responder convite de treino" on public.training_invites;
create policy "Responder convite de treino" on public.training_invites
  for update to authenticated
  using (auth.uid() = invitee_id)
  with check (auth.uid() = invitee_id);

alter table public.friendships enable row level security;
drop policy if exists "Ver minhas amizades" on public.friendships;
create policy "Ver minhas amizades" on public.friendships
  for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
drop policy if exists "Enviar pedido de amizade" on public.friendships;
create policy "Enviar pedido de amizade" on public.friendships
  for insert to authenticated
  with check (auth.uid() = requester_id and requester_id <> addressee_id);
drop policy if exists "Responder pedido de amizade" on public.friendships;
create policy "Responder pedido de amizade" on public.friendships
  for update to authenticated
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id);

alter table public.global_bosses enable row level security;
drop policy if exists "Ver boss global" on public.global_bosses;
create policy "Ver boss global" on public.global_bosses for select to authenticated using (true);

alter table public.global_boss_hits enable row level security;
drop policy if exists "Ver hits do boss global" on public.global_boss_hits;
create policy "Ver hits do boss global" on public.global_boss_hits for select to authenticated using (true);

-- =====================================================================
-- 7. STORAGE — bucket de avatares (upload de foto de perfil)
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Avatares sao publicos" on storage.objects;
create policy "Avatares sao publicos" on storage.objects for select using (bucket_id = 'avatars');

drop policy if exists "Caçador envia o proprio avatar" on storage.objects;
create policy "Caçador envia o proprio avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Caçador atualiza o proprio avatar" on storage.objects;
create policy "Caçador atualiza o proprio avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Caçador apaga o proprio avatar" on storage.objects;
create policy "Caçador apaga o proprio avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- 8. RECARREGAMENTO DE CACHE (CRÍTICO — sem isso o PostgREST não vê
--    as funções/colunas novas até reiniciar sozinho)
-- =====================================================================
NOTIFY pgrst, 'reload schema';
