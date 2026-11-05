const SCHEMA_VERSION = "1";
const snapshots = new WeakMap();
const metaKeys = ["v2", "v3", "v4", "v5", "v6", "googleCalendar"];

const clone = (value) => JSON.parse(JSON.stringify(value));
const array = (value) => Array.isArray(value) ? value : [];
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const keyOf = (row, keys) => keys.map((key) => String(row[key] ?? "")).join("\u001f");
const without = (object, keys) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));

const tableKeys = {
  organizations: ["id"],
  organization_admins: ["organization_id", "member_id"],
  projects: ["id"],
  members: ["id"],
  member_credentials: ["member_id"],
  member_sessions: ["member_id", "token"],
  project_members: ["project_id", "member_id"],
  tickets: ["project_id", "id"],
  ticket_assignees: ["project_id", "ticket_id", "member_id"],
  project_files: ["project_id", "id"],
  project_audit: ["project_id", "event_id"],
  meetings: ["id"],
  meeting_people: ["meeting_id", "kind", "member_key"],
  meeting_occurrences: ["meeting_id", "occurrence_date"],
  meeting_notes: ["id"],
  meeting_note_participants: ["note_id", "member_id"],
  meeting_note_tasks: ["note_id", "task_id"],
  invites: ["token"],
  meeting_edit_requests: ["id"],
  password_resets: ["member_id"],
  google_oauth_states: ["state"],
  google_calendar_connections: ["organization_id"],
  workspace_meta: ["key"],
};

const upsertOrder = [
  "organizations",
  "members",
  "member_credentials",
  "member_sessions",
  "organization_admins",
  "projects",
  "project_members",
  "tickets",
  "ticket_assignees",
  "project_files",
  "project_audit",
  "meetings",
  "meeting_people",
  "meeting_occurrences",
  "meeting_notes",
  "meeting_note_participants",
  "meeting_note_tasks",
  "invites",
  "meeting_edit_requests",
  "password_resets",
  "google_oauth_states",
  "google_calendar_connections",
  "workspace_meta",
];
function normalizedSource(source) {
  const state = clone(source || {});
  if (!Array.isArray(state.projects)) {
    state.projects = [{
      id: "rewaldo",
      organizationId: "solexes",
      name: "Rewaldo",
      tickets: array(state.tickets),
      files: array(state.files),
      audit: array(state.audit),
      members: array(state.members).map((member) => ({
        memberId: member.id,
        role: member.role || "Developer",
        status: "active",
      })),
    }];
  }
  state.organizations = array(state.organizations);
  if (!state.organizations.length) {
    state.organizations.push({
      id: "solexes",
      name: "My Company",
      adminIds: [...new Set(state.projects.flatMap((project) =>
        array(project.members).filter((entry) => entry.role === "Admin" && entry.status !== "disabled").map((entry) => entry.memberId)))],
    });
  }
  const fallbackOrg = state.organizations[0];
  state.projects.forEach((project) => {
    project.organizationId = project.organizationId || fallbackOrg.id;
    if (!state.organizations.some((organization) => organization.id === project.organizationId)) {
      state.organizations.push({ id: project.organizationId, name: "Imported company", adminIds: [] });
    }
    project.tickets = array(project.tickets);
    project.files = array(project.files);
    project.audit = array(project.audit);
    project.members = array(project.members);
    const auditIds = new Map();
    project.audit.forEach((entry) => {
      if (entry.id) return;
      const signature = JSON.stringify(canonical(without(entry, ["id"])));
      const duplicate = auditIds.get(signature) || 0;
      auditIds.set(signature, duplicate + 1);
      const digest = require("crypto").createHash("sha256").update(signature).digest("hex").slice(0, 40);
      entry.id = `legacy-${digest}-${duplicate}`;
    });
  });
  state.members = array(state.members);
  state.googleCalendars = state.googleCalendars && typeof state.googleCalendars === "object"
    ? state.googleCalendars
    : {};
  if (state.googleCalendar?.refreshToken) {
    let organizationId = state.googleCalendar.organizationId || "";
    if (!organizationId && state.googleCalendar.connectedBy) {
      const adminOrganizations = [...new Set(state.projects
        .filter((project) => array(project.members).some((entry) =>
          entry.memberId === state.googleCalendar.connectedBy && entry.role === "Admin" && entry.status !== "disabled"))
        .map((project) => project.organizationId)
        .filter(Boolean))];
      if (adminOrganizations.length === 1) organizationId = adminOrganizations[0];
    }
    if (organizationId && !state.googleCalendars[organizationId]) {
      state.googleCalendars[organizationId] = { ...state.googleCalendar, organizationId };
    }
  }
  state.meetings = array(state.meetings);
  state.meetingNotes = array(state.meetingNotes);
  state.invites = array(state.invites);
  state.meetingEditRequests = array(state.meetingEditRequests);
  state.resets = array(state.resets);
  state.googleOAuthStates = array(state.googleOAuthStates);
  const defaultProjectId = state.projects[0]?.id || "";
  state.meetings.forEach((meeting) => { meeting.projectId = meeting.projectId || defaultProjectId; });
  state.meetingNotes.forEach((note) => { note.projectId = note.projectId || defaultProjectId; });
  state.invites.forEach((invite) => { invite.projectId = invite.projectId || defaultProjectId; });
  state.meetingEditRequests.forEach((request) => { request.projectId = request.projectId || defaultProjectId; });
  return state;
}

