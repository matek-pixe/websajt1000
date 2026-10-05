'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Shape of the on-disk database (data/db.json).
 * Every write goes through Storage#save(), which is atomic (write tmp file, then rename),
 * so a crash mid-write can never leave a half-written database behind.
 */
function defaults() {
  return {
    version: 1,
    // roles.<guildId>.<userId> = { roles: [roleId...], username, updatedAt }
    roles: {},
    // autoRoles.<guildId> = { roleId, setBy, username, at } -> the role new members get on that server.
    //   Overrides the AUTO_ROLE_* env defaults.
    autoRoles: {},
    // tickets.<guildId> = { counter, categoryId, staffRoleId, transcript: { index, count },
    //   tickets: { <channelId>: {...} }, users: { <userId>: { lastClosedAt } } }
    tickets: {},
    // settings.bypass = true while the manager's /b "no limits" mode is switched on;
    // settings.bypassUsers.<userId> = { by, at } for people the manager gave bypass to.
    settings: { bypass: false, bypassUsers: {} },
    // setup.<guildId> = { roles: { verified }, channels: { verify_ch: id } } -> the verified role and the verify
    //   channel of a server, saved earlier. Only read.
    setup: {},
    // locks.<guildId>.<channelId> = { at, by, overwrites, added } -> the channel as it was before /lock,
    //   so /unlock puts back exactly that.
    locks: {},
    // sos.<guildId> = { active, phase, startedAt, startedBy, snapshot, added, stripped, backupFile, failed }
    //   -> the whole server as it was before /sos start. Kept until /sos end has put everything back.
    sos: {},
    // recovered.<guildId> = { channels: { oldId: newId }, roles: { oldId: newId } } -> what /sos recover made
    //   again, so the same thing is never made twice and saved ids follow the new ones.
    recovered: {},
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copy any keys that exist in `base` but are missing in `loaded` (so upgrades never crash on missing keys). */
function mergeDefaults(base, loaded) {
  if (!isPlainObject(loaded)) return base;
  for (const [key, value] of Object.entries(base)) {
    if (!Object.prototype.hasOwnProperty.call(loaded, key)) {
      loaded[key] = value;
    } else if (isPlainObject(value) && isPlainObject(loaded[key])) {
      mergeDefaults(value, loaded[key]);
    } else if (isPlainObject(value) && !isPlainObject(loaded[key])) {
      loaded[key] = value;
    }
  }
  return loaded;
}

/** Make sure every section has the right type even if someone hand-edited db.json. */
function sanitize(data) {
  if (!isPlainObject(data.roles)) data.roles = {};
  if (!isPlainObject(data.autoRoles)) data.autoRoles = {};
  if (!isPlainObject(data.tickets)) data.tickets = {};
  if (!isPlainObject(data.settings)) data.settings = {};
  if (typeof data.settings.bypass !== 'boolean') data.settings.bypass = false;
  if (!isPlainObject(data.settings.bypassUsers)) data.settings.bypassUsers = {};
  if (!isPlainObject(data.setup)) data.setup = {};
  if (!isPlainObject(data.locks)) data.locks = {};
  if (!isPlainObject(data.sos)) data.sos = {};
  if (!isPlainObject(data.recovered)) data.recovered = {};
  return data;
}

class Storage {
  /**
   * @param {string} file absolute path of the JSON database file
   */
  constructor(file) {
    this.file = file;
    /** true when there was no database file yet (first start, or the file was lost) */
    this.fresh = false;
    this.data = this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.fresh = true;
        return defaults();
      }
      throw err;
    }

    try {
      const parsed = JSON.parse(raw);
      return sanitize(mergeDefaults(defaults(), parsed));
    } catch (err) {
      // Never silently throw away data: keep the broken file next to the new one.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* best effort */
      }
      console.error(`[storage] ${this.file} could not be parsed (${err.message}). Backed up to ${backup} and starting fresh.`);
      this.fresh = true;
      return defaults();
    }
  }

  /** Atomically persist the current state to disk. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Storage, defaults };
