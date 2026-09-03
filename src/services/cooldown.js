'use strict';

/**
 * Simple per-key cooldown tracker (key = "<command>:<userId>").
 * Everything is in memory: a bot restart clears cooldowns, which is fine for 30 seconds.
 */
class Cooldown {
  /**
   * @param {number} ms how long a key stays "hot" after a hit
   */
  constructor(ms) {
    this.ms = ms;
    this.until = new Map();
  }

  /** Milliseconds left before `key` may be used again (0 = free to use). */
  remaining(key, now = Date.now()) {
    const expiresAt = this.until.get(key);
    if (expiresAt === undefined) return 0;
    if (expiresAt <= now) {
      this.until.delete(key);
      return 0;
    }
    return expiresAt - now;
  }

  /** Start (or restart) the cooldown for `key`. */
  hit(key, now = Date.now()) {
    this.until.set(key, now + this.ms);
  }

  /** Cancel the cooldown for `key` (e.g. when the command failed and the user should retry). */
  reset(key) {
    this.until.delete(key);
  }

  /** Drop expired entries so the map does not grow forever. */
  sweep(now = Date.now()) {
    for (const [key, expiresAt] of this.until) {
      if (expiresAt <= now) this.until.delete(key);
    }
  }
}

module.exports = { Cooldown };
