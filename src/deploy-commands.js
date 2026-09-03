'use strict';

const { REST, Routes } = require('discord.js');
const config = require('./config');
const registry = require('./commands');

async function main() {
  if (!config.token) throw new Error('DISCORD_TOKEN is missing (.env).');
  if (!config.clientId) throw new Error('CLIENT_ID is missing (.env).');

  const body = registry.toJSON();
  const rest = new REST({ version: '10' }).setToken(config.token);

  const names = body.map((c) => `/${c.name}`).join(', ');

  if (config.guildId) {
    console.log(`[deploy] Registering ${body.length} commands to guild ${config.guildId}: ${names}`);
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    console.log('[deploy] Done. Guild commands appear immediately.');
  } else {
    console.log(`[deploy] Registering ${body.length} GLOBAL commands: ${names}`);
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log('[deploy] Done. Global commands can take up to 1 hour to appear.');
  }
}

main().catch((err) => {
  console.error('[deploy] Failed:', err);
  process.exit(1);
});
