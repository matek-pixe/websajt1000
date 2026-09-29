'use strict';

const crypto = require('node:crypto');
const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
const { panelEmbed, panelRow, BUTTONS } = require('./tickets');
const { plural } = require('../ui');

const P = PermissionFlagsBits;
const T = ChannelType;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Every name the layout creates follows "<icon> ıl NAME". */
const STYLE = (icon, label) => `${icon} ıl ${label}`;
/**
 * Text channel names: Discord lowercases them and turns spaces into hyphens, so the style uses a
 * separator it leaves alone. Categories and voice channels keep the "icon ıl NAME" style.
 */
const TEXT = (icon, label) => `${icon}・${String(label).toLowerCase()}`;
/** Braille blank: Discord trims ordinary spaces, this renders as an empty name. */
const BLANK_ROLE_NAME = '⠀';

// ---------- pure helpers ----------

/**
 * Reduce a channel or role name to its bare word so decoration never matters when matching what
 * already exists: "🎫 ıl VERIFY", "🎫ticket" and "verify" all compare by their letters.
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ıl/g, '')
    .replace(/[^a-z0-9#.+]+/g, '');
}

/** True for a name made only of whitespace and invisible characters. */
function isBlankName(s) {
  return /^[\s⠀​‌‍⁠﻿]*$/.test(String(s || ''));
}

/** The one role the website depends on. Matched by its exact name, never renamed or deleted. */
const isPlusRole = (role) => String(role && role.name).trim() === '+';

/** Roles the template owns. `match` lists the bare names an existing role may have to be reused. */
const ROLE_SPECS = Object.freeze({
  verified: { name: STYLE('✅', 'VERIFIED'), color: 0x57f287, match: ['verified', 'verificiran'] },
  coowner: { name: STYLE('👑', 'CO-OWNER'), color: 0xf1c40f, match: ['coowner', 'suvlasnik'] },
  support: { name: STYLE('🎫', 'SUPPORT'), color: 0x5865f2, match: ['support', 'ticketsupport', 'staff', 'ticketstaff'] },
  vip: { name: STYLE('💎', 'VIP'), color: 0xe91e63, match: ['vip', 'vips'] },
  friend: { name: STYLE('🤝', 'FRIEND'), color: 0x3498db, match: ['friend', 'friends'] },
  blank: { name: BLANK_ROLE_NAME, color: null, match: [], blank: true },
});

/** Template roles, lowest first: the order they are stacked in above the verified role. */
const ROLE_STACK = Object.freeze(['blank', 'friend', 'vip', 'support', 'coowner']);

/**
 * The server layout from top to bottom. `perms` names a set from permsFor(). The tickets category
 * belongs to the ticket service, and the kept categories are appended after everything else.
 */
function buildLayout(siteName) {
  const text = (key, icon, label, perms, topic) => ({ key, name: TEXT(icon, label), type: T.GuildText, perms, topic });
  const voice = (key, icon, label, perms) => ({ key, name: STYLE(icon, label), type: T.GuildVoice, perms });
  return {
    top: [voice('site', '🌐', siteName, 'reminder')],
    categories: [
      {
        key: 'private',
        name: STYLE('🔒', 'PRIVATE'),
        perms: 'private',
        channels: [
          text('priv_chat', '🔒', 'PRIV-CHAT', 'private', 'Private chat for admins and the priv role.'),
          voice('priv', '🔒', 'PRIV', 'private'),
        ],
      },
      {
        key: 'verify',
        name: STYLE('✅', 'VERIFY'),
        perms: 'verify',
        channels: [{ ...text('verify_ch', '🎫', 'VERIFY', 'verify', 'Open a ticket to get access to the server.'), panel: true }],
      },
      { key: 'tickets', managed: true },
      {
        key: 'info',
        name: STYLE('📌', 'INFO'),
        perms: 'info',
        channels: [
          text('rules', '📜', 'RULES', 'info', 'Read these before you do anything else.'),
          text('announcements', '📢', 'ANNOUNCEMENTS', 'info', 'News and announcements.'),
          text('changelog', '🛠️', 'CHANGELOG', 'info', 'What changed and when.'),
          text('information', 'ℹ️', 'INFORMATION', 'info', 'How everything here works.'),
          text('buy_triggers', '🛒', 'BUY-TRIGGERS', 'info', 'What is for sale and how to buy it.'),
          text('joins', '🆗', 'JOINS', 'info', 'Who joined.'),
        ],
      },
      {
        key: 'general',
        name: STYLE('🌍', 'GENERAL'),
        perms: 'members',
        channels: [
          text('chat', '💬', 'CHAT', 'members', 'General chat for verified members.'),
          text('balkan', '🌍', 'BALKAN', 'members', 'Chat in your own language.'),
          text('cmds', '🤖', 'CMDS', 'members', 'Bot commands go here.'),
          text('gen', '🎮', 'GEN', 'members', 'Use /steam, /5m and /combo here.'),
          text('triggers', '♾️', 'TRIGGERS', 'members', 'Triggers and scripts.'),
          text('server', '📢', 'SERVER', 'members', 'News and info about the server.'),
          text('dump', '🗑️', 'DUMP', 'members', 'Anything goes. Media, links, random.'),
        ],
      },
      {
        key: 'voice',
        name: STYLE('🔊', 'VOICE'),
        perms: 'members',
        channels: [
          voice('voice1', '🔊', 'VOICE #1', 'members'),
          voice('voice2', '🔊', 'VOICE #2', 'members'),
          voice('voice3', '🔊', 'VOICE #3', 'members'),
          voice('balkan_voice', '🌍', 'BALKAN', 'members'),
          voice('afk', '💤', 'AFK', 'members'),
        ],
      },
      {
        key: 'vip',
        name: STYLE('💎', 'VIP'),
        perms: 'vip',
        channels: [text('vip_chat', '💎', 'VIP-CHAT', 'vip', 'For VIP members.'), voice('vip_voice', '💎', 'VIP VOICE', 'vip')],
      },
      {
        key: 'staff',
        name: STYLE('🛡️', 'STAFF'),
        perms: 'staff',
        channels: [
          text('staff_news', '📣', 'STAFF-NEWS', 'staff', 'Announcements for the team.'),
          text('staff_chat', '💬', 'STAFF-CHAT', 'staff', 'Team chat.'),
          text('reports', '🚩', 'REPORTS', 'staff', 'Reports from members.'),
          text('logs', '📋', 'LOGS', 'staff', 'Logs from bots and moderation.'),
          voice('staff_voice', '🛡️', 'STAFF VOICE', 'staff'),
        ],
      },
    ],
  };
}