function toTables(input) {
  const state = normalizedSource(input);
  const data = Object.fromEntries(Object.keys(tableKeys).map((table) => [table, []]));

  state.organizations.forEach((organization) => {
    data.organizations.push({ id: organization.id, name: organization.name });
    array(organization.adminIds).forEach((memberId) => data.organization_admins.push({
      organization_id: organization.id,
      member_id: memberId,
    }));
  });
  state.members.forEach((member) => {
    data.members.push({
      id: member.id,
      email: member.email || "",
      name: member.name || "",
      phone: member.phone || "",
      status: member.status || "active",
      payload: without(member, ["pw", "key", "sessions"]),
    });
    data.member_credentials.push({
      member_id: member.id,
      password_hash: member.pw || "",
      legacy_key: member.key || "",
    });
    array(member.sessions).forEach((token, position) => data.member_sessions.push({
      member_id: member.id,
      token,
      expires_at: Number(String(token).split(".").pop()) || null,
      position,
    }));
  });
  state.projects.forEach((project) => {
    data.projects.push({ id: project.id, organization_id: project.organizationId, name: project.name, payload: without(project, ["tickets", "files", "audit", "members"]) });
    array(project.members).forEach((member) => data.project_members.push({
      project_id: project.id,
      member_id: member.memberId,
      role: member.role || "Developer",
      status: member.status || "active",
    }));
    array(project.tickets).forEach((ticket) => {
      data.tickets.push({
        project_id: project.id,
        id: ticket.id,
        type: ticket.type || "",
        status: ticket.status || "",
        created_by: ticket.createdBy || "",
        title: ticket.title || "",
        date: ticket.date || null,
        due_date: ticket.deadline || null,
        payload: without(ticket, ["assignees"]),
      });
      array(ticket.assignees).forEach((memberId) => data.ticket_assignees.push({
        project_id: project.id,
        ticket_id: ticket.id,
        member_id: memberId,
      }));
    });
    array(project.files).forEach((file) => data.project_files.push({
      project_id: project.id,
      id: file.id,
      ticket_id: file.ticket || "",
      payload: file,
    }));
    project.audit.forEach((event, position) => data.project_audit.push({
      project_id: project.id,
      event_id: event.id,
      position: Date.parse(event.at || "") || position,
      payload: event,
    }));
  });
  state.meetings.forEach((meeting) => {
    data.meetings.push({
      id: meeting.id,
      project_id: meeting.projectId,
      date: meeting.date || null,
      payload: without(meeting, ["attendees", "roster", "occurrences"]),
    });
    [["attendee", meeting.attendees], ["roster", meeting.roster]].forEach(([kind, people]) =>
      array(people).forEach((person, position) => data.meeting_people.push({
        meeting_id: meeting.id,
        kind,
        member_key: String(person.id || person.email || `${kind}-${position}`),
        email: person.email || "",
        name: person.name || "",
        position,
      })));
    Object.entries(meeting.occurrences || {}).forEach(([occurrenceDate, occurrence]) =>
      data.meeting_occurrences.push({
        meeting_id: meeting.id,
        occurrence_date: occurrenceDate,
        payload: occurrence,
      }));
  });
  state.meetingNotes.forEach((note) => {
    data.meeting_notes.push({
      id: note.id,
      project_id: note.projectId,
      meeting_id: note.meetingId || "",
      date: note.date || null,
      title: note.title || "",
      payload: without(note, ["tasks", "participantSummaries"]),
    });
    array(note.participantSummaries).forEach((participant, position) =>
      data.meeting_note_participants.push({
        note_id: note.id,
        member_id: participant.memberId,
        position,
        payload: participant,
      }));
    array(note.tasks).forEach((task, position) =>
      data.meeting_note_tasks.push({
        note_id: note.id,
        task_id: task.id,
        assignee_id: task.assigneeId || "",
        due_at: task.dueDate || null,
        status: task.status || "Open",
        position,
        payload: task,
      }));
  });
  state.invites.forEach((invite) => data.invites.push({
    token: invite.token,
    project_id: invite.projectId || "",
    email: invite.email || "",
    payload: invite,
  }));
  state.meetingEditRequests.forEach((request) => data.meeting_edit_requests.push({
    id: request.id,
    project_id: request.projectId,
    member_id: request.memberId,
    status: request.status || "pending",
    expires_at: request.expiresAt || null,
    payload: request,
  }));
  state.resets.forEach((reset) => data.password_resets.push({ member_id: reset.id, payload: reset }));
  state.googleOAuthStates.forEach((item) => data.google_oauth_states.push({ state: item.state, payload: item }));
  Object.entries(state.googleCalendars).forEach(([organizationId, connection]) => {
    if (!connection?.refreshToken) return;
    data.google_calendar_connections.push({
      organization_id: organizationId,
      connected_by: connection.connectedBy || "",
      email: connection.email || "",
      refresh_token: connection.refreshToken,
      connected_at: connection.connectedAt || "",
      payload: without(connection, ["organizationId", "connectedBy", "email", "refreshToken", "connectedAt"]),
    });
  });
  metaKeys.forEach((key) => {
    if (state[key] !== undefined) data.workspace_meta.push({ key, value: state[key] });
  });
  data.workspace_meta.push({ key: "schema_version", value: SCHEMA_VERSION });
  return data;
}

