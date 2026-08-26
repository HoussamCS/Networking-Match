const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

let readyPromise = null;

async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      nom TEXT NOT NULL,
      occupation TEXT,
      categorie TEXT NOT NULL,
      email TEXT,
      telephone TEXT,
      photo TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      person_id TEXT NOT NULL,
      matched_person_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
}

// Runs once per warm serverless instance (cached), re-runs on the next cold start.
function ready() {
  if (!readyPromise) readyPromise = initSchema();
  return readyPromise;
}

module.exports = { sql, ready };
