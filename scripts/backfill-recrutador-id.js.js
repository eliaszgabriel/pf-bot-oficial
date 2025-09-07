// scripts/backfill-recrutador-id.js
import "dotenv/config";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits } from "discord.js";

/**
 * Este script:
 * 1) Carrega todos os membros do GUILD_ID.
 * 2) Monta um índice de nomes -> userId (username, displayName e tag quando existir).
 * 3) Procura registros no SQLite (tabela recruits) com recrutador_id vazio/nulo.
 * 4) Para cada registro, tenta achar o userId pelo nome salvo e preenche recrutador_id.
 *
 * Requisitos:
 * - .env com: DISCORD_TOKEN, GUILD_ID, DB_FILE (opcional; padrão ./recrutamento.sqlite)
 *
 * Execute:
 *   node scripts/backfill-recrutador-id.js
 */

const {
  DISCORD_TOKEN,
  GUILD_ID,
  DB_FILE = "./recrutamento.sqlite",
} = process.env;

// Segurança básica
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("❌ Faltando DISCORD_TOKEN ou GUILD_ID no .env");
  process.exit(1);
}

// === DB ===
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// garante que a coluna existe
const cols = db
  .prepare(`PRAGMA table_info(recruits)`)
  .all()
  .map((c) => c.name);
if (!cols.includes("recrutador_id")) {
  console.log("⚠️  Coluna recrutador_id não existe; adicionando...");
  db.exec(`ALTER TABLE recruits ADD COLUMN recrutador_id TEXT;`);
}

// Seleciona registros sem recrutador_id
const selectMissing = db.prepare(`
  SELECT id, recrutador
  FROM recruits
  WHERE recrutador_id IS NULL OR recrutador_id = ''
  ORDER BY id ASC
`);
const updateId = db.prepare(`
  UPDATE recruits SET recrutador_id = @recrutador_id WHERE id = @id
`);

// === Discord client ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

function normalizeKey(s = "") {
  return String(s)
    .normalize("NFKD") // separa diacríticos
    .replace(/[\u0300-\u036f]/g, "") // remove diacríticos
    .toLowerCase()
    .trim();
}

function buildTagLike(user) {
  // Em contas antigas: username#1234; nas novas, discriminator pode ser "0"
  const { username, discriminator } = user;
  if (discriminator && discriminator !== "0") {
    return `${username}#${discriminator}`;
  }
  return null; // sem tag tradicional
}

async function main() {
  console.log("🔌 Conectando no Discord...");
  await client.login(DISCORD_TOKEN);
  const guild = await client.guilds.fetch(GUILD_ID);

  console.log(
    "👥 Carregando membros do servidor (isso pode levar alguns segundos)..."
  );
  await guild.members.fetch(); // preenche cache com todos os membros visíveis

  // Monta índice nome -> id
  const nameToId = new Map();
  for (const m of guild.members.cache.values()) {
    const user = m.user;
    const keys = [
      user.username,
      m.displayName,
      buildTagLike(user), // pode ser null em contas novas
    ].filter(Boolean);

    for (const k of keys) {
      nameToId.set(normalizeKey(k), user.id);
    }
  }
  console.log(`📇 Índice de nomes criado com ${nameToId.size} chaves.`);

  // Busca pendentes
  const rows = selectMissing.all();
  if (!rows.length) {
    console.log("✅ Não há registros sem recrutador_id. Nada a fazer.");
    process.exit(0);
  }

  console.log(
    `🔎 Encontrados ${rows.length} registros sem recrutador_id. Tentando casar nomes...`
  );
  let acertos = 0;
  let falhas = 0;

  const txn = db.transaction((items) => {
    for (const r of items) {
      const key = normalizeKey(r.recrutador || "");
      const id = nameToId.get(key);
      if (id) {
        updateId.run({ id: r.id, recrutador_id: id });
        acertos++;
      } else {
        falhas++;
      }
    }
  });

  txn(rows);

  console.log("📊 Resultado do backfill:");
  console.log("   ✔️ Atualizados:", acertos);
  console.log("   ❌ Não encontrados (revisar nomes):", falhas);

  if (falhas > 0) {
    console.log("\nℹ️ Dicas para reduzir falhas:");
    console.log(
      '- Verifique se o campo "recrutador" nos registros antigos está igual ao username/displayName atual.'
    );
    console.log(
      "- Se necessário, ajuste manualmente no banco OU rode de novo após padronizar nomes."
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Erro no backfill:", e);
  process.exit(1);
});
