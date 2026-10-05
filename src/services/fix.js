'use strict';

const { PermissionFlagsBits: P, ChannelType } = require('discord.js');
const O = require('./overwrites');
const { BUTTONS, panelEmbed, panelRow } = require('./tickets');

const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What new people get in the verify category: look and read, nothing that lets them write. */
const OPEN = Object.freeze({
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  AddReactions: false,
});
const OPEN_ALLOW = P.ViewChannel | P.ReadMessageHistory;
const OPEN_DENY = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions;

/** The overwrite list as it will be once `id` is opened. Used to check the result without waiting for Discord. */
function withOpen(overwrites, id, type) {
  const list = overwrites.map((o) => ({ ...o }));
  const i = list.findIndex((o) => o.id === id);
  const o = i >= 0 ? list[i] : { id, type, allow: '0', deny: '0' };
  o.allow = String((O.big(o.allow) | OPEN_ALLOW) & ~OPEN_DENY);
  o.deny = String((O.big(o.deny) & ~OPEN_ALLOW) | OPEN_DENY);
  if (i >= 0) list[i] = o;
  else list.push(o);
  return list;
}

/**
 * /fix: get people back in. Nothing is deleted, everything it does only adds.
 *   member role   found or made again, written `member`, remembered as the role new members get, given to everyone
 *   verify        the verify category can be seen and read by new people, and its ticket button is there
 */
class FixService {
  /**
   * @param {object} p
   * @param {import('../storage').Storage} p.storage
   * @param {object} p.config app config (uses config.fix, config.autoRole)
   * @param {import('./roleMemory').RoleMemoryService} p.roleMemory
   * @param {object} [p.setup] SetupService, to find the verify channel it built
   */
  constructor({ storage, config, roleMemory, setup = null }) {
    this.storage = storage;
    this.config = config;
    this.roleMemory = roleMemory;
    this.setup = setup;
    this.busy = new Set();
    this.giveGapMs = 0;
  }

  // ---- where the verify category is ----

  /** The verify category and channel: the ones /setup built, else the ones that are called verify. */
  findVerify(guild) {
    const cache = guild.channels.cache;
    const all = [...cache.values()];
    const bucket = this.storage.data.setup && Object.prototype.hasOwnProperty.call(this.storage.data.setup, guild.id) ? this.storage.data.setup[guild.id] : null;
    const storedCat = bucket && bucket.channels ? cache.get(bucket.channels.verify) : null;
    let channel = this.setup && typeof this.setup.getVerifyChannelId === 'function' ? cache.get(this.setup.getVerifyChannelId(guild)) : null;
    let category = (storedCat && storedCat.type === ChannelType.GuildCategory ? storedCat : null) || (channel && channel.parentId ? cache.get(channel.parentId) : null);
    if (!category) category = all.find((c) => c.type === ChannelType.GuildCategory && /verif/i.test(c.name)) || null;
    if (!channel) {
      const pool = category ? all.filter((c) => c.parentId === category.id) : all;
      channel = pool.find((c) => c.type === ChannelType.GuildText && /verif/i.test(c.name)) || null;
      if (channel && !category && channel.parentId) category = cache.get(channel.parentId) || null;
    }
    const targets = category ? [category, ...all.filter((c) => c.parentId === category.id)] : channel ? [channel] : [];
    return { category, channel, targets };
  }

  // ---- run ----

  async run(guild, by, { onProgress } = {}) {
    if (this.busy.has(guild.id)) return { ok: false, reason: 'busy' };
    this.busy.add(guild.id);
    try {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      if (!me || !me.permissions.has(P.ManageRoles)) return { ok: false, reason: 'permissions' };
      const reason = `35xw /fix by ${by.tag || by.id}`;
      const member = await this._member(guild, me, by, reason, onProgress);
      const verify = await this._verify(guild, member.role, me, reason);
      return { ok: true, member, verify };
    } finally {
      this.busy.delete(guild.id);
    }
  }