const FULL = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.Connect, P.Speak];
const READ = [P.ViewChannel, P.ReadMessageHistory];
const NO_POST = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads];
const NO_JOIN = [P.Connect, P.Speak];

/**
 * Permission overwrites for one set. Discord only lets a bot set overwrites for permissions it
 * holds itself, so every list goes through `held`. Overwrite types are explicit so nothing
 * depends on the user or role being cached. Administrators ignore overwrites and see everything.
 *
 *  verify    everyone reads but cannot post; the verified role no longer sees it; staff still does
 *  members   hidden from everyone except the verified role and staff
 *  info      like members, but verified members can only read
 *  vip       the VIP role and staff only
 *  staff     the support role and the co-owner role only
 *  private   the server owner, admins, the roles above them and the co-owner role
 *  reminder  visible to everyone, nobody can join
 */
function permsFor(kind, ids, held) {
  const H = (flags) => held(flags);
  const role = (id, allow, deny) => ({ id, type: OverwriteType.Role, allow, deny });
  const member = (id, allow, deny) => ({ id, type: OverwriteType.Member, allow, deny });
  const rows = [];
  switch (kind) {
    case 'verify':
      rows.push(role(ids.everyone, H(READ), H(NO_POST)));
      if (ids.verified) rows.push(role(ids.verified, undefined, H([P.ViewChannel])));
      if (ids.support) rows.push(role(ids.support, H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])));
      if (ids.coowner) rows.push(role(ids.coowner, H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])));
      if (ids.manager) rows.push(member(ids.manager, H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])));
      break;
    case 'members':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel])));
      if (ids.verified) rows.push(role(ids.verified, H(FULL)));
      if (ids.support) rows.push(role(ids.support, H(FULL)));
      if (ids.coowner) rows.push(role(ids.coowner, H(FULL)));
      if (ids.manager) rows.push(member(ids.manager, H(FULL)));
      break;
    case 'info':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel])));
      if (ids.verified) rows.push(role(ids.verified, H(READ), H(NO_POST)));
      if (ids.support) rows.push(role(ids.support, H(FULL)));
      if (ids.coowner) rows.push(role(ids.coowner, H(FULL)));
      if (ids.manager) rows.push(member(ids.manager, H(FULL)));
      break;
    case 'vip':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel])));
      if (ids.vip) rows.push(role(ids.vip, H(FULL)));
      if (ids.support) rows.push(role(ids.support, H(FULL)));
      if (ids.coowner) rows.push(role(ids.coowner, H(FULL)));
      if (ids.manager) rows.push(member(ids.manager, H(FULL)));
      break;
    case 'staff':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel])));
      if (ids.support) rows.push(role(ids.support, H(FULL)));
      if (ids.coowner) rows.push(role(ids.coowner, H(FULL)));
      if (ids.manager) rows.push(member(ids.manager, H(FULL)));
      break;
    case 'private':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel, P.Connect])));
      for (const id of ids.privRoles || []) rows.push(role(id, H(FULL)));
      if (ids.owner) rows.push(member(ids.owner, H(FULL)));
      break;
    case 'reminder':
      rows.push(role(ids.everyone, H(READ), H(NO_JOIN)));
      break;
    default:
      throw new Error(`unknown permission set: ${kind}`);
  }
  rows.push(member(ids.bot, H(FULL)));
  return rows.filter((r) => (r.allow && r.allow.length) || (r.deny && r.deny.length));
}

const bits = (list) => {
  let v = 0n;
  for (const f of list || []) v |= BigInt(f);
  return v;
};
const bitfieldOf = (v) => (v && typeof v === 'object' && v.bitfield !== undefined ? BigInt(v.bitfield) : bits(v));

/** True when the channel's current overwrites are not exactly the wanted list. */
function overwritesDiffer(channel, wanted) {
  const cache = channel && channel.permissionOverwrites && channel.permissionOverwrites.cache;
  if (!cache || typeof cache.get !== 'function' || typeof cache.size !== 'number') return true;
  if (cache.size !== wanted.length) return true;
  for (const w of wanted) {
    const cur = cache.get(w.id);
    if (!cur) return true;
    if (bitfieldOf(cur.allow) !== bits(w.allow) || bitfieldOf(cur.deny) !== bits(w.deny)) return true;
  }
  return false;
}

/** Does this message carry the OPEN TICKET button? */
function hasOpenButton(message) {
  const rows = (message && message.components) || [];
  const idOf = (c) => (c && (c.customId !== undefined ? c.customId : c.custom_id)) || null;
  return rows.some((row) => ((row && row.components) || []).some((c) => idOf(c) === BUTTONS.open));
}

const isThread = (c) => !!(c && typeof c.isThread === 'function' && c.isThread());

/**
 * Split the server's channels into what stays and what goes.
 *  keepRoots     category ids that stay untouched together with everything inside them
 *  undeletable   ids Discord will not let a bot delete (Community rules and updates channels)
 * Removal order: children first, categories last.
 */
