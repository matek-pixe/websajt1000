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
const { inlineMedia } = require('./transcriptMedia');
const { TranscriptHost } = require('./transcriptHost');
const { card, field, mention, plural } = require('../ui');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Largest file posted to Discord; bigger pages are only available through the link. */
const ATTACH_LIMIT = 8_000_000;

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
  coll
    ? [...coll.values()].map((a) => ({ name: a.name, url: a.url, proxyUrl: a.proxyURL || null, contentType: a.contentType || '', size: a.size || 0, width: a.width || 0, height: a.height || 0 }))
    : [];

/** Rich embeds as plain data: text, fields, colours and the pictures (their addresses, downloaded later). */
const plainEmbeds = (list) =>
  (list || [])
    .map((e) => {
      const pic = (x) => (x && (x.proxyURL || x.url)) || null;
      return {
        title: e.title || '',
        description: e.description || '',
        url: e.url || null,
        color: typeof e.color === 'number' ? e.color : null,
        author: e.author && e.author.name ? { name: e.author.name, iconUrl: e.author.proxyIconURL || e.author.iconURL || null } : null,
        fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })),
        footer: e.footer && e.footer.text ? { text: e.footer.text, iconUrl: e.footer.proxyIconURL || e.footer.iconURL || null } : null,
        thumbnail: pic(e.thumbnail),
        image: pic(e.image),
        timestamp: e.timestamp ? new Date(e.timestamp).getTime() || null : null,
      };
    })
    .filter((e) => e.title || e.description || e.fields.length || e.image || e.thumbnail || e.author || e.footer);

/** Buttons of a message (labels only, they cannot be pressed in a transcript). */
const plainComponents = (rows) =>
  (rows || [])
    .map((row) =>
      ((row && row.components) || [])
        .filter((c) => c.label || (c.emoji && c.emoji.name))
        .map((c) => ({ label: c.label || '', style: c.style, emoji: c.emoji && !c.emoji.id ? c.emoji.name : '', url: c.url || null })),
    )
    .filter((row) => row.length);

/** A colour that discord.js computes lazily; it must never be able to break a transcript. */
const hex = (get) => {
  try {
    const c = typeof get === 'function' ? get() : get;
    return c && c !== '#000000' ? c : null;
  } catch {
    return null;
  }
};

/**
 * Turn a discord.js message into the plain shape the HTML renderer understands, including
 * reactions, the message it replies to, a forwarded message's snapshot and the edited flag.
 */
function normalizeMessage(m) {
  const author = m.author || {};
  const avatar =
    typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 64 }) : author.avatar || null;
  const mentions = {};
  const roleMentions = {};
  const channelMentions = {};
  if (m.mentions && m.mentions.users) {
    for (const u of m.mentions.users.values()) mentions[u.id] = u.globalName || u.username;
  }
  if (m.mentions && m.mentions.roles) {
    for (const r of m.mentions.roles.values()) roleMentions[r.id] = { name: r.name, color: hex(() => r.hexColor) };
  }
  if (m.mentions && m.mentions.channels) {
    for (const c of m.mentions.channels.values()) channelMentions[c.id] = c.name;
  }

  // reactions: unicode emoji by name, custom emoji by image url
  const reactions = [];
  if (m.reactions && m.reactions.cache) {
    for (const r of m.reactions.cache.values()) {
      try {
        const e = r.emoji || {};
        let url = null;
        if (e.id) {
          if (typeof e.imageURL === 'function') url = e.imageURL({ extension: e.animated ? 'gif' : 'png', size: 32 });
          else if (e.url) url = e.url;
        }
        reactions.push({ name: e.name || '', id: e.id || null, animated: !!e.animated, url, count: r.count || 0 });
      } catch {
        /* a reaction that cannot be read is left out, the rest of the transcript still gets saved */
      }
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
      color: hex(() => m.member && m.member.displayHexColor),
    },
    content: m.content || '',
    mentions,
    roleMentions,
    channelMentions,
    attachments: plainAttachments(m.attachments),
    embeds: plainEmbeds(m.embeds),
    components: plainComponents(m.components),
    stickers: m.stickers ? [...m.stickers.values()].map((st) => ({ name: st.name, url: st.url || null })) : [],
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
    .setDescription('Open a ticket to get access to the server.');
}

