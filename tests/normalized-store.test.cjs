const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemberSession, diffTables, fromTables, hasNormalizedData, loadWorkspaceMemberCount, saveNormalizedState, toTables } = require("../lib/normalized-store.cjs");

const sampleWorkspace = () => ({
  organizations: [{ id: "org-1", name: "Example", adminIds: ["member-1"] }],
  projects: [{
    id: "project-1",
    organizationId: "org-1",
    name: "Website",
    members: [{ memberId: "member-1", role: "Admin", status: "active" }],
    tickets: [{
      id: "ISS-01",
      type: "issue",
      status: "Open",
      createdBy: "member-2",
      title: "Login problem",
      date: "2026-11-01",
      deadline: "2026-11-07",
      assignees: ["member-1"],
      notes: [{ at: "2026-11-01", text: "Reported" }],
    }],
    files: [{ id: "file-1", name: "spec.pdf", ticket: "ISS-01" }],
    audit: [{ id: "event-1", at: "2026-11-01T10:00:00.000Z", who: "Admin", act: "Created ticket" }],
  }],
  members: [
    { id: "member-1", name: "Admin", email: "admin@example.com", role: "Admin", pw: "hashed", sessions: ["session-1"] },
    { id: "member-2", name: "Client", email: "client@example.com", role: "Client", sessions: [] },
  ],
  meetings: [{
    id: "meeting-1",
    projectId: "project-1",
    date: "2026-11-02",
    title: "Planning",
    attendees: [{ id: "member-1", name: "Admin", email: "admin@example.com" }],
    roster: [{ id: "member-1", name: "Admin", email: "admin@example.com" }],
    occurrences: { "2026-11-02": { notes: "Kickoff", updatedBy: "Admin" } },
  }],
  meetingNotes: [{
    id: "note-1",
    projectId: "project-1",
    meetingId: "meeting-1",
    date: "2026-11-02",
    title: "Planning",
    summary: "Discussion",
    participantSummaries: [{ memberId: "member-1", name: "Admin", tasks: ["Review plan"] }],
    tasks: [{ id: "task-1", title: "Review plan", assigneeId: "member-1", dueDate: "2026-11-07T12:00:00.000Z", status: "Open", comments: [] }],
  }],
  invites: [{ token: "invite-1", projectId: "project-1", email: "new@example.com", role: "Developer" }],
  meetingEditRequests: [{ id: "request-1", projectId: "project-1", memberId: "member-1", status: "pending" }],
  resets: [{ id: "member-1", token: "reset-1", at: 1793520000000 }],
  googleOAuthStates: [{ state: "state-1", memberId: "member-1", projectId: "project-1", expiresAt: 1793520000000 }],
  googleCalendar: { email: "admin@example.com", refreshToken: "encrypted-token" },
  googleCalendars: {
    "org-1": {
      organizationId: "org-1",
      connectedBy: "member-1",
      email: "admin@example.com",
      refreshToken: "encrypted-org-token",
      connectedAt: "2026-11-02T10:00:00.000Z",
    },
  },
  v2: true,
});

test("normalized rows round-trip all workspace records and relationships", () => {
  const source = sampleWorkspace();
  const tables = toTables(source);
  const roundTrip = fromTables(tables);
  assert.deepEqual(roundTrip, source);
  assert.equal(Object.hasOwn(tables.members[0].payload, "pw"), false);
  assert.equal(Object.hasOwn(tables.members[0].payload, "sessions"), false);
});

test("a task edit only writes the changed task row", () => {
  const before = toTables(sampleWorkspace());
  const next = sampleWorkspace();
  next.meetingNotes[0].tasks[0].status = "In Progress";
  const after = toTables(next);
  const changes = diffTables(before, after, false);

  assert.equal(changes.upserts.meeting_note_tasks.length, 1);
  assert.equal(changes.upserts.meeting_note_tasks[0].status, "In Progress");
  assert.deepEqual(changes.upserts.organizations, []);
  assert.deepEqual(changes.upserts.tickets, []);
  assert.deepEqual(changes.upserts.meeting_notes, []);
  assert.deepEqual(changes.deletes.meeting_note_tasks, []);
});

