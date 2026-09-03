'use strict';

/**
 * Role memory: remember which roles every member had, keyed by guild ID + Discord user ID,
 * so that if they leave and come back their roles are restored. Because the key is the Discord ID,
 * the memory survives them leaving the server entirely.
 *
 * This file is split in two:
 *   - pure helpers (no discord.js) that decide *which* role IDs to save / restore -> easy to unit test.
 *   - RoleMemoryService, which wires those helpers to a live guild.
 */

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Decide which of a member's current role IDs are worth remembering.
 * We drop @everyone (the guild id) and any "managed" role (roles owned by an integration/bot,
 * e.g. a Nitro booster role) because Discord will not let anyone assign those by hand.
 *
 * @param {string[]} roleIds every role the member currently has
 * @param {string} guildId the guild id (== the @everyone role id)
 * @param {Set<string>} managedRoleIds ids of managed roles in the guild
 */
function rolesToRemember(roleIds, guildId, managedRoleIds = new Set()) {
  const out = [];
  const seen = new Set();
  for (const id of roleIds) {
    if (id === guildId) continue;
    if (managedRoleIds.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Given the roles we remembered plus the auto role, decide which roles to actually apply on join.
 * A role is applied only if it still exists in the guild and the bot is allowed to assign it
 * (not managed, and below the bot's highest role).
 *
 * @param {object} p
 * @param {string[]} p.remembered remembered role ids
 * @param {string|null} p.autoRoleId the auto role id (or null if none)
 * @param {Set<string>} p.assignableRoleIds ids the bot may currently assign
 * @returns {string[]} role ids to add, de-duplicated, auto role first
 */
function rolesToApplyOnJoin({ remembered = [], autoRoleId = null, assignableRoleIds }) {
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    if (!assignableRoleIds.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  push(autoRoleId);
  for (const id of remembered) push(id);
  return out;
}

class RoleMemoryService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} autoRoleConfig { id, name }
   */
  constructor(storage, autoRoleConfig) {
    this.storage = storage;
    this.autoRoleConfig = autoRoleConfig;
  }

  _guildBucket(guildId) {
    const roles = this.storage.data.roles;
    if (!hasOwn(roles, guildId)) {
      Object.defineProperty(roles, guildId, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    return roles[guildId];
  }

  /** Read the remembered role ids for a user (empty array if we have never seen them). */
  getRemembered(guildId, userId) {
    const bucket = this.storage.data.roles[guildId];
    if (!bucket || !hasOwn(bucket, userId)) return [];
    const entry = bucket[userId];
    return Array.isArray(entry.roles) ? entry.roles.slice() : [];
  }

  /** The role id the server owner chose for this guild via /aa (null if none set). */
  getGuildAutoRole(guildId) {
    const map = this.storage.data.autoRoles;
    if (!map || !hasOwn(map, guildId)) return null;
    const entry = map[guildId];
    return entry && entry.roleId ? entry.roleId : null;
  }

  /** Save the per-guild auto role chosen by the server owner. Pass roleId=null to clear it. */
  setGuildAutoRole(guildId, roleId, byUser = null) {
    if (!this.storage.data.autoRoles || typeof this.storage.data.autoRoles !== 'object') {
      this.storage.data.autoRoles = {};
    }
    const map = this.storage.data.autoRoles;
    Object.defineProperty(map, guildId, {
      value: {
        roleId: roleId || null,
        setBy: byUser ? byUser.id : null,
        username: byUser ? byUser.username : null,
        at: new Date().toISOString(),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    this.storage.save();
  }

  /**
   * Find the set of managed role ids in a guild (roles nobody can assign by hand).
   * @param {import('discord.js').Guild} guild
   */
  static managedRoleIds(guild) {
    const ids = new Set();
    for (const role of guild.roles.cache.values()) {
      if (role.managed) ids.add(role.id);
    }
    return ids;
  }

  /**
   * Roles the bot may currently assign in this guild: every role that is not @everyone,
   * not managed, and positioned below the bot member's highest role.
   * @param {import('discord.js').Guild} guild
   */
  static assignableRoleIds(guild) {
    const me = guild.members.me;
    const botHighest = me ? me.roles.highest.position : 0;
    const ids = new Set();
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id) continue;
      if (role.managed) continue;
      if (role.position >= botHighest) continue;
      ids.add(role.id);
    }
    return ids;
  }

  /** Persist a member's current roles. Call on leave and on role change. */
  remember(member) {
    const guild = member.guild;
    const managed = RoleMemoryService.managedRoleIds(guild);
    const roleIds = member.roles && member.roles.cache ? member.roles.cache.map((r) => r.id) : [];
    const kept = rolesToRemember(roleIds, guild.id, managed);

    // Don't overwrite a good snapshot with an empty one when the member is partial (uncached at
    // leave time, so roles.cache holds only @everyone). A full member legitimately losing all roles
    // is still recorded as empty.
    if (kept.length === 0 && member.partial) {
      const existing = this.getRemembered(guild.id, member.id);
      if (existing.length > 0) return existing;
    }

    const bucket = this._guildBucket(guild.id);
    Object.defineProperty(bucket, member.id, {
      value: {
        roles: kept,
        username: member.user ? member.user.username : null,
        updatedAt: new Date().toISOString(),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    this.storage.save();
    return kept;
  }

  /**
   * Resolve the auto role for a guild, in priority order:
   *   1. the role the server owner picked with /aa (per guild);
   *   2. AUTO_ROLE_ID from the environment;
   *   3. a role named AUTO_ROLE_NAME (created if missing and the bot may manage roles).
   * @param {import('discord.js').Guild} guild
   * @returns {Promise<import('discord.js').Role|null>}
   */
  async ensureAutoRole(guild) {
    // 1. Per-guild role chosen by the server owner takes priority.
    const configuredId = this.getGuildAutoRole(guild.id);
    if (configuredId) {
      const configured = guild.roles.cache.get(configuredId) || (await guild.roles.fetch(configuredId).catch(() => null));
      if (configured) return configured;
      console.warn(`[roles] /aa role ${configuredId} no longer exists in guild ${guild.id}; falling back to defaults.`);
    }

    const { id, name } = this.autoRoleConfig;
    if (id) {
      const byId = guild.roles.cache.get(id) || (await guild.roles.fetch(id).catch(() => null));
      if (byId) return byId;
      console.warn(`[roles] AUTO_ROLE_ID ${id} not found in guild ${guild.id}; falling back to name "${name}".`);
    }

    const byName = guild.roles.cache.find((r) => r.name === name && !r.managed);
    if (byName) return byName;

    const me = guild.members.me;
    if (!me || !me.permissions.has('ManageRoles')) {
      console.warn(`[roles] Cannot create auto role "${name}" in ${guild.id}: missing Manage Roles.`);
      return null;
    }
    try {
      return await guild.roles.create({ name, reason: '35xw auto role' });
    } catch (err) {
      console.warn(`[roles] Failed to create auto role "${name}" in ${guild.id}: ${err.message}`);
      return null;
    }
  }

  /**
   * Give a joining member their auto role plus any remembered roles.
   * @param {import('discord.js').GuildMember} member
   */
  async applyOnJoin(member) {
    const guild = member.guild;
    const autoRole = await this.ensureAutoRole(guild);
    const assignable = RoleMemoryService.assignableRoleIds(guild);
    if (autoRole) assignable.add(autoRole.id); // auto role should apply even if the bot just made it

    const remembered = this.getRemembered(guild.id, member.id);
    const toApply = rolesToApplyOnJoin({
      remembered,
      autoRoleId: autoRole ? autoRole.id : null,
      assignableRoleIds: assignable,
    }).filter((id) => !member.roles.cache.has(id));

    if (toApply.length === 0) return { applied: [], autoRoleId: autoRole ? autoRole.id : null };

    try {
      await member.roles.add(toApply, '35xw auto role + remembered roles');
    } catch (err) {
      console.warn(`[roles] Failed to apply roles to ${member.id} in ${guild.id}: ${err.message}`);
      return { applied: [], autoRoleId: autoRole ? autoRole.id : null, error: err.message };
    }
    return { applied: toApply, autoRoleId: autoRole ? autoRole.id : null };
  }
}

module.exports = { RoleMemoryService, rolesToRemember, rolesToApplyOnJoin };
