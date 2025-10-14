// src/commands/rank.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getMonthlyRank } = require("../lib/api");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Exibe ranking mensal (top 10 por padrão)")
    .addIntegerOption((o) =>
      o
        .setName("limit")
        .setDescription("Quantidade (1-25)")
        .setMinValue(1)
        .setMaxValue(25)
    ),
  async execute(interaction) {
    await interaction.deferReply();
    const limit = interaction.options.getInteger("limit") ?? 10;

    try {
      const payload = await getMonthlyRank(limit);
      const arr = payload?.data ?? []; // [{ nome, passport, nota, cargo }, ...]
      if (!arr.length) {
        return interaction.editReply("Sem dados de ranking para este mês.");
      }

      const lines = arr
        .map((r, i) => {
          const pos = String(i + 1).padStart(2, "0");
          return `**${pos}.** ${r.nome || "-"} — passaporte \`${
            r.passport
          }\` — nota **${r.nota ?? "-"}** ${r.cargo ? `(${r.cargo})` : ""}`;
        })
        .join("\n");

      const embed = new EmbedBuilder()
        .setTitle("🏆 Ranking Mensal")
        .setDescription(lines)
        .setFooter({ text: `Fonte: ${process.env.API_BASE}/api/recruits/rank` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply("⚠️ Erro ao buscar ranking na API.");
    }
  },
};