function welcomeEmbed() {
  return new EmbedBuilder()
    .setColor(TICKET_COLORS.blend)
    .setDescription('Wait here for your role. Staff will be with you shortly.');
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
    /** guilds whose ticket counter was already checked against Discord since the bot started */
    this.synced = new Set();
    /** set by the app: (guild, text, title) => void, reports a problem to the server log */
    this.onProblem = null;
    /** puts finished transcripts online (R2 or the bot's own website); tests inject their own */
    this.host = new TranscriptHost(config.transcripts || {});
    /** test hook: replaces fetch when downloading the images of a transcript */
    this.mediaFetch = null;
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
  /**
   * The tickets category: the stored one while it still exists, otherwise the first category with
   * the configured name. Every caller uses this, so preview and execution never disagree.
   */
  findCategory(guild) {
    const b = this._guild(guild.id);
    const cats = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildCategory);
    const stored = b.categoryId && cats.find((c) => c.id === b.categoryId);
    if (stored) return stored;
    const wanted = this.opts.categoryName.toLowerCase();
    return (
      cats
        .filter((c) => c.name.toLowerCase() === wanted)
        .sort((a, c) => (a.rawPosition || 0) - (c.rawPosition || 0))[0] || null
    );
  }

  async ensureCategory(guild) {
    const b = this._guild(guild.id);
    const wanted = this.opts.categoryName;
    let cat = this.findCategory(guild);
    if (cat && cat.name !== wanted && cat.id === b.categoryId) {
      await cat.setName(wanted, '35xw ticket category renamed').catch(() => {});
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

  /** The transcripts channel inside the tickets category (created on demand). Channels elsewhere are never taken over. */
  async ensureTranscriptChannel(guild) {
    const name = this.opts.transcriptChannelName;
    const category = await this.ensureCategory(guild);
    let ch =
      [...guild.channels.cache.values()].find(
        (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === category.id,
      ) || null;
    if (!ch) {
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: this._baseOverwrites(guild),
        topic: '35xw ticket transcripts',
        reason: '35xw transcripts channel',
      });
    }
    return ch;
  }

  // ---- numbering ----

  /**
   * The highest ticket number Discord itself still shows: the open ticket channels and the saved
   * transcripts, both inside the tickets category. The counter lives in data/db.json, but if that
   * file is ever lost (a wiped host, a fresh install) the numbers must not start over at 0001.
   */
  async _highestSeen(guild, category) {
    let max = 0;
    const note = (name) => {
      const m = /^(?:ticket|transcript)-(\d{1,9})(?!\d)/.exec(String(name || ''));
      if (m) max = Math.max(max, Number(m[1]));
    };
    const inside = [...guild.channels.cache.values()].filter((c) => c.parentId === category.id);
    for (const c of inside) note(c.name);
    const transcripts = inside.find((c) => c.name === this.opts.transcriptChannelName && c.messages && typeof c.messages.fetch === 'function');
    if (transcripts) {
      const recent = await transcripts.messages.fetch({ limit: 100 }).catch(() => null);
      if (recent) {
        for (const msg of recent.values()) {
          if (msg.attachments) for (const a of msg.attachments.values()) note(a.name);
        }
      }
    }
    return max;
  }

  /** Raise the stored counter to what Discord shows. Runs once per guild and start; never lowers it. */
  async _syncCounter(guild, category) {
    if (this.synced.has(guild.id)) return;
    const b = this._guild(guild.id);
    const seen = await this._highestSeen(guild, category);
    if (seen > b.counter) {
      console.log(`[35xw] tickets: counter ${b.counter} raised to ${seen} (found in Discord), numbering continues from there.`);
      b.counter = seen;
      this.storage.save();
    }
    this.synced.add(guild.id);
  }

  // ---- notify ----

  /** Channel that gets the "new ticket" message: the configured one, else the staff-news channel /setup built. */
  _notifyChannel(guild) {
    const n = this.opts.notify || {};
    const usable = (c) => (c && typeof c.send === 'function' ? c : null);
    const direct = n.channelId ? usable(guild.channels.cache.get(n.channelId)) : null;
    if (direct) return direct;
    const all = this.storage.data.setup;
    const built = hasOwn(all, guild.id) && all[guild.id].channels ? all[guild.id].channels.staff_news : null;
    return built ? usable(guild.channels.cache.get(built)) : null;
  }

  /** The owner's own server: it has the staff channel, is owned by the alert user or is the GUILD_ID server. */
  _isHome(guild) {
    const n = this.opts.notify || {};
    if (this._notifyChannel(guild)) return true;
    if (n.userId && guild.ownerId === n.userId) return true;
    return !!(this.config.guildId && guild.id === this.config.guildId);
  }

  /** A failed alert in plain words, with what to do about it. */
  _why(err, what) {
    const code = err && err.code;
    if (code === 50007) return `Discord would not let me DM ${what}. In their privacy settings, allow direct messages from server members.`;
    if (code === 50001 || code === 50013) return `I am not allowed to post in ${what}. Give me View Channel, Send Messages and Embed Links there.`;
    return `${err && err.message ? err.message : 'unknown error'} (${what})`;
  }

  _problem(guild, text, title = 'Ticket alert failed') {
    console.warn(`[35xw] ${title.toLowerCase()}: ${text}`);
    if (typeof this.onProblem === 'function') {
      try {
        this.onProblem(guild, text, title);
      } catch {
        /* the report must never break anything */
      }
    }
  }

  /** What is wrong with the alert setup of this server right now (empty list = fine). */
  alertProblems(guild) {
    const n = this.opts.notify || {};
    if (!this._isHome(guild)) return [];
    const out = [];
    const target = this._notifyChannel(guild);
    const me = guild.members && guild.members.me;
    if (!target) {
      out.push(`The staff channel ${n.channelId ? mention.channel(n.channelId) : ''} was not found on this server, so only the DM is sent.`.replace('  ', ' '));
    } else if (me && typeof target.permissionsFor === 'function') {
      const perms = target.permissionsFor(me);
      const need = [
        ['ViewChannel', 'View Channel'],
        ['SendMessages', 'Send Messages'],
        ['EmbedLinks', 'Embed Links'],
      ].filter(([flag]) => perms && !perms.has(PermissionFlagsBits[flag]));
      if (need.length) out.push(`I cannot post in ${mention.channel(target.id)}: missing ${need.map(([, label]) => label).join(', ')}.`);
    }
    const canPingAll = !!(me && me.permissions && me.permissions.has(PermissionFlagsBits.MentionEveryone));
    for (const id of n.roleIds || []) {
      const role = guild.roles.cache.get(id);
      if (!role) out.push(`The role ${mention.role(id)} (${id}) does not exist on this server, so it is not pinged.`);
      else if (!role.mentionable && !canPingAll) out.push(`${mention.role(id)} cannot be pinged: make it mentionable, or give me Mention Everyone.`);
    }
    return out;
  }

  /**
   * Tell the team a ticket was opened: one message in the staff channel (pinging the configured
   * roles) and a DM to the owner. Only for the owner's own server, never for other servers that
   * run the bot. Never throws. Anything that fails is reported once to the server log.
   * With { test: true } nobody is pinged and the message says so (used by /ticketalert).
   * Returns { skipped, staff, dm } where staff and dm are { ok, error? } or null when not attempted.
   */
  async notifyOpened(guild, member, channel, number, { test = false } = {}) {
    const report = { skipped: null, staff: null, dm: null, roles: [] };
    try {
      const n = this.opts.notify || {};
      if (!this._isHome(guild)) {
        report.skipped = 'not the owner server';
        return report;
      }
      const target = this._notifyChannel(guild);
      const roleIds = (n.roleIds || []).filter((id) => guild.roles.cache.has(id));
      report.roles = roleIds;
      const embed = card({
        title: test ? 'Test ticket alert' : 'New ticket',
        description: test
          ? `${mention.user(member.id)} ran a test. Nobody was pinged.`
          : `${mention.user(member.id)} opened ${mention.channel(channel.id)}.`,
        fields: [
          field('Ticket', test ? 'test' : `#${pad4(number)}`, true),
          field('Member', member.user.tag || member.user.username || member.id, true),
          field('Server', guild.name, true),
        ],
        tone: 'brand',
        footer: 'tickets',
        timestamp: true,
      });

      const send = async (what, fn) => {
        try {
          await fn();
          return { ok: true };
        } catch (err) {
          const error = this._why(err, what);
          this._problem(guild, error);
          return { ok: false, error };
        }
      };

      const jobs = [];
      if (target) {
        const ping = test ? [] : roleIds;
        const label = mention.channel(target.id);
        jobs.push(
          send(label, () =>
            target.send({
              content: roleIds.map(mention.role).join(' ') || undefined,
              embeds: [embed],
              allowedMentions: { roles: ping, users: [] },
            }),
          ).then((r) => (report.staff = r)),
        );
      } else {
        report.staff = { ok: false, error: `The staff channel ${n.channelId} was not found on this server.` };
        this._problem(guild, report.staff.error);
      }
      if (n.userId && guild.client && guild.client.users) {
        jobs.push(send(mention.user(n.userId), () => guild.client.users.send(n.userId, { embeds: [embed] })).then((r) => (report.dm = r)));
      }
      await Promise.all(jobs);
    } catch (err) {
      console.warn(`[35xw] ticket alert failed: ${err.message}`);
      report.skipped = report.skipped || err.message;
    }
    return report;
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
      await this._syncCounter(guild, category);
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
        topic: `Ticket #${pad4(number)} · opened by ${member.user.tag}`,
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
      this.notifyOpened(guild, member, channel, number); // fire and forget, never delays or breaks the ticket
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
    // Join notices, pin notices and the like carry nothing worth keeping.
    const real = (m) => m.type === undefined || [0, 19, 20, 23].includes(m.type) || m.content || (m.embeds && m.embeds.length) || (m.attachments && m.attachments.size);
    return all.filter(real).map(normalizeMessage);
  }

  /** Build the HTML transcript and post it (with a summary embed) into the transcripts channel. */
  async saveTranscript(channel, ticket, closer, closedAt) {
    const messages = await this.fetchMessages(channel);
    const guild = channel.guild;
    const closerName = closer.username || closer.tag || closer.id;
    const guildIcon = typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 128 }) : null;

    // Pictures go inside the page: Discord's own links expire and the ticket channel is about to be deleted.
    const session = this.host.enabled() ? this.host.session() : null;
    const { media, files } = await inlineMedia(
      { guildIcon, messages },
      { ...(this.mediaFetch ? { fetchImpl: this.mediaFetch } : {}), ...(session ? { session } : {}), ...(this.opts.media || {}) },
    ).catch((err) => {
      console.warn(`[35xw] transcript pictures skipped: ${err.message}`);
      return { media: new Map(), files: new Map() };
    });
    const page = (withMedia) =>
      renderTranscriptHtml({
        ticket,
        ticketName: formatTicketName(ticket.number),
        guildName: guild.name,
        guildIcon,
        messages,
        closedBy: { id: closer.id, name: closerName },
        closedAt,
        media: withMedia ? media : new Map(),
        files: withMedia ? files : new Map(),
      });
    let html = page(true);

    // Online copy: its own address per ticket.
    let link = null;
    if (session) {
      try {
        link = await session.putPage(html);
      } catch (err) {
        this._problem(guild, `The transcript of ${formatTicketName(ticket.number)} could not be put online (${err.message}). It is attached as a file instead.`, 'Transcript link failed');
      }
    }

    // The file is attached when Discord accepts its size. Without a link it must always be attached, so
    // a transcript that is too big loses its pictures instead of being lost.
    let attach = Buffer.byteLength(html) <= ATTACH_LIMIT;
    if (!attach && !link) {
      html = page(false);
      attach = true;
    }

    const embed = new EmbedBuilder()
      .setColor(TICKET_COLORS.transcript)
      .setTitle(`📄 Transcript for ${formatTicketName(ticket.number)}`)
      .addFields(
        { name: 'Ticket', value: formatTicketName(ticket.number), inline: true },
        { name: 'Opened by', value: `<@${ticket.userId}>`, inline: true },
        { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
        { name: 'Messages', value: String(messages.length), inline: true },
        { name: 'Duration', value: formatSpan(closedAt - ticket.openedAt), inline: true },
        { name: 'Opened', value: `<t:${Math.floor(ticket.openedAt / 1000)}:f>`, inline: true },
      );

    // The very same message goes to the transcripts channel and, as a direct message, to whoever opened
    // the ticket. Built twice so the two sends never share one file object.
    const makePayload = () => {
      const payload = { embeds: [EmbedBuilder.from(embed)] };
      if (attach) payload.files = [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${formatTranscriptName(ticket.number)}.html` })];
      if (link) {
        payload.components = [
          new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View transcript').setEmoji('📄').setURL(link)),
        ];
      }
      return payload;
    };

    const target = await this.ensureTranscriptChannel(guild);
    await target.send(makePayload());

    // Only after the channel copy is safe: a failed save is retried, and the opener must not get it twice.
    const dm = await this._sendToOpener(guild, ticket, makePayload());
    return { channel: target, count: messages.length, url: link, dm };
  }

  /** Direct message to the person who opened the ticket. Never throws; a closed DM is reported to the server log. */
  async _sendToOpener(guild, ticket, payload) {
    if (!ticket.userId || !guild.client || !guild.client.users) return { ok: false, error: 'no way to send' };
    try {
      await guild.client.users.send(ticket.userId, payload);
      return { ok: true };
    } catch (err) {
      const error =
        err && err.code === 50007
          ? `Discord would not let me DM the transcript of ${formatTicketName(ticket.number)} to ${mention.user(ticket.userId)}. They have direct messages from server members turned off.`
          : `The transcript of ${formatTicketName(ticket.number)} could not be sent to ${mention.user(ticket.userId)} (${(err && err.message) || 'unknown error'}).`;
      this._problem(guild, error, 'Transcript not delivered');
      return { ok: false, error };
    }
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
                `Ticket closed by ${mention.user(closer.id)}.\nSaving the transcript. This channel will be deleted in **${plural(secs, 'second')}**.`,
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
          .send({ content: `Could not save the transcript (${err.message}). The ticket was not deleted. Try closing it again.` })
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
      return { ok: true, ticket: t, transcriptChannel: saved.channel, count: saved.count, url: saved.url, dm: saved.dm };
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
