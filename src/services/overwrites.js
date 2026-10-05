'use strict';

const { PermissionFlagsBits: P, Routes } = require('discord.js');

/**
 * The exact-copy machinery behind /lock and /sos.
 *
 * Everything here works on the RAW data Discord's API returns (permission bit fields as decimal
 * strings), never on discord.js objects, so a saved copy puts back exactly the bits that were there.
 *   overwrite: { id, type: 0 (role) | 1 (member), allow: '123', deny: '456' }
 */

const ROLE = 0;
const MEMBER = 1;

const VIEW = P.ViewChannel;
/** Writing in a channel: messages, messages in threads, new threads. */
const WRITE = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
const ADMIN = P.Administrator;

const big = (v) => (v && typeof v === 'object' && 'bitfield' in v ? BigInt(v.bitfield) : BigInt(v || 0));
const raw = (o) => ({ id: String(o.id), type: Number(o.type), allow: String(big(o.allow)), deny: String(big(o.deny)) });
const overwritesOf = (apiChannel) => (apiChannel.permission_overwrites || []).map(raw);
const sameBits = (a, b) => !!a && !!b && a.id === b.id && a.type === b.type && big(a.allow) === big(b.allow) && big(a.deny) === big(b.deny);

/** Channel types as the API numbers them. */
const TYPE = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 };

// ---------- plans: what to write ----------

/**
 * Take `mask` away from everyone: every overwrite that allows it turns that bit into a deny, @everyone
 * gets the deny too, and `grants` (people who must keep it) get an explicit allow.
 * @returns {{ puts: object[], added: string[] }} puts are the overwrites to write, grants first
 */
function planOverwrites(current, { mask, everyoneId, grants = [] }) {
  const puts = [];
  const added = [];
  const seen = new Set();
  const isGrant = (o) => grants.find((g) => g.id === o.id && g.type === o.type);

  for (const o of current) {
    seen.add(o.id);
    let allow = big(o.allow);
    let deny = big(o.deny);
    const g = isGrant(o);
    if (g) {
      allow |= g.allow;
      deny &= ~g.allow;
    } else {
      if (allow & mask) {
        allow &= ~mask;
        deny |= mask;
      }
      if (o.id === everyoneId && o.type === ROLE) {
        allow &= ~mask;
        deny |= mask;
      }
    }
    if (allow !== big(o.allow) || deny !== big(o.deny)) puts.push({ id: o.id, type: o.type, allow: String(allow), deny: String(deny), grant: !!g });
  }
  if (!seen.has(everyoneId)) {
    puts.push({ id: everyoneId, type: ROLE, allow: '0', deny: String(mask), grant: false });
    added.push(everyoneId);
  }
  for (const g of grants) {
    if (!seen.has(g.id)) {
      puts.push({ id: g.id, type: g.type, allow: String(g.allow), deny: '0', grant: true });
      added.push(g.id);
    }
  }
  puts.sort((a, b) => Number(b.grant) - Number(a.grant)); // people who must keep access are written first
  return { puts: puts.map(({ grant, ...o }) => o), added };
}

/**
 * How to get from `current` back to the saved `saved` list: write what differs or is missing and
 * delete only what WE added (something someone else added in the meantime is left alone).
 */
function planRestore(current, saved, added = []) {
  const now = new Map(current.map((o) => [o.id, o]));
  const puts = saved.filter((o) => !sameBits(o, now.get(o.id))).map(raw);
  const savedIds = new Set(saved.map((o) => o.id));
  const deletes = added.filter((id) => now.has(id) && !savedIds.has(id)).map((id) => ({ id, type: now.get(id).type }));
  return { puts, deletes };
}

// ---------- REST ----------

/** Write a plan one overwrite at a time; one failure never stops the rest. */
async function applyPlan(rest, channelId, { puts = [], deletes = [] }, reason) {
  const failed = [];
  let done = 0;
  for (const o of puts) {
    try {
      await rest.put(Routes.channelPermission(channelId, o.id), { body: { allow: String(o.allow), deny: String(o.deny), type: o.type }, reason });
      done += 1;
    } catch (err) {
      failed.push({ id: o.id, type: o.type, code: err && err.code, error: (err && err.message) || 'unknown error' });
    }
  }
  for (const o of deletes) {
    try {
      await rest.delete(Routes.channelPermission(channelId, o.id), { reason });
      done += 1;
    } catch (err) {
      failed.push({ id: o.id, type: o.type, code: err && err.code, error: (err && err.message) || 'unknown error' });
    }
  }
  return { done, failed };
}

