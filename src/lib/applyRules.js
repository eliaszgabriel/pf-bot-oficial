// src/lib/applyRules.js (ESM)
import roles from "../config/roles.js";
import { buildNickname, tagForCargo } from "./nick.js";

export async function applyRecruitRules({
  guild,
  member,
  recruit,
  logChannel,
}) {
  // recruit: { nome, passport, status, cargo, nota, photo_path }
  const { status, cargo, nota, nome, passport } = recruit;

  // 1) Determinar roles alvo
  const rolesToAdd = new Set();
  const rolesToRemove = new Set([
    roles.REPROVADO,
    roles.CURSOS_PENDENTES,
    roles.ESTG,
    roles.AGT3,
    roles.PF,
  ]);

  if (/reprov/i.test(status)) {
    rolesToAdd.add(roles.REPROVADO);
  } else if (/aprov/i.test(status)) {
    rolesToAdd.add(roles.MEMBER);
    const tag = tagForCargo(cargo);
    if (/AGT/i.test(tag)) rolesToAdd.add(roles.AGT3);
    else if (/PF/i.test(tag)) rolesToAdd.add(roles.PF);
    else rolesToAdd.add(roles.ESTG); // fallback
  } else {
    rolesToAdd.add(roles.MEMBER);
    rolesToAdd.add(roles.ESTG);
    rolesToAdd.add(roles.CURSOS_PENDENTES);
  }

  // 2) Aplicar roles
  const current = new Set(member.roles.cache.keys());
  for (const r of rolesToAdd) if (r) await member.roles.add(r).catch(() => {});
  for (const r of rolesToRemove)
    if (r && !rolesToAdd.has(r) && current.has(r)) {
      await member.roles.remove(r).catch(() => {});
    }

  // 3) Renomear
  const nick = buildNickname({ nome, passport, cargo });
  await member.setNickname(nick).catch(() => {});

  // 4) Se reprovado: expulsar após 5 min
  if (/reprov/i.test(status)) {
    setTimeout(async () => {
      try {
        await member.kick(`Reprovado no processo (passport ${passport})`);
        if (logChannel) {
          logChannel.send(
            `👢 Expulso: <@${member.id}> (passport ${passport}) — reprovado.`
          );
        }
      } catch (_) {}
    }, 5 * 60 * 1000);
  }

  // 5) Log opcional
  if (logChannel) {
    logChannel.send(
      `🔁 Regras aplicadas a <@${
        member.id
      }> | status: **${status}** | cargo: **${cargo || "-"}** | nota: **${
        nota ?? "-"
      }**`
    );
  }
}
