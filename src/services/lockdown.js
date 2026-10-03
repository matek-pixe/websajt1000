'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P, PermissionsBitField, Routes } = require('discord.js');
const O = require('./overwrites');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
const big = O.big;

const NOTABLE = [
  ['Administrator', 'Administrator'],
  ['ManageGuild', 'Manage Server'],
  ['ManageChannels', 'Manage Channels'],
  ['ManageRoles', 'Manage Roles'],
  ['BanMembers', 'Ban'],
  ['KickMembers', 'Kick'],
  ['ManageMessages', 'Manage Messages'],
  ['MentionEveryone', 'Mention Everyone'],
  ['ViewChannel', 'View Channels'],
];

const TYPE_LABEL = { [O.TYPE.text]: 'text', [O.TYPE.voice]: 'voice', [O.TYPE.category]: 'category', [O.TYPE.announcement]: 'announcement', [O.TYPE.stage]: 'stage', [O.TYPE.forum]: 'forum', [O.TYPE.media]: 'media' };

/** Run `fn` over `items`, a few at a time. */
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * Two safety tools that change who can see or write in channels, and put everything back exactly:
 *   /lock and /unlock  one channel: only admins and the owner can write, until it is unlocked
 *   /sos start and end every channel: nobody but the owner can see anything, until it ends
 * Before a single change the original state is saved to db.json AND to its own backup file.
 */
class LockdownService {
  /**
   * @param {object} p
   * @param {import('../storage').Storage} p.storage
   * @param {object} p.config app config (uses config.manager, config.dataDir)
   * @param {import('discord.js').REST} p.rest
   */
  constructor({ storage, config, rest }) {
    this.storage = storage;
    this.config = config;
    this.rest = rest;
    this.busy = new Set(); // guilds with a start or end in progress
    this.pending = new Map(); // token -> { userId, guildId, scan, expires }
    this.confirmTtlMs = 2 * 60 * 1000;
    this.concurrency = 3;
  }

  _sos() {
    const d = this.storage.data;
    if (!d.sos || typeof d.sos !== 'object') d.sos = {};
    return d.sos;
  }

  _locks(guildId) {
    const d = this.storage.data;
    if (!d.locks || typeof d.locks !== 'object') d.locks = {};
    if (!hasOwn(d.locks, guildId)) setOwn(d.locks, guildId, {});
    return d.locks[guildId];
  }

  /** The saved SOS record of a guild, or null. */
  state(guildId) {
    const all = this._sos();
    return hasOwn(all, guildId) ? all[guildId] : null;
  }

  isActive(guildId) {
    const s = this.state(guildId);
    return !!(s && s.active);
  }

  isLocked(guildId, channelId) {
    return hasOwn(this._locks(guildId), channelId);
  }

  // ====================================================================================
  // /lock and /unlock
  // ====================================================================================

  /**
   * Only admins and the owner may write in this channel. Everyone else loses it, including roles that
   * had an explicit allow. The bot keeps it (it needs to answer). The old overwrites are saved first.
   * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
   */
  async lockChannel(guild, channelId, by, { botId, botIsAdmin }) {
    if (this.isActive(guild.id)) return { ok: false, reason: 'sos' };
    if (this.isLocked(guild.id, channelId)) return { ok: false, reason: 'already' };

    const current = O.overwritesOf(await this.rest.get(Routes.channel(channelId)));
    const grants = botIsAdmin ? [] : [{ id: botId, type: O.MEMBER, allow: P.SendMessages | P.SendMessagesInThreads }];
    const plan = O.planOverwrites(current, { mask: O.WRITE, everyoneId: guild.id, grants });

    setOwn(this._locks(guild.id), channelId, { at: new Date().toISOString(), by, overwrites: current, added: plan.added });
    this.storage.save();

    const res = await O.applyPlan(this.rest, channelId, { puts: plan.puts }, `35xw /lock by ${by}`);
    if (res.failed.length) {
      await this._restoreChannel(channelId, current, plan.added, `35xw /lock rolled back`);
      delete this._locks(guild.id)[channelId];
      this.storage.save();
      return { ok: false, reason: 'failed', error: res.failed[0].error, code: res.failed[0].code };
    }
    return { ok: true, changed: plan.puts.length };
  }

