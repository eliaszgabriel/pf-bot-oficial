// features/registro.js (ESM, API-only, compatível com seu .env)
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { upsertRecruit } from "../helpers/api.js";

// ====== mapeamento do seu .env ======
const CH_SOLICITAR = process.env.SOLICITAR_SET_CHANNEL_ID;
const CH_FICHAS = process.env.FICHAS_SETAGEM_CHANNEL_ID;
const CH_LOG = process.env.LOG_SETAGEM_CHANNEL_ID;

const ROLE_PF = process.env.ROLE_PF_ID;
const ROLE_MEMBER = process.env.ROLE_MEMBER_ID;
const ROLE_CURSOS = process.env.ROLE_CURSOS_PENDENTES_ID;

const ROLE_EST = process.env.ROLE_ESTAGIARIO_ID || process.env.ROLE_ESTG_ID;
const ROLE_AGT3 = process.env.ROLE_AGT3_ID;

const ROLE_RECRUITER = process.env.RECRUITER_ROLE_ID;

// ====== IDs estáticos usados nos customId ======
const IDs = {
  SELECT_RECRUITER: "reg:selectRecruiter",
  OPEN_MODAL: "reg:openModal",
  MODAL_ID: "reg:modal",
  APPROVE: "reg:approve",
  REJECT: "reg:reject",
  CARGO_SELECT: "reg:cargoSelect",
};

// ====== helpers ======
const cargoTag = (v) => (v === "AGT3" ? "AGT 3" : "EST");
const cargoRole = (v) => (v === "AGT3" ? ROLE_AGT3 : ROLE_EST);
const rankRoles = () => [ROLE_EST, ROLE_AGT3].filter(Boolean);

function formatNick(prefix, name, id) {
  const pre = `[${prefix}] `;
  const suf = ` | ${id}`;
  const max = 32 - pre.length - suf.length; // Discord limita nickname a 32
  return `${pre}${(name || "").slice(0, Math.max(0, max))}${suf}`;
}

