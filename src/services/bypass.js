'use strict';

/**
 * Bypass ("god mode") for the bot manager.
 * When switched on with /b, the manager is exempt from every limit the bot enforces:
 * command cooldowns, the one-open-ticket rule and the post-close ticket cooldown.
 * The switch is persisted, so it survives restarts.
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
    return data.settings;
  }

  isEnabled() {
    return this._settings().bypass === true;
  }

  /** Turn bypass on or off. Returns the new state. */
  set(on) {
    this._settings().bypass = !!on;
    this.storage.save();
    return this.isEnabled();
  }

  toggle() {
    return this.set(!this.isEnabled());
  }

  /** True if this user skips every limit right now: they are the manager AND bypass is on. */
  applies(user) {
    return !!user && user.id === this.config.manager.id && this.isEnabled();
  }

  /** Should the dispatcher skip the cooldown for this command + user? */
  skipsCooldown(command, user) {
    return !!(command && command.noCooldown) || this.applies(user);
  }
}

module.exports = { BypassService };