  /** Put the channel back exactly as it was before /lock. */
  async unlockChannel(guild, channelId, by) {
    if (this.isActive(guild.id)) return { ok: false, reason: 'sos' };
    const locks = this._locks(guild.id);
    if (!hasOwn(locks, channelId)) return { ok: false, reason: 'not_locked' };
    const rec = locks[channelId];
    const res = await this._restoreChannel(channelId, rec.overwrites, rec.added, `35xw /unlock by ${by}`);
    if (res.gone) {
      delete locks[channelId];
      this.storage.save();
      return { ok: false, reason: 'gone' };
    }
    if (res.failed.length || res.mismatches.length) return { ok: false, reason: 'failed', error: (res.failed[0] && res.failed[0].error) || 'the channel does not match the saved copy' };
    delete locks[channelId];
    this.storage.save();
    return { ok: true, changed: res.puts + res.deletes };
  }

  // ====================================================================================
  // shared: put one channel back
  // ====================================================================================

  /**
   * Write one channel back to its saved overwrites, then read it again to prove it matches.
   * Overwrites of roles or members that no longer exist cannot be put back; they are reported as lost.
   */
  async _restoreChannel(channelId, saved, added, reason, existing = null) {
    let before;
    try {
      before = await this.rest.get(Routes.channel(channelId));
    } catch (err) {
      if (O.isGone(err)) return { gone: true, puts: 0, deletes: 0, failed: [], lost: [], mismatches: [] };
      throw err;
    }
    const plan = O.planRestore(O.overwritesOf(before), saved, added);
    const res = await O.applyPlan(this.rest, channelId, plan, reason);

    // Whoever (or whatever role) is gone cannot be put back: that is not a failure of the restore.
    const lost = res.failed.filter((f) => O.isLostTarget(f, existing));
    const failed = res.failed.filter((f) => !lost.includes(f));
    const after = O.overwritesOf(await this.rest.get(Routes.channel(channelId)));
    const ignore = new Set(lost.map((l) => l.id));
    return { gone: false, puts: plan.puts.length, deletes: plan.deletes.length, failed, lost, mismatches: O.mismatches(after, saved, added, ignore) };
  }

  // ====================================================================================
  // /sos
  // ====================================================================================

  /**
   * Look at the whole server and work out exactly what /sos start would do. Changes nothing.
   * @returns {Promise<{ok: boolean, reason?: string, snapshot?, plan?, report?: string, summary?: object}>}
   */
  async scan(guild, { keepAdmins = false } = {}) {
    if (this.isActive(guild.id)) return { ok: false, reason: 'active' };
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) return { ok: false, reason: 'no_bot' };
    const botIsAdmin = me.permissions.has(P.Administrator);
    if (!botIsAdmin && !(me.permissions.has(P.ManageRoles) && me.permissions.has(P.ManageChannels))) return { ok: false, reason: 'permissions' };

