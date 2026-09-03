'use strict';

const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Discord allows at most this many channels inside one category. */
const DISCORD_MAX_CHANNELS_PER_CATEGORY = 50;

/** Embed colours. `blend` matches Discord's dark embed background so no side bar shows. */
const TICKET_COLORS = Object.freeze({
  blend: 0x2b2d31,
  open: 0x5865f2,
  closed: 0xf1c40f,
  reopened: 0x2ecc71,
  archived: 0x95a5a6,
  deleted: 0xe74c3c,
});

/** Button ids. Everything starts with "tk:" so the /v command module can own the routing. */
const BUTTONS = Object.freeze({
  open: 'tk:open',
  close: 'tk:close',
  transcript: 'tk:transcript',
  reopen: 'tk:reopen',
  delete: 'tk:delete',
});

// ---------- pure helpers (unit-tested) ----------

/**
 * A ticket keeps ONE number for its whole life. Only the prefix changes with its state:
 *   open      -> ticket-0001
 *   closed    -> close-0001
 *   archived  -> transcript-0001   (moved into a Transcript-XX category)
 */
const pad4 = (n) => String(n).padStart(4, '0');
function formatTicketName(n) {
  return `ticket-${pad4(n)}`;
}
function formatClosedName(n) {
  return `close-${pad4(n)}`;
}
function formatTranscriptName(n) {
  return `transcript-${pad4(n)}`;
}
/** Archive categories: Transcript-01, Transcript-02, ... */
function formatTranscriptCategory(prefix, i) {
  return `${prefix}${String(i).padStart(2, '0')}`;
}

function defaultGuildBucket() {
  return {
    counter: 0,
    categoryId: null,
    staffRoleId: null,
    // which Transcript-XX category receives the next archived ticket, and how many it holds
    transcript: { index: 1, count: 0 },
    tickets: {},
    users: {},
  };
}

/**
 * Decide whether a user may open a ticket right now.
 * One open ticket per user, and a cooldown after their last ticket was closed.
 */
function evaluateOpen(bucket, userId, now, cooldownMs) {
  for (const [channelId, t] of Object.entries(bucket.tickets)) {
    if (t && t.userId === userId && t.status === 'open') {
      return { ok: false, reason: 'already_open', channelId };
    }
  }
  const u = bucket.users[userId];
  if (u && u.lastClosedAt) {
    const until = u.lastClosedAt + cooldownMs;
    if (until > now) return { ok: false, reason: 'cooldown', retryInMs: until - now };
  }
  return { ok: true };
}

/** One more ticket was archived into the current category; move on once it is full. */
function recordTranscriptPosted(bucket, perCategory) {
  bucket.transcript.count += 1;
  if (bucket.transcript.count >= perCategory) {
    bucket.transcript.index += 1;
    bucket.transcript.count = 0;
  }
}

/** The current category could not be used: skip it for good and never look at it again. */
function skipTranscriptSlot(bucket) {
  bucket.transcript.index += 1;
  bucket.transcript.count = 0;
}

function formatDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ---------- UI builders ----------

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTONS.open).setLabel('OPEN TICKET').setEmoji('🎫').setStyle(ButtonStyle.Primary),
  );
}

function closeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTONS.close).setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );
}

/** Staff controls. After archiving, the Transcript button is left out (it already happened). */
function controlsRow({ archived = false } = {}) {
  const row = new ActionRowBuilder();
  if (!archived) {
    row.addComponents(
      new ButtonBuilder().setCustomId(BUTTONS.transcript).setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(BUTTONS.reopen).setLabel('Open').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BUTTONS.delete).setLabel('Delete').setEmoji('⛔').setStyle(ButtonStyle.Danger),
  );
  return row;
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(TICKET_COLORS.blend)
    .setTitle('35xw verification')
    .setDescription('To get access to the server open a ticket');
}

function welcomeEmbed() {
  return new EmbedBuilder()
    .setColor(TICKET_COLORS.blend)
    .setDescription('Please wait for your role, our moderators will be here shortly.');
}

// ---------- service ----------

