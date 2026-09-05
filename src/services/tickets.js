'use strict';

const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  MessageType,
  MessageReferenceType,
} = require('discord.js');
const { renderTranscriptHtml, formatSpan } = require('./transcriptHtml');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Embed colours. `blend` matches Discord's dark embed background so no side bar shows. */
const TICKET_COLORS = Object.freeze({
  blend: 0x2b2d31,
  open: 0x5865f2,
  closed: 0xf1c40f,
  transcript: 0x57f287,
});

/** Button ids. Everything starts with "tk:" so the /v command module can own the routing. */
const BUTTONS = Object.freeze({
  open: 'tk:open',
  close: 'tk:close',
});

// ---------- pure helpers (unit-tested) ----------

/** A ticket keeps ONE number for its whole life: channel ticket-0001, transcript transcript-0001.html */
const pad4 = (n) => String(n).padStart(4, '0');
function formatTicketName(n) {
  return `ticket-${pad4(n)}`;
}
function formatTranscriptName(n) {
  return `transcript-${pad4(n)}`;
}

function defaultGuildBucket() {
  return {
    counter: 0,
    categoryId: null,
    staffRoleId: null,
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

function formatDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const REPLY_TYPE = (MessageType && MessageType.Reply) ?? 19;
const FORWARD_REF = (MessageReferenceType && MessageReferenceType.Forward) ?? 1;

const plainAttachments = (coll) =>
  coll ? [...coll.values()].map((a) => ({ name: a.name, url: a.url, contentType: a.contentType || '' })) : [];
const plainEmbeds = (list) =>
  (list || []).map((e) => ({ title: e.title || '', description: e.description || '' })).filter((e) => e.title || e.description);

/**
 * Turn a discord.js message into the plain shape the HTML renderer understands, including
 * reactions, the message it replies to, a forwarded message's snapshot and the edited flag.
 */
function normalizeMessage(m) {
  const author = m.author || {};
  const avatar =
    typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 64 }) : author.avatar || null;
  const mentions = {};
  if (m.mentions && m.mentions.users) {
    for (const u of m.mentions.users.values()) mentions[u.id] = u.username;
  }

  // reactions: unicode emoji by name, custom emoji by image url
  const reactions = [];
  if (m.reactions && m.reactions.cache) {
    for (const r of m.reactions.cache.values()) {
      const e = r.emoji || {};
      let url = null;
      if (e.id) {
        if (typeof e.imageURL === 'function') url = e.imageURL({ extension: e.animated ? 'gif' : 'png', size: 32 });
        else if (e.url) url = e.url;
      }
      reactions.push({ name: e.name || '', id: e.id || null, animated: !!e.animated, url, count: r.count || 0 });
    }
  }

  // forward (message snapshot) vs. reply (reference to another message)
  const ref = m.reference || null;
  const snapshots = m.messageSnapshots;
  const hasSnapshot = !!(snapshots && (snapshots.size > 0 || (Array.isArray(snapshots) && snapshots.length)));
  const isForward = hasSnapshot || !!(ref && ref.type === FORWARD_REF);
  let forwarded = null;
  if (hasSnapshot) {
    const s = typeof snapshots.first === 'function' ? snapshots.first() : [...snapshots.values()][0];
    if (s) {
      forwarded = {
        content: s.content || '',
        createdTimestamp: s.createdTimestamp || null,
        attachments: plainAttachments(s.attachments),
        embeds: plainEmbeds(s.embeds),
      };
    }
  }
  const replyTo = !isForward && ref && ref.messageId && (m.type === REPLY_TYPE || !ref.type) ? ref.messageId : null;

  return {
    id: m.id,
    createdTimestamp: m.createdTimestamp,
    author: {
      id: author.id,
      name: (m.member && m.member.displayName) || author.globalName || author.username || author.tag || 'unknown',
      tag: author.tag || author.username || '',
      bot: !!author.bot,
      avatar,
    },
    content: m.content || '',
    mentions,
    attachments: plainAttachments(m.attachments),
    embeds: plainEmbeds(m.embeds),
    reactions,
    replyTo,
    forwarded,
    edited: !!m.editedTimestamp,
  };
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
    /** channels whose close is in progress (blocks a double Close) */
    this.closing = new Set();
  }

  _guild(guildId) {
    const all = this.storage.data.tickets;
    if (!hasOwn(all, guildId)) setOwn(all, guildId, defaultGuildBucket());
    const b = all[guildId];
    if (typeof b.counter !== 'number') b.counter = 0;
    if (!b.tickets || typeof b.tickets !== 'object') b.tickets = {};
    if (!b.users || typeof b.users !== 'object') b.users = {};
    return b;
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

  /** Overwrites for ticket / transcript channels and the category: private, bot + staff can see. */
  _baseOverwrites(guild) {
    const b = this._guild(guild.id);
    const me = guild.members.me;
    const out = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
    if (me) out.push({ id: me.id, allow: this._held(guild, TicketService.PARTICIPANT_FLAGS) });
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

  // ---- category / transcript channel ----

  /** The "🎫 Tickets" category. Renames a previously used category instead of making a duplicate. */
  async ensureCategory(guild) {
    const b = this._guild(guild.id);
    const wanted = this.opts.categoryName;
    let cat = b.categoryId ? guild.channels.cache.get(b.categoryId) : null;
    if (cat && cat.type !== ChannelType.GuildCategory) cat = null;
    if (cat && cat.name !== wanted) await cat.setName(wanted, '35xw ticket category renamed').catch(() => {});
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

  /** The single private transcripts channel (created on demand inside the tickets category). */
  async ensureTranscriptChannel(guild) {
    const name = this.opts.transcriptChannelName;
    let ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name) || null;
    if (!ch) {
      const category = await this.ensureCategory(guild);
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: this._baseOverwrites(guild),
        topic: '📄 35xw ticket transcripts',
        reason: '35xw transcripts channel',
      });
    }
    return ch;
  }

  // ---- open ----

  /**
   * Create a ticket for a member. Returns { ok, reason?, channel?, number? }.
   * reason: 'already_open' | 'cooldown' | 'in_progress'
   * With { bypass: true } (the manager's /b mode) the one-open-ticket rule and the cooldown are
   * skipped; only the double-click guard remains.
   */
  async createTicket(guild, member, { bypass = false } = {}) {
    const b = this._guild(guild.id);

    // Self-heal: if the "open" ticket's channel no longer exists, forget it.
    for (const [channelId, t] of Object.entries(b.tickets)) {
      if (t && t.userId === member.id && t.status === 'open' && !guild.channels.cache.has(channelId)) {
        this.forgetChannel(guild.id, channelId);
      }
    }

    if (!bypass) {
      const elig = evaluateOpen(b, member.id, Date.now(), this.opts.reopenCooldownMs);
      if (!elig.ok) return elig;
    }
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
      });
      this.storage.save();

      await channel.send({ content: `<@${member.id}>`, embeds: [welcomeEmbed()], components: [closeRow()] });
      return { ok: true, channel, number };
    } finally {
      this.creating.delete(member.id);
    }
  }

  // ---- transcript ----

  /** Read the whole conversation, oldest first, as plain data. */
  async fetchMessages(channel) {
    const max = this.opts.maxTranscriptMessages;
    const all = [];
    let before;
    while (all.length < max) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      all.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    return all.map(normalizeMessage);
  }

  /** Build the HTML transcript and post it (with a summary embed) into the transcripts channel. */
  async saveTranscript(channel, ticket, closer, closedAt) {
    const messages = await this.fetchMessages(channel);
    const guild = channel.guild;
    const closerName = closer.username || closer.tag || closer.id;
    const html = renderTranscriptHtml({
      ticket,
      ticketName: formatTicketName(ticket.number),
      guildName: guild.name,
      messages,
      closedBy: { id: closer.id, name: closerName },
      closedAt,
    });
    const file = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${formatTranscriptName(ticket.number)}.html` });
    const embed = new EmbedBuilder()
      .setColor(TICKET_COLORS.transcript)
      .setTitle(`📄 Transcript — ${formatTicketName(ticket.number)}`)
      .setDescription('Open the attached **.html** file in a browser to read the full conversation.')
      .addFields(
        { name: '🎫 Ticket', value: formatTicketName(ticket.number), inline: true },
        { name: '👤 Opened by', value: `<@${ticket.userId}>`, inline: true },
        { name: '🔒 Closed by', value: `<@${closer.id}>`, inline: true },
        { name: '💬 Messages', value: String(messages.length), inline: true },
        { name: '⏱️ Duration', value: formatSpan(closedAt - ticket.openedAt), inline: true },
        { name: '🕒 Opened', value: `<t:${Math.floor(ticket.openedAt / 1000)}:f>`, inline: true },
      )
      .setFooter({ text: '35xw • tickets' })
      .setTimestamp(closedAt);

    const target = await this.ensureTranscriptChannel(guild);
    await target.send({ embeds: [embed], files: [file] });
    return { channel: target, count: messages.length };
  }

  // ---- close ----

  /**
   * Close = save the HTML transcript to the transcripts channel, then delete the ticket channel.
   * If the transcript cannot be saved the channel is kept so nothing is lost (staff can retry).
   */
  async closeTicket(channel, closer) {
    const b = this._guild(channel.guild.id);
    const t = this.get(channel.guild.id, channel.id);
    if (!t) return { ok: false, reason: 'not_ticket' };
    if (t.status !== 'open') return { ok: false, reason: 'already_closed' };
    if (this.closing.has(channel.id)) return { ok: false, reason: 'in_progress' };
    this.closing.add(channel.id);

    try {
      const secs = Math.round(this.opts.deleteDelayMs / 1000);
      await channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setColor(TICKET_COLORS.closed)
              .setDescription(
                `🔒 Ticket closed by <@${closer.id}>\n📄 Saving the transcript… this channel will be deleted in **${secs} seconds**.`,
              ),
          ],
        })
        .catch(() => {});

      const closedAt = Date.now();
      let saved;
      try {
        saved = await this.saveTranscript(channel, t, closer, closedAt);
      } catch (err) {
        await channel
          .send({ content: `⚠️ Could not save the transcript (${err.message}). The ticket was **not** deleted, please try again.` })
          .catch(() => {});
        return { ok: false, reason: 'transcript_failed', error: err };
      }

      t.status = 'closed';
      t.closedAt = closedAt;
      t.closedBy = closer.id;
      setOwn(b.users, t.userId, { lastClosedAt: closedAt });
      this.storage.save();

      await sleep(this.opts.deleteDelayMs);
      delete b.tickets[channel.id];
      this.storage.save();
      await channel.delete(`Ticket closed by ${closer.tag || closer.id}`).catch((err) =>
        console.warn(`[35xw] could not delete ${channel.name}: ${err.message}`),
      );
      return { ok: true, ticket: t, transcriptChannel: saved.channel, count: saved.count };
    } finally {
      this.closing.delete(channel.id);
    }
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
  formatTicketName,
  formatTranscriptName,
  defaultGuildBucket,
  evaluateOpen,
  formatDuration,
  normalizeMessage,
  panelRow,
  panelEmbed,
  closeRow,
};
