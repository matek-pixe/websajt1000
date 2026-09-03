'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The two account pools the bot manages. */
const POOL_TYPES = Object.freeze({
  steam: Object.freeze({ key: 'steam', label: 'Steam', file: 'steam.txt', command: 'steam', emoji: '🎮' }),
  fivem: Object.freeze({ key: 'fivem', label: 'FiveM', file: 'fivem.txt', command: '5m', emoji: '🚗' }),
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Assign a key on a plain object without ever triggering the `__proto__` setter
 * (account lines come from user-uploaded files, so we do not trust them as keys).
 */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function normalizeLine(line) {
  return String(line).replace(/^\uFEFF/, '').trim();
}

/**
 * Parse the content of steam.txt / fivem.txt.
 * One account per line (any format, e.g. `login:password`). Blank lines and lines
 * starting with `#` are ignored. Duplicate lines inside the same file count once.
 */
function parseAccounts(text) {
  const seen = new Set();
  const accounts = [];
  let duplicatesInFile = 0;

  for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
    const line = normalizeLine(rawLine);
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) {
      duplicatesInFile += 1;
      continue;
    }
    seen.add(line);
    accounts.push(line);
  }

  return { accounts, duplicatesInFile };
}

class AccountService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {string} dataDir directory where uploaded steam.txt / fivem.txt are kept
   */
  constructor(storage, dataDir) {
    this.storage = storage;
    this.dataDir = dataDir;
  }

  static type(type) {
    const info = POOL_TYPES[type];
    if (!info) throw new Error(`Unknown account pool: ${type}`);
    return info;
  }

  pool(type) {
    AccountService.type(type);
    return this.storage.data.pools[type];
  }

  /**
   * Merge the uploaded file into the pool. Accounts that were ever given out, or are already
   * waiting in the pool, are skipped, so re-uploading an old file can never hand out a used account.
   * The raw file is also saved to <dataDir>/<steam|fivem>.txt.
   */
  refill(type, text, uploadedBy = null) {
    const info = AccountService.type(type);
    const pool = this.pool(type);
    const { accounts, duplicatesInFile } = parseAccounts(text);

    const waiting = new Set(pool.available);
    let added = 0;
    let alreadyAvailable = 0;
    let alreadyGiven = 0;

    for (const account of accounts) {
      if (hasOwn(pool.given, account)) {
        alreadyGiven += 1;
      } else if (waiting.has(account)) {
        alreadyAvailable += 1;
      } else {
        pool.available.push(account);
        waiting.add(account);
        added += 1;
      }
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(path.join(this.dataDir, info.file), String(text), 'utf8');

    pool.lastRefill = {
      at: new Date().toISOString(),
      by: uploadedBy ? { id: uploadedBy.id, username: uploadedBy.username } : null,
      added,
    };
    this.storage.save();

    return {
      parsed: accounts.length,
      added,
      alreadyAvailable,
      alreadyGiven,
      duplicatesInFile,
      available: pool.available.length,
      givenTotal: Object.keys(pool.given).length,
    };
  }

  /**
   * Hand out the next account that has NEVER been given to anyone, record who got it,
   * and bump that user's usage counter. Returns null when the pool is empty.
   *
   * This is intentionally synchronous (no awaits between taking the account and saving),
   * so two interactions arriving at the same time can never receive the same account.
   */
  claim(type, user) {
    const pool = this.pool(type);
    let dirty = false;

    while (pool.available.length > 0) {
      const account = pool.available.shift();
      dirty = true;
      if (hasOwn(pool.given, account)) continue; // defensive: should never happen

      setOwn(pool.given, account, {
        userId: user.id,
        username: user.username,
        at: new Date().toISOString(),
      });

      const usage = this.storage.data.usage[type];
      setOwn(usage, user.id, (hasOwn(usage, user.id) ? usage[user.id] : 0) + 1);

      this.storage.save();
      return account;
    }

    if (dirty) this.storage.save();
    return null;
  }

  /** Numbers for /stats. */
  stats(type, limit = 5) {
    const pool = this.pool(type);
    const usage = this.storage.data.usage[type];

    const top = Object.entries(usage)
      .map(([userId, count]) => ({ userId, count: Number(count) || 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId))
      .slice(0, limit);

    return {
      available: pool.available.length,
      given: Object.keys(pool.given).length,
      users: Object.keys(usage).length,
      lastRefill: pool.lastRefill || null,
      top,
    };
  }
}

module.exports = { AccountService, POOL_TYPES, parseAccounts };