export default {
  // 1) Abre o fluxo: seletor de recrutador + botão "Abrir formulário"
  async start(interaction) {
    if ((process.env.FEATURE_REGISTRO || "on") !== "on") {
      return interaction.reply({
        content: "Registro desativado.",
        ephemeral: true,
      });
    }

    const select = new UserSelectMenuBuilder()
      .setCustomId(IDs.SELECT_RECRUITER)
      .setPlaceholder("Quem te recrutou?")
      .setMinValues(1)
      .setMaxValues(1);

    const rowSelect = new ActionRowBuilder().addComponents(select);
    const rowBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDs.OPEN_MODAL) // habilitaremos depois com o recrutador embutido
        .setLabel("Abrir formulário")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true)
    );

    await interaction.reply({
      content:
        "📝 **Registro de Recrutado**\nSelecione o **recrutador** e depois clique em **Abrir formulário**.",
      components: [rowSelect, rowBtn],
      ephemeral: true,
    });
  },

  // 2) Após escolher o recrutador, habilita o botão "Abrir formulário"
  async onUserSelect(interaction) {
    if (interaction.customId !== IDs.SELECT_RECRUITER) return;
    const recruiterId = interaction.values[0];

    const rowBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDs.OPEN_MODAL}:${recruiterId}`) // reg:openModal:<recruiterId>
        .setLabel("Abrir formulário")
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.update({
      content: `👤 Recrutador selecionado: <@${recruiterId}>. Clique em **Abrir formulário**.`,
      components: [interaction.message.components[0], rowBtn],
    });
  },

  // 3) Cria o modal com Nome + ID, preservando o recruiterId no customId
  async onOpenModal(interaction) {
    if (
      !interaction.customId ||
      !interaction.customId.startsWith(IDs.OPEN_MODAL)
    )
      return;
    const recruiterId = interaction.customId.split(":")[2]; // reg:openModal:<recruiterId>

    const modal = new ModalBuilder()
      .setCustomId(`${IDs.MODAL_ID}:${recruiterId}`) // reg:modal:<recruiterId>
      .setTitle("Solicitação de Registro");

    const iNome = new TextInputBuilder()
      .setCustomId("nome")
      .setLabel("Nome")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20);

    const iId = new TextInputBuilder()
      .setCustomId("pid")
      .setLabel("ID (passaporte)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    modal.addComponents(
      new ActionRowBuilder().addComponents(iNome),
      new ActionRowBuilder().addComponents(iId)
    );

    await interaction.showModal(modal);
  },

  // 4) Recebe o modal → cria card em #fichas-setagem + salva "Pendente" na API
  async onModalSubmit(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith(IDs.MODAL_ID))
      return;

    // customId do modal: "reg:modal:<recruiterId>"
    const parts = String(interaction.customId).split(":");
    const recruiterId = parts[2] || null;

    let name = (interaction.fields.getTextInputValue("nome") || "").trim();
    const pid = (interaction.fields.getTextInputValue("pid") || "").trim();
    name = name.replace(/\s+/g, " ").slice(0, 20);

    if (!/^\d{1,10}$/.test(pid)) {
      return interaction.reply({ content: "❌ ID inválido.", ephemeral: true });
    }

    // Tag do recrutador (se houver)
    let recruiterTag = recruiterId;
    if (recruiterId) {
      const recMember = await interaction.guild.members
        .fetch(recruiterId)
        .catch(() => null);
      recruiterTag = recMember?.user?.tag || recruiterId;
    }

    // API — status "Pendente"
    try {
      await upsertRecruit({
        passport: Number(pid),
        name,
        discord_id: interaction.user.id,
        recruiter_id: recruiterId || "",
        recruiter_name: recruiterTag || "",
        status: "Pendente",
        cargo: "",
      });
    } catch (e) {
      console.warn(
        "[registro.onModalSubmit] upsertRecruit falhou:",
        e?.message
      );
    }

    // Envia card para #fichas-setagem
    const chFicha = await interaction.client.channels.fetch(CH_FICHAS);

    const embed = new EmbedBuilder()
      .setTitle("🆕 Novo Registro Recebido")
      .setColor(0x1e90ff)
      .setDescription(
        `👤 **Discord:** ${interaction.user}\n` +
          `🧾 **Nome:** ${name}\n` +
          `🪪 **ID (passaporte):** ${pid}\n` +
          `🧑‍✈️ **Recrutador:** ${recruiterId ? `<@${recruiterId}>` : "—"}`
      )
      .setFooter({ text: "Aguardando aprovação" })
      .setTimestamp();

    // IMPORTANTE: encode do nome para não quebrar customId com ":"
    const encName = encodeURIComponent(name);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDs.APPROVE}:${interaction.user.id}:${pid}:${encName}`) // reg:approve:<userId>:<pid>:<encName>
        .setLabel("Aprovar")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDs.REJECT}:${interaction.user.id}:${pid}:${encName}`) // reg:reject:<userId>:<pid>:<encName>
        .setLabel("Reprovar")
        .setStyle(ButtonStyle.Danger)
    );

    await chFicha.send({ embeds: [embed], components: [row] });
    return interaction.reply({
      content: "✅ **REGISTRO ENVIADO COM SUCESSO!**",
      ephemeral: true,
    });
  },

  // 5) Clicou em "Aprovar" → mostra select de cargo e propaga os dados corretamente
  async onApprove(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith(IDs.APPROVE))
      return;

    const can =
      interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
      (ROLE_RECRUITER && interaction.member.roles.cache.has(ROLE_RECRUITER));
    if (!can)
      return interaction.reply({
        content: "❌ Sem permissão para aprovar.",
        ephemeral: true,
      });

    // Aqui é rápido: pode manter update. Se quiser blindar:
    // try { await interaction.deferUpdate(); } catch {}
    // ...e depois interaction.message.edit({ components: [ ...select... ] })

    const a = interaction.customId.split(":");
    const userId = a[2];
    const pid = a[3];
    const encName = a.slice(4).join(":");

    const select = new StringSelectMenuBuilder()
      .setCustomId(`${IDs.CARGO_SELECT}:${userId}:${pid}:${encName}`)
      .setPlaceholder("Selecione o cargo do membro")
      .addOptions(
        { label: "🧑‍✈️ Agente 3ª Classe", value: "AGT3" },
        { label: "🎓 Estagiário", value: "EST" }
      );

    return interaction.update({
      content: "Selecione o cargo:",
      components: [new ActionRowBuilder().addComponents(select)],
      embeds: [],
    });
  },

  // 6) Selecionou o cargo → aplica roles, nickname, API "Aprovado" e log
  async onCargoSelect(interaction) {
    if (
      !interaction.customId ||
      !interaction.customId.startsWith(IDs.CARGO_SELECT)
    )
      return;

    // ✅ feedback instantâneo: desabilita o select e mostra "Pensando..."
    // Silencioso: confirma o clique sem alterar a mensagem no canal
    try {
      await interaction.deferUpdate();
    } catch {}

    // Evita expirar a interação (erro 10062)

    // customId: "reg:cargoSelect:<userId>:<pid>:<encName>"
    const c = interaction.customId.split(":");
    const userId = c[2];
    const pid = c[3];
    const name = decodeURIComponent(c.slice(4).join(":"));
    const cargoVal = interaction.values[0]; // 'AGT3' | 'EST'

    // Aplica roles + nickname
    const member = await interaction.guild.members
      .fetch(userId)
      .catch(() => null);
    if (member) {
      // remove ranks anteriores
      for (const r of rankRoles()) {
        try {
          await member.roles.remove(r);
        } catch {}
      }

      // adiciona rank + PF + Membro + Cursos Pendentes
      const adds = [
        cargoRole(cargoVal),
        ROLE_PF,
        ROLE_MEMBER,
        ROLE_CURSOS,
      ].filter(Boolean);
      for (const rid of adds) {
        try {
          await member.roles.add(rid);
        } catch {}
      }

      // nickname
      const nick = formatNick(cargoTag(cargoVal), name, pid);
      try {
        await member.setNickname(nick);
      } catch {}

      // DM opcional
      if (process.env.DM_RESULT === "true") {
        try {
          const user = await interaction.client.users.fetch(userId);
          await user.send(
            "✅ Você foi aprovado! Aguarde as próximas instruções no servidor."
          );
        } catch {}
      }
    }

    // API — status Aprovado
    try {
      await upsertRecruit({
        passport: Number(pid),
        status: "Aprovado",
        cargo: cargoTag(cargoVal),
      });
    } catch (e) {
      console.warn("[registro.onCargoSelect] upsertRecruit:", e?.message);
    }

    // Log
    try {
      const chLog = await interaction.client.channels.fetch(CH_LOG);
      const embed = new EmbedBuilder()
        .setTitle("✅ Registro Aprovado")
        .setColor(0x00ff83)
        .setDescription(
          `👤 **Membro:** <@${userId}>\n` +
            `🏷️ **Cargo:** ${cargoTag(cargoVal)}\n` +
            `🪪 **ID:** ${pid}\n` +
            `📋 **Aprovado por:** ${interaction.user}`
        )
        .setTimestamp();
      await chLog.send({ embeds: [embed] });
    } catch {}

    // Em vez de interaction.update(...), edita a mensagem original
    // Limpa a ficha do canal para não poluir
    try {
      await interaction.message.delete();
    } catch {}
  },

  // 7) Clicou em "Reprovar" → API "Reprovado" + log + DM
  async onReject(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith(IDs.REJECT))
      return;

    // Silencioso
    try {
      await interaction.deferUpdate();
    } catch {}

    // ✅ Agrade de imediato
    try {
      await interaction.deferUpdate();
    } catch {}

    const can =
      interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) ||
      (ROLE_RECRUITER && interaction.member.roles.cache.has(ROLE_RECRUITER));
    if (!can) {
      // não dá pra reply depois do deferUpdate; manda um followUp no canal de log
      try {
        const chLog = await interaction.client.channels.fetch(CH_LOG);
        await chLog.send(
          `⚠️ ${interaction.user} tentou reprovar sem permissão.`
        );
      } catch {}
      return;
    }

    // customId: "reg:reject:<userId>:<pid>:<encName>"
    const r = interaction.customId.split(":");
    const userId = r[2];
    const pid = r[3];
    const name = decodeURIComponent(r.slice(4).join(":"));

    // API — Reprovado
    try {
      await upsertRecruit({
        passport: Number(pid),
        status: "Reprovado",
        cargo: "",
      });
    } catch {}

    // Log
    try {
      const chLog = await interaction.client.channels.fetch(CH_LOG);
      const embed = new EmbedBuilder()
        .setTitle("❌ Registro Reprovado")
        .setColor(0xff4d4d)
        .setDescription(
          `👤 **Recrutado:** <@${userId}> (${name})\n` +
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
        await user.send(
          "❌ Seu registro foi reprovado. Procure o recrutamento para tentar novamente."
        );
      } catch {}
    }

    // ✅ Em vez de interaction.update(...), edita a mensagem original
    try {
      await interaction.message.delete();
    } catch {}
  },
};
