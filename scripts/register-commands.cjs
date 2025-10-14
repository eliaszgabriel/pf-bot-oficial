// scripts/register-commands.cjs
// Registra APENAS: /painel, /consultar_passport e /rank

require("dotenv").config();

const { REST } = require("@discordjs/rest");
const { Routes } = require("discord.js"); // <- aqui estava o problema

const cmdPainel = {
  name: "painel",
  description: "Recriar/mostrar painel de recrutamento",
};

const cmdConsultarPassport = {
  name: "consultar_passport",
  description: "Consulta candidato pelo número do passaporte",
  options: [
    {
      name: "passport",
      description: "Número do passaporte",
      type: 4, // Integer
      required: true,
      min_value: 1,
    },
  ],
};

const cmdRank = {
  name: "rank",
  description: "Exibe ranking mensal (top 10 por padrão)",
  options: [
    {
      name: "limit",
      description: "Quantidade (1-25)",
      type: 4, // Integer
      required: false,
      min_value: 1,
      max_value: 25,
    },
  ],
};

const commands = [cmdPainel, cmdConsultarPassport, cmdRank];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.APPLICATION_ID;
  const guildId = process.env.GUILD_ID;
  if (!token || !appId || !guildId) {
    throw new Error("Falta DISCORD_TOKEN, APPLICATION_ID ou GUILD_ID no .env");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: commands,
  });
  console.log(
    "✅ Re-registrado: /painel, /consultar_passport e /rank (demais removidos)."
  );
}

main().catch((err) => {
  console.error("❌ Falha ao registrar comandos:", err);
  process.exit(1);
});
