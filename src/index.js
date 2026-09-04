'use strict';

const path = require('node:path');
const { Client, GatewayIntentBits, Partials, Events, MessageFlags } = require('discord.js');

const config = require('./config');
const { Storage } = require('./storage');
const { AccountService } = require('./services/accounts');
const { RoleMemoryService } = require('./services/roleMemory');
const { TicketService } = require('./services/tickets');
const { BypassService } = require('./services/bypass');
const { Cooldown } = require('./services/cooldown');
const { createWebServer } = require('./web/server');
const fs = require('node:fs');
const crypto = require('node:crypto');
const registry = require('./commands');

function fail(message) {
  console.error(`\n[35xw] ${message}\n`);
  process.exit(1);
}

if (!config.token) fail('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
if (!config.clientId) fail('CLIENT_ID is missing. Set it in .env.');

// ---- services ----
const storage = new Storage(path.join(config.dataDir, 'db.json'));
const accounts = new AccountService(storage, config.dataDir);
const roleMemory = new RoleMemoryService(storage, config.autoRole);
const tickets = new TicketService(storage, config);
const bypass = new BypassService(storage, config);
const cooldown = new Cooldown(config.cooldownMs);
setInterval(() => cooldown.sweep(), 60_000).unref();

const services = { config, storage, accounts, roleMemory, tickets, bypass, cooldown };

function isManager(user) {
  return user && user.id === config.manager.id;
}

/** Build the per-interaction context passed to command handlers. */
function contextFor(interaction) {
  const key = `${interaction.commandName || interaction.customId}:${interaction.user.id}`;
  return {
    ...services,
    isManager,
    /** true when this user is the manager and /b bypass is on -> no limits at all */
    isBypass: (user) => bypass.applies(user),
    cooldownKey: key,
    startCooldown: () => cooldown.hit(key),
    refundCooldown: () => cooldown.reset(key),
  };
}

/**
 * Register slash commands.
 *  - GUILD_ID set  -> register to that one guild (instant), for single-server / dev use.
 *  - GUILD_ID empty -> register to EVERY guild the bot is in (instant on each), and clear the global
 *    set so commands are never duplicated. New guilds are handled by the GuildCreate listener.
 * Guild-scoped commands show up immediately, unlike global ones which can take up to an hour.
 */
async function registerCommands(c) {
  const body = registry.toJSON();
  try {
    if (config.guildId) {
      await c.application.commands.set(body, config.guildId);
      console.log(`[35xw] Registered ${body.length} commands to guild ${config.guildId}.`);
      return;
    }
    await c.application.commands.set([]).catch(() => {}); // avoid global+guild duplicates
    let ok = 0;
    for (const guild of c.guilds.cache.values()) {
      try {
        await guild.commands.set(body);
        ok += 1;
      } catch (err) {
        console.warn(`[35xw] Command registration in ${guild.name} (${guild.id}) failed: ${err.message}`);
      }
    }
    console.log(`[35xw] Registered ${body.length} commands in ${ok}/${c.guilds.cache.size} guild(s) (instant).`);
  } catch (err) {
    console.warn(`[35xw] Command registration failed (run "npm run deploy" manually): ${err.message}`);
  }
}

/** Session-cookie secret: use WEB_SESSION_SECRET, else generate one once and keep it in DATA_DIR. */
function loadOrCreateWebSecret() {
  if (config.web.sessionSecret) return config.web.sessionSecret;
  const file = path.join(config.dataDir, 'web-secret.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not there yet */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

/** Start the role-gated website (only when WEB_ENABLED=true and fully configured). */
async function startWeb(c) {
  const w = config.web;
  if (!w.enabled) return;

  const missing = [];
  if (!w.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!w.guildId) missing.push('WEB_GUILD_ID (or GUILD_ID)');
  if (!w.roleIds.length) missing.push('WEB_ROLE_ID');
  if (missing.length) {
    console.warn(`[35xw] web: NOT started, missing ${missing.join(', ')} in .env`);
    return;
  }

  const checkMember = async (userId) => {
    const guild = c.guilds.cache.get(w.guildId) || (await c.guilds.fetch(w.guildId).catch(() => null));
    if (!guild) return { isMember: false, roleIds: [] };
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { isMember: false, roleIds: [] };
    return { isMember: true, roleIds: [...member.roles.cache.keys()] };
  };
  const roleNames = () => {
    const guild = c.guilds.cache.get(w.guildId);
    return w.roleIds.map((id) => (guild && guild.roles.cache.get(id) ? guild.roles.cache.get(id).name : id));
  };

  const site = createWebServer({
    web: w,
    clientId: config.clientId,
    sessionSecret: loadOrCreateWebSecret(),
    checkMember,
    roleNames,
  });
  const { port } = await site.start();
  console.log(`[35xw] web: listening on ${w.host}:${port} | public URL: ${w.publicUrl || '(from request host)'}`);
  console.log(`[35xw] web: access requires role(s) ${roleNames().join(', ')} on guild ${w.guildId}`);
  console.log(`[35xw] web: OAuth2 redirect must be ${w.publicUrl || 'https://<your-domain>'}/callback`);
}

// ---- client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
  partials: [Partials.GuildMember, Partials.User],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[35xw] Logged in as ${c.user.tag} (${c.user.id})`);
  console.log(`[35xw] Manager: ${config.manager.username} (${config.manager.id}) | cooldown: ${config.cooldownMs / 1000}s`);

  // Register the slash commands automatically on startup so a separate `npm run deploy` is optional.
  await registerCommands(c);

  for (const guild of c.guilds.cache.values()) {
    try {
      const role = await roleMemory.ensureAutoRole(guild);
      console.log(`[35xw] ${guild.name}: auto role -> ${role ? `${role.name} (${role.id})` : 'NONE (check perms/config)'}`);
      // Best-effort baseline: cache members and snapshot their roles so a later leave keeps the data.
      // Update in memory for every member, then persist ONCE (not once per member) to avoid a
      // blocking O(N^2) burst of full-database writes on large servers.
      const members = await guild.members.fetch().catch(() => null);
      if (members) {
        for (const member of members.values()) {
          if (!member.user.bot) roleMemory.remember(member, { persist: false });
        }
        storage.save();
        console.log(`[35xw] ${guild.name}: snapshotted roles for ${members.size} members`);
      }
    } catch (err) {
      console.warn(`[35xw] ${guild.name}: ready sync failed: ${err.message}`);
    }
  }
  console.log('[35xw] Ready.');

  // Website (optional) — never lets a web problem take the bot down.
  startWeb(c).catch((err) => console.error(`[35xw] web: failed to start: ${err.message}`));
});

// ---- slash commands + buttons ----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (err) {
    console.error('[35xw] interaction error:', err);
    const msg = { content: '❌ Došlo je do greške.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
        else await interaction.reply(msg);
      }
    } catch {
      /* ignore */
    }
  }
});

async function handleCommand(interaction) {
  const command = registry.commands.get(interaction.commandName);
  if (!command) {
    return interaction.reply({ content: '❓ Nepoznata komanda.', flags: MessageFlags.Ephemeral });
  }

  const ctx = contextFor(interaction);

  if (!command.allowDM && !interaction.inGuild()) {
    return interaction.reply({ content: '⚠️ Ovu komandu možeš koristiti samo na serveru.', flags: MessageFlags.Ephemeral });
  }

  if (command.managerOnly && !isManager(interaction.user)) {
    return interaction.reply({
      content: `⛔ Samo menadžer (**${config.manager.username}**) smije koristiti \`/${interaction.commandName}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Commands flagged noCooldown skip the limit, and so does the manager while /b bypass is on.
  if (!bypass.skipsCooldown(command, interaction.user)) {
    const left = cooldown.remaining(ctx.cooldownKey);
    if (left > 0) {
      return interaction.reply({
        content: `⏳ Prebrzo! Pričekaj još **${Math.ceil(left / 1000)}s** prije ponovnog \`/${interaction.commandName}\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    // Spend the cooldown up front so a rapid double-invoke is blocked; commands refund on no-op/error.
    cooldown.hit(ctx.cooldownKey);
  }

  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    ctx.refundCooldown();
    throw err;
  }
}

async function handleButton(interaction) {
  const command = registry.commandForButton(interaction.customId);
  if (!command || typeof command.handleButton !== 'function') return;
  const ctx = contextFor(interaction);
  await command.handleButton(interaction, ctx);
}

// When the bot joins a new server, register its commands there immediately (all-servers mode) and
// make sure the auto role exists.
client.on(Events.GuildCreate, async (guild) => {
  try {
    if (!config.guildId) {
      await guild.commands.set(registry.toJSON());
      console.log(`[35xw] Joined ${guild.name} (${guild.id}); registered commands.`);
    }
    await roleMemory.ensureAutoRole(guild);
  } catch (err) {
    console.warn(`[35xw] GuildCreate handler failed for ${guild.id}: ${err.message}`);
  }
});

// ---- member events: auto role + role memory ----
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;
  try {
    const res = await roleMemory.applyOnJoin(member);
    console.log(`[35xw] join: ${member.user.tag} -> applied ${res.applied.length} role(s)`);
  } catch (err) {
    console.warn(`[35xw] join handler failed for ${member.id}: ${err.message}`);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    // member may be partial; fetch is not possible after they left, but cached roles are enough.
    if (member.user && member.user.bot) return;
    if (member.roles && member.roles.cache) roleMemory.remember(member);
  } catch (err) {
    console.warn(`[35xw] leave handler failed for ${member.id}: ${err.message}`);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (newMember.user && newMember.user.bot) return;
    const before = oldMember.roles ? [...oldMember.roles.cache.keys()].sort().join(',') : '';
    const after = newMember.roles ? [...newMember.roles.cache.keys()].sort().join(',') : '';
    if (before !== after) roleMemory.remember(newMember);
  } catch (err) {
    console.warn(`[35xw] update handler failed for ${newMember.id}: ${err.message}`);
  }
});

// If a ticket channel is deleted by hand, drop its record so the opener can open a new one.
client.on(Events.ChannelDelete, (channel) => {
  try {
    if (channel.guild && tickets.forgetChannel(channel.guild.id, channel.id)) {
      console.log(`[35xw] ticket channel ${channel.name} was deleted; record cleared.`);
    }
  } catch (err) {
    console.warn(`[35xw] channelDelete handler failed: ${err.message}`);
  }
});

// A ban should permanently strip a member: forget their remembered roles so a ban+unban does not
// auto-restore access roles the way a plain rejoin does.
client.on(Events.GuildBanAdd, (ban) => {
  try {
    if (roleMemory.forget(ban.guild.id, ban.user.id)) {
      console.log(`[35xw] ban: cleared remembered roles for ${ban.user.tag || ban.user.id}`);
    }
  } catch (err) {
    console.warn(`[35xw] ban handler failed for ${ban.user.id}: ${err.message}`);
  }
});

client.on(Events.Error, (err) => console.error('[35xw] client error:', err));
process.on('unhandledRejection', (err) => console.error('[35xw] unhandledRejection:', err));

// Surface a bad/revoked token as a clean startup failure instead of a raw unhandled rejection.
client.login(config.token).catch((err) => fail(`Login failed: ${err.message}. Check DISCORD_TOKEN.`));
