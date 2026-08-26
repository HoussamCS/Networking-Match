const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'networking.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    nom TEXT NOT NULL,
    occupation TEXT,
    categorie TEXT NOT NULL,
    email TEXT,
    telephone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    matched_person_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Thin wrapper so server.js can keep using a better-sqlite3-like API
// (.prepare(sql).get/all/run) on top of node:sqlite's DatabaseSync.
module.exports = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
    };
  },
};
