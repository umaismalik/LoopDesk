const fs = require("node:fs");
const path = require("node:path");
const {
  loadLegacyState,
  loadNormalizedState,
  saveNormalizedState,
  fromTables,
  hasNormalizedData,
  schemaIsCurrent,
  toTables,
} = require("../lib/normalized-store.cjs");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  }
  return value;
}

async function requestStorage(name, options = {}) {
  const headers = {
    apikey: key,
    ...(String(key).startsWith("sb_") ? {} : { Authorization: `Bearer ${key}` }),
    ...(options.headers || {}),
  };
  const objectUrl = `${url}/storage/v1/object/uploads/${encodeURIComponent(name)}`;
  const response = await fetch(objectUrl, {
    ...options,
    headers,
  });
  if (response.status === 409) {
    const existing = await fetch(objectUrl, { headers });
    if (existing.ok && Buffer.compare(Buffer.from(await existing.arrayBuffer()), Buffer.from(options.body)) === 0) return;
    throw new Error(`Storage object ${name} already exists with different content; migration stopped without replacing it.`);
  }
  if (!response.ok) {
    throw new Error(`Could not upload ${name} to Supabase Storage (${response.status}): ${await response.text()}`);
  }
}

async function main() {
  if (!url || !key || url.toLowerCase().includes("your-project.supabase.co")) {
    throw new Error("Set a real SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local.");
  }

  const current = await loadNormalizedState(url, key);
  if (schemaIsCurrent(current)) {
    console.log("The normalized database is already active. No migration was performed.");
    return;
  }
  if (hasNormalizedData(current)) {
    throw new Error("Normalized tables already contain records but the migration marker is missing. No data or files were changed; inspect the partial migration before retrying.");
  }

  const legacy = await loadLegacyState(url, key);
  const localDatabase = path.join(process.cwd(), "data", "db.json");
  const localUploads = path.join(process.cwd(), "data", "uploads");
  const source = legacy || (fs.existsSync(localDatabase)
    ? JSON.parse(fs.readFileSync(localDatabase, "utf8"))
    : null);
  if (!source) {
    throw new Error("No legacy Supabase kv record or local data/db.json was found. Nothing was changed.");
  }

  if (fs.existsSync(localUploads)) {
    for (const name of fs.readdirSync(localUploads)) {
      const file = path.join(localUploads, name);
      if (!fs.statSync(file).isFile()) continue;
      await requestStorage(name, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: fs.readFileSync(file),
      });
    }
  }

  await saveNormalizedState(url, key, source, null, true);
  const verified = await loadNormalizedState(url, key);
  if (!schemaIsCurrent(verified) || JSON.stringify(canonical(fromTables(verified))) !== JSON.stringify(canonical(fromTables(toTables(source))))) {
    throw new Error("Migration verification failed. The original source was preserved; inspect normalized rows before retrying.");
  }
  console.log("Migration completed and verified. Existing normalized records were not replaced, and the old kv record remains available.");
}

main().catch((error) => {
  console.error("Normalized Supabase migration failed:", error.message);
  process.exitCode = 1;
});
