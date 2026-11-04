-- Run in Supabase SQL Editor before deploying the normalized data store.
-- The legacy kv row is intentionally retained as a rollback/migration backup.

create table if not exists public.kv (
  key text primary key,
  value jsonb not null
);
alter table public.kv enable row level security;

create table if not exists public.organizations (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id text primary key,
  email text not null default '',
  name text not null default '',
  phone text not null default '',
  status text not null default 'active',
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create unique index if not exists members_email_unique
  on public.members (lower(email)) where email <> '';

create table if not exists public.member_credentials (
  member_id text primary key references public.members(id) on delete cascade,
  password_hash text not null default '',
  legacy_key text not null default ''
);

create table if not exists public.member_sessions (
  member_id text not null references public.members(id) on delete cascade,
  token text not null,
  expires_at numeric,
  position integer not null default 0,
  primary key (member_id, token)
);
create index if not exists member_sessions_expiry_idx on public.member_sessions (expires_at);

create table if not exists public.organization_admins (
  organization_id text not null references public.organizations(id) on delete cascade,
  member_id text not null references public.members(id) on delete cascade,
  primary key (organization_id, member_id)
);

create table if not exists public.projects (
  id text primary key,
  organization_id text not null references public.organizations(id),
  name text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists projects_org_name_unique
  on public.projects (organization_id, lower(name));
create index if not exists projects_organization_id_idx on public.projects (organization_id);

create table if not exists public.project_members (
  project_id text not null references public.projects(id) on delete cascade,
  member_id text not null references public.members(id) on delete cascade,
  role text not null,
  status text not null default 'active',
  primary key (project_id, member_id)
);
create index if not exists project_members_member_id_idx on public.project_members (member_id);

create table if not exists public.tickets (
  project_id text not null references public.projects(id) on delete cascade,
  id text not null,
  type text not null default '',
  status text not null default '',
  created_by text not null default '',
  title text not null default '',
  date text,
  due_date text,
  payload jsonb not null,
  primary key (project_id, id)
);
create index if not exists tickets_project_status_idx on public.tickets (project_id, status);
create index if not exists tickets_project_date_idx on public.tickets (project_id, date desc);
create index if not exists tickets_created_by_idx on public.tickets (created_by);

create table if not exists public.ticket_assignees (
  project_id text not null,
  ticket_id text not null,
  member_id text not null references public.members(id) on delete cascade,
  primary key (project_id, ticket_id, member_id),
  foreign key (project_id, ticket_id) references public.tickets(project_id, id) on delete cascade
);
create index if not exists ticket_assignees_member_idx on public.ticket_assignees (member_id);

create table if not exists public.project_files (
  project_id text not null references public.projects(id) on delete cascade,
  id text not null,
  ticket_id text not null default '',
  payload jsonb not null,
  primary key (project_id, id)
);
create index if not exists project_files_ticket_idx on public.project_files (project_id, ticket_id);

create table if not exists public.project_audit (
  project_id text not null references public.projects(id) on delete cascade,
  event_id text not null,
  position bigint not null default 0,
  payload jsonb not null,
  primary key (project_id, event_id)
);
create index if not exists project_audit_recent_idx on public.project_audit (project_id, position);

create table if not exists public.meetings (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  date text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists meetings_project_date_idx on public.meetings (project_id, date);

create table if not exists public.meeting_people (
  meeting_id text not null references public.meetings(id) on delete cascade,
  kind text not null check (kind in ('attendee', 'roster')),
  member_key text not null,
  email text not null default '',
  name text not null default '',
  position integer not null default 0,
  primary key (meeting_id, kind, member_key)
);

create table if not exists public.meeting_occurrences (
  meeting_id text not null references public.meetings(id) on delete cascade,
  occurrence_date text not null,
  payload jsonb not null,
  primary key (meeting_id, occurrence_date)
);

create table if not exists public.meeting_notes (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  meeting_id text not null default '',
  date text,
  title text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists meeting_notes_project_date_idx on public.meeting_notes (project_id, date desc);
create index if not exists meeting_notes_meeting_id_idx on public.meeting_notes (meeting_id);

create table if not exists public.meeting_note_participants (
  note_id text not null references public.meeting_notes(id) on delete cascade,
  member_id text not null,
  position integer not null default 0,
  payload jsonb not null,
  primary key (note_id, member_id)
);

create table if not exists public.meeting_note_tasks (
  note_id text not null references public.meeting_notes(id) on delete cascade,
  task_id text not null,
  assignee_id text not null default '',
  due_at text,
  status text not null default 'Open',
  position integer not null default 0,
  payload jsonb not null,
  primary key (note_id, task_id)
);
create index if not exists meeting_note_tasks_assignee_due_idx
  on public.meeting_note_tasks (assignee_id, due_at) where assignee_id <> '';
create index if not exists meeting_note_tasks_status_idx on public.meeting_note_tasks (status);

create table if not exists public.invites (
  token text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  email text not null,
  payload jsonb not null
);
create index if not exists invites_project_email_idx on public.invites (project_id, lower(email));

create table if not exists public.meeting_edit_requests (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  member_id text not null references public.members(id) on delete cascade,
  status text not null default 'pending',
  expires_at numeric,
  payload jsonb not null
);
create index if not exists meeting_edit_requests_project_status_idx
  on public.meeting_edit_requests (project_id, status);
create index if not exists meeting_edit_requests_member_idx
  on public.meeting_edit_requests (member_id, status);

create table if not exists public.password_resets (
  member_id text primary key references public.members(id) on delete cascade,
  payload jsonb not null
);

create table if not exists public.google_oauth_states (
  state text primary key,
  payload jsonb not null
);

create table if not exists public.google_calendar_connections (
  organization_id text primary key references public.organizations(id) on delete cascade,
  connected_by text not null references public.members(id),
  email text not null,
  refresh_token text not null,
  connected_at text not null default '',
  payload jsonb not null default '{}'::jsonb
);
create index if not exists google_calendar_connected_by_idx
  on public.google_calendar_connections (connected_by);

create table if not exists public.workspace_meta (
  key text primary key,
  value jsonb not null
);

insert into public.google_calendar_connections (
  organization_id, connected_by, email, refresh_token, connected_at
)
select coalesce(legacy.value->>'organizationId', inferred.organization_id),
       legacy.value->>'connectedBy',
       coalesce(legacy.value->>'email', ''),
       legacy.value->>'refreshToken',
       coalesce(legacy.value->>'connectedAt', '')
  from public.workspace_meta legacy
  left join lateral (
    select min(project.organization_id) as organization_id
      from public.projects project
      join public.project_members membership on membership.project_id = project.id
     where membership.member_id = legacy.value->>'connectedBy'
       and membership.role = 'Admin'
       and membership.status <> 'disabled'
     having count(distinct project.organization_id) = 1
  ) inferred on true
 where legacy.key = 'googleCalendar'
   and coalesce(legacy.value->>'refreshToken', '') <> ''
   and legacy.value->>'connectedBy' is not null
   and (
     inferred.organization_id is not null
     or (
       legacy.value->>'organizationId' is not null
       and exists (
         select 1
           from public.project_members membership
           join public.projects project on project.id = membership.project_id
          where project.organization_id = legacy.value->>'organizationId'
            and membership.member_id = legacy.value->>'connectedBy'
            and membership.role = 'Admin'
            and membership.status <> 'disabled'
       )
     )
   )
on conflict (organization_id) do nothing;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations', 'members', 'organization_admins', 'projects', 'project_members',
    'member_credentials', 'member_sessions',
    'tickets', 'ticket_assignees', 'project_files', 'project_audit', 'meetings',
    'meeting_people', 'meeting_occurrences', 'meeting_notes',
    'meeting_note_participants', 'meeting_note_tasks', 'invites',
    'meeting_edit_requests', 'password_resets', 'google_oauth_states',
    'google_calendar_connections', 'workspace_meta'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
  execute 'grant all on public.kv to service_role';
end $$;

create or replace function public.load_workspace_state()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'organizations', coalesce((select jsonb_agg(to_jsonb(x)) from public.organizations x), '[]'::jsonb),
    'organization_admins', coalesce((select jsonb_agg(to_jsonb(x)) from public.organization_admins x), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(x)) from public.projects x), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(to_jsonb(x)) from public.members x), '[]'::jsonb),
    'member_credentials', coalesce((select jsonb_agg(to_jsonb(x)) from public.member_credentials x), '[]'::jsonb),
    'member_sessions', coalesce((select jsonb_agg(to_jsonb(x)) from public.member_sessions x), '[]'::jsonb),
    'project_members', coalesce((select jsonb_agg(to_jsonb(x)) from public.project_members x), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(to_jsonb(x)) from public.tickets x), '[]'::jsonb),
    'ticket_assignees', coalesce((select jsonb_agg(to_jsonb(x)) from public.ticket_assignees x), '[]'::jsonb),
    'project_files', coalesce((select jsonb_agg(to_jsonb(x)) from public.project_files x), '[]'::jsonb),
    'project_audit', coalesce((select jsonb_agg(to_jsonb(x)) from public.project_audit x), '[]'::jsonb),
    'meetings', coalesce((select jsonb_agg(to_jsonb(x)) from public.meetings x), '[]'::jsonb),
    'meeting_people', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_people x), '[]'::jsonb),
    'meeting_occurrences', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_occurrences x), '[]'::jsonb),
    'meeting_notes', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_notes x), '[]'::jsonb),
    'meeting_note_participants', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_note_participants x), '[]'::jsonb),
    'meeting_note_tasks', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_note_tasks x), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(to_jsonb(x)) from public.invites x), '[]'::jsonb),
    'meeting_edit_requests', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_edit_requests x), '[]'::jsonb),
    'password_resets', coalesce((select jsonb_agg(to_jsonb(x)) from public.password_resets x), '[]'::jsonb),
    'google_oauth_states', coalesce((select jsonb_agg(to_jsonb(x)) from public.google_oauth_states x), '[]'::jsonb),
    'google_calendar_connections', coalesce((select jsonb_agg(to_jsonb(x)) from public.google_calendar_connections x), '[]'::jsonb),
    'workspace_meta', coalesce((select jsonb_agg(to_jsonb(x)) from public.workspace_meta x), '[]'::jsonb)
  )
