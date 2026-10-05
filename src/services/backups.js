'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Events } = require('discord.js');
const O = require('./overwrites');

const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const DAY = 24 * 60 * 60 * 1000;

/** Ticket channels come and go all day, they are not part of what a copy has to protect. */
const isTicketChannel = (c) => c.type === O.TYPE.text && /^ticket-\d+$/i.test(String(c.name || ''));

/** Everybody who is not a bot, with the roles they hold (without @everyone). Needed to give roles back. */
function membersOf(guild) {
  const out = [];
  const cache = guild.members && guild.members.cache;
  if (!cache) return out;
  for (const m of cache.values()) {
    if (!m || !m.roles || !m.roles.cache) continue;
    if (m.user && m.user.bot) continue;
    const roles = [...m.roles.cache.keys()].filter((id) => id !== guild.id);
    if (roles.length) out.push({ id: m.id, roles });
  }
  return out;
}

/** Did something that mattered disappear between two copies? */
function lostSomething(before, after) {
  const chans = new Set(after.channels.map((c) => c.id));
  const roles = new Set(after.roles.map((r) => r.id));
  return before.channels.some((c) => !chans.has(c.id) && !isTicketChannel(c)) || before.roles.some((r) => !roles.has(r.id) && !r.managed);
}

/** A saved copy as a file's text. Returns the snapshot, or null when it is not a copy of this server. */
function parseCopy(text, guildId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const s = data && data.kind === '35xw-backup' ? data.snapshot : null;
  if (!s || String(s.guildId) !== String(guildId) || !Array.isArray(s.channels) || !Array.isArray(s.roles)) return null;
  return { ...s, members: Array.isArray(s.members) ? s.members : [] };
}

/**
 * Saved copies of the server's structure (every channel with its permissions, every role, who holds which
 * role), so that after an attack the deleted channels and roles can be made again with /sos recover.
 *
 * A copy is taken at start, every `everyMinutes`, and a little after a channel or role is made or changed
 * (never after one is deleted). Only the newest `keep` copies are kept, with two exceptions that are pinned
 * as "incident" copies and never pruned with the rest:
 *   - the moment somebody who is not allowed to starts deleting channels or roles, the newest copy is
 *     pinned and new copies stop for a while, so the state from before the attack is not overwritten
 *   - when a new copy has lost a channel or role the previous one still had, the previous one is pinned,
 *     so an attack that nobody noticed cannot push every good copy out
 */
class BackupService {
  /**
   * @param {object} p
   * @param {import('discord.js').REST} p.rest
   * @param {object} p.config app config (uses config.dataDir and config.backup)
   */
  constructor({ rest, config }) {
    this.rest = rest;
    this.config = config;
    this.opts = { everyMinutes: 30, keep: 12, ...(config.backup || {}) };
    this.frozen = new Map(); // guildId -> time until copies stop
    this.timers = new Map(); // guildId -> debounce timer
    this.freezeMs = 60 * 60 * 1000;
    this.debounceMs = 2 * 60 * 1000;
    this.maxPinned = 8;
    this.pinnedForMs = 7 * DAY;
    this.pinnedUsableMs = 2 * DAY;
    this.interval = null;
  }

  dirFor(guildId) {
    return path.join(this.config.dataDir, 'backups', String(guildId));
  }

  isFrozen(guildId) {
    return (this.frozen.get(guildId) || 0) > Date.now();
  }

  /** Copies may be taken again (after a successful recover). */
  thaw(guildId) {
    this.frozen.delete(guildId);
  }