  async _member(guild, me, by, reason, onProgress) {
    const res = { role: null, created: false, renamed: false, given: 0, already: 0, failedCount: 0, failed: [], problem: null };
    const known = new Set(guild.roles.cache.keys());
    const role = await this.roleMemory.ensureAutoRole(guild);
    if (!role) return { ...res, problem: 'I could not find or make the member role. I need the Manage Roles permission.' };
    res.role = role;
    res.created = !known.has(role.id);

    // Only the capitals are fixed, a role with a completely different name is somebody's choice.
    const wanted = this.config.fix.memberRoleName;
    if (norm(role.name) === norm(wanted) && role.name !== wanted) {
      try {
        await role.setName(wanted, reason);
        res.renamed = true;
      } catch (err) {
        res.problem = `I could not rename the role: ${err.message}`;
      }
    }
    // Remembered, so the bot gives this exact role to everyone who joins from now on.
    if (this.roleMemory.getGuildAutoRole(guild.id) !== role.id) this.roleMemory.setGuildAutoRole(guild.id, role.id, { id: by.id, username: by.username || by.tag || by.id });

    const top = me.roles && me.roles.highest ? me.roles.highest.position : 0;
    if (role.managed) return { ...res, problem: 'That role belongs to a bot and cannot be given to people.' };
    if (role.position >= top) return { ...res, problem: 'The member role is above my highest role. Move my role above it, then run /fix again.' };

    const fetched = await guild.members.fetch().catch(() => null);
    const humans = [...(fetched || guild.members.cache).values()].filter((m) => !(m.user && m.user.bot));
    const todo = humans.filter((m) => !m.roles.cache.has(role.id));
    res.already = humans.length - todo.length;
    let n = 0;
    for (const m of todo) {
      try {
        await m.roles.add(role.id, reason);
        res.given += 1;
      } catch (err) {
        res.failedCount += 1;
        if (res.failed.length < 5) res.failed.push(`${m.user ? m.user.tag || m.user.username : m.id}: ${err.message}`);
      }
      n += 1;
      if (onProgress) Promise.resolve(onProgress({ done: n, total: todo.length })).catch(() => {});
      if (this.giveGapMs) await sleep(this.giveGapMs);
    }
    return res;
  }

  /** Can a person who only holds the member role see and read this channel, going by the raw numbers? */
  _sees(guild, role, channel, overwrites) {
    const roles = [...guild.roles.cache.values()].map((r) => ({ id: r.id, permissions: String(O.big(r.permissions)) }));
    return O.memberCanRead({ roleIds: role ? [role.id] : [], roles, channel: { overwrites }, everyoneId: guild.id });
  }

  _rawOverwrites(channel) {
    return [...channel.permissionOverwrites.cache.values()].map((o) => O.raw({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  }

  async _verify(guild, role, me, reason) {
    const { category, channel, targets } = this.findVerify(guild);
    const res = { category: category ? category.name : null, channel: channel ? channel.name : null, fine: 0, opened: [], failed: [], panel: null, found: targets.length > 0 };
    if (!targets.length) return res;

    for (const t of targets) {
      try {
        const now = this._rawOverwrites(t);
        if (this._sees(guild, role, t, now)) {
          res.fine += 1;
          continue;
        }
        // Like /setup built it: @everyone looks and reads, nobody can write here.
        await t.permissionOverwrites.edit(guild.roles.everyone || guild.id, OPEN, { reason });
        let how = 'everyone';
        const asEveryone = withOpen(now, guild.id, O.ROLE);
        if (role && !this._sees(guild, role, t, asEveryone)) {
          // Something overrides it for the member role itself, so it is opened for that role too.
          await t.permissionOverwrites.edit(role, OPEN, { reason });
          how = 'the member role';
        }
        res.opened.push({ name: t.name, how });
      } catch (err) {
        res.failed.push({ name: t.name, error: err.message || 'unknown error' });
      }
    }

    // The ticket button has to be there, or nobody can open a ticket.
    if (channel && typeof channel.send === 'function' && channel.messages && typeof channel.messages.fetch === 'function') {
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (!recent) res.panel = 'unknown';
      else {
        const has = [...recent.values()].some((m) => m.author && m.author.id === me.id && (m.components || []).some((row) => (row.components || []).some((c) => c.customId === BUTTONS.open)));
        if (has) res.panel = 'found';
        else {
          try {
            await channel.send({ embeds: [panelEmbed()], components: [panelRow()] });
            res.panel = 'posted';
          } catch (err) {
            res.panel = 'failed';
            res.failed.push({ name: `${channel.name} (ticket button)`, error: err.message || 'unknown error' });
          }
        }
      }
    }
    return res;
  }
}

module.exports = { FixService, withOpen, OPEN };