function fromTables(data) {
  const organizationAdminIds = new Map();
  array(data.organization_admins).forEach((row) => {
    const admins = organizationAdminIds.get(row.organization_id) || [];
    admins.push(row.member_id);
    organizationAdminIds.set(row.organization_id, admins);
  });
  const organizations = array(data.organizations).map((row) => ({
    id: row.id,
    name: row.name,
    adminIds: organizationAdminIds.get(row.id) || [],
  }));
  const credentials = new Map(array(data.member_credentials).map((row) => [row.member_id, row]));
  const sessions = new Map();
  array(data.member_sessions).forEach((row) => {
    const memberSessions = sessions.get(row.member_id) || [];
    memberSessions.push(row);
    sessions.set(row.member_id, memberSessions);
  });
  const members = array(data.members).map((row) => {
    const member = { ...row.payload };
    const auth = credentials.get(row.id);
    if (auth?.password_hash) member.pw = auth.password_hash;
    if (auth?.legacy_key) member.key = auth.legacy_key;
    const memberSessions = sessions.get(row.id) || [];
    member.sessions = memberSessions
      .sort((left, right) => left.position - right.position)
      .map((session) => session.token);
    return member;
  });
  const projects = array(data.projects).map((row) => {
    const project = { ...row.payload, id: row.id, organizationId: row.organization_id, name: row.name };
    project.members = array(data.project_members)
      .filter((entry) => entry.project_id === row.id)
      .map((entry) => ({ memberId: entry.member_id, role: entry.role, status: entry.status }));
    const ticketAssignees = new Map();
    array(data.ticket_assignees).filter((entry) => entry.project_id === row.id).forEach((entry) => {
      const assignees = ticketAssignees.get(entry.ticket_id) || [];
      assignees.push(entry.member_id);
      ticketAssignees.set(entry.ticket_id, assignees);
    });
    project.tickets = array(data.tickets).filter((ticket) => ticket.project_id === row.id).map((ticket) => ({
      ...ticket.payload,
      id: ticket.id,
      assignees: ticketAssignees.get(ticket.id) || [],
    }));
    project.files = array(data.project_files).filter((file) => file.project_id === row.id).map((file) => file.payload);
    project.audit = array(data.project_audit).filter((event) => event.project_id === row.id)
      .sort((left, right) => right.position - left.position).map((event) => event.payload);
    return project;
  });
  const meetings = array(data.meetings).map((row) => {
    const meeting = { ...row.payload, id: row.id, projectId: row.project_id, date: row.date };
    const people = array(data.meeting_people).filter((person) => person.meeting_id === row.id);
    meeting.attendees = people.filter((person) => person.kind === "attendee")
      .sort((left, right) => left.position - right.position)
      .map((person) => ({ id: person.member_key, name: person.name, email: person.email }));
    meeting.roster = people.filter((person) => person.kind === "roster")
      .sort((left, right) => left.position - right.position)
      .map((person) => ({ id: person.member_key, name: person.name, email: person.email }));
    meeting.occurrences = Object.fromEntries(array(data.meeting_occurrences)
      .filter((occurrence) => occurrence.meeting_id === row.id)
      .map((occurrence) => [occurrence.occurrence_date, occurrence.payload]));
    return meeting;
  });
  const meetingNotes = array(data.meeting_notes).map((row) => ({
    ...row.payload,
    id: row.id,
    projectId: row.project_id,
    meetingId: row.meeting_id,
    date: row.date,
    participantSummaries: array(data.meeting_note_participants)
      .filter((participant) => participant.note_id === row.id)
      .sort((left, right) => left.position - right.position)
      .map((participant) => participant.payload),
    tasks: array(data.meeting_note_tasks)
      .filter((task) => task.note_id === row.id)
      .sort((left, right) => left.position - right.position)
      .map((task) => task.payload),
  }));
  const state = {
    organizations,
    projects,
    members,
    meetings,
    meetingNotes,
    invites: array(data.invites).map((row) => row.payload),
    meetingEditRequests: array(data.meeting_edit_requests).map((row) => row.payload),
    resets: array(data.password_resets).map((row) => row.payload),
    googleOAuthStates: array(data.google_oauth_states).map((row) => row.payload),
    googleCalendars: Object.fromEntries(array(data.google_calendar_connections).map((row) => [
      row.organization_id,
      {
        ...row.payload,
        organizationId: row.organization_id,
        connectedBy: row.connected_by,
        email: row.email,
        refreshToken: row.refresh_token,
        connectedAt: row.connected_at,
      },
    ])),
  };
  array(data.workspace_meta).forEach((row) => {
    if (row.key !== "schema_version") state[row.key] = row.value;
  });
  return state;
}

