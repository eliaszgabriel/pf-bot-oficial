// features/menu.js (ESM)
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export const MENU_IDS = {
  BTN_OPEN_REG: "menu:openReg",
  BTN_OPEN_JUR: "menu:openJur",
};

export default {
  async postAndPin(client) {
    const ch = await client.channels.fetch(
      process.env.SOLICITAR_SET_CHANNEL_ID
    );
    const embed = new EmbedBuilder()
      .setTitle("SISTEMA DE REGISTRO")
      .setDescription(
        "Utilize o botão abaixo para **abrir o menu de registro**.\n" +
          "Após enviar o seu registro, aguarde um administrador aprová-lo.\n" +
          "Quando for aprovado, você será notificado no **privado** (deixe as DMs abertas)."
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(MENU_IDS.BTN_OPEN_REG)
        .setLabel("Registro")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🪪"),
      new ButtonBuilder()
        .setCustomId(MENU_IDS.BTN_OPEN_JUR)
        .setLabel("Jurídico")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("⚖️")
    );

    const msg = await ch.send({ embeds: [embed], components: [row] });
    await msg.pin().catch(() => {});
    return msg.id;
  },

  async onClick(interaction) {
    if (interaction.customId === MENU_IDS.BTN_OPEN_REG) {
      return interaction.client.features.registro.start(interaction);
    }
    if (interaction.customId === MENU_IDS.BTN_OPEN_JUR) {
      return interaction.client.features.juridico.start(interaction);
    }
  },
};
