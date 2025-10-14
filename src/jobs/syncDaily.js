// src/jobs/syncDaily.js (ESM)
import cron from "node-cron";
import { getRecruitByPassport } from "../lib/api.js";
import { applyRecruitRules } from "../lib/applyRules.js";
import { extractPassportFromNick } from "../lib/nick.js";

export async function runSync({ client }) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const logCh = process.env.RECRUIT_LOG_CHANNEL_ID
    ? await guild.channels
        .fetch(process.env.RECRUIT_LOG_CHANNEL_ID)
        .catch(() => null)
    : null;

  const members = await guild.members.fetch();

  let scanned = 0,
    updated = 0,
    skipped = 0;
  for (const [, member] of members) {
    const passport = extractPassportFromNick(member.displayName);
    if (!passport) {
      skipped++;
      continue;
    }
    scanned++;
    try {
      const payload = await getRecruitByPassport(passport);
      if (payload?.data) {
        await applyRecruitRules({
          guild,
          member,
          recruit: payload.data,
          logChannel: logCh,
        });
        updated++;
      } else {
        skipped++;
      }
    } catch (_) {
      skipped++;
    }
  }

  if (logCh) {
    logCh.send(
      `🕒 Sync diário: scanned **${scanned}**, atualizados **${updated}**, pulados **${skipped}**.`
    );
  }
}

export function scheduleDailySync({ client }) {
  cron.schedule("0 3 * * *", () => runSync({ client }), {
    timezone: "America/Sao_Paulo",
  });
}
