// features/juridico.js (ESM, API-only) — versão alinhada ao fluxo do Registro
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { upsertJuridico } from "../helpers/api.js";

// canais/roles do seu .env
const CH_LOG = process.env.LOG_SETAGEM_CHANNEL_ID;
const ROLE_PF = process.env.ROLE_PF_ID;
const ROLE_MEMBER = process.env.ROLE_MEMBER_ID;
const ROLE_JUR = process.env.ROLE_JURIDICO_ID;
const ROLE_EST = process.env.ROLE_ESTAGIARIO_ID || process.env.ROLE_ESTG_ID;
const ROLE_AGT3 = process.env.ROLE_AGT3_ID;

// permissões (quem pode aprovar jurídico: usa mesmo papel do recrutador ou quem tem ManageRoles)
const ROLE_RECRUITER = process.env.RECRUITER_ROLE_ID;

const IDs = {
  MODAL_ID: "jur:modal",
  APPROVE: "jur:approve",
  REJECT: "jur:reject",
};

function formatNick(name, id) {
  const pre = "[ADV] ";
  const suf = ` | ${id}`;
  const max = 32 - pre.length - suf.length; // limite do Discord
  return `${pre}${(name || "").slice(0, Math.max(0, max))}${suf}`;
}

export default {
  // Abre o modal (Nome/ID) com limites
  async start(interaction) {
    if ((process.env.FEATURE_JURIDICO || "on") !== "on") {
      return interaction.reply({
        content: "Jurídico desativado.",
        ephemeral: true,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(IDs.MODAL_ID)
      .setTitle("Solicitação de Jurídico");

    const iNome = new TextInputBuilder()
      .setCustomId("nome")
      .setLabel("Nome")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20); // limite no formulário

    const iId = new TextInputBuilder()
      .setCustomId("pid")
      .setLabel("ID (passaporte)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10); // limite no formulário

    modal.addComponents(
      new ActionRowBuilder().addComponents(iNome),
      new ActionRowBuilder().addComponents(iId)
    );

    await interaction.showModal(modal);
  },

  // Recebe o modal → publica no canal de log com botões Aprovar/Reprovar
  async onModalSubmit(interaction) {
    if (interaction.customId !== IDs.MODAL_ID) return;

    let name = (interaction.fields.getTextInputValue("nome") || "").trim();
    const pid = (interaction.fields.getTextInputValue("pid") || "").trim();

    // saneamento extra
    if (!/^\d{1,10}$/.test(pid)) {
      return interaction.reply({ content: "❌ ID inválido.", ephemeral: true });
    }
    name = name.replace(/\s+/g, " ").slice(0, 20);

    // API — registra solicitação (tolerante se rota não existir)
    try {
      await upsertJuridico({
        passport: Number(pid),
        name,
        discord_id: interaction.user.id,
        type: "Jurídico",
        status: "Solicitado",
      });
    } catch {}

    // Envia card para canal de LOG (mesmo canal do fluxo de registro)
    const chFicha = await interaction.client.channels.fetch(
      process.env.FICHAS_SETAGEM_CHANNEL_ID
    );
    const embed = new EmbedBuilder()
      .setTitle("⚖️ Solicitação Jurídica")
      .setColor(0x1e90ff)
      .setDescription(
        `👤 **Discord:** ${interaction.user}\n` +
          `🧾 **Nome:** ${name}\n` +
          `🪪 **ID (passaporte):** ${pid}`
      )
      .setFooter({ text: "Aguardando aprovação do Jurídico" })
      .setTimestamp();

    const encName = encodeURIComponent(name);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDs.APPROVE}:${interaction.user.id}:${pid}:${encName}`) // jur:approve:<userId>:<pid>:<encName>
        .setLabel("Aprovar")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDs.REJECT}:${interaction.user.id}:${pid}:${encName}`) // jur:reject:<userId>:<pid>:<encName>
        .setLabel("Reprovar")
        .setStyle(ButtonStyle.Danger)
    );

    const ignore = new ButtonBuilder()
      .setCustomId("ignore")
      .setLabel("Ignorar")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    row.addComponents(ignore);

    await chFicha.send({ embeds: [embed], components: [row] });

    return interaction.reply({
      content: "✅ **REGISTRO ENVIADO COM SUCESSO!**",
      ephemeral: true,
    });
  },

  // Aprovar Jurídico → remove EST/AGT3, adiciona JUR + PF + MEMBRO, define nick, API e log
  async onApprove(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith(IDs.APPROVE))
      return;
    if (!ROLE_JUR) {
      return interaction.reply({
        content: "⚠️ ROLE_JURIDICO_ID não configurado.",
        ephemeral: true,
      });
    }

    // Permissão: ManageRoles OU ROLE_RECRUITER
    const can =
      interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
      (ROLE_RECRUITER && interaction.member.roles.cache.has(ROLE_RECRUITER));
    if (!can) {
      return interaction.reply({
        content: "❌ Sem permissão para aprovar.",
        ephemeral: true,
      });
    }

    // Feedback imediato (Pensando…)
    // Silencioso
    try {
      await interaction.deferUpdate();
    } catch {}

    // customId = "jur:approve:<userId>:<pid>:<encName>"
    const a = interaction.customId.split(":");
    const userId = a[2];
    const pid = a[3];
    const name = decodeURIComponent(a.slice(4).join(":"));

    // aplica roles e apelido
    const member = await interaction.guild.members
      .fetch(userId)
      .catch(() => null);
    if (member) {
      // remove ranks de agente/estagiário
      for (const rid of [ROLE_EST, ROLE_AGT3]) {
        if (!rid) continue;
        try {
          await member.roles.remove(rid);
        } catch {}
      }
      // adiciona Jurídico + PF + Membro
      for (const rid of [ROLE_JUR, ROLE_PF, ROLE_MEMBER]) {
        if (!rid) continue;
        try {
          await member.roles.add(rid);
        } catch {}
      }
      // nickname
      try {
        await member.setNickname(formatNick(name, pid));
      } catch {}

      // DM opcional
      if (process.env.DM_RESULT === "true") {
        try {
          const user = await interaction.client.users.fetch(userId);
          await user.send(
            "✅ Você foi aprovado no Jurídico! Verifique suas permissões no servidor."
          );
        } catch {}
      }
    }

    // API — aprovado
    try {
      await upsertJuridico({ passport: Number(pid), status: "Aprovado" });
    } catch {}

    // Log bonitão
    try {
      const chLog = await interaction.client.channels.fetch(CH_LOG);
      const embed = new EmbedBuilder()
        .setTitle("✅ Jurídico Aprovado")
        .setColor(0x00ff83)
        .setDescription(
          `👤 **Membro:** <@${userId}>\n` +
            `🏷️ **Cargo:** Jurídico\n` +
            `🪪 **ID:** ${pid}\n` +
            `📋 **Aprovado por:** ${interaction.user}`
        )
        .setTimestamp();
      await chLog.send({ embeds: [embed] });
    } catch {}

    // Mensagem final com “Ignorar”
    // Limpa a ficha do canal
    try {
      await interaction.message.delete();
    } catch {}
  },

  // Reprovar Jurídico → API, log, DM e mensagem final com Ignorar
  async onReject(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith(IDs.REJECT))
      return;

    // Permissão: ManageRoles OU ROLE_RECRUITER
    const can =
      interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
      (ROLE_RECRUITER && interaction.member.roles.cache.has(ROLE_RECRUITER));
    if (!can) {
      return interaction.reply({
        content: "❌ Sem permissão para reprovar.",
        ephemeral: true,
      });
    }

    // feedback “Pensando…”
    // Silencioso
    try {
      await interaction.deferUpdate();
    } catch {}

    // customId = "jur:reject:<userId>:<pid>:<encName>"
    const r = interaction.customId.split(":");
    const userId = r[2];
    const pid = r[3];
    const name = decodeURIComponent(r.slice(4).join(":"));

    // API — reprovado
    try {
      await upsertJuridico({ passport: Number(pid), status: "Reprovado" });
    } catch {}

    // Log (embed)
    try {
      const chLog = await interaction.client.channels.fetch(CH_LOG);
      const embed = new EmbedBuilder()
        .setTitle("❌ Jurídico Reprovado")
        .setColor(0xff4d4d)
        .setDescription(
          `👤 **Solicitante:** <@${userId}> (${name})\n` +
            `🪪 **ID:** ${pid}\n` +
            `📋 **Reprovado por:** ${interaction.user}`
        )
        .setTimestamp();
      await chLog.send({ embeds: [embed] });
    } catch {}

    // DM opcional
    if (process.env.DM_RESULT === "true") {
      try {
        const user = await interaction.client.users.fetch(userId);
        await user.send("❌ Sua solicitação de Jurídico foi reprovada.");
      } catch {}
    }

    // Limpa a ficha do canal
    try {
      await interaction.message.delete();
    } catch {}
  },
};