$$;

create or replace function public.load_authorized_workspace(
  session_token text,
  requested_project_id text default null,
  ticket_page_size integer default 100,
  ticket_page_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  current_member_id text;
  member_project_role text;
  allowed_project_ids text[];
  active_project_id text;
  visible_organization_ids text[];
  safe_page_size integer := least(200, greatest(1, coalesce(ticket_page_size, 100)));
  safe_page_offset integer := greatest(0, coalesce(ticket_page_offset, 0));
  ticket_total integer := 0;
begin
  if coalesce(session_token, '') = '' then
    return jsonb_build_object('scope', jsonb_build_object('authorized', false));
  end if;

  select member.id
    into current_member_id
    from public.members member
    left join public.member_credentials credential on credential.member_id = member.id
   where member.status <> 'disabled'
     and (
       credential.legacy_key = session_token
       or exists (
         select 1
           from public.member_sessions session
          where session.member_id = member.id
            and session.token = session_token
            and session.expires_at > extract(epoch from clock_timestamp()) * 1000
       )
     )
   limit 1;

  if current_member_id is null then
    return jsonb_build_object('scope', jsonb_build_object('authorized', false));
  end if;

  select array_agg(project.id order by project.created_at, project.id)
    into allowed_project_ids
    from public.projects project
    join public.project_members membership on membership.project_id = project.id
   where membership.member_id = current_member_id
     and membership.status <> 'disabled';

  if coalesce(array_length(allowed_project_ids, 1), 0) = 0 then
    return jsonb_build_object('scope', jsonb_build_object('authorized', false));
  end if;

  if requested_project_id is not null and requested_project_id <> all(allowed_project_ids) then
    return jsonb_build_object(
      'scope',
      jsonb_build_object('authorized', true, 'forbidden_project', true, 'member_id', current_member_id)
    );
  end if;

  if requested_project_id = any(allowed_project_ids) then
    active_project_id := requested_project_id;
  else
    active_project_id := allowed_project_ids[1];
  end if;

  select membership.role
    into member_project_role
    from public.project_members membership
   where membership.project_id = active_project_id
     and membership.member_id = current_member_id
     and membership.status <> 'disabled';

  select array_agg(distinct project.organization_id)
    into visible_organization_ids
    from public.projects project
   where project.id = any(allowed_project_ids);

  select count(*)::integer
    into ticket_total
    from public.tickets ticket
   where ticket.project_id = active_project_id
     and (member_project_role <> 'Client' or ticket.created_by = current_member_id);

  return jsonb_build_object(
    'scope', jsonb_build_object(
      'authorized', true,
      'member_id', current_member_id,
      'project_id', active_project_id,
      'ticket_total', ticket_total,
      'ticket_offset', safe_page_offset,
      'ticket_limit', safe_page_size
    ),
    'organizations', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.id)
        from public.organizations row
       where row.id = any(visible_organization_ids)
          or exists (select 1 from public.organization_admins admin where admin.organization_id = row.id and admin.member_id = current_member_id)
    ), '[]'::jsonb),
    'organization_admins', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.organization_admins row
       where row.organization_id = any(visible_organization_ids)
          or row.member_id = current_member_id
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.created_at, row.id)
        from public.projects row
       where row.id = any(allowed_project_ids)
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.id)
        from public.members row
       where row.id = current_member_id
          or exists (
            select 1 from public.project_members membership
             where membership.project_id = any(allowed_project_ids)
               and membership.member_id = row.id
          )
    ), '[]'::jsonb),
    'member_credentials', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.member_credentials row
       where row.member_id = current_member_id
    ), '[]'::jsonb),
    'member_sessions', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.position)
        from public.member_sessions row
       where row.member_id = current_member_id
    ), '[]'::jsonb),
    'project_members', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.project_members row
       where row.project_id = any(allowed_project_ids)
    ), '[]'::jsonb),
    'tickets', coalesce((
      select jsonb_agg(to_jsonb(page) order by page.date desc nulls last, page.id)
        from (
          select ticket.*
            from public.tickets ticket
           where ticket.project_id = active_project_id
             and (member_project_role <> 'Client' or ticket.created_by = current_member_id)
           order by ticket.date desc nulls last, ticket.id
           limit safe_page_size offset safe_page_offset
        ) page
    ), '[]'::jsonb),
    'ticket_assignees', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.ticket_assignees row
       where row.project_id = active_project_id
         and exists (
           select 1 from public.tickets ticket
            where ticket.project_id = row.project_id
              and ticket.id = row.ticket_id
              and (member_project_role <> 'Client' or ticket.created_by = current_member_id)
         )
    ), '[]'::jsonb),
    'project_files', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.project_files row
       where row.project_id = active_project_id
         and (
           member_project_role <> 'Client'
           or exists (
             select 1 from public.tickets ticket
              where ticket.project_id = row.project_id
                and ticket.id = row.ticket_id
                and ticket.created_by = current_member_id
           )
         )
    ), '[]'::jsonb),
    'project_audit', coalesce((
      select jsonb_agg(to_jsonb(row) order by row.position desc)
        from public.project_audit row
       where row.project_id = active_project_id
         and member_project_role = 'Admin'
    ), '[]'::jsonb),
    'meetings', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meetings row
       where row.project_id = active_project_id
         and member_project_role <> 'Client'
    ), '[]'::jsonb),
    'meeting_people', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_people row
       where member_project_role <> 'Client'
         and row.meeting_id in (select meeting.id from public.meetings meeting where meeting.project_id = active_project_id)
    ), '[]'::jsonb),
    'meeting_occurrences', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_occurrences row
       where member_project_role <> 'Client'
         and row.meeting_id in (select meeting.id from public.meetings meeting where meeting.project_id = active_project_id)
    ), '[]'::jsonb),
    'meeting_notes', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_notes row
       where row.project_id = active_project_id
        and member_project_role <> 'Client'
    ), '[]'::jsonb),
    'meeting_note_participants', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_note_participants row
       where member_project_role <> 'Client'
         and row.note_id in (select note.id from public.meeting_notes note where note.project_id = active_project_id)
    ), '[]'::jsonb),
    'meeting_note_tasks', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_note_tasks row
       where member_project_role <> 'Client'
         and row.note_id in (select note.id from public.meeting_notes note where note.project_id = active_project_id)
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.invites row
       where row.project_id = active_project_id
        and member_project_role = 'Admin'
    ), '[]'::jsonb),
    'meeting_edit_requests', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.meeting_edit_requests row
       where row.project_id = active_project_id
        and (member_project_role = 'Admin' or row.member_id = current_member_id)
    ), '[]'::jsonb),
    'password_resets', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.password_resets row
       where row.member_id = current_member_id
    ), '[]'::jsonb),
    'google_oauth_states', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.google_oauth_states row
       where row.payload->>'memberId' = current_member_id
    ), '[]'::jsonb),
    'google_calendar_connections', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.google_calendar_connections row
       where row.organization_id = (select project.organization_id from public.projects project where project.id = active_project_id)
         and member_project_role = 'Admin'
    ), '[]'::jsonb),
    'workspace_meta', coalesce((
      select jsonb_agg(to_jsonb(row))
        from public.workspace_meta row
       where row.key in ('v2', 'v3', 'v4', 'v5', 'v6', 'schema_version')
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.lookup_login_state(login_identifier text, login_phone text default '')
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with matched_member as (
    select member.*
      from public.members member
     where (
          coalesce(login_identifier, '') <> ''
          and lower(member.email) = lower(login_identifier)
        )
        or (
          coalesce(login_phone, '') <> ''
          and regexp_replace(member.phone, '[^0-9+]', '', 'g') = login_phone
        )
     order by member.id
     limit 1
  ),
  member_projects as (
    select project.*
      from public.projects project
      join public.project_members membership on membership.project_id = project.id
      join matched_member member on member.id = membership.member_id
     where membership.status <> 'disabled'
  )
  select jsonb_build_object(
    'organizations', coalesce((
      select jsonb_agg(to_jsonb(visible))
        from (
          select distinct organization.*
            from public.organizations organization
            join member_projects project on project.organization_id = organization.id
        ) visible
    ), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(project)) from member_projects project), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(to_jsonb(member)) from matched_member member), '[]'::jsonb),
    'member_credentials', coalesce((
      select jsonb_agg(to_jsonb(credential))
        from public.member_credentials credential
        join matched_member member on member.id = credential.member_id
    ), '[]'::jsonb),
    'member_sessions', coalesce((
      select jsonb_agg(to_jsonb(session))
        from public.member_sessions session
        join matched_member member on member.id = session.member_id
    ), '[]'::jsonb),
    'project_members', coalesce((
      select jsonb_agg(to_jsonb(membership))
        from public.project_members membership
        join member_projects project on project.id = membership.project_id
        join matched_member member on member.id = membership.member_id
    ), '[]'::jsonb),
    'organization_admins', coalesce((
      select jsonb_agg(to_jsonb(administrator))
        from (
          select distinct administrator.*
            from public.organization_admins administrator
            join member_projects project on project.organization_id = administrator.organization_id
            join matched_member member on member.id = administrator.member_id
        ) administrator
    ), '[]'::jsonb)
  )
