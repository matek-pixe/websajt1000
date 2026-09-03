'use strict';

const path = require('node:path');
require('dotenv').config();

const env = process.env;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config = {
  botName: '35xw',

  token: env.DISCORD_TOKEN || '',
  clientId: env.CLIENT_ID || '',
  guildId: env.GUILD_ID || '',

  // The one and only bot manager. Both the Discord ID and the username are checked.
  manager: {
    id: (env.MANAGER_ID || '1143659003327553556').trim(),
    username: (env.MANAGER_USERNAME || '35bf').trim().toLowerCase(),
  },

  // Every command can be used once per this many milliseconds, per user.
  cooldownMs: positiveNumber(env.COOLDOWN_SECONDS, 30) * 1000,

  autoRole: {
    id: (env.AUTO_ROLE_ID || '').trim(),
    name: (env.AUTO_ROLE_NAME || 'Member').trim() || 'Member',
  },

  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),

  // Name of the single text channel that survives /n.
  finalChannelName: 'zavrseno',

  // Title of the /stats embed.
  statsTitle: 'Rastrosan',

  // Max size of an uploaded refill file (bytes).
  maxRefillFileBytes: 8 * 1024 * 1024,

  // Pause between channel deletions in /n (ms) so we go "one by one" gently.
  nukeDelayMs: 350,
};

module.exports = config;
