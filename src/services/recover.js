'use strict';

const { Routes } = require('discord.js');
const O = require('./overwrites');
const { isTicketChannel } = require('./backups');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const norm = (s) => String(s || '').trim().toLowerCase();
const CATEGORY = O.TYPE.category;

/** Run `fn` over `items`, a few at a time. */
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Follow old id -> new id until it stops (something made again twice ends on the last one). */
function resolve(map, id) {
  let out = id;
  for (let i = 0; i < 10 && hasOwn(map, out) && map[out] !== out; i += 1) out = map[out];
  return out;
}

/**
 * After an attack: make the deleted roles and channels again from a saved copy (see BackupService).
 *   roles      made again with the same name, colour and permissions, then given back to everyone who had them
 *   channels   made again with the same name, topic, settings and permissions, in the same category
 * Only what is missing is made; nothing that exists is changed. A role or channel somebody already made
 * again by hand (same name) is linked, not made twice. What was said in a deleted channel cannot come back,
 * and the new channels and roles have new ids, which are remembered so nothing is made twice.
 */
class RecoverService {
  /**
   * @param {object} p
   * @param {import('../storage').Storage} p.storage
   * @param {object} p.config app config, whose saved ids are updated to the new ones
   * @param {import('discord.js').REST} p.rest
   */
  constructor({ storage, config, rest }) {
    this.storage = storage;
    this.config = config;
    this.rest = rest;
    this.busy = new Set();
    this.pending = new Map();
    this.confirmTtlMs = 5 * 60 * 1000;
    this.concurrency = 3;
  }

  _all() {
    const d = this.storage.data;
    if (!d.recovered || typeof d.recovered !== 'object') d.recovered = {};
    return d.recovered;
  }

  /** old id -> new id of what was made again on this server. */
  _map(guildId) {
    const all = this._all();
    if (!hasOwn(all, guildId) || !all[guildId]) all[guildId] = { channels: {}, roles: {} };
    const m = all[guildId];
    if (!m.channels) m.channels = {};
    if (!m.roles) m.roles = {};
    return m;
  }

  // ---- plan: what is missing, nothing is changed ----

