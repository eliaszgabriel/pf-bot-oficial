import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  Events,
  Routes,
  MessageFlags,
  AttachmentBuilder,
} from "discord.js";
import { InteractionResponseType } from "discord-api-types/v10";
import {
  insertRecruit,
  getRecruitsByDiscordId,
  getRecruitCountsByDay,
  getRecruitCountsByMonth,
  db, // reusamos o mesmo SQLite
} from "./db.js";
// ---- Safe helper: check if a table has a given column (prevents "no such column") ----
function hasColumn(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table});`).all();
    return rows.some(r => r.name === column);
  } catch (e) {
    return false;
  }
}

/* ================== ENV ================== */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  RECRUIT_CHANNEL_ID,
  RECRUIT_LOG_CHANNEL_ID,
  ROLE_APROVADO_ID,
  ROLE_REPROVADO_ID,
  ROLE_DIRETOR_ID,
  ROLE_SUBDIRETOR_ID,
  ROLE_RECRUTADOR_ID, // 👈 ADICIONADO

  // disciplina
  EXON_LOG_CHANNEL_ID,
  BLACKLIST_LOG_CHANNEL_ID,
  DISCIPLINE_ROLE_IDS,
} = process.env;

const DM_RESULT = (process.env.DM_RESULT || "false").toLowerCase() === "true";

// TTLs (ms) para apagar mensagens efêmeras automaticamente
const TTL_PICK = Number(process.env.TTL_PICK_MS ?? 10000);
const TTL_PASSPORT_OK = Number(process.env.TTL_PASSPORT_OK_MS ?? 10000);
const TTL_PHOTO_PROMPT = Number(process.env.TTL_PHOTO_PROMPT_MS ?? 20000);
const TTL_PHOTO_OK = Number(process.env.TTL_PHOTO_OK_MS ?? 10000);

/* ============ Discord Client ============ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ============ Painel fixado ============ */
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🗂️ Painel de Recrutamento")
    .setDescription(
      "Use os atalhos abaixo para facilitar o fluxo:\n" +
        "• **Recrutar** → selecione o conscrito, **defina o passaporte**, depois preencha os modais (foto é opcional, basta enviar no chat)\n" +
        "• **Consultar Passaporte** → digite o número e veja status/histórico\n" +
        "• **Ranking de Recrutadores** → informe data e escopo\n" +
        "• **Exonerar/Blacklist** → ações disciplinares (somente diretoria)"
    )
    .setColor(0x0ea5e9);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("atalho_recrutar")
      .setLabel("Recrutar")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("passaporte:open")
      .setLabel("Consultar Passaporte")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("atalho_ranking")
      .setLabel("Ranking Recrutadores")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("disc:open:exon")
      .setLabel("Exonerar")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("disc:open:black")
      .setLabel("Blacklist")
      .setStyle(ButtonStyle.Danger)
  );

  return { embed, row };
}

async function ensurePanelPinned(client, channelId) {
  if (!channelId) {
    console.warn(
      "RECRUIT_CHANNEL_ID não definido; pulando ensurePanelPinned()"
    );
    return;
  }
  const channel = await client.channels.fetch(channelId);
  const pinned = await channel.messages.fetchPinned().catch(() => null);
  const mine = pinned?.filter(
    (m) =>
      m.author?.id === client.user.id &&
      m.embeds?.[0]?.title === "🗂️ Painel de Recrutamento"
  );

  if (mine && mine.size >= 1) {
    const msg = mine.first();
    const { embed, row } = buildPanelMessage();
    await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
    if (mine.size > 1) {
      for (const extra of mine.toJSON().slice(1)) {
        await extra.unpin().catch(() => {});
      }
    }
    return;
  }

  const { embed, row } = buildPanelMessage();
  const newMsg = await channel.send({ embeds: [embed], components: [row] });
  await newMsg.pin().catch(() => {});
}

/* ============ SQLite disciplinar extra ============ */
db.exec(`
CREATE TABLE IF NOT EXISTS exonerations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  passport TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exon_user ON exonerations(user_id);
CREATE INDEX IF NOT EXISTS idx_exon_passport ON exonerations(passport);

CREATE TABLE IF NOT EXISTS blacklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  passport TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_black_user ON blacklists(user_id);
CREATE INDEX IF NOT EXISTS idx_black_passport ON blacklists(passport);