    const snapshot = await O.takeSnapshot(this.rest, guild);
    const managerId = this.config.manager.id;
    const managerInGuild = !!managerId && (guild.members.cache.has(managerId) || !!(await guild.members.fetch(managerId).catch(() => null)));
    const plan = planSos(snapshot, {
      everyoneId: guild.id,
      ownerId: guild.ownerId,
      managerId,
      managerInGuild,
      botId: me.id,
      botIsAdmin,
      botRoleIds: new Set(me.roles.cache.keys()),
      botTop: me.roles.highest ? me.roles.highest.position : 0,
      keepAdmins,
    });
    const summary = summarize(snapshot, plan, guild.id);
    const community = [guild.rulesChannelId, guild.publicUpdatesChannelId].filter(Boolean);
    return { ok: true, snapshot, plan, summary, community, report: reportText(snapshot, plan, summary, { managerId, botId: me.id }), keepAdmins };
  }

  createPending(userId, guildId, scan) {
    const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.pending.set(token, { userId, guildId, scan, expires: Date.now() + this.confirmTtlMs });
    for (const [t, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(t);
    return token;
  }

  dropPending(token) {
    this.pending.delete(token);
  }

  /** The scan behind a button, only for the person who asked and only once. */
  takePending(token, { guildId, userId }) {
    const p = this.pending.get(token);
    if (!p || p.expires < Date.now() || p.guildId !== guildId || p.userId !== userId) return null;
    this.pending.delete(token);
    return p.scan;
  }

  _backupFile(guildId) {
    const dir = path.join(this.config.dataDir, 'sos');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    return path.join(dir, `sos-${guildId}-${stamp}.json`);
  }

  /** Write the backup as its own file, so a lost or damaged db.json cannot lose the original state. */
  _writeBackup(record) {
    const file = this._backupFile(record.guildId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ kind: '35xw-sos', version: 1, ...record }, null, 2), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    return file;
  }

  /**
   * Save everything, then hide every channel from everyone except the owner.
   * The saved copy exists BEFORE the first change, so whatever happens afterwards /sos end can undo it.
   */
  async start(guild, scan, by, { onProgress } = {}) {
    if (this.isActive(guild.id)) return { ok: false, reason: 'active' };
    if (this.busy.has(guild.id)) return { ok: false, reason: 'busy' };
    this.busy.add(guild.id);
    try {
      // The preview may be a minute old. What gets saved must be the server as it is at this very moment,
      // or /sos end would undo changes somebody made in between.
      const fresh = await this.scan(guild, { keepAdmins: !!scan.keepAdmins });
      if (!fresh.ok) return { ok: false, reason: fresh.reason === 'active' ? 'active' : 'scan', error: fresh.reason };
      const { snapshot, plan } = fresh;
      const record = {
        guildId: guild.id,
        guildName: guild.name,
        startedAt: new Date().toISOString(),
        startedBy: by,
        snapshot,
        added: plan.added,
        stripped: plan.strip.map((r) => r.id),
      };
      const backupFile = this._writeBackup(record); // a failure here stops everything before any change
      setOwn(this._sos(), guild.id, { ...record, active: true, phase: 'applying', backupFile, failed: [] });
      this.storage.save();

      const state = this.state(guild.id);
      const failed = [];
      const total = plan.channels.length + plan.strip.length;
      let done = 0;
      const tick = () => {
        done += 1;
        if (onProgress) Promise.resolve(onProgress({ done, total, phase: 'hide' })).catch(() => {});
      };

      let hidden = 0;
      const roleIds = new Set(snapshot.roles.map((r) => r.id));
      await pool(plan.channels, this.concurrency, async (c) => {
        const res = await O.applyPlan(this.rest, c.id, { puts: c.puts }, `35xw /sos start by ${by}`);
        const real = res.failed.filter((f) => !O.isLostTarget(f, roleIds)); // a member who left needs nothing
        if (real.length) failed.push({ kind: 'channel', id: c.id, name: c.name, error: real[0].error });
        else hidden += 1;
        tick();
      });

      let stripped = 0;
      for (const r of plan.strip) {
        try {
          await this.rest.patch(Routes.guildRole(guild.id, r.id), { body: { permissions: String(big(r.permissions) & ~O.ADMIN) }, reason: `35xw /sos start by ${by}` });
          stripped += 1;
        } catch (err) {
          failed.push({ kind: 'role', id: r.id, name: r.name, error: err.message || 'unknown error' });
        }
        tick();
      }

      state.phase = 'on';
      state.failed = failed;
      this.storage.save();
      return { ok: true, hidden, channels: plan.channels.length, stripped, strip: plan.strip.length, failed, backupFile };
    } finally {
      this.busy.delete(guild.id);
    }
  }

  /**
   * Put everything back exactly as it was and prove it. Roles first (so admins get their power back),
   * then every channel, then everything is read again and compared with the saved copy.
   * `record` is the saved state; pass the content of a backup file to restore from that instead.
   */
  async end(guild, by, { record = null, onProgress } = {}) {
    const rec = record || this.state(guild.id);
    if (!rec || !rec.snapshot) return { ok: false, reason: 'not_active' };
    if (rec.guildId !== guild.id) return { ok: false, reason: 'wrong_server' };
    if (this.busy.has(guild.id)) return { ok: false, reason: 'busy' };
    this.busy.add(guild.id);
    try {
      const snap = rec.snapshot;
      const reason = `35xw /sos end by ${by}`;
      const savedRole = new Map(snap.roles.map((r) => [r.id, r]));
      const roleNow = new Map((await this.rest.get(Routes.guildRoles(guild.id))).map((r) => [r.id, r]));
      const total = (rec.stripped || []).length + snap.channels.length;
      let done = 0;
      const tick = () => {
        done += 1;
        if (onProgress) Promise.resolve(onProgress({ done, total, phase: 'restore' })).catch(() => {});
      };

      // 1. roles
      const roles = { restored: 0, unchanged: 0, gone: [], failed: [] };
      for (const id of rec.stripped || []) {
        const saved = savedRole.get(id);
        const now = roleNow.get(id);
        if (!now) roles.gone.push(saved ? saved.name : id);
        else if (big(now.permissions) === big(saved.permissions)) roles.unchanged += 1;
        else {
          try {
            await this.rest.patch(Routes.guildRole(guild.id, id), { body: { permissions: String(big(saved.permissions)) }, reason });
            roles.restored += 1;
          } catch (err) {
            roles.failed.push({ id, name: saved.name, error: err.message || 'unknown error' });
          }
        }
        tick();
      }

      // 2. channels
      const channels = { restored: 0, unchanged: 0, gone: [], lost: [], failed: [], mismatches: [] };
      await pool(snap.channels, this.concurrency, async (c) => {
        try {
          const added = (rec.added && rec.added[c.id]) || [];
          const res = await this._restoreChannel(c.id, c.overwrites, added, reason, new Set([...roleNow.keys()]));
          if (res.gone) channels.gone.push(c.name);
          else {
            if (res.puts + res.deletes > 0) channels.restored += 1;
            else channels.unchanged += 1;
            for (const l of res.lost) channels.lost.push({ channel: c.name, id: l.id });
            for (const f of res.failed) channels.failed.push({ channel: c.name, id: f.id, error: f.error });
            if (res.mismatches.length) channels.mismatches.push({ channel: c.name, ids: res.mismatches });
          }
        } catch (err) {
          channels.failed.push({ channel: c.name, id: c.id, error: err.message || 'unknown error' });
        }
        tick();
      });

      // 3. read the roles again and compare with the saved copy
      const roleAfter = new Map((await this.rest.get(Routes.guildRoles(guild.id))).map((r) => [r.id, r]));
      const roleMismatch = [];
      for (const id of rec.stripped || []) {
        const now = roleAfter.get(id);
        if (now && big(now.permissions) !== big(savedRole.get(id).permissions)) roleMismatch.push(savedRole.get(id).name);
      }

      const clean = !roles.failed.length && !roleMismatch.length && !channels.failed.length && !channels.mismatches.length;
      const result = { ok: clean, channels, roles, roleMismatch, checked: snap.channels.length - channels.gone.length };
      if (clean) {
        // The saved copy stays on disk as a file; the database only remembers that SOS is over.
        setOwn(this._sos(), guild.id, { active: false, endedAt: new Date().toISOString(), endedBy: by, backupFile: rec.backupFile || null, guildId: guild.id });
        this.storage.save();
      } else if (this.state(guild.id) && this.state(guild.id).snapshot) {
        const state = this.state(guild.id);
        state.phase = 'restore_incomplete'; // still active: run /sos end again
        this.storage.save();
      }
      return result;
    } finally {
      this.busy.delete(guild.id);
    }
  }
}

