'use strict';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Bypass ("god mode"): whoever it applies to is exempt from every limit the bot enforces
 * (command cooldowns, one-open-ticket rule, post-close ticket cooldown).
 *
 * Two independent sources, both persisted:
 *  - the manager's own switch (/b on/off);
 *  - per-user grants the manager hands out (/b user:@someone).
 */
class BypassService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.manager.id)
   */
  constructor(storage, config) {
    this.storage = storage;
    this.config = config;
  }

  _settings() {
    const data = this.storage.data;
    if (!data.settings || typeof data.settings !== 'object') data.settings = {};
    if (!data.settings.bypassUsers || typeof data.settings.bypassUsers !== 'object') data.settings.bypassUsers = {};
    return data.settings;
  }

  // ---- the manager's own switch ----

  isEnabled() {
    return this._settings().bypass === true;
  }

  /** Turn the manager's bypass on or off. Returns the new state. */
  set(on) {
    this._settings().bypass = !!on;
    this.storage.save();
    return this.isEnabled();
  }

  toggle() {
    return this.set(!this.isEnabled());
  }

  // ---- per-user grants ----

  has(userId) {
    return !!userId && hasOwn(this._settings().bypassUsers, String(userId));
  }

  grant(userId, byId = null) {
    const users = this._settings().bypassUsers;
    Object.defineProperty(users, String(userId), {
      value: { by: byId, at: new Date().toISOString() },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    this.storage.save();
    return true;
  }

  revoke(userId) {
    const users = this._settings().bypassUsers;
    if (!hasOwn(users, String(userId))) return false;
    delete users[String(userId)];
    this.storage.save();
    return true;
  }

  /** Grant if they do not have it, revoke if they do. Returns true when they now have it. */
  toggleUser(userId, byId = null) {
    if (this.has(userId)) {
      this.revoke(userId);
      return false;
    }
    this.grant(userId, byId);
    return true;
  }

  /** Everyone with a per-user grant: [{ id, by, at }]. */
  list() {
    return Object.entries(this._settings().bypassUsers).map(([id, v]) => ({
      id,
      by: (v && v.by) || null,
      at: (v && v.at) || null,
    }));
  }

  // ---- decisions ----

  /** True if this user skips every limit right now. */
  applies(user) {
    if (!user) return false;
    if (this.has(user.id)) return true;
    return user.id === this.config.manager.id && this.isEnabled();
  }

  /** Should the dispatcher skip the cooldown for this command + user? */
  skipsCooldown(command, user) {
    return !!(command && command.noCooldown) || this.applies(user);
  }
}

module.exports = { BypassService };
