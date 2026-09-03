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
    // Category that holds open/closed tickets (created on first use, renamed if it already exists).
    categoryName: (env.TICKET_CATEGORY_NAME || '🎫 Tickets').trim() || '🎫 Tickets',
    // Each transcript gets its own private channel transcript-NNNN (same number as the ticket),
    // placed in categories named <prefix>01, <prefix>02, ... (Transcript-01, Transcript-02, ...).
    transcriptCategoryPrefix: (env.TRANSCRIPT_CATEGORY_PREFIX || 'Transcript-').trim() || 'Transcript-',
    // How many transcript channels fit in one Transcript-XX category before moving to the next.
    // Discord's hard limit is 50 channels per category; the service never exceeds that.
    transcriptsPerCategory: positiveNumber(env.TRANSCRIPTS_PER_CATEGORY, 50),
    // Safety cap on how many messages a transcript will include.
    maxTranscriptMessages: 2000,
    // After a ticket is closed the opener must wait this long before opening a new one.
    reopenCooldownMs: positiveNumber(env.TICKET_REOPEN_COOLDOWN_MINUTES, 10) * 60 * 1000,
    // Countdown before a ticket channel is actually deleted.
    deleteDelayMs: 5000,
    // How long to wait for a rename/move before letting it finish in the background
    // (Discord rate-limits channel renames to 2 per 10 minutes).
    editTimeoutMs: 8000,
  },
};

module.exports = config;
