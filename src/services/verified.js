'use strict';

const { PermissionFlagsBits: P } = require('discord.js');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Who counts as verified: members holding the verified role, the role staff hands out after a ticket.
 * Commands marked `requiresVerified` are only for them.
 */
class VerifiedService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.verified)
   */
  constructor(storage, config) {
    this.storage = storage;
    this.config = config;
  }

  /** The verified role of a guild: the one saved earlier, else the configured id if it exists there. */
  getVerifiedRoleId(guild) {
    if (!guild || !guild.roles || !guild.roles.cache) return null;
    const all = this.storage.data.setup;
    const stored = hasOwn(all, guild.id) && all[guild.id].roles ? all[guild.id].roles.verified : null;
    if (stored && guild.roles.cache.has(stored)) return stored;
    const cfg = this.config.verified && this.config.verified.roleId;
    if (cfg && guild.roles.cache.has(cfg)) return cfg;
    return null;
  }

  /** The channel with the verification panel, if the server has one saved. */
  getVerifyChannelId(guild) {
    const all = this.storage.data.setup;
    const id = hasOwn(all, guild.id) && all[guild.id].channels ? all[guild.id].channels.verify_ch : null;
    return id && guild.channels && guild.channels.cache && guild.channels.cache.has(id) ? id : null;
  }

  /**
   * May this member use a "verified members only" command?
   * Passes: the manager, anyone with bypass, the server owner, admins (Administrator or Manage
   * Server) and holders of the verified role. A server with no known verified role stays open.
   * Returns { ok: true } or { ok: false, roleId, channelId }.
   */
  verifiedGate(guild, member, user, { isManager = () => false, isBypass = () => false } = {}) {
    if (!guild) return { ok: false, roleId: null, channelId: null };
    if (user && (isManager(user) || isBypass(user))) return { ok: true };
    if (user && guild.ownerId === user.id) return { ok: true };
    const roleId = this.getVerifiedRoleId(guild);
    if (!roleId) return { ok: true };
    const perms = member && member.permissions;
    if (perms && typeof perms.has === 'function' && (perms.has(P.Administrator) || perms.has(P.ManageGuild))) return { ok: true };
    const roles = member && member.roles && member.roles.cache;
    if (roles && typeof roles.has === 'function' && roles.has(roleId)) return { ok: true };
    return { ok: false, roleId, channelId: this.getVerifyChannelId(guild) };
  }
}

module.exports = { VerifiedService };