/** What Discord says about a missing channel, role or member. */
const isGone = (err) => !!err && [10003, 10011, 10013, 10007].includes(err.code);

/**
 * A failed write whose target no longer exists (a deleted role, a member who left). Nothing can be done
 * for it and nothing needs to be: it is reported as lost, not as a failure.
 */
const isLostTarget = (f, roleIds = null) =>
  (f.type === ROLE && !!roleIds && !roleIds.has(f.id)) || isGone({ code: f.code }) || (f.type === MEMBER && f.code === 50035);

/**
 * Compare the live overwrites of a channel with the saved ones. Returns what differs.
 * `ignore` holds ids that cannot exist any more (deleted roles, members who left).
 */
function mismatches(current, saved, added = [], ignore = new Set()) {
  const now = new Map(current.map((o) => [o.id, o]));
  const out = [];
  for (const o of saved) if (!ignore.has(o.id) && !sameBits(o, now.get(o.id))) out.push(o.id);
  const savedIds = new Set(saved.map((o) => o.id));
  for (const id of added) if (now.has(id) && !savedIds.has(id)) out.push(id);
  return out;
}

/** The whole server as Discord holds it right now: every channel with its overwrites, every role. */
async function takeSnapshot(rest, guild) {
  const [channels, roles] = await Promise.all([rest.get(Routes.guildChannels(guild.id)), rest.get(Routes.guildRoles(guild.id))]);
  return {
    version: 1,
    guildId: guild.id,
    guildName: guild.name,
    ownerId: guild.ownerId,
    takenAt: new Date().toISOString(),
    channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null, position: c.position || 0, overwrites: overwritesOf(c) })),
    roles: roles.map((r) => ({ id: r.id, name: r.name, permissions: String(big(r.permissions)), managed: !!r.managed, position: r.position || 0 })),
  };
}

// ---------- who can see what ----------

/**
 * What a member can do in a channel, in Discord's own order: base permissions, then the @everyone
 * overwrite, then the member's role overwrites together, then their own overwrite.
 */
function memberPerms({ memberId, roleIds = [], roles, channel, everyoneId, ownerId }) {
  const ALL = (1n << 64n) - 1n;
  if (memberId && memberId === ownerId) return ALL;
  const byId = new Map(roles.map((r) => [r.id, r]));
  let perms = big((byId.get(everyoneId) || {}).permissions);
  for (const id of roleIds) perms |= big((byId.get(id) || {}).permissions);
  if (perms & ADMIN) return ALL;
  const ow = new Map(channel.overwrites.map((o) => [o.id, o]));
  const ev = ow.get(everyoneId);
  if (ev) perms = (perms & ~big(ev.deny)) | big(ev.allow);
  let deny = 0n;
  let allow = 0n;
  for (const id of roleIds) {
    const o = ow.get(id);
    if (o && o.type === ROLE) {
      deny |= big(o.deny);
      allow |= big(o.allow);
    }
  }
  perms = (perms & ~deny) | allow;
  const mine = memberId && ow.get(memberId);
  if (mine && mine.type === MEMBER) perms = (perms & ~big(mine.deny)) | big(mine.allow);
  return perms;
}

/** Can this member see this channel? */
const memberCanView = (args) => !!(memberPerms(args) & VIEW);

/** Can this member see the channel and read what is in it? (Without seeing it there is nothing else.) */
const memberCanRead = (args) => {
  const perms = memberPerms(args);
  return !!(perms & VIEW) && !!(perms & P.ReadMessageHistory);
};

/** Roles that can see the channel on their own, and whether @everyone can. */
function whoSees(channel, roles, everyoneId) {
  const everyone = memberCanView({ roleIds: [], roles, channel, everyoneId });
  const viaRoles = [];
  for (const r of roles) {
    if (r.id === everyoneId || r.managed) continue;
    if (big(r.permissions) & ADMIN) continue; // listed on their own
    if (memberCanView({ roleIds: [r.id], roles, channel, everyoneId })) if (!everyone) viaRoles.push(r.name);
  }
  const members = channel.overwrites.filter((o) => o.type === MEMBER && big(o.allow) & VIEW).length;
  return { everyone, roles: viaRoles, members };
}

module.exports = {
  ROLE,
  MEMBER,
  VIEW,
  WRITE,
  ADMIN,
  TYPE,
  big,
  raw,
  overwritesOf,
  sameBits,
  planOverwrites,
  planRestore,
  applyPlan,
  isGone,
  isLostTarget,
  mismatches,
  takeSnapshot,
  memberPerms,
  memberCanView,
  memberCanRead,
  whoSees,
};
