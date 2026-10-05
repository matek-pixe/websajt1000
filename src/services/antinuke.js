'use strict';

const { AuditLogEvent, Events, PermissionFlagsBits } = require('discord.js');
const { card, field, mention, plural } = require('../ui');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SIGNATURE = 'Anti-nuke system made by 35bf';

/**
 * Anti-nuke: someone who deletes `banAt` channels inside `windowMs` is told about it (a private message
 * to them, an alert in the staff channel) and then banned. Always on. Who deleted what comes from the
 * audit log, which Discord pushes to the bot the moment an entry is written.
 *
 * Never touched: the server owner, the bot manager, this bot and the ids in `trustedIds`.
 * Deletions done by this bot itself (closing tickets) are never counted.
 */
class AntiNukeService {
  /**
   * @param {object} p
   * @param {import('discord.js').Client} p.client
   * @param {import('../storage').Storage} p.storage
   * @param {object} p.config the app config (uses config.manager, config.antiNuke and config.tickets.notify)
   * @param {object} [p.logs] LogService, for one line in the server log
   */
  constructor({ client, storage, config, logs = null }) {
    this.client = client;
    this.storage = storage;
    this.config = config;
    this.logs = logs;
    this.rule = config.antiNuke;
    /** how long the warning DM may take before the ban goes ahead anyway */
    this.dmTimeoutMs = 3000;
    /** "guildId:userId" -> timestamps of recent channel deletions */
    this.recent = new Map();
    /** "guildId:userId" -> true while that person is being dealt with (one ban per burst) */
    this.acted = new Set();
  }

  // ---- who is exempt, what counts ----

  isExempt(guild, userId) {
    if (!userId) return true;
    if (this.client.user && userId === this.client.user.id) return true;
    if (userId === this.config.manager.id) return true;
    if (guild.ownerId && userId === guild.ownerId) return true;
    return (this.rule.trustedIds || []).includes(userId);
  }

  /** Count one deletion. Returns how many this person has made inside the window. */
  record(guildId, userId, at = Date.now()) {
    const key = `${guildId}:${userId}`;
    const from = at - this.rule.windowMs;
    const times = (this.recent.get(key) || []).filter((t) => t > from);
    times.push(at);
    this.recent.set(key, times);
    if (this.recent.size > 200) {
      for (const [k, list] of this.recent) if (list[list.length - 1] <= from) this.recent.delete(k);
    }
    return times.length;
  }

  // ---- wiring ----

