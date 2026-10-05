'use strict';

const { PermissionFlagsBits } = require('discord.js');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });

/** What the priv role may do in the private category: see it, write, and join and speak in voice. */
const GRANT = Object.freeze({
  ViewChannel: true,
  SendMessages: true,
  SendMessagesInThreads: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
  AddReactions: true,
  Connect: true,
  Speak: true,
  Stream: true,
  UseVAD: true,
});

/**
 * The priv role: one role that opens one private category (text and voice).
 * Only ever adds an allow for that role; nobody else's permissions are touched.
 */
class PrivService {
  /**
   * @param {import('../storage').Storage} storage
   * @param {object} config app config (uses config.priv: { categoryId, roleName })
   */
  constructor(storage, config) {
    this.storage = storage;
    this.opts = config.priv;
  }

  _all() {
    const d = this.storage.data;
    if (!d.priv || typeof d.priv !== 'object') d.priv = {};
    return d.priv;
  }

  /** The id of the priv role this server already has, remembered even if somebody renames it. */
  roleId(guildId) {
    const all = this._all();
    return hasOwn(all, guildId) && all[guildId] ? all[guildId].roleId : null;
  }

  /** The private category of this server, or null when it is not on this server. */
  category(guild) {
    const c = guild.channels.cache.get(this.opts.categoryId);
    return c && c.type === 4 ? c : null; // 4 = category
  }

  /**
   * The priv role: the remembered one, else a role already called that, else a new one without any
   * permissions of its own. Running it again never makes a second role.
   * @returns {Promise<{ role: object, created: boolean }>}
   */
  async ensureRole(guild, reason) {
    const wanted = this.opts.roleName;
    const stored = this.roleId(guild.id);
    let role = (stored && guild.roles.cache.get(stored)) || null;
    if (!role) role = [...guild.roles.cache.values()].find((r) => !r.managed && r.name.toLowerCase() === wanted.toLowerCase()) || null;
    let created = false;
    if (!role) {
      role = await guild.roles.create({ name: wanted, permissions: [], hoist: false, mentionable: false, reason });
      created = true;
    }
    setOwn(this._all(), guild.id, { roleId: role.id, at: new Date().toISOString() });
    this.storage.save();
    return { role, created };
  }

  /** Only what the bot itself holds can be granted, anything else would fail the whole edit. */
  _held(guild) {
    const perms = guild.members.me && guild.members.me.permissions;
    if (!perms || typeof perms.has !== 'function') return { ...GRANT };
    const out = {};
    for (const key of Object.keys(GRANT)) if (perms.has(PermissionFlagsBits[key])) out[key] = true;
    return out;
  }

  /**
   * Give the role its access on the category and on every channel inside it. Each channel is handled on
   * its own, one that fails is named and the rest still get done.
   * @returns {Promise<{ done: string[], failed: { name: string, error: string }[], skipped: string[] }>}
   */
  async grant(guild, category, role, reason) {
    const allow = this._held(guild);
    const skipped = Object.keys(GRANT).filter((k) => !allow[k]);
    const inside = [...guild.channels.cache.values()].filter((c) => c.parentId === category.id);
    const done = [];
    const failed = [];
    for (const channel of [category, ...inside]) {
      try {
        await channel.permissionOverwrites.edit(role, allow, { reason });
        done.push(channel.name);
      } catch (err) {
        failed.push({ name: channel.name, error: err.message || 'unknown error' });
      }
    }
    return { done, failed, skipped };
  }
}

module.exports = { PrivService, GRANT };