class TicketService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config the app config (uses config.tickets and config.manager)
   */
  constructor(storage, config) {
    this.storage = storage;
    this.config = config;
    this.opts = config.tickets;
    /** users whose ticket channel is being created right now (blocks double-clicks) */
    this.creating = new Set();
  }

  _guild(guildId) {
    const all = this.storage.data.tickets;
    if (!hasOwn(all, guildId)) setOwn(all, guildId, defaultGuildBucket());
    const b = all[guildId];
    // heal older / hand-edited buckets
    if (typeof b.counter !== 'number') b.counter = 0;
    if (!b.transcript || typeof b.transcript !== 'object') b.transcript = { index: 1, count: 0 };
    if (typeof b.transcript.index !== 'number' || b.transcript.index < 1) b.transcript.index = 1;
    if (typeof b.transcript.count !== 'number' || b.transcript.count < 0) b.transcript.count = 0;
    if (!b.tickets || typeof b.tickets !== 'object') b.tickets = {};
    if (!b.users || typeof b.users !== 'object') b.users = {};
    return b;
  }

  /** Never exceed Discord's per-category channel limit, whatever the config says. */
  get perCategory() {
    return Math.min(this.opts.transcriptsPerCategory, DISCORD_MAX_CHANNELS_PER_CATEGORY);
  }

  // ---- config / lookups ----

  setStaffRole(guildId, roleId) {
    this._guild(guildId).staffRoleId = roleId || null;
    this.storage.save();
  }

  getStaffRole(guildId) {
    return this._guild(guildId).staffRoleId || null;
  }

  /** Staff = bot manager, server admins / managers, or holders of the configured staff role. */
  isStaff(member, guildId) {
    if (!member) return false;
    if (member.id === this.config.manager.id) return true;
    if (member.permissions && member.permissions.has) {
      if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
      if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
    }
    const staffRoleId = this.getStaffRole(guildId);
    return !!(staffRoleId && member.roles && member.roles.cache && member.roles.cache.has(staffRoleId));
  }

  /** The ticket record for a channel, or null if the channel is not a ticket. */
  get(guildId, channelId) {
    const b = this._guild(guildId);
    return hasOwn(b.tickets, channelId) ? b.tickets[channelId] : null;
  }

  /** Called when a channel disappears (manual delete): drop its record so the opener is not stuck. */
  forgetChannel(guildId, channelId) {
    const b = this._guild(guildId);
    if (!hasOwn(b.tickets, channelId)) return false;
    const t = b.tickets[channelId];
    if (t && t.status === 'open') setOwn(b.users, t.userId, { lastClosedAt: Date.now() });
    delete b.tickets[channelId];
    this.storage.save();
    return true;
  }

  // ---- permissions ----

  /**
   * Discord only lets a bot grant permissions it actually holds in the guild; asking for more
   * fails the whole channel create/edit with "Missing Permissions". So every allow list is
   * filtered down to what the bot currently has (falls back to "all" if we cannot tell).
   */
  _held(guild, flags) {
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    if (!perms) return flags;
    return flags.filter((f) => perms.has(f));
  }

  /** Same idea for the { ViewChannel: true, ... } object form used by permissionOverwrites.edit(). */
  _heldObject(guild, obj) {
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    if (!perms) return obj;
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const bit = PermissionFlagsBits[key];
      if (bit === undefined || perms.has(bit)) out[key] = value;
    }
    return out;
  }

  /** Permissions a ticket participant (opener / added user / staff) gets in the channel. */
  static PARTICIPANT_FLAGS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  /** Overwrites for ticket channels and categories: private, bot + staff (+ manager) can see. */
  _baseOverwrites(guild) {
    const b = this._guild(guild.id);
    const me = guild.members.me;
    const out = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
    if (me) {
      // The bot only needs to see and talk in the channel; deleting it uses guild-level Manage Channels.
      out.push({ id: me.id, allow: this._held(guild, TicketService.PARTICIPANT_FLAGS) });
    }
    if (b.staffRoleId && guild.roles.cache.has(b.staffRoleId)) {
      out.push({ id: b.staffRoleId, allow: this._held(guild, TicketService.PARTICIPANT_FLAGS) });
    }
    const managerId = this.config.manager.id;
    if (managerId && guild.members.cache.has(managerId)) {
      out.push({ id: managerId, allow: this._held(guild, TicketService.PARTICIPANT_FLAGS) });
    }
    return out;
  }

  _memberAllow(guild) {
    return this._heldObject(guild, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });
  }

  // ---- channel edits ----

  /**
   * Discord allows only 2 name changes per channel per 10 minutes. discord.js waits out that
   * limit automatically, which could stall an interaction for minutes, so we wait a short while
   * and then let the edit finish in the background. A real API error still rejects immediately.
   */
  async _edit(channel, data) {
    const pending = channel.edit(data);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), this.opts.editTimeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (result === '__timeout__') {
      pending.catch((err) => console.warn(`[35xw] delayed edit of #${channel.name} failed: ${err.message}`));
      return { done: false };
    }
    return { done: true };
  }

  // ---- categories ----

  /** The "🎫 Tickets" category. Renames a previously used category instead of making a duplicate. */
  async ensureCategory(guild) {
    const b = this._guild(guild.id);
    const wanted = this.opts.categoryName;
    let cat = b.categoryId ? guild.channels.cache.get(b.categoryId) : null;
    if (cat && cat.type !== ChannelType.GuildCategory) cat = null;

    if (cat && cat.name !== wanted) {
      await cat.setName(wanted, '35xw ticket category renamed').catch(() => {});
    }
    if (!cat) {
      cat =
        guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === wanted.toLowerCase(),
        ) || null;
    }
    if (!cat) {
      cat = await guild.channels.create({
        name: wanted,
        type: ChannelType.GuildCategory,
        permissionOverwrites: this._baseOverwrites(guild),
        reason: '35xw ticket category',
      });
    }
    if (b.categoryId !== cat.id) {
      b.categoryId = cat.id;
      this.storage.save();
    }
    return cat;
  }

  /** The Transcript-XX category that receives the next archived ticket (created on demand). */
  async ensureTranscriptCategory(guild) {
    const b = this._guild(guild.id);
    const name = formatTranscriptCategory(this.opts.transcriptCategoryPrefix, b.transcript.index);
    let cat =
      guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase(),
      ) || null;
    if (!cat) {
      cat = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: this._baseOverwrites(guild),
        reason: '35xw transcript category',
      });
    }
    return cat;
  }

  // ---- open ----

  /**
   * Create a ticket for a member. Returns { ok, reason?, channel?, number? }.
   * reason: 'already_open' | 'cooldown' | 'in_progress'
   */
  async createTicket(guild, member) {
    const b = this._guild(guild.id);

    // Self-heal: if the "open" ticket's channel no longer exists, forget it.
    for (const [channelId, t] of Object.entries(b.tickets)) {
      if (t && t.userId === member.id && t.status === 'open' && !guild.channels.cache.has(channelId)) {
        this.forgetChannel(guild.id, channelId);
      }
    }

    const elig = evaluateOpen(b, member.id, Date.now(), this.opts.reopenCooldownMs);
    if (!elig.ok) return elig;
    if (this.creating.has(member.id)) return { ok: false, reason: 'in_progress' };

    this.creating.add(member.id);
    try {
      const category = await this.ensureCategory(guild);

      // Reserve the number first so it is never reused even if channel creation fails.
      b.counter += 1;
      const number = b.counter;
      this.storage.save();

      const overwrites = this._baseOverwrites(guild);
      overwrites.push({ id: member.id, allow: this._held(guild, TicketService.PARTICIPANT_FLAGS) });

      const channel = await guild.channels.create({
        name: formatTicketName(number),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
        topic: `Ticket #${pad4(number)} • opened by ${member.user.tag}`,
        reason: `35xw ticket #${pad4(number)} opened by ${member.user.tag}`,
      });

      setOwn(b.tickets, channel.id, {
        number,
        userId: member.id,
        username: member.user.username,
        openedAt: Date.now(),
        status: 'open',
        closedAt: null,
        closedBy: null,
        archivedAt: null,
        archivedBy: null,
        transcriptCategoryId: null,
      });
      this.storage.save();

      await channel.send({ content: `<@${member.id}>`, embeds: [welcomeEmbed()], components: [closeRow()] });
      return { ok: true, channel, number };
    } finally {
      this.creating.delete(member.id);
    }
  }

  // ---- close / archive / reopen / delete ----

  /** Close: rename to close-NNNN, hide it from the opener, show the staff controls. */
  async closeTicket(channel, closer) {
    const b = this._guild(channel.guild.id);
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };
    if (t.status !== 'open') return { ok: false, reason: 'already_closed' };

    // The opener loses access; @everyone is already denied so removing the overwrite hides it.
    await channel.permissionOverwrites.delete(t.userId, 'Ticket closed').catch(() => {});
    await this._edit(channel, { name: formatClosedName(t.number) }).catch((err) =>
      console.warn(`[35xw] rename to ${formatClosedName(t.number)} failed: ${err.message}`),
    );

    t.status = 'closed';
    t.closedAt = Date.now();
    t.closedBy = closer.id;
    setOwn(b.users, t.userId, { lastClosedAt: t.closedAt });
    this.storage.save();

    await channel.send({
      embeds: [new EmbedBuilder().setColor(TICKET_COLORS.closed).setDescription(`🔒 Ticket closed by <@${closer.id}>`)],
    });
    await channel.send({
      embeds: [new EmbedBuilder().setColor(TICKET_COLORS.blend).setDescription('**Support team ticket controls**')],
      components: [controlsRow()],
    });
    return { ok: true, ticket: t };
  }

  /**
   * Transcript: move the closed ticket channel into the current Transcript-XX category and rename
   * it to transcript-NNNN (same number). When the category is full, or the move fails, the bot
   * advances to the next Transcript-XX and remembers it, so a full category is never re-checked.
   */
  async archiveTicket(channel, by) {
    const b = this._guild(channel.guild.id);
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };
    if (t.status === 'open') return { ok: false, reason: 'must_close_first' };
    if (t.status === 'archived') return { ok: false, reason: 'already_archived' };

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (b.transcript.count >= this.perCategory) {
        skipTranscriptSlot(b);
        this.storage.save();
      }
      const category = await this.ensureTranscriptCategory(channel.guild);
      try {
        await this._edit(channel, {
          name: formatTranscriptName(t.number),
          parent: category.id,
          lockPermissions: false, // keep the channel's own (private) permissions
        });
      } catch (err) {
        lastErr = err;
        skipTranscriptSlot(b);
        this.storage.save();
        continue;
      }

      recordTranscriptPosted(b, this.perCategory);
      t.status = 'archived';
      t.archivedAt = Date.now();
      t.archivedBy = by.id;
      t.transcriptCategoryId = category.id;
      this.storage.save();

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLORS.archived)
            .setDescription(`📄 Ticket archived to **${category.name}** by <@${by.id}>`),
        ],
        components: [controlsRow({ archived: true })],
      });
      return { ok: true, ticket: t, category };
    }
    throw lastErr || new Error('Could not archive the ticket');
  }

  /** Reopen from closed or archived: back to the Tickets category as ticket-NNNN, opener restored. */
  async reopenTicket(channel, by) {
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };
    if (t.status === 'open') return { ok: false, reason: 'already_open' };

    const category = await this.ensureCategory(channel.guild);
    await this._edit(channel, {
      name: formatTicketName(t.number),
      parent: category.id,
      lockPermissions: false,
    }).catch((err) => console.warn(`[35xw] reopen edit failed: ${err.message}`));
    await channel.permissionOverwrites.edit(t.userId, this._memberAllow(channel.guild), { reason: 'Ticket reopened' });

    t.status = 'open';
    t.closedAt = null;
    t.closedBy = null;
    t.archivedAt = null;
    t.archivedBy = null;
    t.transcriptCategoryId = null;
    this.storage.save();

    await channel.send({
      content: `<@${t.userId}>`,
      embeds: [new EmbedBuilder().setColor(TICKET_COLORS.reopened).setDescription(`🔓 Ticket reopened by <@${by.id}>`)],
      components: [closeRow()],
    });
    return { ok: true, ticket: t };
  }

  async deleteTicket(channel, by) {
    const b = this._guild(channel.guild.id);
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };

    const secs = Math.round(this.opts.deleteDelayMs / 1000);
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLORS.deleted)
            .setDescription(`⛔ Ticket will be deleted in **${secs} seconds** by <@${by.id}>`),
        ],
      })
      .catch(() => {});
    await sleep(this.opts.deleteDelayMs);

    if (t.status === 'open') setOwn(b.users, t.userId, { lastClosedAt: Date.now() });
    delete b.tickets[channel.id];
    this.storage.save();

    await channel.delete(`Ticket deleted by ${by.tag || by.id}`);
    return { ok: true };
  }

  // ---- add ----

  async addToTicket(channel, target) {
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };
    await channel.permissionOverwrites.edit(target.id, this._memberAllow(channel.guild), { reason: 'Added to ticket' });
    return { ok: true };
  }
}

module.exports = {
  TicketService,
  TICKET_COLORS,
  BUTTONS,
  DISCORD_MAX_CHANNELS_PER_CATEGORY,
  formatTicketName,
  formatClosedName,
  formatTranscriptName,
  formatTranscriptCategory,
  defaultGuildBucket,
  evaluateOpen,
  recordTranscriptPosted,
  skipTranscriptSlot,
  formatDuration,
  panelRow,
  panelEmbed,
  closeRow,
  controlsRow,
};
