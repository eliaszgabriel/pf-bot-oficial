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


// === MIGRAÇÕES PARA PERFIL/ALCUNHA (apelidos) ===
export function ensureProfileMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members_profile (
      discord_id TEXT PRIMARY KEY,
      nickname   TEXT NOT NULL,
      qra        TEXT,
      passport   TEXT,
      tag        TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS nickname_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      old_nickname TEXT,
      new_nickname TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function upsertMemberProfile({
  discord_id,
  nickname,
  qra = null,
  passport = null,
  tag = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO members_profile (discord_id, nickname, qra, passport, tag, updated_at)
    VALUES (@discord_id, @nickname, @qra, @passport, @tag, datetime('now'))
    ON CONFLICT(discord_id) DO UPDATE SET
      nickname   = excluded.nickname,
      qra        = excluded.qra,
      passport   = excluded.passport,
      tag        = excluded.tag,
      updated_at = excluded.updated_at
  `);
  stmt.run({ discord_id, nickname, qra, passport, tag });
}

export function getMemberProfile(discord_id) {
  return db
    .prepare(
      `SELECT discord_id, nickname, qra, passport, tag, updated_at
       FROM members_profile
       WHERE discord_id = ?`
    )
    .get(discord_id);
}

export function insertNicknameHistory(discord_id, old_nickname, new_nickname) {
  db.prepare(
    `INSERT INTO nickname_history (discord_id, old_nickname, new_nickname)
     VALUES (?, ?, ?)`
  ).run(discord_id, old_nickname, new_nickname);
}

export function getNicknameHistory(discord_id, limit = 20) {
  return db
    .prepare(
      `SELECT old_nickname, new_nickname, changed_at
       FROM nickname_history
       WHERE discord_id = ?
       ORDER BY datetime(changed_at) DESC
       LIMIT ?`
    )
    .all(discord_id, limit);
}