  /**
   * @param {object} guild
   * @param {object} copy the snapshot inside a saved copy (with `members`)
   * @returns {Promise<object>} { roles, channels, adoptRoles, adoptChannels, reparent, permissions, gives, copy, copySnapshot, empty }
   */
  async plan(guild, copy) {
    const now = await O.takeSnapshot(this.rest, guild);
    const map = this._map(guild.id);
    const roleIds = new Set(now.roles.map((r) => r.id));
    const chanIds = new Set(now.channels.map((c) => c.id));
    const there = (m, ids, id) => hasOwn(m, id) && ids.has(m[id]);

    // Roles: missing ones are made again, unless a role with the same name exists (then it is linked).
    const roleByName = new Map();
    for (const r of now.roles) if (!roleByName.has(norm(r.name))) roleByName.set(norm(r.name), r);
    const roles = [];
    const adoptRoles = [];
    for (const r of copy.roles) {
      if (r.id === guild.id || r.managed || roleIds.has(r.id) || there(map.roles, roleIds, r.id)) continue;
      const same = roleByName.get(norm(r.name));
      if (same) adoptRoles.push({ from: r.id, to: same.id, name: r.name });
      else roles.push(r);
    }

    // Channels: categories first, so a channel can find its category.
    const adopted = {};
    const linked = new Set();
    const currentId = (id) => (chanIds.has(id) ? id : there(map.channels, chanIds, id) ? map.channels[id] : hasOwn(adopted, id) ? adopted[id] : null);
    const channels = [];
    const adoptChannels = [];
    const ordered = [...copy.channels].sort((a, b) => (a.type === CATEGORY ? 0 : 1) - (b.type === CATEGORY ? 0 : 1));
    for (const c of ordered) {
      if (currentId(c.id) || isTicketChannel(c)) continue;
      const parent = c.parentId ? currentId(c.parentId) : null;
      const same = now.channels.find((x) => !linked.has(x.id) && x.type === c.type && norm(x.name) === norm(c.name) && (x.parentId || null) === (parent || null));
      if (same) {
        adopted[c.id] = same.id;
        linked.add(same.id);
        adoptChannels.push({ from: c.id, to: same.id, name: c.name });
      } else {
        channels.push(c);
      }
    }

    // A deleted category leaves its channels without one. They go back into it, but only then: a channel an
    // admin moved out of a category that still exists stays where it is.
    const nowById = new Map(now.channels.map((c) => [c.id, c]));
    const parentMissing = (oldId) => channels.some((x) => x.id === oldId) || hasOwn(adopted, oldId);
    const reparent = [];
    for (const c of copy.channels) {
      if (!c.parentId || !parentMissing(c.parentId) || isTicketChannel(c)) continue;
      const cur = currentId(c.id);
      const here = cur && nowById.get(cur);
      if (here && !here.parentId) reparent.push({ id: cur, name: c.name, parentOld: c.parentId });
    }

    // Deleting a role also wipes its permissions from every channel. On channels that still exist they are
    // put back for the role that stands in for it now, unless that role already has its own there.
    const missingOld = new Set([...roles.map((r) => r.id), ...adoptRoles.map((a) => a.from)]);
    const adoptTo = new Map(adoptRoles.map((a) => [a.from, a.to]));
    const nowOverwrites = new Map(now.channels.map((c) => [c.id, c.overwrites]));
    const permissions = [];
    for (const c of copy.channels) {
      if (!chanIds.has(c.id)) continue;
      for (const o of c.overwrites) {
        if (o.type !== O.ROLE || !missingOld.has(o.id)) continue;
        const to = adoptTo.get(o.id);
        if (to && (nowOverwrites.get(c.id) || []).some((x) => x.id === to)) continue;
        permissions.push({ key: `${c.id}:${o.id}`, channel: c.id, name: c.name, role: o.id, allow: o.allow, deny: o.deny });
      }
    }

    const gives = this._gives(guild, copy, new Map([...roles.map((r) => [r.id, null]), ...adoptRoles.map((a) => [a.from, a.to])]));
    return {
      roles,
      channels,
      adoptRoles,
      adoptChannels,
      reparent,
      permissions,
      gives: gives.length,
      copy: { takenAt: copy.takenAt, channels: copy.channels.length, roles: copy.roles.length },
      copySnapshot: copy,
      empty: !roles.length && !channels.length && !adoptRoles.length && !reparent.length && !permissions.length,
    };
  }

  /**
   * Who gets which role: everybody still on the server who held one of `targets` (old role id -> the role
   * that stands in for it now, or null while it is not made yet) in the copy and does not hold it now.
   */
  _gives(guild, copy, targets) {
    const out = [];
    for (const m of copy.members || []) {
      const member = guild.members.cache.get(m.id);
      if (!member) continue;
      for (const old of m.roles) {
        if (!targets.has(old)) continue;
        const target = targets.get(old);
        if (target && member.roles && member.roles.cache && member.roles.cache.has(target)) continue;
        out.push({ user: m.id, old });
      }
    }
    return out;
  }

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

  // ---- run ----