  /** Every copy of a server, newest first: { file, name, takenAt, channels, roles, members, reason, incident, pinnedAt }. */
  list(guildId) {
    const dir = this.dirFor(guildId);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.kind !== '35xw-backup' || !data.snapshot) continue;
        const incident = name.startsWith('incident-');
        out.push({
          file,
          name,
          takenAt: data.snapshot.takenAt,
          channels: data.snapshot.channels.length,
          roles: data.snapshot.roles.length,
          members: Array.isArray(data.snapshot.members) ? data.snapshot.members.length : 0,
          reason: data.reason,
          incident,
          pinnedAt: incident ? fs.statSync(file).mtimeMs : 0,
        });
      } catch {
        /* a damaged file is skipped, never fatal */
      }
    }
    return out.sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
  }

  /**
   * The copy to recover from: among the pinned copies of the last two days the one with the most in it
   * (the state from before the attack), else the newest one.
   */
  best(guildId) {
    const all = this.list(guildId);
    const recent = all.filter((c) => c.incident && c.pinnedAt > Date.now() - this.pinnedUsableMs);
    recent.sort((a, b) => b.channels + b.roles - (a.channels + a.roles) || String(b.takenAt).localeCompare(String(a.takenAt)));
    return recent[0] || all.find((c) => !c.incident) || null;
  }

  /** The content of a copy, as a snapshot. */
  read(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...data.snapshot, members: Array.isArray(data.snapshot.members) ? data.snapshot.members : [] };
  }

  /**
   * Take a copy now. Returns its entry, or null when copies are paused because of an incident.
   * `force` takes one anyway (used by /sos backup).
   */
  async take(guild, { reason = 'scheduled', force = false, at = new Date() } = {}) {
    if (!force && this.isFrozen(guild.id)) return null;
    const snapshot = await O.takeSnapshot(this.rest, guild);
    snapshot.members = membersOf(guild);
    snapshot.takenAt = at.toISOString();
    const dir = this.dirFor(guild.id);
    fs.mkdirSync(dir, { recursive: true });

    const previous = this.list(guild.id).find((c) => !c.incident);
    const file = path.join(dir, `${stampOf(at)}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ kind: '35xw-backup', version: 1, reason, snapshot }), 'utf8');
    fs.renameSync(`${file}.tmp`, file);

    if (previous) {
      try {
        if (lostSomething(this.read(previous.file), snapshot)) this._pin(previous.file);
      } catch {
        /* best effort */
      }
    }
    this._prune(guild.id);
    return { file, name: path.basename(file), takenAt: snapshot.takenAt, channels: snapshot.channels.length, roles: snapshot.roles.length, members: snapshot.members.length, reason };
  }

  /** Keep a copy for good: it is the same file under another name, found again by that name. */
  _pin(file) {
    const pinned = path.join(path.dirname(file), `incident-${path.basename(file)}`);
    if (!fs.existsSync(pinned)) fs.copyFileSync(file, pinned);
    return pinned;
  }

  _prune(guildId) {
    const all = this.list(guildId);
    const rm = (c) => {
      try {
        fs.unlinkSync(c.file);
      } catch {
        /* best effort */
      }
    };
    all.filter((c) => !c.incident).slice(this.opts.keep).forEach(rm);
    const pinned = all.filter((c) => c.incident).sort((a, b) => b.pinnedAt - a.pinnedAt);
    pinned.filter((c, i) => i >= this.maxPinned || c.pinnedAt < Date.now() - this.pinnedForMs).forEach(rm);
  }

  /**
   * Somebody is deleting channels or roles who should not be. Pin the newest copy and stop taking new ones.
   * Returns the pinned entry (or null when there was no copy yet or copies were already stopped).
   */
  freeze(guildId) {
    if (this.isFrozen(guildId)) return null;
    this.frozen.set(guildId, Date.now() + this.freezeMs);
    const newest = this.list(guildId).find((c) => !c.incident);
    if (!newest) return null;
    try {
      const pinned = this._pin(newest.file);
      return { ...newest, file: pinned, name: path.basename(pinned), incident: true };
    } catch {
      return null;
    }
  }

  /** Take copies now and from here on, and after channels or roles are made or changed. */
  start(client) {
    const all = () => [...client.guilds.cache.values()];
    const run = (guild, reason) =>
      this.take(guild, { reason }).catch((err) => console.warn(`[35xw] backup of ${guild.name} failed: ${err.message}`));
    for (const g of all()) run(g, 'start');
    this.interval = setInterval(() => all().forEach((g) => run(g, 'scheduled')), this.opts.everyMinutes * 60 * 1000);
    if (typeof this.interval.unref === 'function') this.interval.unref();

    const later = (guild) => {
      if (!guild || this.timers.has(guild.id)) return;
      const t = setTimeout(() => {
        this.timers.delete(guild.id);
        run(guild, 'changed');
      }, this.debounceMs);
      if (typeof t.unref === 'function') t.unref();
      this.timers.set(guild.id, t);
    };
    // Made or changed, never deleted: a deletion is exactly what a copy must not capture.
    for (const ev of [Events.ChannelCreate, Events.ChannelUpdate, Events.GuildRoleCreate, Events.GuildRoleUpdate]) {
      client.on(ev, (a, b) => later((b && b.guild) || (a && a.guild)));
    }
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

module.exports = { BackupService, parseCopy, isTicketChannel, membersOf, lostSomething };