// ---------- the plan and the report ----------

/** Work out the SOS changes from a snapshot. Pure. */
function planSos(snapshot, { everyoneId, ownerId, managerId, managerInGuild, botId, botIsAdmin, botRoleIds = new Set(), botTop = 0, keepAdmins = false }) {
  const grants = [];
  if (managerId && managerId !== ownerId && managerInGuild) grants.push({ id: managerId, type: O.MEMBER, allow: O.VIEW });
  if (!botIsAdmin && botId) grants.push({ id: botId, type: O.MEMBER, allow: O.VIEW });

  const channels = [];
  const added = {};
  for (const c of snapshot.channels) {
    const p = O.planOverwrites(c.overwrites, { mask: O.VIEW, everyoneId, grants });
    if (!p.puts.length) continue;
    channels.push({ id: c.id, name: c.name, type: c.type, puts: p.puts });
    if (p.added.length) added[c.id] = p.added;
  }

  const strip = [];
  const stuck = [];
  const kept = [];
  for (const r of snapshot.roles) {
    if (!(big(r.permissions) & O.ADMIN)) continue;
    if (keepAdmins) kept.push({ id: r.id, name: r.name });
    else if (botRoleIds.has(r.id)) kept.push({ id: r.id, name: r.name, reason: 'my own role' });
    else if (r.managed) stuck.push({ id: r.id, name: r.name, reason: 'managed by an integration' });
    else if (r.id !== everyoneId && r.position >= botTop) stuck.push({ id: r.id, name: r.name, reason: 'above my highest role' });
    else strip.push({ id: r.id, name: r.name, permissions: r.permissions });
  }
  return { channels, added, strip, stuck, kept, grants, ownerId, managerId };
}