function diffTables(before, after, force) {
  const upserts = {}, deletes = {}, expected = {}, absent = {};
  upsertOrder.forEach((table) => {
    const previousRows = force ? [] : array(before?.[table]);
    const previous = new Map(previousRows.map((row) => [keyOf(row, tableKeys[table]), row]));
    const currentRows = array(after[table]);
    const current = new Map(currentRows.map((row) => [keyOf(row, tableKeys[table]), row]));
    upserts[table] = currentRows.filter((row) => force || !previous.has(keyOf(row, tableKeys[table])) || !equal(previous.get(keyOf(row, tableKeys[table])), row));
    deletes[table] = force ? [] : previousRows
      .filter((row) => !current.has(keyOf(row, tableKeys[table])))
      .map((row) => Object.fromEntries(tableKeys[table].map((key) => [key, row[key]])));
    expected[table] = force ? [] : [
      ...upserts[table].map((row) => previous.get(keyOf(row, tableKeys[table]))).filter(Boolean),
      ...deletes[table].map((deleted) => previous.get(keyOf(deleted, tableKeys[table]))).filter(Boolean),
    ];
    absent[table] = force ? [] : upserts[table]
      .filter((row) => !previous.has(keyOf(row, tableKeys[table])))
      .map((row) => Object.fromEntries(tableKeys[table].map((key) => [key, row[key]])));
  });
  return { upserts, deletes, expected, absent };
}

