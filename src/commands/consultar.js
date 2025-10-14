// src/commands/consultar.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getRecruitByPassport } = require("../lib/api");
const { applyRecruitRules } = require("../lib/applyRules");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("consultar")
    .setDescription("Consulta candidato/recruta pelo passaporte")
    .addIntegerOption((o) =>
      o
        .setName("passport")
        .setDescription("Número do passaporte")
        .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const passport = interaction.options.getInteger("passport");
    try {
      const payload = await getRecruitByPassport(passport);
      if (!payload?.data) {
        return interaction.editReply(
          `❌ Não encontrei o passaporte **${passport}**.`
        );
      }
      const r = payload.data; // { nome, status, cargo, nota, photo_path, passport }
      const embed = new EmbedBuilder()
        .setTitle("📋 Consulta de Recruta")
        .setDescription(
          `**Nome:** ${r.nome || "-"}\n**Passaporte:** ${
            r.passport
          }\n**Status:** ${r.status}\n**Cargo:** ${r.cargo || "-"}\n**Nota:** ${
            r.nota ?? "-"
          }\n**Foto:** ${r.photo_path ? "`anexada/armazenada`" : "—"}`
        )
        .setFooter({ text: "BOT ↔ API" })
        .setTimestamp();

      // Tentar achar o membro pelo usuário que executou / pelo guild (casos reais variam):
      const guild = interaction.guild;
      const logCh = process.env.RECRUIT_LOG_CHANNEL_ID
        ? await guild.channels
            .fetch(process.env.RECRUIT_LOG_CHANNEL_ID)
            .catch(() => null)
        : null;

      // Tentativa de localizar membro pelo formato atual (nick com | passport)
      // Fallback: se mencionado, etc. Para agora, tentamos por nickname.
      const members = await guild.members.fetch();
      const member = members.find((m) =>
        m.displayName.endsWith(`| ${r.passport}`)
      );

      if (member) {
        await applyRecruitRules({
          guild,
          member,
          recruit: r,
          logChannel: logCh,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(
        "⚠️ Erro ao consultar na API. Verifique API_BASE/API_TOKEN e o passaporte."
      );
    }
  },
};