function summarize(snapshot, plan, everyoneId) {
  let everyone = 0;
  let restricted = 0;
  const kinds = {};
  for (const c of snapshot.channels) {
    kinds[TYPE_LABEL[c.type] || 'other'] = (kinds[TYPE_LABEL[c.type] || 'other'] || 0) + 1;
    if (O.whoSees(c, snapshot.roles, everyoneId).everyone) everyone += 1;
    else restricted += 1;
  }
  let flipped = 0;
  let adds = 0;
  for (const c of plan.channels) {
    const before = new Map(snapshot.channels.find((x) => x.id === c.id).overwrites.map((o) => [o.id, o]));
    for (const p of c.puts) before.has(p.id) ? (flipped += 1) : (adds += 1);
  }
  return { total: snapshot.channels.length, kinds, everyone, restricted, toChange: plan.channels.length, flipped, adds };
}

/** A plain text map of the server: which roles can do what, which channel can be seen by whom. */
function reportText(snapshot, plan, summary, { managerId, botId }) {
  const L = [];
  L.push(`SOS scan of ${snapshot.guildName} (${snapshot.guildId})`);
  L.push(`Taken ${snapshot.takenAt}`);
  L.push(`Keeps seeing everything: server owner ${snapshot.ownerId}${managerId && managerId !== snapshot.ownerId ? `, manager ${managerId}` : ''}, bot ${botId}`);
  L.push('');
  L.push('ADMINISTRATOR ROLES');
  const adminRows = [
    ...plan.strip.map((r) => `- ${r.name} (${r.id}): loses Administrator until /sos end`),
    ...plan.stuck.map((r) => `- ${r.name} (${r.id}): CANNOT be hidden from, ${r.reason}`),
    ...plan.kept.map((r) => `- ${r.name} (${r.id}): stays${r.reason ? `, ${r.reason}` : ' (keep_admins)'}`),
  ];
  L.push(...(adminRows.length ? adminRows : ['- none']));
  L.push('');
  L.push(`ROLES (${snapshot.roles.length}) and what they are for`);
  for (const r of [...snapshot.roles].sort((a, b) => b.position - a.position)) {
    const have = NOTABLE.filter(([flag]) => big(r.permissions) & P[flag]).map(([, label]) => label);
    L.push(`- ${r.name}${r.managed ? ' [bot role]' : ''}: ${have.length ? have.join(', ') : 'no special permissions'}`);
  }
  L.push('');
  L.push(`CHANNELS (${summary.total}): ${summary.everyone} visible to everyone, ${summary.restricted} restricted`);
  const children = new Map();
  for (const c of snapshot.channels) {
    const key = c.type === O.TYPE.category ? '' : c.parentId || '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(c);
  }
  const who = (c) => {
    const w = O.whoSees(c, snapshot.roles, snapshot.guildId);
    if (w.everyone) return 'everyone';
    return `${w.roles.length ? w.roles.join(', ') : 'only admins'}${w.members ? ` +${w.members} member overwrite${w.members === 1 ? '' : 's'}` : ''}`;
  };
  const sorted = (list) => [...list].sort((a, b) => a.position - b.position);
  const line = (c, pad) => `${pad}${c.type === O.TYPE.category ? '[' : ''}${c.name}${c.type === O.TYPE.category ? ']' : ''} (${TYPE_LABEL[c.type] || 'channel'}, ${c.id}): visible to ${who(c)}`;
  for (const top of sorted(snapshot.channels.filter((c) => c.type === O.TYPE.category || !c.parentId))) {
    L.push(line(top, ''));
    if (top.type === O.TYPE.category) for (const child of sorted((children.get(top.id) || []).filter((x) => x.type !== O.TYPE.category))) L.push(line(child, '  '));
  }
  return L.join('\n');
}

/** A backup file's content, checked before anything is restored from it. Returns the record or null. */
function parseBackup(text, guildId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const ok =
    data &&
    data.kind === '35xw-sos' &&
    data.version === 1 &&
    data.guildId === guildId &&
    data.snapshot &&
    Array.isArray(data.snapshot.channels) &&
    Array.isArray(data.snapshot.roles) &&
    data.snapshot.channels.every((c) => c && typeof c.id === 'string' && Array.isArray(c.overwrites)) &&
    Array.isArray(data.stripped) &&
    data.added && typeof data.added === 'object';
  return ok ? data : null;
}

module.exports = { LockdownService, planSos, summarize, reportText, parseBackup };
