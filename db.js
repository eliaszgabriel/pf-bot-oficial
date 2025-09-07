// db.js
import Database from "better-sqlite3";

const dbFile = process.env.DB_FILE || "./recrutamento.sqlite";
export const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

// Tabela principal + migração leve
db.exec(`
  CREATE TABLE IF NOT EXISTS recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    recrutado TEXT NOT NULL,
    recrutador TEXT NOT NULL,
    recrutador_id TEXT,
    nota INTEGER NOT NULL,
    status TEXT NOT NULL,
    observacoes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const cols = db
  .prepare(`PRAGMA table_info(recruits)`)
  .all()
  .map((c) => c.name);
if (!cols.includes("recrutador_id")) {
  db.exec(`ALTER TABLE recruits ADD COLUMN recrutador_id TEXT;`);
}

// === Funções de acesso usadas no server.js ===
export function insertRecruit({
  discord_id,
  recrutado,
  recrutador,
  recrutador_id,
  nota,
  status,
  observacoes,
}) {
  const stmt = db.prepare(`
    INSERT INTO recruits (discord_id, recrutado, recrutador, recrutador_id, nota, status, observacoes)
    VALUES (@discord_id, @recrutado, @recrutador, @recrutador_id, @nota, @status, @observacoes)
  `);
  const info = stmt.run({
    discord_id,
    recrutado,
    recrutador,
    recrutador_id,
    nota,
    status,
    observacoes,
  });
  return info.lastInsertRowid;
}

export function getRecruitsByDiscordId(discord_id, limit = 5) {
  return db
    .prepare(
      `
      SELECT * FROM recruits
      WHERE discord_id = ?
      ORDER BY id DESC
      LIMIT ?
    `
    )
    .all(discord_id, limit);
}

export function getRecruitCountsByDay(yyyy_mm_dd, limit = 100) {
  return db
    .prepare(
      `
      SELECT COALESCE(recrutador_id, '') AS recrutador_id,
             recrutador,
             COUNT(*) AS total
      FROM recruits
      WHERE date(created_at) = date(?)
      GROUP BY recrutador_id, recrutador
      ORDER BY total DESC, MAX(id) DESC
      LIMIT ?
    `
    )
    .all(`${yyyy_mm_dd} 00:00:00`, limit);
}

export function getRecruitCountsByMonth(yyyy_mm, limit = 200) {
  return db
    .prepare(
      `
      SELECT COALESCE(recrutador_id, '') AS recrutador_id,
             recrutador,
             COUNT(*) AS total
      FROM recruits
      WHERE strftime('%Y-%m', created_at) = ?
      GROUP BY recrutador_id, recrutador
      ORDER BY total DESC, MAX(id) DESC
      LIMIT ?
    `
    )
    .all(yyyy_mm, limit);
}