function classifyChannels(channels, { keepRoots, undeletable, keepChannels = new Set() }) {
  const roots = new Set([...keepRoots].filter(Boolean));
  const all = channels.filter((c) => !isThread(c));
  const kept = all.filter((c) => roots.has(c.id) || roots.has(c.parentId) || keepChannels.has(c.id));
  const keptIds = new Set(kept.map((c) => c.id));
  const rest = all.filter((c) => !keptIds.has(c.id));
  const blocked = rest.filter((c) => undeletable.has(c.id));
  const remove = rest
    .filter((c) => !undeletable.has(c.id))
    .sort((a, b) => {
      const ac = a.type === T.GuildCategory ? 1 : 0;
      const bc = b.type === T.GuildCategory ? 1 : 0;
      return ac - bc || (a.rawPosition || 0) - (b.rawPosition || 0);
    });
  return { kept, remove, blocked };
}

/**
 * Decide what happens to every role.
 *  protectedIds   Map id -> reason for roles that must stay exactly as they are
 *  autoRoleNames  bare names of the auto role (the bot recreates it anyway)
 * Roles are handled highest first. Template roles found by name are reused (renamed in place, so
 * members keep them); the rest are deleted unless they carry Administrator.
 */
function classifyRoles(roles, { botTop, everyoneId, protectedIds, autoRoleNames = [], needVerified = false, deleteRoles = true, preferredSupport = null }) {
  const out = { kept: [], adopt: [], create: [], remove: [] };
  const pool = [];
  for (const r of [...roles].sort((a, b) => b.position - a.position)) {
    if (r.id === everyoneId) continue;
    if (r.managed) out.kept.push({ id: r.id, name: r.name, reason: 'managed by an integration' });
    else if (r.position >= botTop) out.kept.push({ id: r.id, name: r.name, reason: 'above my role' });
    else if (isPlusRole(r)) out.kept.push({ id: r.id, name: r.name, reason: 'the + role' });
    else if (protectedIds.has(r.id)) out.kept.push({ id: r.id, name: r.name, reason: protectedIds.get(r.id) });
    else if (autoRoleNames.includes(normalizeName(r.name))) out.kept.push({ id: r.id, name: r.name, reason: 'auto role' });
    else pool.push(r);
  }

  const wanted = ['coowner', 'support', 'vip', 'friend', 'blank'];
  for (const key of wanted) {
    const spec = ROLE_SPECS[key];
    const preferred = key === 'support' && preferredSupport ? pool.find((r) => r.id === preferredSupport) : null;
    const hit = preferred || pool.find((r) => (spec.blank ? isBlankName(r.name) : spec.match.includes(normalizeName(r.name))));
    if (hit) {
      out.adopt.push({ key, id: hit.id, name: hit.name, to: spec.name });
      pool.splice(pool.indexOf(hit), 1);
    } else {
      out.create.push({ key, name: spec.name });
    }
  }
  if (needVerified) out.create.push({ key: 'verified', name: ROLE_SPECS.verified.name });

  for (const r of pool) {
    if (r.permissions && typeof r.permissions.has === 'function' && r.permissions.has(P.Administrator)) {
      out.kept.push({ id: r.id, name: r.name, reason: 'has Administrator' });
    } else if (deleteRoles) out.remove.push({ id: r.id, name: r.name });
    else out.kept.push({ id: r.id, name: r.name, reason: 'left alone' });
  }
  return out;
}

/**
 * New positions that stack `stack` (lowest first) directly above `anchorId`, or at the top of the
 * band below the bot when there is no anchor. Only roles below the bot are ever moved, and only
 * those whose position actually changes are returned.
 */
function planRoleOrder(roles, { botTop, everyoneId, anchorId, stack }) {
  const below = roles.filter((r) => r.id !== everyoneId && r.position < botTop).sort((a, b) => a.position - b.position);
  const present = stack.filter((id) => below.some((r) => r.id === id));
  const ids = below.map((r) => r.id).filter((id) => !present.includes(id));
  const at = anchorId && ids.includes(anchorId) ? ids.indexOf(anchorId) + 1 : ids.length;
  ids.splice(at, 0, ...present);
  const byId = new Map(below.map((r) => [r.id, r]));
  return ids.map((id, i) => ({ role: id, position: i + 1 })).filter((e) => byId.get(e.role).position !== e.position);
}

/**
 * Who may enter the private channels besides the server owner: every role with Administrator,
 * every role positioned above the lowest of them, and roles named explicitly. Roles that only
 * mark ordinary members are never included, however high they sit: the verified role, the +
 * role, the auto role, website roles and the template's member tiers (`exclude`).
 */
function computePrivRoles(roles, { everyoneId, exclude = new Set(), autoRoleNames = [], extraIds = new Set() }) {
  const usable = roles.filter((r) => r.id !== everyoneId && !r.managed).sort((a, b) => b.position - a.position);
  const isAdmin = (r) => !!(r.permissions && typeof r.permissions.has === 'function' && r.permissions.has(P.Administrator));
  const admins = usable.filter(isAdmin);
  const floor = admins.length ? Math.min(...admins.map((r) => r.position)) : null;
  const out = [];
  for (const r of usable) {
    // Member-marking roles are never listed, even when they happen to carry Administrator.
    if (exclude.has(r.id) || isPlusRole(r) || autoRoleNames.includes(normalizeName(r.name))) continue;
    if (isAdmin(r)) out.push({ id: r.id, name: r.name, why: 'admin role' });
    else if (extraIds.has(r.id)) out.push({ id: r.id, name: r.name, why: 'chosen in the command' });
    else if (floor !== null && r.position > floor) out.push({ id: r.id, name: r.name, why: 'above the admin roles' });
  }
  return out;
}

/** Ids of the roles a channel has permission overwrites for (deleting such a role edits the channel). */
function overwriteRoleIds(channel, guild) {
  const cache = channel && channel.permissionOverwrites && channel.permissionOverwrites.cache;
  if (!cache || typeof cache.values !== 'function') return [];
  return [...cache.values()].map((o) => o.id).filter((id) => id !== guild.id && guild.roles.cache.has(id));
}

const listOf = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ---------- service ----------

