import 'dotenv/config';
import { REST, Routes, ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js';

const commands = [
  {
    name: 'painel',
    description: 'Posta um painel com atalhos de recrutamento e ranking',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    dm_permission: false
  },
  {
    name: 'recrutar',
    description: 'Registrar recrutamento (modal em 2 partes)',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    dm_permission: false,
    options: [
      {
        name: 'candidato',
        description: 'Usuário a ser avaliado',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
      {
        name: 'foto',
        description: 'Foto do conscrito (imagem)',
        type: ApplicationCommandOptionType.Attachment,
        required: false
      }
    ]
  },
  {
    name: 'consultar',
    description: 'Consultar histórico de recrutamento de um usuário',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    dm_permission: false,
    options: [
      { name: 'usuario', description: 'Usuário a consultar', type: ApplicationCommandOptionType.User, required: true },
      { name: 'limit', description: 'Quantos registros (padrão 5)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 1, max_value: 50 }
    ]
  },
  {
    name: 'ranking_recrutadores',
    description: 'Ranking de recrutadores por dia ou mês',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    dm_permission: false,
    options: [
      { name: 'data', description: 'DD/MM/AAAA (ex: 05/09/2025)', type: ApplicationCommandOptionType.String, required: true },
      {
        name: 'escopo',
        description: 'Filtrar pelo dia exato ou pelo mês inteiro',
        type: ApplicationCommandOptionType.String, required: true,
        choices: [
          { name: 'dia', value: 'dia' },
          { name: 'mês', value: 'mes' }
        ]
      },
      { name: 'limit', description: 'Limite de linhas (padrão 100 dia / 200 mês)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 1, max_value: 500 }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const appId = process.env.APPLICATION_ID;
  const guildId = process.env.GUILD_ID;
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log('✅ Comandos registrados (/painel, /recrutar, /consultar, /ranking_recrutadores).');
}
main().catch(console.error);