CREATE TABLE IF NOT EXISTS passport_recruits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passport TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recruiter_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  classification TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_passport_recruits_pass ON passport_recruits(passport);
`);

/* ---------- [ADICIONAL] Tabela recruits p/ /syncaprovados ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS recruits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  passport TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
if (hasColumn('recruits', 'passport')) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recruits_passport_norm
    ON recruits (lower(replace(trim(passport), ' ', '')));
  `);
} else {
  console.warn("[DB] recruits.passport não existe — índice não criado.");
}
`);

/* ============ Express (health) ============ */
const app = express();
app.use(bodyParser.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(3000, () => console.log("🌐 API interna ouvindo em :3000"));

/* ============ Helpers gerais ============ */

// apaga uma mensagem efêmera criada por ESTE interaction após ttlMs
async function autoDeleteEphemeral(ix, message, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return;
  setTimeout(() => {
    ix.webhook?.deleteMessage(message).catch(() => {});
  }, ttlMs);
}

// disciplina
const canDiscipline = (member) => {
  const ids = (DISCIPLINE_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return false;
  return member?.roles?.cache?.some((r) => ids.includes(r.id));
};
async function logToChannel(channelId, embed) {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send({ embeds: [embed] });
  } catch {}
}

// 👇 PERMISSÃO: quem pode recrutar/usar ranking
function canRecruit(member) {
  if (!ROLE_RECRUTADOR_ID) return true; // se não configurado, não bloqueia
  return member?.roles?.cache?.has(ROLE_RECRUTADOR_ID);
}

// ====== Sistema de Pontuação / Regras ======
function pontosCodigosQ(v) {
  return [0, 6, 9, 12][v] ?? 0;
}
function pontosPatrulha(v) {
  return [0, 5, 8, 10][v] ?? 0;
}
function pontosFuncoesPx(v) {
  return [0, 6, 10][v] ?? 0;
}
function pontosBin6(v) {
  return [0, 6][v] ?? 0;
}
function pontosBin8(v) {
  return [0, 8][v] ?? 0;
}
function pontosMod14(v) {
  return [0, 6, 10, 14][v] ?? 0;
}
function pontosCaixa2(v) {
  return [0, 3, 6][v] ?? 0;
}
function pontosAbordagem(v) {
  return [0, 3, 6][v] ?? 0;
}

const labelCodigosQ = (v) =>
  ["Não soube nenhum", "Acertou 3", "Acertou 5", "Acertou todos"][v] ?? "—";
const labelPatrulha = (v) =>
  ["≤1", "Acertou 3", "Acertou 5", "Acertou todos"][v] ?? "—";
const labelFuncoesP = (v) => ["Não sabe", "Média", "Todas"][v] ?? "—";
const labelBin = (v) => ["Não sabe", "Acertou"][v] ?? "—";
const labelMod = (v) => ["Péssima", "Ruim", "Média", "Perfeita"][v] ?? "—";
const labelCaixa2 = (v) => ["Não sabe", "Aproximada", "Correta"][v] ?? "—";
const labelAbord = (v) => ["Não sabe", "Média", "Correta"][v] ?? "—";

function calculaNotaCategorias(a) {
  const m0 = Number(a.mod_codigo0) || 0;
  const m1 = Number(a.mod_disparos) || 0;
  const m2 = Number(a.mod_acompanhamento) || 0;
  const autoFail = m0 === 0 || m1 === 0 || m2 === 0;

  const total =
    pontosCodigosQ(Number(a.codigos_q) || 0) +
    pontosPatrulha(Number(a.codigos_patrulha) || 0) +
    pontosFuncoesPx(Number(a.funcoes_p) || 0) +
    pontosBin6(Number(a.rev_sexo_oposto) || 0) +
    pontosBin8(Number(a.lei_miranda) || 0) +
    pontosMod14(m0) +
    pontosMod14(m1) +
    pontosMod14(m2) +
    pontosCaixa2(Number(a.caixa2) || 0) +
    pontosAbordagem(Number(a.abordagem) || 0);

  return { total, autoFail };
}

const CLASS_REPROVADO = "Reprovado";
const CLASS_ESTAGIARIO = "Estagiario";
const CLASS_AGENTE3 = "Agente de 3 classe";

function decidirClassificacao(total, autoFail) {
  if (autoFail || total < 43)
    return { classificacao: CLASS_REPROVADO, aprovado: false };
  if (total <= 75) return { classificacao: CLASS_ESTAGIARIO, aprovado: true };
  return { classificacao: CLASS_AGENTE3, aprovado: true };
}

// ===== UI helpers =====
const clamp = (s, n = 45) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const makeInput = (id, shortLabel, placeholder, max = 1) =>
  new TextInputBuilder()
    .setCustomId(id)
    .setLabel(clamp(shortLabel))
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(max)
    .setRequired(true);

async function showModalSafe(ix, modal) {
  if (typeof ix.showModal === "function") return ix.showModal(modal);
  return ix.client.rest.post(Routes.interactionCallback(ix.id, ix.token), {
    body: { type: InteractionResponseType.Modal, data: modal.toJSON() },
  });
}

/* ============ Cache simples ============ */
const tempMap = new Map();

/* ============ [ADICIONAL] Helpers: apelido/passaporte + setter por TAG ============ */

// Passaporte no final do apelido: "... | 12345"
function extractPassportStrict(displayName = "") {
  const m = displayName.match(/\|\s*(\d{1,7})\s*$/);
  return m ? Number(m[1]) : null;
}
// Tag no começo do apelido: "[EST] Nome | 1234", "[AGT 3] ..."
function extractBracketTag(displayName = "") {
  const m = displayName.match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim() : null; // "EST" ou "AGT 3"
}

// Toggle em memória para set de cargo por TAG
let roleSetterEnabled = (process.env.ROLE_SETTER_ENABLED || "0") === "1";
const { ROLE_ESTAGIARIO_ID, ROLE_AGT3_ID } = process.env;
const TAG_ROLE_MAP = { EST: ROLE_ESTAGIARIO_ID, "AGT 3": ROLE_AGT3_ID };

async function applyRoleFromNickname(member) {
  if (!roleSetterEnabled) return { changed: false, reason: "disabled" };
  const name = member.displayName || member.user.username;
  const tag = extractBracketTag(name);
  const wanted = tag ? TAG_ROLE_MAP[tag] : null;
  if (!wanted) return { changed: false, reason: "no_match" };

  const toAdd = member.roles.cache.has(wanted) ? [] : [wanted];
  const toRemove = [ROLE_ESTAGIARIO_ID, ROLE_AGT3_ID]
    .filter(Boolean)
    .filter((rid) => rid !== wanted && member.roles.cache.has(rid));

  for (const rid of toAdd) await member.roles.add(rid).catch(() => {});
  for (const rid of toRemove) await member.roles.remove(rid).catch(() => {});
  return { changed: toAdd.length + toRemove.length > 0, tag, wanted };
}

/* ============ Ready & Login ============ */
client.once("ready", async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await ensurePanelPinned(client, process.env.RECRUIT_CHANNEL_ID);
  try {
    const g = await client.guilds.fetch(GUILD_ID);
    const name = (id) => g.roles.cache.get(id)?.name || "N/A";
    console.log("🧭 Mapeamento de cargos:");
    console.log(
      "  ROLE_REPROVADO_ID  ->",
      ROLE_REPROVADO_ID,
      name(ROLE_REPROVADO_ID)
    );
    console.log(
      "  ROLE_APROVADO_ID   ->",
      ROLE_APROVADO_ID,
      name(ROLE_APROVADO_ID)
    );
    if (ROLE_RECRUTADOR_ID) {
      console.log(
        "  ROLE_RECRUTADOR_ID ->",
        ROLE_RECRUTADOR_ID,
        name(ROLE_RECRUTADOR_ID)
      );
    } else {
      console.warn(
        "⚠️ ROLE_RECRUTADOR_ID não configurado — recrutamento/ranking liberados."
      );
    }
  } catch (e) {
    console.error("Falha ao ler cargos do guild:", e);
  }
});
await client.login(DISCORD_TOKEN);

/* ============ Interactions ============ */
client.on(Events.InteractionCreate, async (ix) => {
  try {
    /* ---------- /painel ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "painel") {
      if (RECRUIT_CHANNEL_ID && ix.channelId !== RECRUIT_CHANNEL_ID) {
        return ix.reply({
          content: `⚠️ Use este comando apenas em <#${RECRUIT_CHANNEL_ID}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const { embed, row } = buildPanelMessage();
      return ix.reply({ embeds: [embed], components: [row] });
    }

    /* ---------- [NOVO] /rolesetter (toggle do setter por TAG) ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "rolesetter") {
      const enable = ix.options.getBoolean("enable", true);
      roleSetterEnabled = !!enable;
      return ix.reply({
        content: `Role Setter por TAG: **${
          roleSetterEnabled ? "LIGADO" : "DESLIGADO"
        }**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    /* ---------- [NOVO] /setapelido → abre modal (Passaporte → Nome) ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "setapelido") {
      const alvo = ix.options.getUser("alvo", true);
      const tag = ix.options.getString("tag", true); // "EST" | "AGT 3"

      const modal = new ModalBuilder()
        .setCustomId(`modal_setapelido:${alvo.id}:${tag}`)
        .setTitle("Definir apelido");

      const passaporteInput = new TextInputBuilder()
        .setCustomId("passaporte")
        .setLabel("Passaporte (ex.: 1234)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const nomeInput = new TextInputBuilder()
        .setCustomId("nome")
        .setLabel("Nome (ex.: Elias)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const row1 = new ActionRowBuilder().addComponents(passaporteInput);
      const row2 = new ActionRowBuilder().addComponents(nomeInput);
      modal.addComponents(row1, row2);

      return showModalSafe(ix, modal);
    }

    /* ---------- [NOVO] /setapelido (submit) → define apelido + ajusta cargo (se ligado) ---------- */
    if (ix.isModalSubmit() && ix.customId.startsWith("modal_setapelido:")) {
      await ix.deferReply({ flags: MessageFlags.Ephemeral });
      const [, alvoId, tag] = ix.customId.split(":");
      const passRaw = (ix.fields.getTextInputValue("passaporte") || "").trim();
      const nomeRaw = (ix.fields.getTextInputValue("nome") || "").trim();

      if (!/^\d{1,7}$/.test(passRaw)) {
        return ix.editReply(
          "❌ Informe um **passaporte numérico** (1–7 dígitos)."
        );
      }
      if (!nomeRaw) {
        return ix.editReply("❌ Informe um **nome** válido.");
      }

      const member = await ix.guild.members.fetch(alvoId).catch(() => null);
      if (!member)
        return ix.editReply("❌ Não consegui localizar o membro no servidor.");

      const apelido = `[${tag}] ${nomeRaw} | ${passRaw}`;
      try {
        await member.setNickname(apelido, `Setado por ${ix.user.tag}`);
      } catch {
        return ix.editReply(
          "⚠️ Não consegui alterar o apelido (verifique permissões/ordem dos cargos)."
        );
      }

      const res = await applyRoleFromNickname(member).catch(() => ({
        changed: false,
      }));
      return ix.editReply(
        `✅ Apelido definido: **${apelido}**\n` +
          `🔧 Cargos: ${
            res.changed ? "ajustados" : "mantidos / recurso desligado"
          }`
      );
    }

    /* ---------- PASSAPORTE (consulta): abrir modal ---------- */
    if (ix.isButton() && ix.customId === "passaporte:open") {
      const modal = new ModalBuilder()
        .setCustomId("passaporte:modal")
        .setTitle("Consultar por Passaporte");

      const input = new TextInputBuilder()
        .setCustomId("numero")
        .setLabel("Número do passaporte (RP)")
        .setPlaceholder("Ex.: 12345")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(16);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return showModalSafe(ix, modal);
    }

    // ---------- ATALHO: botão "Ranking Recrutadores" -> abre modal ----------
    if (ix.isButton() && ix.customId === "atalho_ranking") {
      // 👇 PERMISSÃO
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canRecruit(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para usar este atalho.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("atalho_ranking_modal")
        .setTitle("Ranking — Parâmetros");

      const dataInput = new TextInputBuilder()
        .setCustomId("data")
        .setLabel("Data base (DD/MM/AAAA)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("05/09/2025");

      const escopoInput = new TextInputBuilder()
        .setCustomId("escopo")
        .setLabel("Escopo (dia ou mes)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("dia  |  mes");

      modal.addComponents(
        new ActionRowBuilder().addComponents(dataInput),
        new ActionRowBuilder().addComponents(escopoInput)
      );

      return showModalSafe(ix, modal);
    }

    // ---------- ATALHO: submit do modal de ranking ----------
    if (ix.isModalSubmit() && ix.customId === "atalho_ranking_modal") {
      try {
        await ix.deferReply({ flags: MessageFlags.Ephemeral });

        const dataStr = ix.fields.getTextInputValue("data").trim();
        const escopo = ix.fields
          .getTextInputValue("escopo")
          .trim()
          .toLowerCase();
        if (!["dia", "mes", "mês"].includes(escopo)) {
          return ix.editReply("Escopo inválido. Use **dia** ou **mes**.");
        }
        const esc = escopo.startsWith("m") ? "mes" : "dia";

        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataStr);
        if (!m) {
          return ix.editReply(
            "Formato inválido. Use **DD/MM/AAAA** (ex: 05/09/2025)."
          );
        }
        const [_, dd, mm, yyyy] = m;
        const yyyy_mm_dd = `${yyyy}-${mm}-${dd}`;
        const yyyy_mm = `${yyyy}-${mm}`;

        const rows =
          esc === "dia"
            ? getRecruitCountsByDay(yyyy_mm_dd, 100)
            : getRecruitCountsByMonth(yyyy_mm, 200);

        if (!rows.length) {
          return ix.editReply(
            `Sem registros para **${
              esc === "dia" ? `${dd}/${mm}/${yyyy}` : `${mm}/${yyyy}`
            }**.`
          );
        }

        const guild = await ix.client.guilds.fetch(GUILD_ID);
        await guild.members.fetch();

        // tenta casar nomes com IDs p/ somar corretamente
        const nameToId = new Map();
        for (const mbr of guild.members.cache.values()) {
          const keys = [
            mbr.user.username,
            mbr.displayName,
            mbr.user.tag,
          ].filter(Boolean);
          for (const k of keys) nameToId.set(k.toLowerCase().trim(), mbr.id);
        }

        const agg = new Map();
        for (const r of rows) {
          let id =
            r.recrutador_id && r.recrutador_id !== "" ? r.recrutador_id : null;
          if (!id && r.recrutador) {
            const guess = nameToId.get(r.recrutador.toLowerCase().trim());
            if (guess) id = guess;
          }
          const key = id
            ? `id:${id}`
            : `name:${(r.recrutador || "").toLowerCase().trim()}`;
          const prev = agg.get(key) || {
            id: id || null,
            name: r.recrutador || "(desconhecido)",
            total: 0,
          };
          prev.total += Number(r.total) || 0;
          if (id) {
            const mem = guild.members.cache.get(id);
            prev.name = mem?.displayName || mem?.user?.username || prev.name;
          }
          agg.set(key, prev);
        }

        const merged = [...agg.values()].sort((a, b) => b.total - a.total);
        const totalGeral = merged.reduce((acc, it) => acc + it.total, 0);
        const lines = merged.map((it, i) => {
          const who = it.id ? `<@${it.id}>` : `**${it.name}**`;
          return `${i + 1}. ${who} — **${it.total}** recrutamento(s)`;
        });

        const titulo =
          esc === "dia"
            ? `Ranking de Recrutadores — ${dd}/${mm}/${yyyy}`
            : `Ranking de Recrutadores — ${mm}/${yyyy}`;

        const embed = new EmbedBuilder()
          .setTitle(titulo)
          .setDescription(lines.join("\n"))
          .addFields({
            name: "Total no período",
            value: String(totalGeral),
            inline: false,
          })
          .setColor(0xf39c12);

        return ix.editReply({ embeds: [embed] });
      } catch (e) {
        console.error("atalho_ranking_modal erro:", e);
        return ix.editReply("❌ Erro ao gerar ranking.");
      }
    }

    /* ---------- [NOVO] /syncaprovados → salva nome + passaporte + status=aprovado ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "syncaprovados") {
      const preview = ix.options.getBoolean("preview") ?? true;
      const limit = ix.options.getInteger("limit") ?? null;

      await ix.deferReply({ flags: MessageFlags.Ephemeral });

      const guild = await client.guilds.fetch(GUILD_ID);
      const members = await guild.members.fetch();
      const aprovados = members.filter((m) =>
        m.roles.cache.has(ROLE_APROVADO_ID)
      );
      const arr = limit
        ? aprovados.first(limit)
        : Array.from(aprovados.values());

      if (!arr.length) {
        return ix.editReply("Nenhum membro com cargo **Aprovado** encontrado.");
      }

      if (preview) {
        const linhas = arr
          .slice(0, 25)
          .map((m) => {
            const nome = m.displayName || m.user.username;
            const pass = extractPassportStrict(nome);
            return `• ${nome}  | passaporte=${pass ?? "—"}`;
          })
          .join("\n");

        return ix.editReply(
          `**PREVIEW**: encontrados **${arr.length}** aprovados.\n` +
            (linhas ? `${linhas}\n` : "") +
            `Nada foi gravado. Rode \`/syncaprovados preview:false\` para executar.`
        );
      }

      // UPSERT por passaporte
      let ok = 0,
        fail = 0;
      const stmt = db.prepare(`
        INSERT INTO recruits (nome, passport, status, source, updated_at)
        VALUES (?, ?, 'aprovado', 'sync', datetime('now'))
        ON CONFLICT(passport) DO UPDATE SET
          nome=excluded.nome,
          status='aprovado',
          source='sync',
          updated_at=datetime('now');
      `);

      for (const m of arr) {
        const nome = m.displayName || m.user.username;
        const pass = extractPassportStrict(nome);
        if (!pass) {
          fail++;
          continue;
        }
        try {
          stmt.run(nome, String(pass));
          ok++;
        } catch {
          fail++;
        }
      }

      const summary =
        `✅ Sincronização concluída.\n` +
        `• Total aprovados: **${arr.length}**\n` +
        `• Gravados/atualizados: **${ok}**\n` +
        `• Sem passaporte/falhas: **${fail}**`;

      await ix.editReply(summary);

      if (RECRUIT_LOG_CHANNEL_ID) {
        try {
          const ch = await client.channels.fetch(RECRUIT_LOG_CHANNEL_ID);
          if (ch?.isTextBased())
            await ch.send(`**/syncaprovados** — ${summary}`);
        } catch {}
      }
    }

    /* ---------- PASSAPORTE (consulta): submit ---------- */
    if (ix.isModalSubmit() && ix.customId === "passaporte:modal") {
      try {
        await ix.deferReply({ flags: MessageFlags.Ephemeral });
        const passport = ix.fields.getTextInputValue("numero").trim();

        const history = db
          .prepare(
            `SELECT passport, user_id, recruiter_id, score, classification, status, created_at
             FROM passport_recruits
             WHERE passport = ?
             ORDER BY datetime(created_at) DESC
             LIMIT 5`
          )
          .all(passport);

        const exo = db
          .prepare(
            `SELECT executor_id, reason, created_at
             FROM exonerations
             WHERE passport = ?
             ORDER BY datetime(created_at) DESC
             LIMIT 1`
          )
          .get(passport);

        const bl = db
          .prepare(
            `SELECT executor_id, reason, created_at
             FROM blacklists
             WHERE passport = ?
             ORDER BY datetime(created_at) DESC
             LIMIT 1`
          )
          .get(passport);

        if (!history.length && !exo && !bl) {
          return ix.editReply(
            `Nenhum registro encontrado para o passaporte **${passport}**.`
          );
        }

        const lastUserId = history[0]?.user_id || null;
        const conscritoField = lastUserId
          ? `<@${lastUserId}> (${lastUserId})`
          : "—";

        const histBlock = history.length
          ? history
              .map(
                (r) =>
                  `• ${r.created_at} — **${r.status}** — ${r.score} pts — ${r.classification} — por <@${r.recruiter_id}>`
              )
              .join("\n")
          : "—";

        const embed = new EmbedBuilder()
          .setTitle("🔎 Consulta por Passaporte")
          .addFields(
            { name: "📇 Passaporte", value: passport, inline: true },
            {
              name: "👤 Conscrito (último visto)",
              value: conscritoField,
              inline: true,
            }
          )
          .setColor(0x5865f2)
          .setTimestamp(new Date());

        if (exo) {
          embed.addFields({
            name: "🟥 Exonerado?",
            value: `**Sim** — ${exo.created_at}\nExecutor: <@${exo.executor_id}>\nMotivo: ${exo.reason}`,
            inline: false,
          });
        } else {
          embed.addFields({
            name: "🟥 Exonerado?",
            value: "Não",
            inline: true,
          });
        }

        if (bl) {
          embed.addFields({
            name: "🟥 Blacklist?",
            value: `**Sim** — ${bl.created_at}\nExecutor: <@${bl.executor_id}>\nMotivo: ${bl.reason}`,
            inline: false,
          });
        } else {
          embed.addFields({
            name: "🟥 Blacklist?",
            value: "Não",
            inline: true,
          });
        }

        embed.addFields({
          name: "🗂️ Últimos recrutamentos (até 5)",
          value: histBlock,
          inline: false,
        });

        return ix.editReply({ embeds: [embed] });
      } catch (e) {
        console.error("passaporte:modal erro:", e);
        return ix.editReply("❌ Erro interno na consulta por passaporte.");
      }
    }

    /* ---------- /consultar ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "consultar") {
      try {
        await ix.deferReply({ flags: MessageFlags.Ephemeral });
        const user = ix.options.getUser("usuario", true);
        const limit = ix.options.getInteger("limit") ?? 5;
        const rows = getRecruitsByDiscordId(user.id, limit);

        if (!rows.length)
          return ix.editReply(`Nenhum registro para ${user.tag}.`);

        const lines = rows.map(
          (r) =>
            `• ${r.status} — ${r.nota} pts — ${r.created_at} — por ${r.recrutador}`
        );
        const embed = new EmbedBuilder()
          .setTitle(`Histórico do Conscrito ${user.tag}`)
          .setDescription(lines.join("\n"))
          .setColor(0x3498db);

        return ix.editReply({ embeds: [embed] });
      } catch (e) {
        console.error("/consultar erro:", e);
        return ix.editReply("❌ Erro interno no /consultar.");
      }
    }

    /* ---------- /ranking_recrutadores ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "ranking_recrutadores") {
      // 👇 PERMISSÃO
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canRecruit(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para usar este comando.",
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        await ix.deferReply({ flags: MessageFlags.Ephemeral });

        const dataStr = ix.options.getString("data", true).trim();
        const escopo = ix.options.getString("escopo", true);
        const limit =
          ix.options.getInteger("limit") ?? (escopo === "dia" ? 100 : 200);

        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataStr);
        if (!m)
          return ix.editReply(
            "Formato inválido. Use **DD/MM/AAAA** (ex: 05/09/2025)."
          );
        const [_, dd, mm, yyyy] = m;
        const yyyy_mm_dd = `${yyyy}-${mm}-${dd}`;
        const yyyy_mm = `${yyyy}-${mm}`;

        const rows =
          escopo === "dia"
            ? getRecruitCountsByDay(yyyy_mm_dd, limit)
            : getRecruitCountsByMonth(yyyy_mm, limit);

        if (!rows.length) {
          return ix.editReply(
            `Sem registros para **${
              escopo === "dia" ? dd + "/" + mm + "/" + yyyy : mm + "/" + yyyy
            }**.`
          );
        }

        const guild = await ix.client.guilds.fetch(GUILD_ID);
        await guild.members.fetch();

        const nameToId = new Map();
        for (const mbr of guild.members.cache.values()) {
          const keys = [
            mbr.user.username,
            mbr.displayName,
            mbr.user.tag,
          ].filter(Boolean);
          for (const k of keys) nameToId.set(k.toLowerCase().trim(), mbr.id);
        }

        const agg = new Map();
        for (const r of rows) {
          let id =
            r.recrutador_id && r.recrutador_id !== "" ? r.recrutador_id : null;
          if (!id && r.recrutador) {
            const guess = nameToId.get(r.recrutador.toLowerCase().trim());
            if (guess) id = guess;
          }
          const key = id
            ? `id:${id}`
            : `name:${(r.recrutador || "").toLowerCase().trim()}`;
          const prev = agg.get(key) || {
            id: id || null,
            name: r.recrutador || "(desconhecido)",
            total: 0,
          };
          prev.total += Number(r.total) || 0;
          if (id) {
            const mem = guild.members.cache.get(id);
            prev.name = mem?.displayName || mem?.user?.username || prev.name;
          }
          agg.set(key, prev);
        }

        const merged = [...agg.values()].sort((a, b) => b.total - a.total);
        const totalGeral = merged.reduce((acc, it) => acc + it.total, 0);
        const lines = merged.map((it, i) => {
          const who = it.id ? `<@${it.id}>` : `**${it.name}**`;
          return `${i + 1}. ${who} — **${it.total}** recrutamento(s)`;
        });

        const titulo =
          escopo === "dia"
            ? `Ranking de Recrutadores — ${dd}/${mm}/${yyyy}`
            : `Ranking de Recrutadores — ${mm}/${yyyy}`;

        const embed = new EmbedBuilder()
          .setTitle(titulo)
          .setDescription(lines.join("\n"))
          .addFields({
            name: "Total no período",
            value: String(totalGeral),
            inline: false,
          })
          .setColor(0xf39c12);

        return ix.editReply({ embeds: [embed] });
      } catch (e) {
        console.error("/ranking_recrutadores erro:", e);
        return ix.editReply("❌ Erro interno no /ranking_recrutadores.");
      }
    }

    /* ---------- ATALHO: botão "Recrutar" -> User Select ---------- */
    if (ix.isButton() && ix.customId === "atalho_recrutar") {
      // 👇 PERMISSÃO
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canRecruit(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para recrutar.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId("atalho_pick_conscrito")
          .setPlaceholder("Selecione o conscrito...")
          .setMinValues(1)
          .setMaxValues(1)
      );
      return ix.reply({
        content: "Selecione o conscrito para iniciar o recrutamento:",
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    /* ---------- Também suportar /recrutar criando o mesmo fluxo ---------- */
    if (ix.isChatInputCommand() && ix.commandName === "recrutar") {
      if (RECRUIT_CHANNEL_ID && ix.channelId !== RECRUIT_CHANNEL_ID) {
        return ix.reply({
          content: `⚠️ Use este comando apenas em <#${RECRUIT_CHANNEL_ID}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // 👇 PERMISSÃO
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canRecruit(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para usar /recrutar.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const user = ix.options.getUser("candidato", true);
      const fotoAtt = ix.options.getAttachment("foto"); // opcional

      tempMap.delete(`${ix.user.id}:${user.id}:foto`);
      tempMap.delete(`${ix.user.id}:${user.id}:fotoName`);
      tempMap.delete(`${ix.user.id}:${user.id}:fotoMsgId`);

      if (
        fotoAtt &&
        (fotoAtt.contentType || "").startsWith("image/") &&
        (fotoAtt.size || 0) <= 8 * 1024 * 1024
      ) {
        tempMap.set(`${ix.user.id}:${user.id}:foto`, fotoAtt.url);
        tempMap.set(
          `${ix.user.id}:${user.id}:fotoName`,
          fotoAtt.name || "foto.png"
        );
      }

      const buttons = [
        new ButtonBuilder()
          .setCustomId(`defpass:open:${user.id}`)
          .setLabel("Definir Passaporte")
          .setStyle(ButtonStyle.Primary),
      ];
      const row = new ActionRowBuilder().addComponents(buttons);

      const msg = await ix.reply({
        content:
          "Você pode **definir o passaporte**, **enviar a foto** (basta mandar no chat após definir) ou **pular**.",
        components: [row],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      });
      await autoDeleteEphemeral(ix, msg, TTL_PICK);
      return;
    }

    /* ---------- ATALHO: User Select -> prompt inicial ---------- */
    if (ix.isUserSelectMenu() && ix.customId === "atalho_pick_conscrito") {
      const userId = ix.values?.[0];
      if (!userId) {
        return ix.reply({
          content: "Seleção inválida.",
          flags: MessageFlags.Ephemeral,
        });
      }

      tempMap.delete(`${ix.user.id}:${userId}:foto`);
      tempMap.delete(`${ix.user.id}:${userId}:fotoName`);
      tempMap.delete(`${ix.user.id}:${userId}:fotoMsgId`);

      const buttons = [
        new ButtonBuilder()
          .setCustomId(`defpass:open:${userId}`)
          .setLabel("Definir Passaporte")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`atalho_pular_foto:${userId}`)
          .setLabel("Pular foto")
          .setStyle(ButtonStyle.Danger),
      ];
      const row = new ActionRowBuilder().addComponents(buttons);

      const msg = await ix.reply({
        content:
          "Você pode **definir o passaporte**, **enviar a foto** (basta mandar no chat após definir) ou **pular**.",
        components: [row],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      });
      await autoDeleteEphemeral(ix, msg, TTL_PICK);
      return;
    }

    /* ---------- Definir Passaporte (abre modal) ---------- */
    if (ix.isButton() && ix.customId.startsWith("defpass:open:")) {
      const userId = ix.customId.split(":")[2];

      const modal = new ModalBuilder()
        .setCustomId(`defpass:modal:${userId}`)
        .setTitle("Definir passaporte");

      const pass = new TextInputBuilder()
        .setCustomId("passport")
        .setLabel("Número do passaporte (RP)")
        .setPlaceholder("Ex.: 12345")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(16);

      modal.addComponents(new ActionRowBuilder().addComponents(pass));
      return showModalSafe(ix, modal);
    }

    /* ---------- Definir Passaporte (submit) ---------- */
    if (ix.isModalSubmit() && ix.customId.startsWith("defpass:modal:")) {
      const userId = ix.customId.split(":")[2];
      const passport = ix.fields.getTextInputValue("passport").trim();

      tempMap.set(`${ix.user.id}:${userId}:passport`, passport);

      const ok = await ix.reply({
        content: `✅ Passaporte **${passport}** definido para <@${userId}>.`,
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      });
      await autoDeleteEphemeral(ix, ok, TTL_PASSPORT_OK);

      const ch = await ix.channel?.fetch();
      const prompt = await ix.followUp({
        content:
          "Envie **agora** uma **imagem** neste canal (1 anexo, até **8MB**). Você tem **2 minutos**.\nDica: aguarde o upload completar antes de enviar.",
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      });
      await autoDeleteEphemeral(ix, prompt, TTL_PHOTO_PROMPT);

      if (ch) {
        const filter = (m) => {
          if (m.author.id !== ix.user.id) return false;
          if (m.attachments.size === 0) return false;
          const att = m.attachments.first();
          return (att?.contentType || "").startsWith("image/");
        };
        ch.awaitMessages({ filter, max: 1, time: 120_000, errors: ["time"] })
          .then(async (collected) => {
            const msg = collected.first();
            const att = msg.attachments.first();
            const okSize = (att?.size || 0) <= 8 * 1024 * 1024;
            if (!okSize) {
              const warn = await ix.followUp({
                content:
                  "⚠️ A imagem precisa ter **até 8MB**. Tente novamente.",
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
              });
              await autoDeleteEphemeral(ix, warn, TTL_PHOTO_OK);
              return;
            }
            tempMap.set(`${ix.user.id}:${userId}:foto`, att.url);
            tempMap.set(
              `${ix.user.id}:${userId}:fotoName`,
              att.name || "foto.png"
            );
            tempMap.set(`${ix.user.id}:${userId}:fotoMsgId`, msg.id);

            const openBtn = new ButtonBuilder()
              .setCustomId(`abrirParte1:${userId}`)
              .setLabel("Abrir Parte 1")
              .setStyle(ButtonStyle.Primary);
            const row = new ActionRowBuilder().addComponents(openBtn);

            const got = await ix.followUp({
              content:
                "✅ Foto recebida! Clique abaixo para abrir **Parte 1**.",
              components: [row],
              flags: MessageFlags.Ephemeral,
              fetchReply: true,
            });
            await autoDeleteEphemeral(ix, got, TTL_PHOTO_OK);
          })
          .catch(async () => {
            const t = await ix.followUp({
              content: "⏱️ Tempo para enviar a **imagem** esgotado.",
              flags: MessageFlags.Ephemeral,
              fetchReply: true,
            });
            await autoDeleteEphemeral(ix, t, TTL_PHOTO_OK);
            const openBtn = new ButtonBuilder()
              .setCustomId(`abrirParte1:${userId}`)
              .setLabel("Abrir Parte 1")
              .setStyle(ButtonStyle.Primary);
            const row = new ActionRowBuilder().addComponents(openBtn);
            const nxt = await ix.followUp({
              content: "Você pode prosseguir abrindo **Parte 1**.",
              components: [row],
              flags: MessageFlags.Ephemeral,
              fetchReply: true,
            });
            await autoDeleteEphemeral(ix, nxt, TTL_PHOTO_OK);
          });
      }
      return;
    }

    /* ---------- Pular foto -> abrir Parte 1 (exige passaporte) ---------- */
    if (ix.isButton() && ix.customId.startsWith("atalho_pular_foto:")) {
      const userId = ix.customId.split(":")[1];
      const pass = tempMap.get(`${ix.user.id}:${userId}:passport`);
      if (!pass) {
        const warn = await ix.reply({
          content: "⚠️ Defina o **passaporte** primeiro.",
          flags: MessageFlags.Ephemeral,
          fetchReply: true,
        });
        await autoDeleteEphemeral(ix, warn, TTL_PASSPORT_OK);
        return;
      }
      const inputsA = [
        makeInput(
          "codigos_q",
          "7 Códigos Q e Seus Respectivos Significados",
          "0: Errou todos | 1: Acertou 3 | 2: Acertou 5 | 3: Acertou todos"
        ),
        makeInput(
          "codigos_patrulha",
          "Códigos Patrulha (0–3)",
          "0: Acertou1 ou menos | 1: Acert 3 | 2: Acert 5 | 3: Acert todos"
        ),
        makeInput(
          "funcoes_p",
          "Funções P1–P4 (0–2)",
          "0: não sabe | 1: Resposta média | 2: Acertou todas"
        ),
        makeInput(
          "rev_sexo_oposto",
          "Revista Sexo Oposto (0–1)",
          "0: não sabe | 1: acertou"
        ),
        makeInput(
          "lei_miranda",
          "Lei de Miranda (0–1)",
          "0: não sabe | 1: acertou"
        ),
      ];
      const modalA = new ModalBuilder()
        .setCustomId(`recrutarModalA:${userId}`)
        .setTitle("Recrutamento — Parte 1/2");
      modalA.addComponents(
        ...inputsA.map((i) => new ActionRowBuilder().addComponents(i))
      );
      return showModalSafe(ix, modalA);
    }

    /* ---------- Abrir Parte 1 (após foto recebida) ---------- */
    if (ix.isButton() && ix.customId.startsWith("abrirParte1:")) {
      const userId = ix.customId.split(":")[1];
      const pass = tempMap.get(`${ix.user.id}:${userId}:passport`);
      if (!pass) {
        const warn = await ix.reply({
          content: "⚠️ Defina o **passaporte** primeiro.",
          flags: MessageFlags.Ephemeral,
          fetchReply: true,
        });
        await autoDeleteEphemeral(ix, warn, TTL_PASSPORT_OK);
        return;
      }
      const inputsA = [
        makeInput(
          "codigos_q",
          "7 Códigos Q e Seus Respectivos Significados",
          "0: Errou todos | 1: Acertou 3 | 2: Acertou 5 | 3: Acertou todos"
        ),
        makeInput(
          "codigos_patrulha",
          "Códigos Patrulha (0–3)",
          "0: Acertou1 ou menos | 1: Acert 3 | 2: Acert 5 | 3: Acert todos"
        ),
        makeInput(
          "funcoes_p",
          "Funções P1–P4 (0–2)",
          "0: não sabe | 1: Resposta média | 2: Acertou todas"
        ),
        makeInput(
          "rev_sexo_oposto",
          "Revista Sexo Oposto (0–1)",
          "0: não sabe | 1: acertou"
        ),
        makeInput(
          "lei_miranda",
          "Lei de Miranda (0–1)",
          "0: não sabe | 1: acertou"
        ),
      ];
      const modalA = new ModalBuilder()
        .setCustomId(`recrutarModalA:${userId}`)
        .setTitle("Recrutamento — Parte 1/2");
      modalA.addComponents(
        ...inputsA.map((i) => new ActionRowBuilder().addComponents(i))
      );
      return showModalSafe(ix, modalA);
    }

    /* ---------- Submit Parte 1 → botão para Parte 2 ---------- */
    if (ix.isModalSubmit() && ix.customId.startsWith("recrutarModalA:")) {
      const userId = ix.customId.split(":")[1];
      const partial = {
        codigos_q: ix.fields.getTextInputValue("codigos_q"),
        codigos_patrulha: ix.fields.getTextInputValue("codigos_patrulha"),
        funcoes_p: ix.fields.getTextInputValue("funcoes_p"),
        rev_sexo_oposto: ix.fields.getTextInputValue("rev_sexo_oposto"),
        lei_miranda: ix.fields.getTextInputValue("lei_miranda"),
      };
      tempMap.set(`${ix.user.id}:${userId}`, partial);

      const openBtn = new ButtonBuilder()
        .setCustomId(`abrirParte2:${userId}`)
        .setLabel("Abrir Parte 2")
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(openBtn);
      const msg = await ix.reply({
        content: "Parte 1 recebida. Clique abaixo para abrir **Parte 2**.",
        components: [row],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
      });
      await autoDeleteEphemeral(ix, msg, TTL_PHOTO_OK);
      return;
    }

    /* ---------- Botão → Modal Parte 2 ---------- */
    if (ix.isButton() && ix.customId.startsWith("abrirParte2:")) {
      const userId = ix.customId.split(":")[1];
      if (!tempMap.has(`${ix.user.id}:${userId}`)) {
        const warn = await ix.reply({
          content: "⚠️ Não encontrei a Parte 1. Comece novamente.",
          flags: MessageFlags.Ephemeral,
          fetchReply: true,
        });
        await autoDeleteEphemeral(ix, warn, TTL_PHOTO_OK);
        return;
      }

      const inputsB = [
        makeInput(
          "mod_codigo0",
          "Modulação Código 0 (0–3)",
          "0: Resp péssima | 1: ruim | 2: média | 3: perfeita"
        ),
        makeInput(
          "mod_disparos",
          "Modulação Disparos (0–3)",
          "0: péssima | 1: ruim | 2: média | 3: perfeita"
        ),
        makeInput(
          "mod_acompanhamento",
          "Modulação de acompanhamento. (0–3)",
          "0: Resposta péssima | 1: ruim | 2: média | 3: perfeita"
        ),
        makeInput(
          "caixa2",
          "O que é Caixa 2 (0–2)",
          "0: não sabe | 1: Resposta aproximada | 2: Resposta correta"
        ),
        makeInput(
          "abordagem",
          "Abordagem dRotina x Suspeita (0–2)",
          "0: não sabe | 1: Resposta média | 2: Resposta correta"
        ),
      ];
      const modalB = new ModalBuilder()
        .setCustomId(`recrutarModalB:${userId}`)
        .setTitle("Recrutamento — Parte 2/2");
      modalB.addComponents(
        ...inputsB.map((i) => new ActionRowBuilder().addComponents(i))
      );

      return await showModalSafe(ix, modalB);
    }

    /* ---------- Submit Parte 2 → calcula/aplica/loga/salva ---------- */
    if (ix.isModalSubmit() && ix.customId.startsWith("recrutarModalB:")) {
      await ix.deferReply({ flags: MessageFlags.Ephemeral });

      const discordId = ix.customId.split(":")[1];
      const key = `${ix.user.id}:${discordId}`;
      const fotoKey = `${ix.user.id}:${discordId}:foto`;

      const partial = tempMap.get(key) || {};
      const fotoUrl = tempMap.get(fotoKey) || null;
      const fotoName =
        tempMap.get(`${ix.user.id}:${discordId}:fotoName`) || "foto.png";
      const fotoMsgId =
        tempMap.get(`${ix.user.id}:${discordId}:fotoMsgId`) || null;
      const passport = (
        tempMap.get(`${ix.user.id}:${discordId}:passport`) || ""
      )
        .toString()
        .trim();

      if (!passport) {
        return ix.editReply(
          "⛔ Passaporte obrigatório. Defina antes de concluir."
        );
      }

      tempMap.delete(key);
      tempMap.delete(fotoKey);
      tempMap.delete(`${ix.user.id}:${discordId}:fotoName`);

      const a = {
        ...partial,
        mod_codigo0: ix.fields.getTextInputValue("mod_codigo0"),
        mod_disparos: ix.fields.getTextInputValue("mod_disparos"),
        mod_acompanhamento: ix.fields.getTextInputValue("mod_acompanhamento"),
        caixa2: ix.fields.getTextInputValue("caixa2"),
        abordagem: ix.fields.getTextInputValue("abordagem"),
      };

      const { total, autoFail } = calculaNotaCategorias(a);
      const nota = total;

      const guild = await client.guilds.fetch(GUILD_ID);
      let member;
      try {
        member = await guild.members.fetch(discordId);
      } catch {
        return ix.editReply({
          content: "❌ O conscrito não está no servidor.",
        });
      }

      const { classificacao, aprovado } = decidirClassificacao(nota, autoFail);

      // aplica papel aprovado/reprovado
      const roleId = aprovado ? ROLE_APROVADO_ID : ROLE_REPROVADO_ID;
      const fluxo = [ROLE_APROVADO_ID, ROLE_REPROVADO_ID].filter(Boolean);
      const toRemove = member.roles.cache.filter(
        (r) => fluxo.includes(r.id) && r.id !== roleId
      );
      if (toRemove.size)
        await member.roles.remove([...toRemove.keys()]).catch(() => {});
      if (roleId) await member.roles.add(roleId).catch(() => {});

      const v = (k) => Number(a[k]) || 0;

      // ===== Embed formatado =====
      const embed = new EmbedBuilder()
        .setTitle("📋 Recrutamento Concluído")
        .setColor(
          !aprovado
            ? 0xe74c3c
            : classificacao === CLASS_ESTAGIARIO
            ? 0xf1c40f
            : 0x2ecc71
        )
        .setTimestamp(new Date())
        .addFields(
          {
            name: "👤 Conscrito",
            value: `${member.user.tag} (<@${discordId}>)`,
            inline: false,
          },
          { name: "📇 Passaporte", value: passport, inline: false },
          {
            name: "🧑‍✈️ Recrutador",
            value: `${ix.user.tag} (<@${ix.user.id}>)`,
            inline: false,
          },
          { name: "📊 Pontuação", value: String(nota), inline: false },
          { name: "🏅 Classificação", value: classificacao, inline: false },
          {
            name: "📌 Status aplicado",
            value: aprovado ? "✅ Aprovado" : "❌ Reprovado",
            inline: false,
          },
          {
            name: "⚠️ Reprovação automática",
            value: autoFail ? "Sim (alguma modulação = 0)" : "Não",
            inline: false,
          },
          {
            name: "📚 Detalhamento por categoria",
            value: [
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **7 Códigos Q e Seus Respectivos Significados** — ${labelCodigosQ(
                v("codigos_q")
              )} — ${pontosCodigosQ(v("codigos_q"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Códigos de Patrulha** — ${labelPatrulha(
                v("codigos_patrulha")
              )} — ${pontosPatrulha(v("codigos_patrulha"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Função do P1, P2, P3 e P4 na Viatura** — ${labelFuncoesP(
                v("funcoes_p")
              )} — ${pontosFuncoesPx(v("funcoes_p"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Revista Sexo Oposto** — ${labelBin(
                v("rev_sexo_oposto")
              )} — ${pontosBin6(v("rev_sexo_oposto"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Lei de Miranda** — ${labelBin(
                v("lei_miranda")
              )} — ${pontosBin8(v("lei_miranda"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Modulação Código 0** — ${labelMod(
                v("mod_codigo0")
              )} — ${pontosMod14(v("mod_codigo0"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Modulação Disparos** — ${labelMod(
                v("mod_disparos")
              )} — ${pontosMod14(v("mod_disparos"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Modulação Acompanhamento** — ${labelMod(
                v("mod_acompanhamento")
              )} — ${pontosMod14(v("mod_acompanhamento"))} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Caixa 2** — ${labelCaixa2(v("caixa2"))} — ${pontosCaixa2(
                v("caixa2")
              )} pts`,
              "━━━━━━━━━━━━━━━━━━━━━━━━",
              `• **Diferença entre abordagem de rotina & suspeita** — ${labelAbord(
                v("abordagem")
              )} — ${pontosAbordagem(v("abordagem"))} pts`,
            ].join("\n"),
            inline: false,
          }
        );

      const files = [];
      if (fotoUrl) {
        const file = new AttachmentBuilder(fotoUrl, { name: fotoName });
        files.push(file);
        embed.setImage(`attachment://${fotoName}`);
      }

      // log no canal
      try {
        const ch = await client.channels.fetch(RECRUIT_LOG_CHANNEL_ID);
        await ch.send({ embeds: [embed], files });
      } catch (e) {
        console.error("Falha ao enviar no canal de log:", e);
      }

      // DM opcional
      if (DM_RESULT) {
        try {
          await member.send({
            content: `📢 **Resultado do recrutamento**\nPontuação: **${nota}**\nClassificação: **${classificacao}**\nStatus aplicado: **${
              aprovado ? "Aprovado" : "Reprovado"
            }**\nRecrutador: **${ix.user.tag}**`,
          });
        } catch {}

        // (ignora erro de DM bloqueada)
      }

      // Persistência
      insertRecruit({
        discord_id: discordId,
        recrutado: member.user.tag,
        recrutador: ix.user.tag,
        recrutador_id: ix.user.id,
        nota,
        status: classificacao,
        observacoes: JSON.stringify({
          ...a,
          passaporte: passport,
          fotoUrl: fotoUrl || null,
        }),
      });

      try {
        db.prepare(
          `INSERT INTO passport_recruits (passport, user_id, recruiter_id, score, classification, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          passport,
          discordId,
          ix.user.id,
          nota,
          classificacao,
          aprovado ? "Aprovado" : "Reprovado"
        );
      } catch (e) {
        console.error("Falha ao gravar passport_recruits:", e);
      }

      // apaga a msg da foto (no canal) se existir
      try {
        if (fotoMsgId && RECRUIT_CHANNEL_ID) {
          const recruitCh = await client.channels.fetch(RECRUIT_CHANNEL_ID);
          const fotoMsg = await recruitCh.messages.fetch(fotoMsgId);
          await fotoMsg.delete().catch(() => {});
        }
      } catch {}

      tempMap.delete(`${ix.user.id}:${discordId}:fotoMsgId`);

      // mensagem final (não apagamos automaticamente)
      return ix.editReply({
        content: `✅ Registrado! **${
          aprovado ? "Aprovado" : "Reprovado"
        }** — classificação: **${classificacao}** — ${nota} pontos.`,
      });
    }

    /* ---------- DISCIPLINA: abrir seletor ---------- */
    if (
      ix.isButton() &&
      (ix.customId === "disc:open:exon" || ix.customId === "disc:open:black")
    ) {
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canDiscipline(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para isso.",
          flags: MessageFlags.Ephemeral,
        });
      }
      const action = ix.customId.endsWith("exon") ? "exon" : "black";
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`disc:pick:${action}`)
          .setPlaceholder(
            action === "exon"
              ? "Selecione o usuário para Exonerar"
              : "Selecione o usuário para Blacklist"
          )
          .setMinValues(1)
          .setMaxValues(1)
      );
      return ix.reply({ components: [row], flags: MessageFlags.Ephemeral });
    }

    /* ---------- DISCIPLINA: após selecionar → modal ---------- */
    if (ix.isUserSelectMenu() && ix.customId.startsWith("disc:pick:")) {
      const action = ix.customId.split(":")[2]; // exon|black
      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canDiscipline(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para isso.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const targetId = ix.values[0];
      const modal = new ModalBuilder()
        .setCustomId(`disc:modal:${action}:${targetId}`)
        .setTitle(action === "exon" ? "Exonerar — Dados" : "Blacklist — Dados");

      const passaporte = new TextInputBuilder()
        .setCustomId("passport")
        .setLabel("Passaporte (obrigatório)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(16);

      const motivo = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Motivo (obrigatório)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(passaporte),
        new ActionRowBuilder().addComponents(motivo)
      );

      return await showModalSafe(ix, modal);
    }

    /* ---------- DISCIPLINA: submit → kick/ban + DB + log ---------- */
    if (ix.isModalSubmit() && ix.customId.startsWith("disc:modal:")) {
      const [_, __, action, targetId] = ix.customId.split(":"); // disc:modal:exon|black:<id>
      const passport = ix.fields.getTextInputValue("passport").trim();
      const reason = ix.fields.getTextInputValue("reason").trim();

      const member = await ix.guild.members.fetch(ix.user.id);
      if (!canDiscipline(member)) {
        return ix.reply({
          content: "⛔ Você não tem permissão para isso.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === "exon") {
        const targetMember = await ix.guild.members
          .fetch(targetId)
          .catch(() => null);
        if (targetMember) {
          await targetMember
            .kick(`Exonerado por ${ix.user.tag} — ${reason}`)
            .catch(() => {});
        }

        try {
          db.prepare(
            `INSERT INTO exonerations (user_id, passport, executor_id, reason) VALUES (?, ?, ?, ?)`
          ).run(targetId, passport, ix.user.id, reason);
        } catch (e) {
          console.error("exonerations insert fail:", e);
        }

        const embed = new EmbedBuilder()
          .setTitle("🟥 EXONERAÇÃO")
          .addFields(
            {
              name: "👤 Usuário",
              value: `<@${targetId}> (${targetId})`,
              inline: true,
            },
            { name: "📇 Passaporte", value: passport, inline: true },
            {
              name: "👮 Executor",
              value: `<@${ix.user.id}> (${ix.user.tag})`,
              inline: true,
            },
            { name: "📝 Motivo", value: reason, inline: false }
          )
          .setColor(0xff0000)
          .setTimestamp();

        await logToChannel(EXON_LOG_CHANNEL_ID, embed);
        return ix.reply({
          content: "✅ Exoneração aplicado e registrada.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === "black") {
        await ix.guild.members
          .ban(targetId, { reason: `Blacklist por ${ix.user.tag} — ${reason}` })
          .catch(() => {});

        try {
          db.prepare(
            `INSERT INTO blacklists (user_id, passport, executor_id, reason) VALUES (?, ?, ?, ?)`
          ).run(targetId, passport, ix.user.id, reason);
        } catch (e) {
          console.error("blacklists insert fail:", e);
        }

        const embed = new EmbedBuilder()
          .setTitle("🟥 BLACKLIST")
          .addFields(
            {
              name: "👤 Usuário",
              value: `<@${targetId}> (${targetId})`,
              inline: true,
            },
            { name: "📇 Passaporte", value: passport, inline: true },
            {
              name: "👮 Executor",
              value: `<@${ix.user.id}> (${ix.user.tag})`,
              inline: true,
            },
            { name: "📝 Motivo", value: reason, inline: false }
          )
          .setColor(0x111111)
          .setTimestamp();

        await logToChannel(BLACKLIST_LOG_CHANNEL_ID, embed);
        return ix.reply({
          content: "✅ Blacklist aplicada e registrada.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (e) {
    console.error("Erro em InteractionCreate:", e);
    try {
      await ix.reply({
        content: `❌ Erro: ${e?.message || e}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
  }
});