class SetupService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.setup, config.web, config.autoRole, config.manager)
   * @param {import('./tickets').TicketService} tickets
   * @param {import('./roleMemory').RoleMemoryService} roleMemory
   */
  constructor(storage, config, tickets, roleMemory) {
    this.storage = storage;
    this.config = config;
    this.tickets = tickets;
    this.roleMemory = roleMemory;
    this.running = new Set();
    this.pending = new Map();
    this.started = new Map();
    /** guildId -> number of finished rebuilds; a preview made before one is stale afterwards */
    this.generation = new Map();
  }

  _bucket(guildId) {
    const all = this.storage.data.setup;
    if (!hasOwn(all, guildId)) setOwn(all, guildId, { roles: {}, channels: {}, keep: [], updatedAt: null });
    const b = all[guildId];
    if (!b.roles || typeof b.roles !== 'object') b.roles = {};
    if (!b.channels || typeof b.channels !== 'object') b.channels = {};
    if (!Array.isArray(b.keep)) b.keep = [];
    return b;
  }

  _gen(guildId) {
    return this.generation.get(guildId) || 0;
  }

  isRunning(guildId) {
    return this.running.has(guildId);
  }

  _held(guild) {
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    return (flags) => (perms ? flags.filter((f) => perms.has(f)) : flags);
  }

  async _refresh(guild) {
    if (guild.channels && typeof guild.channels.fetch === 'function') await guild.channels.fetch().catch(() => {});
    if (guild.roles && typeof guild.roles.fetch === 'function') await guild.roles.fetch().catch(() => {});
  }

  // ---- who counts as verified ----

  /** The verified role of a guild: what /setup stored, else the configured id if it exists there. */
  getVerifiedRoleId(guild) {
    if (!guild || !guild.roles || !guild.roles.cache) return null;
    const all = this.storage.data.setup;
    const stored = hasOwn(all, guild.id) && all[guild.id].roles ? all[guild.id].roles.verified : null;
    if (stored && guild.roles.cache.has(stored)) return stored;
    const cfg = this.config.setup && this.config.setup.verifiedRoleId;
    if (cfg && guild.roles.cache.has(cfg)) return cfg;
    return null;
  }

  /** The channel with the verification panel, if /setup has been run here. */
  getVerifyChannelId(guild) {
    const all = this.storage.data.setup;
    const id = hasOwn(all, guild.id) && all[guild.id].channels ? all[guild.id].channels.verify_ch : null;
    return id && guild.channels && guild.channels.cache && guild.channels.cache.has(id) ? id : null;
  }

  /**
   * May this member use a "verified members only" command?
   * Passes: the manager, anyone with bypass, the server owner, admins (Administrator or Manage
   * Server) and holders of the verified role. A server with no known verified role stays open.
   * Returns { ok: true } or { ok: false, roleId, channelId }.
   */
  verifiedGate(guild, member, user, { isManager = () => false, isBypass = () => false } = {}) {
    if (!guild) return { ok: false, roleId: null, channelId: null };
    if (user && (isManager(user) || isBypass(user))) return { ok: true };
    if (user && guild.ownerId === user.id) return { ok: true };
    const roleId = this.getVerifiedRoleId(guild);
    if (!roleId) return { ok: true };
    const perms = member && member.permissions;
    if (perms && typeof perms.has === 'function' && (perms.has(P.Administrator) || perms.has(P.ManageGuild))) return { ok: true };
    const roles = member && member.roles && member.roles.cache;
    if (roles && typeof roles.has === 'function' && roles.has(roleId)) return { ok: true };
    return { ok: false, roleId, channelId: this.getVerifyChannelId(guild) };
  }

  // ---- preview ----

  _keepRoots(guild, opts) {
    const cfg = this.config.setup;
    const names = new Set((cfg.keepCategories || []).map(normalizeName));
    const stored = new Set(this._bucket(guild.id).keep);
    const cats = [...guild.channels.cache.values()].filter((c) => c.type === T.GuildCategory);
    const roots = new Map();
    for (const c of cats) {
      if (names.has(normalizeName(c.name)) || stored.has(c.id)) roots.set(c.id, c);
    }
    if (opts.keep && opts.keep.id && guild.channels.cache.has(opts.keep.id)) roots.set(opts.keep.id, guild.channels.cache.get(opts.keep.id));
    return [...roots.values()];
  }

  _verifiedRole(guild, opts) {
    const cache = guild.roles.cache;
    const usable = (r) => r && r.id !== guild.id && !r.managed;
    if (usable(opts.verified)) return { role: opts.verified, source: 'chosen in the command' };
    const cfgId = this.config.setup.verifiedRoleId;
    if (cfgId && usable(cache.get(cfgId))) return { role: cache.get(cfgId), source: 'the configured role' };
    const plus = [...cache.values()].find((r) => usable(r) && isPlusRole(r));
    if (plus) return { role: plus, source: 'the + role' };
    const stored = this._bucket(guild.id).roles.verified;
    if (stored && usable(cache.get(stored))) return { role: cache.get(stored), source: 'the role from the last setup' };
    const named = [...cache.values()].find((r) => usable(r) && ROLE_SPECS.verified.match.includes(normalizeName(r.name)));
    if (named) return { role: named, source: 'a role with that name' };
    return { role: null, source: 'created new' };
  }

  /**
   * Work out exactly what a rebuild would do, without touching anything.
   * Returns { ok: false, problems } or { ok: true, plan }.
   */
  async preview(guild, opts = {}) {
    await this._refresh(guild);

    const problems = [];
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    const admin = !!(perms && perms.has(P.Administrator));
    if (!perms || (!admin && !(perms.has(P.ManageChannels) && perms.has(P.ManageRoles) && perms.has(P.ViewChannel)))) {
      problems.push('I need the Administrator permission, or Manage Channels, Manage Roles and View Channels, to rebuild the server.');
    }

    const keepCats = this._keepRoots(guild, opts);
    if (!keepCats.length) {
      const names = (this.config.setup.keepCategories || ['osjetljivo']).join(', ');
      problems.push(`I cannot find the ${names} category, so I will not delete anything. Pick it with the keep option.`);
    }
    if (problems.length) return { ok: false, problems };

    const ticketCat = this.tickets.findCategory(guild);
    const undeletable = new Set([guild.rulesChannelId, guild.publicUpdatesChannelId].filter(Boolean));
    const keepRoots = new Set([...keepCats.map((c) => c.id), ...(ticketCat ? [ticketCat.id] : [])]);
    // The server log channel is never deleted, wherever it sits.
    const keepChannels = new Set([this.config.logs && this.config.logs.channelId].filter(Boolean));
    const channels = classifyChannels([...guild.channels.cache.values()], { keepRoots, undeletable, keepChannels });

    const verified = this._verifiedRole(guild, opts);
    const protectedIds = new Map();
    const protect = (id, why) => id && !protectedIds.has(id) && protectedIds.set(id, why);
    protect(verified.role && verified.role.id, 'verified role');
    protect(this.config.setup.sensitiveRoleId, 'gives access to the kept category');
    protect(opts.priv && opts.priv.id, 'chosen for the priv channels');
    for (const id of (this.config.web && this.config.web.roleIds) || []) protect(id, 'used by the website');
    for (const id of this.config.setup.protectedRoleIds || []) protect(id, 'protected in the settings');
    protect(this.roleMemory.getGuildAutoRole(guild.id), 'auto role');
    if (this.config.autoRole && this.config.autoRole.id) protect(this.config.autoRole.id, 'auto role');
    // Deleting a role removes its permission overwrites everywhere, so roles named in a kept channel stay.
    for (const ch of channels.kept) for (const id of overwriteRoleIds(ch, guild)) protect(id, 'used in a kept channel');

    // The current ticket staff role becomes SUPPORT, unless it carries Administrator: that one stays untouched.
    const staffId = this.tickets.getStaffRole(guild.id);
    const staffRole = staffId ? guild.roles.cache.get(staffId) : null;
    const staffIsAdmin = !!(staffRole && staffRole.permissions && typeof staffRole.permissions.has === 'function' && staffRole.permissions.has(P.Administrator));
    if (staffIsAdmin) protect(staffId, 'the ticket staff role');
    const autoNames = [normalizeName(this.config.autoRole && this.config.autoRole.name)].filter(Boolean);
    const roles = classifyRoles([...guild.roles.cache.values()], {
      botTop: me.roles.highest.position,
      everyoneId: guild.id,
      protectedIds,
      autoRoleNames: autoNames,
      needVerified: !verified.role,
      deleteRoles: opts.deleteRoles !== false,
      preferredSupport: staffRole && !staffRole.managed && !staffIsAdmin ? staffRole.id : null,
    });

    // Priv access: admins and everyone above them. Those roles are kept, never deleted.
    const exclude = new Set([verified.role && verified.role.id, ...((this.config.web && this.config.web.roleIds) || [])].filter(Boolean));
    for (const a of roles.adopt) if (a.key !== 'coowner') exclude.add(a.id);
    const priv = computePrivRoles([...guild.roles.cache.values()], {
      everyoneId: guild.id,
      exclude,
      autoRoleNames: autoNames,
      extraIds: new Set([opts.priv && opts.priv.id].filter(Boolean)),
    });
    const privIds = new Set(priv.map((r) => r.id));
    roles.remove = roles.remove.filter((r) => {
      if (!privIds.has(r.id)) return true;
      roles.kept.push({ id: r.id, name: r.name, reason: 'has priv access' });
      return false;
    });

    const removeIds = new Set(channels.remove.map((c) => c.id));
    let invites = 0;
    if (guild.invites && typeof guild.invites.fetch === 'function') {
      try {
        const all = await guild.invites.fetch();
        for (const i of all.values()) if (removeIds.has(i.channelId || (i.channel && i.channel.id))) invites += 1;
      } catch {
        /* needs Manage Server; without it the warning is skipped */
      }
    }

    const warnings = [];
    if (verified.role && verified.role.position >= me.roles.highest.position) {
      warnings.push(`My role is not above ${verified.role.name}, so I cannot hand it out. Move my role higher.`);
    }
    if (channels.blocked.length) {
      warnings.push(`Discord will not let me delete ${channels.blocked.map((c) => c.name).join(', ')} (required by Community).`);
    }
    if (invites) {
      warnings.push(`${plural(invites, 'invite')} for channels that will be deleted will stop working. A new permanent invite is created and shown in the summary.`);
    }

    return {
      ok: true,
      plan: {
        guildId: guild.id,
        gen: this._gen(guild.id),
        createdAt: Date.now(),
        opts: { verifiedId: verified.role ? verified.role.id : null, privId: opts.priv ? opts.priv.id : null, deleteRoles: opts.deleteRoles !== false, keepId: opts.keep ? opts.keep.id : null },
        verified: { name: verified.role ? verified.role.name : ROLE_SPECS.verified.name, source: verified.source, id: verified.role ? verified.role.id : null },
        keepCategories: keepCats.map((c) => ({ id: c.id, name: c.name })),
        ticketCategory: ticketCat ? { id: ticketCat.id, name: ticketCat.name } : null,
        keepRoots: [...keepRoots],
        keptChannels: channels.kept.filter((c) => c.type !== T.GuildCategory).map((c) => ({ id: c.id, name: c.name })),
        remove: channels.remove.map((c) => ({ id: c.id, name: c.name, category: c.type === T.GuildCategory })),
        blocked: channels.blocked.map((c) => ({ id: c.id, name: c.name })),
        roles,
        priv,
        afk: guild.afkChannelId && removeIds.has(guild.afkChannelId) ? { timeout: guild.afkTimeout } : null,
        system: !!(guild.systemChannelId && removeIds.has(guild.systemChannelId)),
        invites,
        create: buildLayout(this.config.setup.siteName),
        warnings,
      },
    };
  }

  // ---- pending confirmations ----

  createPending(plan, userId) {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const token = crypto.randomBytes(8).toString('hex');
    this.pending.set(token, { plan, userId, guildId: plan.guildId, expires: now + this.config.setup.confirmTtlMs });
    return token;
  }

  /** Single use: the entry is removed whether or not it matches. */
  takePending(token, { guildId, userId }) {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    if (!entry || entry.expires < Date.now() || entry.guildId !== guildId || entry.userId !== userId) return null;
    this.started.set(token, Date.now());
    return entry.plan;
  }

  /** True while a token that was already used may still be pressed again (a double click). */
  wasStarted(token) {
    const at = this.started.get(token);
    if (at === undefined) return false;
    if (Date.now() - at > 60_000) {
      this.started.delete(token);
      return false;
    }
    return true;
  }

  dropPending(token) {
    this.pending.delete(token);
  }

  /** After a rebuild every other open preview for that guild is out of date. */
  _invalidate(guildId) {
    for (const [k, v] of this.pending) if (v.guildId === guildId) this.pending.delete(k);
  }

  // ---- execute ----

  /**
   * Rebuild the server from a previewed plan. Order matters:
   *   1. roles, 2. build every new channel, 3. only then delete what the preview listed,
   *   4. ordering, settings, the panel.
   * If roles or the build fail, what was created is removed again (and renamed roles are renamed
   * back) and nothing old is deleted. Only channels and roles named in the preview are ever
   * deleted, and never anything inside a kept category or anything a kept channel refers to.
   *
   * Returns { ok: true, report, fallbackChannelId, invite } or { ok: false, reason, ... } with
   * reason: in_progress | stale | keep_missing | verified_missing | roles_failed | build_failed | partial
   */
  async execute(guild, plan, { onProgress = async () => {} } = {}) {
    if (this.running.has(guild.id)) return { ok: false, reason: 'in_progress' };
    this.running.add(guild.id);
    const report = { created: [], updated: [], deleted: [], kept: [], failed: [], warnings: [...plan.warnings], invite: null };
    const created = [];
    const undo = { created: [], renamed: [] };
    const built = { channels: {}, top: [], categories: [], tickets: null };
    let destructive = false;
    const fallback = () => (built.channels.priv_chat && built.channels.priv_chat.id) || (built.channels.verify_ch && built.channels.verify_ch.id) || null;
    try {
      await this._refresh(guild);
      if (plan.gen !== this._gen(guild.id)) return { ok: false, reason: 'stale' };
      const me = guild.members.me;
      const cache = guild.channels.cache;
      for (const c of plan.keepCategories) {
        if (!cache.has(c.id)) return { ok: false, reason: 'keep_missing', name: c.name };
      }
      if (plan.opts.verifiedId && !guild.roles.cache.has(plan.opts.verifiedId)) return { ok: false, reason: 'verified_missing' };

      await onProgress('Roles');
      const R = await this._roles(guild, plan, report, undo);
      const missing = ['verified', 'support', 'coowner'].filter((k) => !R[k]);
      if (missing.length) {
        const left = await this._rollback(guild, [], undo);
        return { ok: false, reason: 'roles_failed', message: `The ${missing.join(' and ')} role could not be set up.`, left, report };
      }

      const managerId = this.config.manager.id;
      const ids = {
        everyone: guild.id,
        bot: me.id,
        owner: guild.ownerId,
        manager: managerId && managerId !== guild.ownerId && guild.members.cache.has(managerId) ? managerId : null,
        verified: R.verified.id,
        support: R.support.id,
        vip: R.vip ? R.vip.id : null,
        coowner: R.coowner.id,
        privRoles: [...new Set([...plan.priv.map((r) => r.id).filter((id) => guild.roles.cache.has(id)), R.coowner.id])],
      };

      await onProgress('Building');
      try {
        await this._build(guild, plan, ids, built, created, report);
      } catch (err) {
        const left = await this._rollback(guild, created, undo);
        return { ok: false, reason: 'build_failed', message: err.message, left, report };
      }

      // From here on the new layout stands; a failure means the server is partly rebuilt.
      destructive = true;
      await this._retagTickets(guild, R, built, report);
      await this._panel(guild, built, report);

      const liveRoots = new Set([...plan.keepRoots, built.tickets.cat.id]);
      const newIds = new Set(created.map((c) => c.id));
      await onProgress('Removing old channels');
      for (const item of plan.remove) {
        const ch = cache.get(item.id);
        if (!ch || newIds.has(ch.id)) continue;
        if (liveRoots.has(ch.id) || liveRoots.has(ch.parentId) || ch.id === built.tickets.tr.id || ch.id === (this.config.logs && this.config.logs.channelId)) continue; // kept, or moved into a kept category since the preview
        try {
          await ch.delete('35xw /setup server');
          report.deleted.push(item.name);
        } catch (err) {
          report.failed.push(`${item.name}: ${err.message}`);
        }
      }

      if (plan.opts.deleteRoles) {
        await onProgress('Removing old roles');
        const usedByKept = this._usedByKeptChannels(guild, liveRoots);
        for (const item of plan.roles.remove) {
          const role = guild.roles.cache.get(item.id);
          if (!role || this._keepRoleNow(guild, role, plan, R, me, usedByKept)) continue;
          try {
            await role.delete('35xw /setup server');
            report.deleted.push(`role ${item.name}`);
          } catch (err) {
            report.failed.push(`role ${item.name}: ${err.message}`);
          }
        }
      }

      await onProgress('Ordering');
      await this._order(guild, plan, built, R, report);
      await this._settings(guild, plan, built, report);

      try {
        const b = this._bucket(guild.id);
        b.roles = {};
        for (const [k, r] of Object.entries(R)) if (r) setOwn(b.roles, k, r.id);
        b.channels = {};
        for (const [k, ch] of Object.entries(built.channels)) if (ch) setOwn(b.channels, k, ch.id);
        b.keep = plan.keepCategories.map((c) => c.id);
        b.updatedAt = Date.now();
        this.storage.save();
      } catch (err) {
        report.warnings.push(`I could not save the new layout to disk (${err.message}). Run /setup server again only if the bot forgets it.`);
      }

      for (const c of plan.keepCategories) report.kept.push(c.name);
      for (const r of plan.roles.kept) report.kept.push(`role ${r.name}`);
      this.generation.set(guild.id, this._gen(guild.id) + 1);
      this._invalidate(guild.id);
      return { ok: true, report, fallbackChannelId: fallback(), invite: report.invite };
    } catch (err) {
      if (destructive) return { ok: false, reason: 'partial', message: err.message, report, fallbackChannelId: fallback() };
      await this._rollback(guild, created, undo).catch(() => {});
      throw err;
    } finally {
      this.running.delete(guild.id);
    }
  }

  /** Roles the deletion loop must still skip, judged on the live server and not on the old preview. */
  _keepRoleNow(guild, role, plan, R, me, usedByKept) {
    if (role.managed || role.position >= me.roles.highest.position || isPlusRole(role)) return true;
    if (Object.values(R).some((x) => x && x.id === role.id)) return true;
    if (plan.roles.kept.some((k) => k.id === role.id)) return true;
    if (role.permissions && typeof role.permissions.has === 'function' && role.permissions.has(P.Administrator)) return true;
    if (usedByKept.has(role.id) || role.id === this.tickets.getStaffRole(guild.id)) return true;
    const cfg = this.config.setup;
    const listed = [cfg.sensitiveRoleId, cfg.verifiedRoleId, ...(cfg.protectedRoleIds || []), ...((this.config.web && this.config.web.roleIds) || []), this.roleMemory.getGuildAutoRole(guild.id), this.config.autoRole && this.config.autoRole.id];
    return listed.filter(Boolean).includes(role.id);
  }

  _usedByKeptChannels(guild, roots) {
    const used = new Set();
    for (const ch of guild.channels.cache.values()) {
      if (roots.has(ch.id) || roots.has(ch.parentId)) for (const id of overwriteRoleIds(ch, guild)) used.add(id);
    }
    return used;
  }

  async _roles(guild, plan, report, undo) {
    const cache = guild.roles.cache;
    const R = {};
    const verifiedId = plan.opts.verifiedId;
    if (verifiedId && cache.has(verifiedId)) R.verified = cache.get(verifiedId);
    const safe = async (label, fn) => {
      try {
        return await fn();
      } catch (err) {
        report.failed.push(`role ${label}: ${err.message}`);
        return null;
      }
    };
    for (const a of plan.roles.adopt) {
      const role = cache.get(a.id);
      if (!role) continue;
      const spec = ROLE_SPECS[a.key];
      const before = { name: role.name, hoist: role.hoist };
      if (role.name !== spec.name) {
        const done = await safe(a.name, async () => {
          await role.edit({ name: spec.name, reason: '35xw /setup server' });
          return true;
        });
        if (done) {
          undo.renamed.push({ role, oldName: before.name, oldHoist: before.hoist });
          report.updated.push(`role ${a.name} renamed to ${spec.name}`);
        }
      }
      if (spec.blank && role.hoist) await safe(a.name, () => role.edit({ hoist: false, reason: '35xw /setup server' }));
      R[a.key] = role;
    }
    for (const c of plan.roles.create) {
      const spec = ROLE_SPECS[c.key];
      const role = await safe(spec.name, () =>
        guild.roles.create({ name: spec.name, color: spec.color || undefined, hoist: false, mentionable: false, permissions: [], reason: '35xw /setup server' }),
      );
      if (role) {
        R[c.key] = role;
        undo.created.push(role);
        report.created.push(`role ${spec.name}`);
      }
    }
    return R;
  }

  /** Undo what a failed run created: new channels and roles are deleted, renamed roles get their name back. */
  async _rollback(guild, created, undo) {
    const left = { channels: [], roles: [] };
    for (const ch of [...created].reverse()) {
      try {
        await ch.delete('35xw /setup rollback');
      } catch {
        left.channels.push(ch.name);
      }
    }
    for (const r of [...undo.created].reverse()) {
      try {
        await r.delete('35xw /setup rollback');
      } catch {
        left.roles.push(`${r.name} was created and could not be removed`);
      }
    }
    for (const { role, oldName, oldHoist } of [...undo.renamed].reverse()) {
      try {
        await role.edit({ name: oldName, hoist: oldHoist, reason: '35xw /setup rollback' });
      } catch {
        left.roles.push(`${oldName} is still renamed to ${role.name}`);
      }
    }
    return left;
  }

  async _create(guild, spec, parentId, ids, held, created, report) {
    const isCategory = spec.type === T.GuildCategory;
    const payload = {
      name: spec.name,
      type: spec.type,
      permissionOverwrites: permsFor(spec.perms, ids, held),
      reason: '35xw /setup server',
    };
    if (parentId) payload.parent = parentId;
    if (spec.topic) payload.topic = spec.topic;
    const ch = await guild.channels.create(payload);
    created.push(ch);
    report.created.push(`${isCategory ? 'category' : spec.type === T.GuildVoice ? 'voice' : 'channel'} ${ch.name || spec.name}`);
    return ch;
  }

  async _build(guild, plan, ids, built, created, report) {
    const held = this._held(guild);
    const layout = plan.create;
    for (const spec of layout.top) {
      const ch = await this._create(guild, spec, null, ids, held, created, report);
      built.channels[spec.key] = ch;
      built.top.push(ch);
    }
    for (const cspec of layout.categories) {
      if (cspec.managed) {
        // The tickets category and #transcripts are kept. If the ticket service has to create them, only those two count as ours.
        const known = new Set(guild.channels.cache.keys());
        const cat = await this.tickets.ensureCategory(guild);
        if (!known.has(cat.id)) created.push(cat);
        const tr = await this.tickets.ensureTranscriptChannel(guild);
        if (!known.has(tr.id)) created.push(tr);
        built.tickets = { cat, tr };
        built.categories.push(cat);
        continue;
      }
      const cat = await this._create(guild, { ...cspec, type: T.GuildCategory }, null, ids, held, created, report);
      built.categories.push(cat);
      built.channels[cspec.key] = cat;
      for (const child of cspec.channels) {
        const ch = await this._create(guild, child, cat.id, ids, held, created, report);
        built.channels[child.key] = ch;
        if (child.panel) built.panelChannel = ch;
      }
    }
  }

  /** After a successful build: the new support role becomes the ticket staff, and the kept ticket channels learn about it. */
  async _retagTickets(guild, R, built, report) {
    this.tickets.setStaffRole(guild.id, R.support.id);
    const { cat, tr } = built.tickets;
    const base = this.tickets._baseOverwrites(guild);
    try {
      if (overwritesDiffer(cat, base)) {
        await cat.edit({ permissionOverwrites: base, reason: '35xw /setup server' });
        report.updated.push(`category ${cat.name} permissions`);
      }
      if (overwritesDiffer(tr, base)) {
        await tr.edit({ permissionOverwrites: base, reason: '35xw /setup server' });
        report.updated.push(`channel ${tr.name} permissions`);
      }
    } catch (err) {
      report.failed.push(`tickets category permissions: ${err.message}`);
    }
    const open = Object.entries(this.tickets._guild(guild.id).tickets).filter(([, t]) => t && t.status === 'open');
    let touched = 0;
    for (const [channelId] of open) {
      const ch = guild.channels.cache.get(channelId);
      if (!ch || !ch.permissionOverwrites || typeof ch.permissionOverwrites.edit !== 'function') continue;
      try {
        await ch.permissionOverwrites.edit(R.support.id, this.tickets._memberAllow(guild), { reason: '35xw /setup server' });
        touched += 1;
      } catch (err) {
        report.failed.push(`${ch.name}: ${err.message}`);
      }
    }
    if (touched) report.updated.push(`${plural(touched, 'open ticket')} now include the support role`);
  }

  /** Post the verification panel into the new verify channel. */
  async _panel(guild, built, report) {
    const ch = built.panelChannel;
    if (!ch || typeof ch.send !== 'function') return;
    try {
      await ch.send({ embeds: [panelEmbed()], components: [panelRow()] });
      report.created.push('verification panel');
    } catch (err) {
      report.failed.push(`verification panel: ${err.message}`);
    }
  }

  /** Channel order (new categories first, kept ones last) and role order (template stack above the verified role). */
  async _order(guild, plan, built, R, report) {
    if (guild.channels && typeof guild.channels.setPositions === 'function') {
      const keepIds = new Set(plan.keepCategories.map((c) => c.id));
      const layoutIds = new Set([...built.top, ...built.categories].map((c) => c.id));
      const leftovers = [...guild.channels.cache.values()].filter((c) => !c.parentId && !layoutIds.has(c.id) && !keepIds.has(c.id) && !isThread(c));
      const looseChannels = leftovers.filter((c) => c.type !== T.GuildCategory);
      const otherCategories = leftovers.filter((c) => c.type === T.GuildCategory);
      const keptCategories = plan.keepCategories.map((c) => guild.channels.cache.get(c.id)).filter(Boolean);
      const ordered = [...built.top, ...looseChannels, ...built.categories, ...otherCategories, ...keptCategories];
      try {
        await guild.channels.setPositions(ordered.map((c, i) => ({ channel: c.id, position: i })));
      } catch (err) {
        report.warnings.push(`I could not set the channel order (${err.message}). Drag the categories into place.`);
      }
    }
    if (guild.roles && typeof guild.roles.setPositions === 'function') {
      const me = guild.members.me;
      const stack = ROLE_STACK.map((k) => R[k] && R[k].id).filter(Boolean);
      const anchor = R.verified && R.verified.position < me.roles.highest.position ? R.verified.id : null;
      const moves = planRoleOrder([...guild.roles.cache.values()], { botTop: me.roles.highest.position, everyoneId: guild.id, anchorId: anchor, stack });
      if (moves.length) {
        try {
          await guild.roles.setPositions(moves);
        } catch (err) {
          report.warnings.push(`I could not set the role order (${err.message}). Drag the new roles into place.`);
        }
      }
    }
  }

  /** Server settings that pointed at deleted channels (AFK, system messages) and the permanent invite. */
  async _settings(guild, plan, built, report) {
    const warn = (what, err) => report.warnings.push(`I could not ${what} (${err.message}).`);
    if (plan.afk && built.channels.afk && typeof guild.setAFKChannel === 'function') {
      try {
        await guild.setAFKChannel(built.channels.afk, '35xw /setup server');
        report.updated.push('the AFK channel points at the new AFK voice channel');
      } catch (err) {
        warn('set the AFK channel', err);
      }
    }
    if (plan.system && built.channels.chat && typeof guild.setSystemChannel === 'function') {
      try {
        await guild.setSystemChannel(built.channels.chat, '35xw /setup server');
        report.updated.push('system messages go to the new chat channel');
      } catch (err) {
        warn('set the system messages channel', err);
      }
    }
    const verifyCh = built.channels.verify_ch;
    if (plan.invites > 0 && verifyCh && typeof verifyCh.createInvite === 'function') {
      try {
        const invite = await verifyCh.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: '35xw /setup server' });
        report.invite = invite.url;
      } catch (err) {
        warn('create a new invite', err);
      }
    }
  }
}

module.exports = {
  SetupService,
  STYLE,
  BLANK_ROLE_NAME,
  ROLE_SPECS,
  ROLE_STACK,
  buildLayout,
  normalizeName,
  isBlankName,
  isPlusRole,
  permsFor,
  overwritesDiffer,
  hasOpenButton,
  classifyChannels,
  classifyRoles,
  computePrivRoles,
  overwriteRoleIds,
  planRoleOrder,
  TEXT,
  listOf,
};