async function request(url, key, pathname, options = {}) {
  const response = await fetch(`${url}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: key,
      ...(String(key).startsWith("sb_") ? {} : { Authorization: `Bearer ${key}` }),
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${pathname} failed (${response.status}): ${detail}`);
  }
  return response;
}

async function loadNormalizedState(url, key) {
  const response = await request(url, key, "rpc/load_workspace_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return response.json();
}

async function loadAuthorizedWorkspace(url, key, sessionToken, projectId, ticketOffset = 0, ticketLimit = 100) {
  const response = await request(url, key, "rpc/load_authorized_workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      requested_project_id: projectId || null,
      ticket_page_size: ticketLimit,
      ticket_page_offset: ticketOffset,
    }),
  });
  return response.json();
}

async function loadAuthorizedCollection(url, key, sessionToken, projectId, collection, rangeStart, rangeEnd, offset = 0, limit = 100, recordId) {
  const response = await request(url, key, "rpc/load_authorized_collection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      requested_project_id: projectId,
      collection_name: collection,
      range_start: rangeStart || null,
      range_end: rangeEnd || null,
      page_offset: offset,
      page_size: limit,
      record_id: recordId || null,
    }),
  });
  return response.json();
}

async function loadLoginState(url, key, identifier, phoneNumber) {
  const response = await request(url, key, "rpc/lookup_login_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login_identifier: identifier,
      login_phone: phoneNumber || "",
    }),
  });
  return response.json();
}

async function loadWorkspaceMemberCount(url, key) {
  const response = await request(url, key, "rpc/workspace_member_count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return response.json();
}

async function loadPublicFlowState(url, key, flow, token, identifier, phoneNumber) {
  const response = await request(url, key, "rpc/load_public_flow_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flow_name: flow,
      flow_token: token || null,
      login_identifier: identifier || null,
      login_phone: phoneNumber || "",
    }),
  });
  return response.json();
}

async function loadReminderState(url, key) {
  const response = await request(url, key, "rpc/load_reminder_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return response.json();
}

async function acquireWorkerLease(url, key, name, token, seconds = 900) {
  const response = await request(url, key, "rpc/acquire_worker_lease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lease_name: name, owner_token: token, lease_seconds: seconds }),
  });
  return response.json();
}

async function releaseWorkerLease(url, key, name, token) {
  await request(url, key, "rpc/release_worker_lease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lease_name: name, owner_token: token }),
  });
}

async function loadLegacyState(url, key) {
  const response = await request(url, key, "kv?key=eq.db&select=value&limit=1");
  const rowsFromLegacy = await response.json();
  return rowsFromLegacy[0]?.value || null;
}

async function saveNormalizedState(url, key, state, baseline, force = false) {
  const nextTables = toTables(state);
  const previousTables = baseline ? toTables(baseline) : null;
  const changes = diffTables(previousTables, nextTables, force || !baseline);
  await request(url, key, "rpc/apply_workspace_changes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
}

function attachSnapshot(state, normalized) {
  snapshots.set(state, { state: clone(normalizedSource(state)), normalized });
}

function snapshotFor(state) {
  return snapshots.get(state);
}

function updateSnapshot(state, current, normalized = true) {
  snapshots.set(state, { state: clone(normalizedSource(current)), normalized });
}

function hydrateNormalizedState(data) {
  return fromTables(data);
}

function schemaIsCurrent(data) {
  return array(data.workspace_meta).some((row) => row.key === "schema_version" && String(row.value) === SCHEMA_VERSION);
}

function hasNormalizedData(data) {
  return Object.keys(tableKeys).some((table) => {
    const rows = array(data?.[table]);
    return table === "workspace_meta"
      ? rows.some((row) => row.key !== "schema_version")
      : rows.length > 0;
  });
}

module.exports = {
  attachSnapshot,
  diffTables,
  fromTables,
  hasNormalizedData,
  loadAuthorizedWorkspace,
  loadAuthorizedCollection,
  loadLoginState,
  loadWorkspaceMemberCount,
  loadPublicFlowState,
  loadReminderState,
  acquireWorkerLease,
  releaseWorkerLease,
  hydrateNormalizedState,
  loadLegacyState,
  loadNormalizedState,
  saveNormalizedState,
  schemaIsCurrent,
  snapshotFor,
  toTables,
  updateSnapshot,
};
