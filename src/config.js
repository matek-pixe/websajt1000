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

  // The one and only bot manager. Access is verified by the Discord ID (spoof-proof);
  // the username is informational / display only.
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

  // Ticket system (/v panel, OPEN TICKET button, /new, /close, /open, /add, /claim).
  tickets: {
    // Category that holds every ticket and the transcript channels (created on first use).
    categoryName: (env.TICKET_CATEGORY_NAME || 'TICKET').trim() || 'TICKET',
    // Transcript channels are named <prefix><n>: transcript-1, transcript-2, ...
    transcriptPrefix: (env.TRANSCRIPT_CHANNEL_PREFIX || 'transcript-').trim() || 'transcript-',
    // How many transcripts fit in one transcript channel before the bot moves to the next one.
    transcriptsPerChannel: positiveNumber(env.TRANSCRIPTS_PER_CHANNEL, 100),
    // After a ticket is closed the opener must wait this long before opening a new one.
    reopenCooldownMs: positiveNumber(env.TICKET_REOPEN_COOLDOWN_MINUTES, 10) * 60 * 1000,
    // Safety cap on how many messages a transcript will include.
    maxTranscriptMessages: 2000,
    // Countdown before a ticket channel is actually deleted.
    deleteDelayMs: 5000,
  },
};

module.exports = config;