  /**
   * Make what was approved again. The plan is worked out again first, so only what is still missing and
   * was in the preview is made.
   * @returns {Promise<object>} { ok, roles: { made, failed, adopted, given, giveFailed }, channels: { made, failed, adopted, droppedOverwrites } }
   */
  async execute(guild, approved, by, { onProgress } = {}) {
    if (this.busy.has(guild.id)) return { ok: false, reason: 'busy' };
    this.busy.add(guild.id);
    try {
      const copy = approved.copySnapshot;
      const fresh = await this.plan(guild, copy);
      const pick = (list, key, approvedList) => {
        const ok = new Set(approvedList.map((x) => x[key]));
        return list.filter((x) => ok.has(x[key]));
      };
      const roles = pick(fresh.roles, 'id', approved.roles);
      const channels = pick(fresh.channels, 'id', approved.channels);
      const adoptRoles = pick(fresh.adoptRoles, 'from', approved.adoptRoles);
      const adoptChannels = pick(fresh.adoptChannels, 'from', approved.adoptChannels);
      const reparent = pick(fresh.reparent, 'id', approved.reparent || []);
      const permissions = pick(fresh.permissions, 'key', approved.permissions || []);

      const reason = `35xw /sos recover by ${by}`;
      const map = this._map(guild.id);
      const now = await O.takeSnapshot(this.rest, guild);
      const roleIds = new Set(now.roles.map((r) => r.id));
      const chanIds = new Set(now.channels.map((c) => c.id));
      const out = { ok: true, roles: { made: [], failed: [], adopted: adoptRoles.map((a) => a.name), given: 0, giveFailed: 0 }, channels: { made: [], failed: [], adopted: adoptChannels.map((a) => a.name), droppedOverwrites: 0, moved: 0, moveFailed: 0, restored: 0, restoreFailed: 0 } };

      for (const a of adoptRoles) map.roles[a.from] = a.to;
      for (const a of adoptChannels) map.channels[a.from] = a.to;

      const targets = new Map([...roles.map((r) => [r.id, null]), ...adoptRoles.map((a) => [a.from, a.to])]);
      const wanted = this._gives(guild, copy, targets).length;
      const total = roles.length + channels.length + reparent.length + permissions.length + wanted;
      let done = 0;
      const tick = () => {
        done += 1;
        if (onProgress) Promise.resolve(onProgress({ done, total })).catch(() => {});
      };

      // 1. roles, in the order they were in
      for (const r of [...roles].sort((a, b) => a.position - b.position)) {
        try {
          const made = await this.rest.post(Routes.guildRoles(guild.id), {
            body: { name: r.name, permissions: String(O.big(r.permissions)), color: r.color || 0, hoist: !!r.hoist, mentionable: !!r.mentionable },
            reason,
          });
          map.roles[r.id] = made.id;
          roleIds.add(made.id);
          out.roles.made.push(r.name);
          this.storage.save();
        } catch (err) {
          out.roles.failed.push({ name: r.name, error: err.message || 'unknown error' });
        }
        tick();
      }

      // 2. channels: categories first, then what is inside them
      const newChan = (id) => {
        const n = resolve(map.channels, id);
        return chanIds.has(n) ? n : null;
      };
      const mapOverwrites = (list) =>
        list.flatMap((o) => {
          if (o.type === O.ROLE) {
            if (o.id === guild.id || roleIds.has(o.id)) return [o];
            const n = resolve(map.roles, o.id);
            if (roleIds.has(n)) return [{ ...o, id: n }];
            out.channels.droppedOverwrites += 1;
            return [];
          }
          if (guild.members.cache.has(o.id)) return [o];
          out.channels.droppedOverwrites += 1;
          return [];
        });
      const order = [...channels].sort((a, b) => (a.type === CATEGORY ? 0 : 1) - (b.type === CATEGORY ? 0 : 1) || a.position - b.position);
      for (const c of order) {
        try {
          const body = { name: c.name, type: c.type, position: c.position, permission_overwrites: mapOverwrites(c.overwrites).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) })) };
          const parent = c.parentId ? newChan(c.parentId) : null;
          if (parent) body.parent_id = parent;
          if (c.topic) body.topic = c.topic;
          if (c.nsfw) body.nsfw = true;
          if (c.rateLimit) body.rate_limit_per_user = c.rateLimit;
          if (c.type === O.TYPE.voice || c.type === O.TYPE.stage) {
            if (c.bitrate) body.bitrate = Math.min(c.bitrate, 96000);
            if (c.userLimit) body.user_limit = c.userLimit;
          }
          const made = await this.rest.post(Routes.guildChannels(guild.id), { body, reason });
          map.channels[c.id] = made.id;
          chanIds.add(made.id);
          out.channels.made.push(c.name);
          this.storage.save();
        } catch (err) {
          out.channels.failed.push({ name: c.name, error: err.message || 'unknown error' });
        }
        tick();
      }

      // 3. channels that lost their category go back into it
      for (const r of reparent) {
        const parent = newChan(r.parentOld);
        if (parent) {
          try {
            await this.rest.patch(Routes.channel(r.id), { body: { parent_id: parent }, reason });
            out.channels.moved += 1;
          } catch {
            out.channels.moveFailed += 1;
          }
        } else {
          out.channels.moveFailed += 1;
        }
        tick();
      }

      // 4. permissions of the deleted roles on channels that still exist
      for (const o of permissions) {
        const target = resolve(map.roles, o.role);
        if (roleIds.has(target) && chanIds.has(o.channel)) {
          try {
            await this.rest.put(Routes.channelPermission(o.channel, target), { body: { allow: String(o.allow), deny: String(o.deny), type: O.ROLE }, reason });
            out.channels.restored += 1;
          } catch {
            out.channels.restoreFailed += 1;
          }
        } else {
          out.channels.restoreFailed += 1;
        }
        tick();
      }

      // 5. everybody who had a deleted role gets the new one
      const toGive = this._gives(guild, copy, targets)
        .map((g) => ({ user: g.user, role: map.roles[g.old] }))
        .filter((g) => g.role && roleIds.has(g.role));
      await pool(toGive, this.concurrency, async (g) => {
        try {
          await this.rest.put(Routes.guildMemberRole(guild.id, g.user, g.role), { reason });
          out.roles.given += 1;
        } catch {
          out.roles.giveFailed += 1;
        }
        tick();
      });

      this.rememberIds(guild.id);
      return out;
    } finally {
      this.busy.delete(guild.id);
    }
  }

  /** What the bot saved about a server (auto role, ticket staff role and category, verify channel) follows the new ids. */
  rememberIds(guildId) {
    const map = this._map(guildId);
    const d = this.storage.data;
    const swap = (obj, key, m) => {
      if (obj && obj[key] && hasOwn(m, obj[key])) obj[key] = resolve(m, obj[key]);
    };
    if (d.autoRoles && hasOwn(d.autoRoles, guildId)) swap(d.autoRoles[guildId], 'roleId', map.roles);
    if (d.tickets && hasOwn(d.tickets, guildId)) {
      swap(d.tickets[guildId], 'staffRoleId', map.roles);
      swap(d.tickets[guildId], 'categoryId', map.channels);
    }
    if (d.setup && hasOwn(d.setup, guildId) && d.setup[guildId]) {
      if (d.setup[guildId].roles) swap(d.setup[guildId].roles, 'verified', map.roles);
      if (d.setup[guildId].channels) for (const k of Object.keys(d.setup[guildId].channels)) swap(d.setup[guildId].channels, k, map.channels);
    }
    this.storage.save();
    applyRecovered(this.config, this.storage);
  }
}

/** The ids in the settings (log channel, staff channel, verified role, website roles) follow what was made again. */
function applyRecovered(config, storage) {
  const all = (storage.data && storage.data.recovered) || {};
  const ch = {};
  const ro = {};
  for (const g of Object.values(all)) {
    Object.assign(ch, (g && g.channels) || {});
    Object.assign(ro, (g && g.roles) || {});
  }
  const swap = (obj, key, m) => {
    if (obj && obj[key] && hasOwn(m, obj[key])) obj[key] = resolve(m, obj[key]);
  };
  swap(config.logs, 'channelId', ch);
  swap(config.verified, 'roleId', ro);
  swap(config.autoRole, 'id', ro);
  if (config.tickets && config.tickets.notify) {
    swap(config.tickets.notify, 'channelId', ch);
    if (Array.isArray(config.tickets.notify.roleIds)) config.tickets.notify.roleIds = config.tickets.notify.roleIds.map((id) => resolve(ro, id));
  }
  if (config.web && Array.isArray(config.web.roleIds)) config.web.roleIds = config.web.roleIds.map((id) => resolve(ro, id));
}

module.exports = { RecoverService, applyRecovered, resolve };