$$;

create or replace function public.workspace_member_count()
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::integer from public.members
$$;

create or replace function public.apply_workspace_changes(changes jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  table_name text;
  table_oid regclass;
  primary_keys text[];
  conflict_target text;
  insert_columns text;
  update_columns text;
  table_changes jsonb;
  expected_rows jsonb;
  absent_rows jsonb;
  matched_rows integer;
begin
  perform pg_advisory_xact_lock(hashtext('loopdesk_workspace_write'));

  foreach table_name in array array[
    'organizations', 'members', 'member_credentials', 'member_sessions',
    'organization_admins', 'projects', 'project_members',
    'tickets', 'ticket_assignees', 'project_files', 'project_audit', 'meetings',
    'meeting_people', 'meeting_occurrences', 'meeting_notes',
    'meeting_note_participants', 'meeting_note_tasks', 'invites',
    'meeting_edit_requests', 'password_resets',     'google_oauth_states', 'google_calendar_connections', 'workspace_meta'
  ] loop
    expected_rows := changes #> array['expected', table_name];
    if jsonb_typeof(expected_rows) = 'array' and jsonb_array_length(expected_rows) > 0 then
      execute format(
        'select count(*) from public.%I target where exists (select 1 from jsonb_array_elements($1) as expected(row) where to_jsonb(target) @> expected.row)',
        table_name
      ) into matched_rows using expected_rows;
      if matched_rows <> jsonb_array_length(expected_rows) then
        raise exception using errcode = '40001', message = 'Concurrent update detected. Reload the page and retry.';
      end if;
    end if;

    absent_rows := changes #> array['absent', table_name];
    if jsonb_typeof(absent_rows) = 'array' and jsonb_array_length(absent_rows) > 0 then
      execute format(
        'select count(*) from public.%I target where exists (select 1 from jsonb_array_elements($1) as absent(row) where to_jsonb(target) @> absent.row)',
        table_name
      ) into matched_rows using absent_rows;
      if matched_rows > 0 then
        raise exception using errcode = '40001', message = 'A record was created by another request. Reload the page and retry.';
      end if;
    end if;
  end loop;

  foreach table_name in array array[
    'workspace_meta', 'google_oauth_states', 'password_resets', 'meeting_edit_requests',
    'invites', 'meeting_note_tasks', 'meeting_note_participants', 'meeting_notes',
    'meeting_occurrences', 'meeting_people', 'meetings', 'google_calendar_connections', 'project_audit',
    'project_files', 'ticket_assignees', 'tickets', 'project_members', 'projects',
    'organization_admins', 'member_sessions', 'member_credentials', 'members', 'organizations'
  ] loop
    table_changes := changes #> array['deletes', table_name];
    if jsonb_typeof(table_changes) = 'array' and jsonb_array_length(table_changes) > 0 then
      execute format(
        'delete from public.%I target where exists (select 1 from jsonb_array_elements($1) as deleted(key) where to_jsonb(target) @> deleted.key)',
        table_name
      ) using table_changes;
    end if;
  end loop;

  foreach table_name in array array[
    'organizations', 'members', 'member_credentials', 'member_sessions',
    'organization_admins', 'projects', 'project_members',
    'tickets', 'ticket_assignees', 'project_files', 'project_audit', 'meetings',
    'meeting_people', 'meeting_occurrences', 'meeting_notes',
    'meeting_note_participants', 'meeting_note_tasks', 'invites',
    'meeting_edit_requests', 'password_resets', 'google_oauth_states',
    'google_calendar_connections', 'workspace_meta'
  ] loop
    table_changes := changes #> array['upserts', table_name];
    if jsonb_typeof(table_changes) = 'array' and jsonb_array_length(table_changes) > 0 then
      table_oid := format('public.%I', table_name)::regclass;
      select array_agg(attribute.attname order by key_column.ordinality)
        into primary_keys
        from pg_index index_data
        cross join lateral unnest(index_data.indkey) with ordinality as key_column(attnum, ordinality)
        join pg_attribute attribute on attribute.attrelid = index_data.indrelid and attribute.attnum = key_column.attnum
       where index_data.indrelid = table_oid and index_data.indisprimary;
      if primary_keys is null then
        raise exception 'No primary key configured for table %', table_name;
      end if;
      select string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum),
             string_agg(format('%I = excluded.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
        into insert_columns, update_columns
        from pg_attribute attribute
       where attribute.attrelid = table_oid
         and attribute.attnum > 0
         and not attribute.attisdropped
         and attribute.attgenerated = ''
         and attribute.attname <> 'created_at';
      select string_agg(format('%I', key_column), ', ')
        into conflict_target
        from unnest(primary_keys) as key_column;
      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict (%s) do update set %s',
        table_name, insert_columns, insert_columns, table_name, conflict_target, update_columns
      ) using table_changes;
    end if;
  end loop;
end
$$;

revoke all on function public.load_workspace_state() from public, anon, authenticated;
revoke all on function public.load_authorized_workspace(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.lookup_login_state(text, text) from public, anon, authenticated;
revoke all on function public.workspace_member_count() from public, anon, authenticated;
revoke all on function public.apply_workspace_changes(jsonb) from public, anon, authenticated;
grant execute on function public.load_workspace_state() to service_role;
grant execute on function public.load_authorized_workspace(text, text, integer, integer) to service_role;
grant execute on function public.lookup_login_state(text, text) to service_role;
grant execute on function public.workspace_member_count() to service_role;
grant execute on function public.apply_workspace_changes(jsonb) to service_role;

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;
