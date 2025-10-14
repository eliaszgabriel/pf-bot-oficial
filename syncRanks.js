import cron from "node-cron";
import { ChannelType } from "discord.js";
import {
  db,
  upsertMemberProfile,
  insertNicknameHistory,
  getMemberProfile,
} from "./db.js";

let isSyncRunning = false;

function ensureSyncSchema() {
  // members_profile & nickname_history já criados em db.js (ensureProfileMigrations)
  // garantimos também promotions_history e current_rank para consistência
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotions_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      old_rank TEXT,
      new_rank TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // (removido) ALTER TABLE recruits.current_rank — já gerenciado em db.js
}

/* ========= Helpers de apelido ========= */
function parseNickname(nick) {
  if (!nick) return { tag: null, qra: null, passport: null };
  const s = String(nick).trim();
  const m = s.match(
    /^\s*\[\s*([^\]\}]+)\s*\]?\}?\s*(.*?)\s*\|\s*(\d{1,10})\s*$/
  );
  if (m)
    return {
      tag: `[${m[1].trim().toUpperCase()}]`,
      qra: m[2].trim(),
      passport: m[3].trim(),
    };
  const m2 = s.match(/^(.*?)\s*\|\s*(\d{1,10})\s*$/);
  if (m2) return { tag: null, qra: m2[1].trim(), passport: m2[2].trim() };
  return { tag: null, qra: s, passport: null };
}

function updateRankIfChanged(discordId, newRank) {
  const current = db
    .prepare(
      `SELECT current_rank FROM recruits WHERE discord_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(discordId);
  const oldRank = current ? current.current_rank : null;
  if (oldRank === newRank) return false;
  db.prepare(`UPDATE recruits SET current_rank = ? WHERE discord_id = ?`).run(
    newRank,
    discordId
  );
  db.prepare(
    `INSERT INTO promotions_history (discord_id, old_rank, new_rank) VALUES (?, ?, ?)`
  ).run(discordId, oldRank, newRank);
  return true;
}

export async function syncRanks(client) {
  if (isSyncRunning) {
    console.warn("[SYNC RANKS] ⚠️ Já em execução, abortando.");
    return;
  }
  isSyncRunning = true;
  try {
    ensureSyncSchema();
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.members.fetch();

    let checked = 0,
      updated = 0,
      errors = 0,
      profUpdates = 0;

    for (const member of guild.members.cache.values()) {
      try {
        checked++;
        const nick =
          member.nickname ||
          member.user.globalName ||
          member.user.username ||
          "";
        const { tag, qra, passport } = parseNickname(nick);

        // Atualiza profile (para consultas mostrarem sempre o apelido mais recente)
        const prevProfile = getMemberProfile(member.id);
        if (
          !prevProfile ||
          prevProfile.nickname !== nick ||
          prevProfile.passport !== passport ||
          prevProfile.tag !== tag
        ) {
          upsertMemberProfile({
            discord_id: member.id,
            nickname: nick,
            qra,
            passport,
            tag,
          });
          if (
            prevProfile &&
            prevProfile.nickname &&
            prevProfile.nickname !== nick
          ) {
            insertNicknameHistory(member.id, prevProfile.nickname, nick);
          }
          profUpdates++;
        }

        // Atualiza recruits.current_rank se tag mudou
        if (tag) {
          if (updateRankIfChanged(member.id, tag)) updated++;
        }

        // (Opcional) sincronizar campo passport no recruits (se existir)
        try {
          if (passport) {
            db.prepare(
              `UPDATE recruits SET passport = ? WHERE discord_id = ? AND (passport IS NULL OR replace(passport,' ','') = '')`
            ).run(passport, member.id);
          }
        } catch {}
      } catch (e) {
        console.error("Erro no membro:", member.user?.tag || member.id, e);
        errors++;
      }
    }

    // Log resumo
    try {
      const ch = await client.channels.fetch(
        process.env.RECRUIT_LOG_CHANNEL_ID
      );
      if (ch && ch.type === ChannelType.GuildText) {
        await ch.send(
          `🧭 **Sync de patentes/apelidos (diário)**\n` +
            `Verificados: **${checked}** | Atualizados (rank): **${updated}** | Perfis atualizados: **${profUpdates}** | Erros: **${errors}**`
        );
      }
    } catch (e) {
      console.warn("Falha ao enviar log de sync:", e.message);
    }
  } finally {
    isSyncRunning = false;
  }
}

export function scheduleDailySync(client) {
  cron.schedule(
    "0 3 * * *",
    async () => {
      console.log("[SYNC RANKS] ⏰ Rodando sync diário...");
      try {
        await syncRanks(client);
        console.log("[SYNC RANKS] ✅ Concluído");
      } catch (err) {
        console.error("[SYNC RANKS] ❌ Erro:", err);
      }
    },
    { timezone: "America/Sao_Paulo" }
  );
}
