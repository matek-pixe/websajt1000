'use strict';

const crypto = require('node:crypto');
const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
const { panelEmbed, panelRow, BUTTONS } = require('./tickets');

const P = PermissionFlagsBits;
const T = ChannelType;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Every name the layout creates follows "<icon> ıl NAME". */
const STYLE = (icon, label) => `${icon} ıl ${label}`;
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
    .replace(/[^a-z0-9#.]+/g, '');
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
  const voice = (n) => ({ key: `voice${n}`, name: STYLE('🔊', `VOICE #${n}`), type: T.GuildVoice, perms: 'members' });
  return {
    top: [{ key: 'site', name: STYLE('🌐', siteName), type: T.GuildVoice, perms: 'reminder' }],
    categories: [
      {
        key: 'private',
        name: STYLE('🔒', 'PRIVATE'),
        perms: 'private',
        channels: [
          { key: 'priv_chat', name: STYLE('🔒', 'PRIV-CHAT'), type: T.GuildText, perms: 'private', topic: 'Private chat for admins and the priv role.' },
          { key: 'priv', name: STYLE('🔒', 'PRIV'), type: T.GuildVoice, perms: 'private' },
        ],
      },
      {
        key: 'verify',
        name: STYLE('✅', 'VERIFY'),
        perms: 'verify',
        channels: [
          { key: 'verify_ch', name: STYLE('🎫', 'VERIFY'), type: T.GuildText, perms: 'verify', topic: 'Open a ticket to get access to the server.', panel: true },
        ],
      },
      { key: 'tickets', managed: true },
      {
        key: 'general',
        name: STYLE('🌍', 'GENERAL'),
        perms: 'members',
        channels: [
          { key: 'chat', name: STYLE('💬', 'CHAT'), type: T.GuildText, perms: 'members', topic: 'General chat for verified members.' },
          { key: 'cmds', name: STYLE('🤖', 'CMDS'), type: T.GuildText, perms: 'members', topic: 'Bot commands go here.' },
          { key: 'server', name: STYLE('📢', 'SERVER'), type: T.GuildText, perms: 'members', topic: 'News and info about the server.' },
          { key: 'dump', name: STYLE('🗑️', 'DUMP'), type: T.GuildText, perms: 'members', topic: 'Anything goes. Media, links, random.' },
        ],
      },
      {
        key: 'voice',
        name: STYLE('🔊', 'VOICE'),
        perms: 'members',
        channels: [voice(1), voice(2), voice(3)],
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
 *  private   the server owner and the priv role only
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
      if (ids.manager) rows.push(member(ids.manager, H([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])));
      break;
    case 'members':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel])));
      if (ids.verified) rows.push(role(ids.verified, H(FULL)));
      if (ids.support) rows.push(role(ids.support, H(FULL)));
      if (ids.manager) rows.push(member(ids.manager, H(FULL)));
      break;
    case 'private':
      rows.push(role(ids.everyone, undefined, H([P.ViewChannel, P.Connect])));
      if (ids.priv) rows.push(role(ids.priv, H(FULL)));
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
function classifyChannels(channels, { keepRoots, undeletable }) {
  const roots = new Set([...keepRoots].filter(Boolean));
  const all = channels.filter((c) => !isThread(c));
  const kept = all.filter((c) => roots.has(c.id) || roots.has(c.parentId));
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
function classifyRoles(roles, { botTop, everyoneId, protectedIds, autoRoleNames = [], needVerified = false, deleteRoles = true }) {
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
    const hit = pool.find((r) => (spec.blank ? isBlankName(r.name) : spec.match.includes(normalizeName(r.name))));
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

  isRunning(guildId) {
    return this.running.has(guildId);
  }

  _held(guild) {
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    return (flags) => (perms ? flags.filter((f) => perms.has(f)) : flags);
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

  _ticketCategory(guild) {
    const b = this.tickets._guild(guild.id);
    const wanted = normalizeName(this.config.tickets.categoryName);
    const cats = [...guild.channels.cache.values()].filter((c) => c.type === T.GuildCategory);
    return (b.categoryId && cats.find((c) => c.id === b.categoryId)) || cats.find((c) => normalizeName(c.name) === wanted) || null;
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
    return { role: null, source: 'created new' };
  }

  /**
   * Work out exactly what a rebuild would do, without touching anything.
   * Returns { ok: false, problems } or { ok: true, plan }.
   */
  async preview(guild, opts = {}) {
    if (guild.channels && typeof guild.channels.fetch === 'function') await guild.channels.fetch().catch(() => {});
    if (guild.roles && typeof guild.roles.fetch === 'function') await guild.roles.fetch().catch(() => {});

    const problems = [];
    const me = guild.members.me;
    const perms = me && me.permissions && typeof me.permissions.has === 'function' ? me.permissions : null;
    const admin = !!(perms && perms.has(P.Administrator));
    if (!perms || (!admin && (!perms.has(P.ManageChannels) || !perms.has(P.ManageRoles)))) {
      problems.push('I need the Administrator permission, or Manage Channels and Manage Roles, to rebuild the server.');
    }

    const keepCats = this._keepRoots(guild, opts);
    if (!keepCats.length) {
      const names = (this.config.setup.keepCategories || ['osjetljivo']).join(', ');
      problems.push(`I cannot find the ${names} category, so I will not delete anything. Pick it with the keep option.`);
    }
    const ticketCat = this._ticketCategory(guild);

    if (problems.length) return { ok: false, problems };

    const undeletable = new Set([guild.rulesChannelId, guild.publicUpdatesChannelId].filter(Boolean));
    const keepRoots = new Set([...keepCats.map((c) => c.id), ...(ticketCat ? [ticketCat.id] : [])]);
    const channels = classifyChannels([...guild.channels.cache.values()], { keepRoots, undeletable });

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

    const autoNames = [normalizeName(this.config.autoRole && this.config.autoRole.name)].filter(Boolean);
    const roles = classifyRoles([...guild.roles.cache.values()], {
      botTop: me.roles.highest.position,
      everyoneId: guild.id,
      protectedIds,
      autoRoleNames: autoNames,
      needVerified: !verified.role,
      deleteRoles: opts.deleteRoles !== false,
    });

    const warnings = [];
    if (verified.role && verified.role.position >= me.roles.highest.position) {
      warnings.push(`My role is not above ${verified.role.name}, so I cannot hand it out. Move my role higher.`);
    }
    if (channels.blocked.length) {
      warnings.push(`Discord will not let me delete ${channels.blocked.map((c) => c.name).join(', ')} (required by Community).`);
    }

    return {
      ok: true,
      plan: {
        guildId: guild.id,
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
    return entry.plan;
  }

  dropPending(token) {
    this.pending.delete(token);
  }

  // ---- execute ----

  /**
   * Rebuild the server from a previewed plan. Order matters:
   *   1. roles, 2. build every new channel, 3. only then delete what the preview listed,
   *   4. ordering and the panel.
   * If the build fails, every channel created so far is removed again and nothing old is deleted.
   * Only channels and roles named in the preview are ever deleted, and never anything inside a
   * kept category.
   */
  async execute(guild, plan, { onProgress = async () => {} } = {}) {
    if (this.running.has(guild.id)) return { ok: false, reason: 'in_progress' };
    this.running.add(guild.id);
    const report = { created: [], updated: [], deleted: [], kept: [], failed: [], warnings: [...plan.warnings] };
    const created = [];
    try {
      if (guild.channels && typeof guild.channels.fetch === 'function') await guild.channels.fetch().catch(() => {});
      if (guild.roles && typeof guild.roles.fetch === 'function') await guild.roles.fetch().catch(() => {});
      const me = guild.members.me;
      const cache = guild.channels.cache;
      const keepRoots = new Set(plan.keepRoots);
      for (const c of plan.keepCategories) {
        if (!cache.has(c.id)) return { ok: false, reason: 'keep_missing', name: c.name };
      }

      await onProgress('Roles');
      const R = await this._roles(guild, plan, report);

      const managerId = this.config.manager.id;
      const ids = {
        everyone: guild.id,
        bot: me.id,
        owner: guild.ownerId,
        manager: managerId && managerId !== guild.ownerId && guild.members.cache.has(managerId) ? managerId : null,
        verified: R.verified ? R.verified.id : null,
        support: R.support ? R.support.id : null,
        priv: plan.opts.privId || (R.coowner ? R.coowner.id : null),
      };
      if (R.support) this.tickets.setStaffRole(guild.id, R.support.id);

      await onProgress('Building');
      const built = { channels: {}, top: [], categories: [] };
      try {
        await this._build(guild, plan, ids, built, created, report);
      } catch (err) {
        for (const ch of created.reverse()) await ch.delete('35xw /setup rollback').catch(() => {});
        return { ok: false, reason: 'build_failed', message: err.message, report };
      }

      await this._panel(guild, built, report);

      await onProgress('Removing old channels');
      for (const item of plan.remove) {
        const ch = cache.get(item.id);
        if (!ch) continue;
        if (keepRoots.has(ch.id) || keepRoots.has(ch.parentId)) continue; // moved into a kept category since the preview
        try {
          await ch.delete('35xw /setup server');
          report.deleted.push(item.name);
        } catch (err) {
          report.failed.push(`${item.name}: ${err.message}`);
        }
      }

      if (plan.opts.deleteRoles) {
        await onProgress('Removing old roles');
        for (const item of plan.roles.remove) {
          const role = guild.roles.cache.get(item.id);
          if (!role || role.managed || role.position >= me.roles.highest.position || isPlusRole(role)) continue;
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

      const b = this._bucket(guild.id);
      b.roles = {};
      for (const [k, r] of Object.entries(R)) if (r) setOwn(b.roles, k, r.id);
      b.channels = {};
      for (const [k, ch] of Object.entries(built.channels)) if (ch) setOwn(b.channels, k, ch.id);
      b.keep = plan.keepCategories.map((c) => c.id);
      b.updatedAt = Date.now();
      this.storage.save();

      for (const c of plan.keepCategories) report.kept.push(c.name);
      for (const r of plan.roles.kept) report.kept.push(`role ${r.name}`);
      return { ok: true, report };
    } finally {
      this.running.delete(guild.id);
    }
  }

  async _roles(guild, plan, report) {
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
      if (role.name !== spec.name) {
        await safe(a.name, async () => {
          await role.edit({ name: spec.name, reason: '35xw /setup server' });
          report.updated.push(`role ${a.name} renamed to ${spec.name}`);
        });
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
        report.created.push(`role ${spec.name}`);
      }
    }
    if (plan.opts.privId && cache.has(plan.opts.privId)) R.priv = cache.get(plan.opts.privId);
    else if (R.coowner) R.priv = R.coowner;
    return R;
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
    report.created.push(`${isCategory ? 'category' : spec.type === T.GuildVoice ? 'voice' : 'channel'} ${spec.name}`);
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
        // The ticket service may create the category and #transcripts; track them so a failed build removes them too.
        const known = new Set(guild.channels.cache.keys());
        const cat = await this._ensureTickets(guild, report);
        for (const ch of guild.channels.cache.values()) if (!known.has(ch.id)) created.push(ch);
        if (cat) built.categories.push(cat);
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

  /** The tickets category and #transcripts are kept, and re-permissioned for the new support role. */
  async _ensureTickets(guild, report) {
    try {
      const cat = await this.tickets.ensureCategory(guild);
      const base = this.tickets._baseOverwrites(guild);
      if (overwritesDiffer(cat, base)) {
        await cat.edit({ permissionOverwrites: base, reason: '35xw /setup server' });
        report.updated.push(`category ${cat.name} permissions`);
      }
      const tr = await this.tickets.ensureTranscriptChannel(guild);
      const patch = {};
      if ((tr.parentId || null) !== cat.id) {
        patch.parent = cat.id;
        patch.lockPermissions = false;
      }
      if (overwritesDiffer(tr, base)) patch.permissionOverwrites = base;
      if (Object.keys(patch).length) {
        await tr.edit({ ...patch, reason: '35xw /setup server' });
        report.updated.push(`channel ${tr.name} permissions`);
      }
      return cat;
    } catch (err) {
      report.failed.push(`tickets category: ${err.message}`);
      return null;
    }
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
  planRoleOrder,
  listOf,
};
