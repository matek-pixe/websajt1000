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
    pools: {
      // `available`: accounts waiting to be handed out (in upload order).
      // `given`: every account that was EVER handed out -> { userId, username, at }.
      //          An account listed here is never handed out again, even if re-uploaded.
      steam: { available: [], given: {} },
      fivem: { available: [], given: {} },
    },
    // usage.<pool>.<userId> = number of accounts that user generated.
    usage: { steam: {}, fivem: {} },
    // roles.<guildId>.<userId> = { roles: [roleId...], username, updatedAt }
    roles: {},
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

/** Make sure the pool arrays/objects have the right types even if someone hand-edited db.json. */
function sanitize(data) {
  for (const poolName of Object.keys(defaults().pools)) {
    const pool = data.pools[poolName];
    if (!Array.isArray(pool.available)) pool.available = [];
    pool.available = pool.available.filter((a) => typeof a === 'string' && a.trim() !== '');
    if (!isPlainObject(pool.given)) pool.given = {};
    if (!isPlainObject(data.usage[poolName])) data.usage[poolName] = {};
  }
  if (!isPlainObject(data.roles)) data.roles = {};
  return data;
}

class Storage {
  /**
   * @param {string} file absolute path of the JSON database file
   */
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return defaults();
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