test("workspace writes retry briefly when the transaction lock is busy", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return attempts < 3
      ? new Response(JSON.stringify({ code: "55P03", message: "Workspace write is busy; retry shortly." }), { status: 500 })
      : new Response(null, { status: 204 });
  };

  try {
    await saveNormalizedState("https://example.supabase.co", "service-key", sampleWorkspace(), null, true);
    assert.equal(attempts, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("workspace writes do not retry stale optimistic conflicts", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ code: "PT409", message: "Concurrent update detected." }), { status: 409 });
  };

  try {
    await assert.rejects(
      saveNormalizedState("https://example.supabase.co", "service-key", sampleWorkspace(), null, true),
      /Concurrent update detected/,
    );
    assert.equal(attempts, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("login session creation uses the targeted RPC and preserves the 30-day expiry", async () => {
  const originalFetch = global.fetch;
  let actualRequest;
  global.fetch = async (url, options) => {
    actualRequest = { url, options };
    return new Response(null, { status: 204 });
  };
  const token = `session.${Date.now()}`;

  try {
    await createMemberSession("https://example.supabase.co", "service-key", "member-1", token);
    assert.equal(actualRequest.url, "https://example.supabase.co/rest/v1/rpc/create_member_session");
    assert.deepEqual(JSON.parse(actualRequest.options.body), {
      target_member_id: "member-1",
      session_token: token,
      session_expires_at: Number(token.split(".")[1]) + 30 * 24 * 60 * 60 * 1000,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("login session creation retries transient member lock contention", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return attempts < 3
      ? new Response(JSON.stringify({ code: "55P03", message: "Member session update is busy; retry shortly." }), { status: 500 })
      : new Response(null, { status: 204 });
  };

  try {
    await createMemberSession("https://example.supabase.co", "service-key", "member-1", `session.${Date.now()}`);
    assert.equal(attempts, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("workspace member count retries only transient PostgREST schema cache errors", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return attempts < 3
      ? new Response(JSON.stringify({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }), { status: 503 })
      : new Response("2", { status: 200 });
  };

  try {
    assert.equal(await loadWorkspaceMemberCount("https://example.supabase.co", "service-key"), 2);
    assert.equal(attempts, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a scoped login lookup hydrates only the selected account and writes only its session", () => {
  const allTables = toTables(sampleWorkspace());
  const tableKeys = Object.keys(allTables);
  const scopedTables = Object.fromEntries(tableKeys.map((table) => [table, []]));
  for (const table of ["organizations", "organization_admins", "projects", "members", "member_credentials", "member_sessions", "project_members"]) {
    scopedTables[table] = allTables[table].filter((row) => {
      if (table === "organizations" || table === "projects") return row.id === "org-1" || row.id === "project-1";
      if (table === "organization_admins") return row.organization_id === "org-1" && row.member_id === "member-1";
      if (table === "project_members") return row.project_id === "project-1" && row.member_id === "member-1";
      return row.member_id === "member-1" || row.id === "member-1";
    });
  }
  scopedTables.workspace_meta = allTables.workspace_meta;
  const state = fromTables(scopedTables);

  assert.deepEqual(state.members.map((member) => member.id), ["member-1"]);
  assert.deepEqual(state.projects.map((project) => project.id), ["project-1"]);
  assert.deepEqual(state.projects[0].tickets, []);
  assert.equal(state.members[0].pw, "hashed");
  state.members[0].sessions.push("session-2");

  const changes = diffTables(scopedTables, toTables(state), false);
  assert.equal(changes.upserts.member_sessions.length, 1);
  assert.equal(changes.upserts.member_sessions[0].token, "session-2");
  assert.deepEqual(changes.upserts.members, []);
  assert.deepEqual(changes.upserts.tickets, []);
});

test("login sessions expire 30 days after issuance, not immediately", () => {
  const issuedAt = Date.now();
  const workspace = sampleWorkspace();
  workspace.members[0].sessions = [`session.${issuedAt}`];
  const session = toTables(workspace).member_sessions[0];

  assert.equal(session.expires_at, issuedAt + 30 * 24 * 60 * 60 * 1000);
  assert.ok(session.expires_at > Date.now());
});

test("adding an audit event does not rewrite existing audit rows", () => {
  const before = toTables(sampleWorkspace());
  const next = sampleWorkspace();
  next.projects[0].audit.unshift({
    id: "event-2",
    at: "2026-11-02T10:00:00.000Z",
    who: "Admin",
    act: "Updated ticket",
  });
  const changes = diffTables(before, toTables(next), false);

  assert.equal(changes.upserts.project_audit.length, 1);
  assert.deepEqual(changes.deletes.project_audit, []);
});

test("migration refuses to overwrite pre-existing normalized records", () => {
  const empty = Object.fromEntries(Object.keys(toTables({})).map((table) => [table, []]));
  empty.workspace_meta = [{ key: "schema_version", value: "1" }];
  const populated = toTables(sampleWorkspace());

  assert.equal(hasNormalizedData(empty), false);
  assert.equal(hasNormalizedData(populated), true);
  assert.equal(hasNormalizedData({ ...empty, workspace_meta: [{ key: "application-setting", value: true }] }), true);
});

test("legacy calendar connections migrate only when their admin has one organization", () => {
  const legacy = sampleWorkspace();
  delete legacy.googleCalendars;
  legacy.googleCalendar = {
    connectedBy: "member-1",
    email: "admin@example.com",
    refreshToken: "encrypted-token",
  };
  const migrated = fromTables(toTables(legacy));

  assert.equal(migrated.googleCalendars["org-1"].refreshToken, "encrypted-token");
  assert.equal(migrated.googleCalendars["org-1"].organizationId, "org-1");

  legacy.projects.push({
    id: "project-2",
    organizationId: "org-2",
    name: "Second",
    members: [{ memberId: "member-1", role: "Admin", status: "active" }],
    tickets: [],
    files: [],
    audit: [],
  });
  legacy.organizations.push({ id: "org-2", name: "Another", adminIds: ["member-1"] });
  const ambiguous = fromTables(toTables(legacy));
  assert.deepEqual(ambiguous.googleCalendars, {});
});

test("workspace write locks build text keys without jsonb operator precedence bugs", () => {
  const sql = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "supabase.sql"), "utf8");
  // `'literal' || row->>'key'` parses as `('literal' || row)->>'key'`, casting the literal to jsonb.
  assert.doesNotMatch(sql, /'[^']*'\s*\|\|\s*[\w.]+->>/);
  // A subquery column named like the plpgsql variable `lock_id` is ambiguous at runtime.
  assert.doesNotMatch(sql, /array_agg\(lock_id order by lock_id\)\s*,\s*array\[\]::bigint\[\]\)\s*into lock_ids/);
});

test("database functions never raise SQLSTATEs that PostgREST retries forever", () => {
  const sql = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "supabase.sql"), "utf8");
  // PostgREST transparently re-runs transactions failing with 40001/40P01; a deterministic raise loops until the pool is exhausted.
  assert.doesNotMatch(sql, /errcode\s*=\s*'40(001|P01)'/);
});