  attach() {
    this.client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
      this.onAudit(entry, guild).catch((err) => console.warn(`[35xw] anti-nuke: ${err.message}`));
    });
  }

  async onAudit(entry, guild) {
    if (entry.action !== AuditLogEvent.ChannelDelete) return null;
    if (this.isExempt(guild, entry.executorId)) return null;
    const userId = entry.executorId;
    const count = this.record(guild.id, userId, entry.createdTimestamp || Date.now());
    if (count < this.rule.banAt) return null;

    const key = `${guild.id}:${userId}`;
    if (this.acted.has(key)) return null; // already being banned, the rest of the burst is ignored
    this.acted.add(key);
    try {
      return await this.punish(guild, userId, count);
    } finally {
      const timer = setTimeout(() => this.acted.delete(key), this.rule.windowMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  // ---- the action ----

  minutes() {
    return Math.max(1, Math.round(this.rule.windowMs / 60_000));
  }

  _warning(guild, count) {
    return card({
      title: 'Anti-nuke',
      description:
        `You deleted ${plural(count, 'channel')} within ${plural(this.minutes(), 'minute')} on **${guild.name}**. ` +
        `Deleting ${plural(this.rule.banAt, 'channel')} gets you banned.\n\nYou are being banned from the server now.`,
      tone: 'danger',
      footer: false,
    }).setFooter({ text: SIGNATURE });
  }

  /** The channel that is told before the ban: the staff channel, else the server log channel. */
  _alertChannel(guild) {
    const notify = (this.config.tickets && this.config.tickets.notify) || {};
    const usable = (c) => (c && typeof c.send === 'function' ? c : null);
    const staff = notify.channelId ? usable(guild.channels.cache.get(notify.channelId)) : null;
    return staff || (this.logs ? this.logs.channelFor(guild) : null);
  }

  /** Warn by DM and tell the server, both before the ban. Neither can hold the ban back for long. */
  async _beforeBan(guild, user, userId, count) {
    const notify = (this.config.tickets && this.config.tickets.notify) || {};
    const who = user ? `${mention.user(userId)} \`${user.tag || user.username || userId}\`` : `\`${userId}\``;
    const roleIds = (notify.roleIds || []).filter((id) => guild.roles && guild.roles.cache.has(id));

    const dm = user ? user.send({ embeds: [this._warning(guild, count)] }).then(() => true, () => false) : Promise.resolve(false);
    const channel = this._alertChannel(guild);
    const alert = channel
      ? channel
          .send({
            content: roleIds.map(mention.role).join(' ') || undefined,
            embeds: [
              card({
                title: 'Anti-nuke',
                description: `${who} deleted ${plural(count, 'channel')} within ${plural(this.minutes(), 'minute')}. They are being banned now.`,
                tone: 'danger',
                footer: false,
                timestamp: true,
              }).setFooter({ text: SIGNATURE }),
            ],
            allowedMentions: { roles: roleIds, users: [] },
          })
          .then(() => true, () => false)
      : Promise.resolve(false);

    const both = Promise.all([dm, alert]);
    const [warned, announced] = await Promise.race([both, sleep(this.dmTimeoutMs).then(() => [false, false])]);
    return { warned, announced };
  }

  /** Tell them and the server first, then ban. The owner gets a report afterwards. */
  async punish(guild, userId, count) {
    const user = await this.client.users.fetch(userId).catch(() => null);

    // 1. Before the ban: the private warning and the alert in the server.
    const { warned, announced } = await this._beforeBan(guild, user, userId, count);

    // 2. Ban.
    let banned = false;
    let error = null;
    try {
      await guild.members.ban(userId, {
        reason: `${SIGNATURE}: deleted ${count} channels within ${this.minutes()} min (limit ${this.rule.banAt})`,
        deleteMessageSeconds: 0,
      });
      banned = true;
    } catch (err) {
      error = err.message || 'unknown error';
    }

    // 3. Tell the owner (and the server log).
    const who = user ? `${mention.user(userId)} \`${user.tag || user.username || userId}\`` : `\`${userId}\``;
    const report = card({
      title: banned ? 'Anti-nuke ban' : 'Anti-nuke could not ban',
      description: banned
        ? `${who} deleted ${plural(count, 'channel')} within ${plural(this.minutes(), 'minute')} and was banned.`
        : `${who} deleted ${plural(count, 'channel')} within ${plural(this.minutes(), 'minute')}, but the ban failed: ${error}.\nMove my role above theirs and give me Ban Members.`,
      fields: [field('Warned by DM', warned ? 'Yes' : 'No (DMs closed)', true), field('Server told', announced ? 'Yes' : 'No', true), field('Server', guild.name, true)],
      tone: banned ? 'warn' : 'danger',
      footer: false,
      timestamp: true,
    }).setFooter({ text: SIGNATURE });

    if (this.logs) this.logs.post(guild, report);
    const recipients = new Set([guild.ownerId]);
    if (guild.members && guild.members.cache && guild.members.cache.has(this.config.manager.id)) recipients.add(this.config.manager.id);
    for (const id of recipients) {
      if (id) await this.client.users.send(id, { embeds: [report] }).catch(() => {});
    }
    return { userId, count, warned, announced, banned, error };
  }

  /** Is the bot actually able to do its job on this server? */
  health(guild) {
    const perms = guild.members && guild.members.me && guild.members.me.permissions;
    const can = (flag) => !!perms && typeof perms.has === 'function' && perms.has(flag);
    return {
      canBan: can(PermissionFlagsBits.BanMembers),
      canSeeAudit: can(PermissionFlagsBits.ViewAuditLog),
    };
  }
}

module.exports = { AntiNukeService, SIGNATURE };
