'use strict';

const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
const norm = (s) => String(s || '').trim().toLowerCase();
const bits = (v) => BigInt(v && v.bitfield !== undefined ? v.bitfield : v || 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a role may do in a category it is opened for: see it, write, and join and speak in voice. */
const GRANT = Object.freeze({
  ViewChannel: true,
  SendMessages: true,
  SendMessagesInThreads: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
  AddReactions: true,
  Connect: true,
  Speak: true,
  Stream: true,
  UseVAD: true,
});

/** What staff may do on the server: kick people and delete messages, nothing else. */
const STAFF_NAMES = Object.freeze(['KickMembers', 'ManageMessages']);
const STAFF_PERMS = STAFF_NAMES.map((n) => P[n]);

/** What staff gets in the private category and the log channel: look, nothing more. */
const READ_ALLOW = Object.freeze(['ViewChannel', 'ReadMessageHistory']);
const READ_DENY = Object.freeze(['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions', 'ManageMessages', 'Connect', 'Speak']);

/**
 * The role setup behind /priv:
 *   priv    a role with no permissions of its own that opens the private category
 *   staff   a role that can only kick people and delete messages; it opens the staff categories and may read the private category and the log
 *   member  the role every member gets: its name fixed, the other roles called member removed, given to everyone
 * It first works out exactly what it would do (plan), and only a confirmed plan is carried out.
 */
class PrivService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.priv, config.autoRole, config.setup, config.web)
   * @param {object} [deps] { roleMemory, setup, tickets } to protect the roles other features rely on
   */
  constructor(storage, config, { roleMemory = null, setup = null, tickets = null } = {}) {
    this.storage = storage;
    this.config = config;
    this.opts = config.priv;
    this.roleMemory = roleMemory;
    this.setup = setup;
    this.tickets = tickets;
    this.busy = new Set();
    this.pending = new Map(); // token -> { userId, guildId, plan, expires }
    this.confirmTtlMs = 5 * 60 * 1000;
    this.giveGapMs = 0; // pause between role gives, Discord rate-limits them on its own
  }

  _all() {
    const d = this.storage.data;
    if (!d.priv || typeof d.priv !== 'object') d.priv = {};
    return d.priv;
  }

  _rec(guildId) {
    const all = this._all();
    if (!hasOwn(all, guildId) || !all[guildId]) setOwn(all, guildId, {});
    return all[guildId];
  }

  /** The id of the priv role this server already has, remembered even if somebody renames it. */
  roleId(guildId) {
    const all = this._all();
    return hasOwn(all, guildId) && all[guildId] ? all[guildId].roleId || null : null;
  }

  staffRoleId(guildId) {
    const all = this._all();
    return hasOwn(all, guildId) && all[guildId] ? all[guildId].staffRoleId || null : null;
  }

  /** A category of this server by id, or null when it is not here (or is not a category). */
  _category(guild, id) {
    const c = guild.channels.cache.get(id);
    return c && c.type === 4 ? c : null; // 4 = category
  }

  category(guild) {
    return this._category(guild, this.opts.categoryId);
  }

  /** The remembered role, else a regular role already called that, else null. */
  _existing(guild, key, name) {
    const rec = this._all()[guild.id];
    const stored = rec && rec[key] ? guild.roles.cache.get(rec[key]) : null;
    if (stored) return stored;
    return [...guild.roles.cache.values()].find((r) => !r.managed && r.id !== guild.id && norm(r.name) === norm(name)) || null;
  }

  _inside(guild, category) {
    return [...guild.channels.cache.values()].filter((c) => c.parentId === category.id);
  }

  // ====================================================================================
  // plan: what would happen, nothing is changed
  // ====================================================================================

  async plan(guild) {
    const o = this.opts;
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    const problems = [];
    if (!me || !me.permissions.has(P.ManageRoles)) problems.push('I need the Manage Roles permission.');
    const botTop = me && me.roles && me.roles.highest ? me.roles.highest.position : 0;

    const privCat = this.category(guild);
    const staffCats = o.staffCategoryIds.map((id) => this._category(guild, id)).filter(Boolean);
    const staffMissing = o.staffCategoryIds.filter((id) => !staffCats.some((c) => c.id === id));
    const privRole = privCat ? this._existing(guild, 'roleId', o.roleName) : null;
    // Staff may read the private category and the log channel, wherever the log sits.
    const readTargets = privCat ? [privCat, ...this._inside(guild, privCat)] : [];
    const logChannel = this.config.logs && this.config.logs.channelId ? guild.channels.cache.get(this.config.logs.channelId) : null;
    if (logChannel && !readTargets.includes(logChannel)) readTargets.push(logChannel);
    const hasStaff = staffCats.length > 0 || readTargets.length > 0;

    const staffRole = hasStaff ? this._existing(guild, 'staffRoleId', o.staffRoleName) : null;
    const staffNames = staffRole && staffRole.permissions && typeof staffRole.permissions.toArray === 'function' ? staffRole.permissions.toArray() : null;
    const staffExtra = staffNames ? staffNames.filter((n) => !STAFF_NAMES.includes(n)) : [];
    const staffAdd = staffNames ? STAFF_NAMES.filter((n) => !staffNames.includes(n)) : [];

    const member = await this._planMember(guild, botTop);
    return {
      problems,
      priv: privCat ? { category: privCat, role: privRole, channels: this._inside(guild, privCat).length } : null,
      privMissing: privCat ? null : o.categoryId,
      staff: hasStaff ? { categories: staffCats, role: staffRole, extra: staffExtra, add: staffAdd, channels: staffCats.reduce((n, c) => n + this._inside(guild, c).length, 0), read: readTargets } : null,
      staffMissing,
      member,
    };
  }

  /** Roles other features rely on: never deleted by the member clean-up. */
  _protected(guild, keep) {
    const out = new Map();
    const add = (id, why) => id && !out.has(id) && out.set(id, why);
    if (this.setup && typeof this.setup.getVerifiedRoleId === 'function') add(this.setup.getVerifiedRoleId(guild), 'the verified role');
    add(this.config.setup && this.config.setup.sensitiveRoleId, 'gives access to the private category');
    for (const id of (this.config.setup && this.config.setup.protectedRoleIds) || []) add(id, 'protected in the settings');
    for (const id of (this.config.web && this.config.web.roleIds) || []) add(id, 'used by the website');
    if (this.tickets) add(this.tickets.getStaffRole(guild.id), 'the ticket staff role');
    add(this.roleId(guild.id), 'the priv role');
    add(this.staffRoleId(guild.id), 'the staff role');
    if (keep) add(keep.id, 'kept');
    return out;
  }

  async _planMember(guild, botTop) {
    const wanted = this.opts.memberRoleName;
    const fetched = await guild.members.fetch().catch(() => null);
    const humans = fetched ? [...fetched.values()].filter((m) => !(m.user && m.user.bot)) : [];
    const roles = [...guild.roles.cache.values()];
    const candidates = roles.filter((r) => r.id !== guild.id && !r.managed && norm(r.name) === norm(wanted));
    const sizeOf = (r) => (r.members ? r.members.size : 0);

    // The role new members get today decides which one is kept.
    const configuredId = (this.roleMemory && this.roleMemory.getGuildAutoRole(guild.id)) || this.config.autoRole.id || null;
    const configured = configuredId ? guild.roles.cache.get(configuredId) : null;
    let keep = null;
    let skip = null;
    if (configured) {
      if (configured.managed || norm(configured.name) !== norm(wanted)) skip = `The role new members get is ${configured.name}, so I leave the ${wanted} roles alone.`;
      else keep = configured;
    } else if (candidates.length) {
      keep = [...candidates].sort((a, b) => sizeOf(b) - sizeOf(a) || a.id.length - b.id.length || a.id.localeCompare(b.id))[0];
    }
    if (keep && keep.position >= botTop) {
      skip = `The ${wanted} role is above my highest role. Move my role above it first.`;
      keep = null;
    }
    if (skip) return { skip, wanted };

    const protectedIds = this._protected(guild, keep);
    const keepBits = keep ? bits(keep.permissions) : 0n;
    const used = (r) => [...guild.channels.cache.values()].filter((c) => c.permissionOverwrites && c.permissionOverwrites.cache && c.permissionOverwrites.cache.has(r.id)).length;
    const dups = candidates
      .filter((r) => !keep || r.id !== keep.id)
      .map((r) => {
        let why = null;
        let n;
        if (protectedIds.has(r.id)) why = protectedIds.get(r.id);
        else if (r.position >= botTop) why = 'above my highest role';
        else if (bits(r.permissions) & ~keepBits) why = 'has permissions the kept role lacks';
        else if ((n = used(r)) > 0) why = `used in ${n} channel permission${n === 1 ? '' : 's'}`;
        return { id: r.id, name: r.name, members: sizeOf(r), action: why ? 'keep' : 'delete', reason: why };
      });

    return {
      wanted,
      keep,
      create: !keep,
      rename: !!keep && keep.name !== wanted,
      dups,
      giveTo: humans.filter((m) => !keep || !m.roles.cache.has(keep.id)).length,
      total: humans.length,
    };
  }

  // ====================================================================================
  // confirm
  // ====================================================================================

  createPending(userId, guildId, plan) {
    const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.pending.set(token, { userId, guildId, plan, expires: Date.now() + this.confirmTtlMs });
    for (const [t, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(t);
    return token;
  }

  dropPending(token) {
    this.pending.delete(token);
  }

  takePending(token, { guildId, userId }) {
    const p = this.pending.get(token);
    if (!p || p.expires < Date.now() || p.guildId !== guildId || p.userId !== userId) return null;
    this.pending.delete(token);
    return p.plan;
  }

  // ====================================================================================
  // run
  // ====================================================================================

  /** Make the role, or take the one that is already there. Permissions are only ever set when it is made. */
  async _ensureRole(guild, { key, name, permissions, reason }) {
    let role = this._existing(guild, key, name);
    let created = false;
    if (!role) {
      role = await guild.roles.create({ name, permissions, hoist: false, mentionable: false, reason });
      created = true;
    }
    this._rec(guild.id)[key] = role.id;
    this._rec(guild.id).at = new Date().toISOString();
    this.storage.save();
    return { role, created };
  }

  /** Only what the bot itself holds can be granted, anything else would fail the whole edit. */
  _held(guild) {
    const perms = guild.members.me && guild.members.me.permissions;
    if (!perms || typeof perms.has !== 'function') return { ...GRANT };
    const out = {};
    for (const key of Object.keys(GRANT)) if (perms.has(P[key])) out[key] = true;
    return out;
  }

  /**
   * Give the role its access on the category and on every channel inside it. Each channel is handled on
   * its own, one that fails is named and the rest still get done.
   */
  async grant(guild, category, role, reason) {
    const allow = this._held(guild);
    const skipped = Object.keys(GRANT).filter((k) => !allow[k]);
    const done = [];
    const failed = [];
    for (const channel of [category, ...this._inside(guild, category)]) {
      try {
        await channel.permissionOverwrites.edit(role, allow, { reason });
        done.push(channel.name);
      } catch (err) {
        failed.push({ name: channel.name, error: err.message || 'unknown error' });
      }
    }
    return { done, failed, skipped };
  }

  /** Look and read, nothing else: everything that would let someone write, react, delete or join is denied. */
  async readOnly(guild, channels, role, reason) {
    const held = this._held(guild);
    const options = {};
    for (const key of READ_ALLOW) if (held[key] !== undefined || !guild.members.me) options[key] = true;
    for (const key of READ_DENY) options[key] = false;
    const done = [];
    const failed = [];
    for (const channel of channels) {
      try {
        await channel.permissionOverwrites.edit(role, options, { reason });
        done.push(channel.name);
      } catch (err) {
        failed.push({ name: channel.name, error: err.message || 'unknown error' });
      }
    }
    return { done, failed };
  }

  /**
   * Carry out an approved plan. The plan is worked out again first, so what is changed is the server as it
   * is now, and only roles that were in the preview as "delete" are ever deleted.
   * @param {object} by { id, tag, username }
   */
  async execute(guild, approved, by, { onProgress } = {}) {
    if (this.busy.has(guild.id)) return { ok: false, reason: 'busy' };
    this.busy.add(guild.id);
    try {
      const reason = `35xw /priv by ${by.tag || by.id}`;
      const plan = await this.plan(guild);
      if (plan.problems.length) return { ok: false, reason: 'problems', problems: plan.problems };
      const out = { ok: true, priv: null, staff: null, member: null };

      if (plan.priv) {
        const { role, created } = await this._ensureRole(guild, { key: 'roleId', name: this.opts.roleName, permissions: [], reason });
        out.priv = { role, created, ...(await this.grant(guild, plan.priv.category, role, reason)) };
      }

      if (plan.staff) {
        const { role, created } = await this._ensureRole(guild, { key: 'staffRoleId', name: this.opts.staffRoleName, permissions: STAFF_PERMS, reason });
        // A role that was already there only gets what it lacks, nothing is ever taken away from it.
        let added = [];
        const errors = [];
        if (!created && plan.staff.add.length) {
          try {
            const extra = plan.staff.add.reduce((a, n) => a | P[n], 0n);
            await role.setPermissions(new PermissionsBitField(bits(role.permissions) | extra), reason);
            added = plan.staff.add;
          } catch (err) {
            errors.push(`Could not add ${plan.staff.add.join(', ')}: ${err.message}`);
          }
        }
        const parts = { done: [], failed: [], skipped: [] };
        for (const cat of plan.staff.categories) {
          const r = await this.grant(guild, cat, role, reason);
          parts.done.push(...r.done);
          parts.failed.push(...r.failed);
          parts.skipped = r.skipped;
        }
        const read = await this.readOnly(guild, plan.staff.read, role, reason);
        out.staff = { role, created, extra: created ? [] : plan.staff.extra, added, errors, ...parts, read };
      }

      out.member = await this._runMember(guild, plan.member, approved.member, by, reason, onProgress);
      return out;
    } finally {
      this.busy.delete(guild.id);
    }
  }

  async _runMember(guild, plan, approved, by, reason, onProgress) {
    if (plan.skip) return { skipped: plan.skip };
    const res = { created: false, renamed: false, given: 0, already: 0, failedCount: 0, failed: [], deleted: [], kept: [], errors: [] };
    let keep = plan.keep;

    if (!keep) {
      keep = await guild.roles.create({ name: plan.wanted, permissions: [], hoist: false, mentionable: false, reason });
      res.created = true;
    } else if (plan.rename) {
      try {
        await keep.setName(plan.wanted, reason);
        res.renamed = true;
      } catch (err) {
        res.errors.push(`Could not rename the role: ${err.message}`);
      }
    }
    res.role = keep;
    // The role is remembered, so the bot gives this exact one to new members, whatever it is called.
    if (this.roleMemory) this.roleMemory.setGuildAutoRole(guild.id, keep.id, { id: by.id, username: by.username || by.tag || by.id });

    // Everyone gets it before any duplicate is deleted, nobody is ever left without.
    const humans = [...guild.members.cache.values()].filter((m) => !(m.user && m.user.bot)); // filled by the plan just before
    const todo = humans.filter((m) => !m.roles.cache.has(keep.id));
    res.already = humans.length - todo.length;
    let n = 0;
    for (const member of todo) {
      try {
        await member.roles.add(keep.id, reason);
        res.given += 1;
      } catch (err) {
        if (res.failed.length < 5) res.failed.push(`${member.user ? member.user.tag || member.user.username : member.id}: ${err.message}`);
        res.failedCount += 1;
      }
      n += 1;
      if (onProgress) Promise.resolve(onProgress({ done: n, total: todo.length })).catch(() => {});
      if (this.giveGapMs) await sleep(this.giveGapMs);
    }

    // Only what the preview showed as "delete", and only if nobody still depends on it.
    const approvedIds = new Set((approved.dups || []).filter((d) => d.action === 'delete').map((d) => d.id));
    for (const d of plan.dups) {
      if (d.action !== 'delete' || !approvedIds.has(d.id)) {
        res.kept.push({ name: d.name, reason: d.reason || 'it was not in the preview' });
        continue;
      }
      const role = guild.roles.cache.get(d.id);
      if (!role) continue;
      try {
        await role.delete(reason);
        res.deleted.push({ name: d.name, members: d.members });
      } catch (err) {
        res.kept.push({ name: d.name, reason: `could not delete: ${err.message}` });
      }
    }
    return res;
  }
}

module.exports = { PrivService, GRANT, STAFF_NAMES, READ_DENY };
