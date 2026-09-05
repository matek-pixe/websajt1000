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
    // Closing a ticket saves an HTML transcript (transcript-NNNN.html) into this single private
    // channel inside the tickets category, then deletes the ticket channel.
    transcriptChannelName: (env.TRANSCRIPT_CHANNEL_NAME || 'transcripts').trim().toLowerCase() || 'transcripts',
    // Safety cap on how many messages a transcript will include.
    maxTranscriptMessages: 2000,
    // After a ticket is closed the opener must wait this long before opening a new one.
    reopenCooldownMs: positiveNumber(env.TICKET_REOPEN_COOLDOWN_MINUTES, 10) * 60 * 1000,
    // Countdown between "closed" and the channel actually being deleted.
    deleteDelayMs: 5000,
  },

  // Role-gated website: visitors sign in with Discord and only get in if they hold a required role.
  web: {
    enabled: /^(1|true|yes|on)$/i.test((env.WEB_ENABLED || '').trim()),
    // Hosts usually hand the port over as SERVER_PORT.
    port: positiveNumber(env.WEB_PORT || env.SERVER_PORT, 3000),
    host: (env.WEB_HOST || '0.0.0.0').trim(),
    // Public address of the site, e.g. https://35xw.example.com (used for the OAuth2 redirect).
    publicUrl: (env.WEB_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    // OAuth2 client secret from the Developer Portal (OAuth2 page).
    clientSecret: (env.DISCORD_CLIENT_SECRET || '').trim(),
    // Which server and which role(s) grant access (comma-separated role ids = any of them).
    guildId: (env.WEB_GUILD_ID || env.GUILD_ID || '').trim(),
    roleIds: (env.WEB_ROLE_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Secret for signing session cookies; generated and stored in DATA_DIR if left empty.
    sessionSecret: (env.WEB_SESSION_SECRET || '').trim(),
    sessionHours: positiveNumber(env.WEB_SESSION_HOURS, 24),
    // How often a logged-in visitor's role is re-checked.
    recheckMinutes: positiveNumber(env.WEB_RECHECK_MINUTES, 10),
    // Folder with public/ (login + denied pages) and protected/ (your website).
    dir: path.resolve(env.WEB_DIR || path.join(__dirname, '..', 'web')),
  },
};

module.exports = config;
