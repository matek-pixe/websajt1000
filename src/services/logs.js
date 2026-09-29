'use strict';

const { AuditLogEvent, ChannelType, Events, PermissionsBitField } = require('discord.js');
const { card, field, mention, time, plural, truncate, codeBlock, joinList, num } = require('../ui');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = AuditLogEvent;

const CHANNEL_TYPES = new Map([
  [ChannelType.GuildText, 'Text channel'],
  [ChannelType.GuildVoice, 'Voice channel'],
  [ChannelType.GuildCategory, 'Category'],
  [ChannelType.GuildAnnouncement, 'Announcement channel'],
  [ChannelType.GuildStageVoice, 'Stage channel'],
  [ChannelType.GuildForum, 'Forum'],
]);
const typeName = (t) => CHANNEL_TYPES.get(t) || 'Channel';

/** Audit actions that change the structure of the server. They are muted while a rebuild or a mass role change runs. */
const NOISY = new Set([A.ChannelCreate, A.ChannelDelete, A.ChannelUpdate, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete, A.RoleCreate, A.RoleDelete, A.RoleUpdate, A.MemberRoleUpdate]);

const isRoleTarget = (extra) => !!extra && (String(extra.type) === '0' || ('permissions' in extra && !('roles' in extra)));
const person = (id) => (id ? `${mention.user(id)} \`${id}\`` : 'Unknown');
const changeOf = (entry, key) => (entry.changes || []).find((c) => c.key === key) || null;
const fmt = (v) => (v === null || v === undefined || v === '' ? 'none' : `\`${truncate(String(v), 80)}\``);

/** Human list of what a permission bitfield gained and lost. */
function permissionDiff(before, after) {
  try {
    const b = new PermissionsBitField(BigInt(before || 0)).toArray();
    const a = new PermissionsBitField(BigInt(after || 0)).toArray();
    return { added: a.filter((p) => !b.includes(p)), removed: b.filter((p) => !a.includes(p)) };
  } catch {
    return { added: [], removed: [] };
  }
}

/** "key: old to new" lines for an audit entry, skipping keys that are noise or shown elsewhere. */
function describeChanges(entry, skip = []) {
  const out = [];
  for (const c of entry.changes || []) {
    if (skip.includes(c.key) || c.key === 'permission_overwrites') continue;
    if (c.key === 'permissions' || c.key === 'allow' || c.key === 'deny') {
      const d = permissionDiff(c.old, c.new);
      if (d.added.length) out.push(`${c.key} added: ${joinList(d.added.map((x) => `\`${x}\``), { max: 8 })}`);
      if (d.removed.length) out.push(`${c.key} removed: ${joinList(d.removed.map((x) => `\`${x}\``), { max: 8 })}`);
      continue;
    }
    if ('old' in c && 'new' in c) out.push(`${c.key}: ${fmt(c.old)} to ${fmt(c.new)}`);
    else if ('new' in c) out.push(`${c.key}: set to ${fmt(c.new)}`);
    else out.push(`${c.key}: was ${fmt(c.old)}`);
  }
  return out;
}

/**
 * Posts what happens on the server into one private log channel: deleted messages (with who
 * deleted them and whose they were), deleted or changed channels and roles, bans and kicks,
 * joins and leaves, voice activity and the bot's own admin commands.
 *
 * Who did something comes from the audit log, which Discord pushes to the bot as it is written.
 * Deleting your own message leaves no audit entry, so that case is reported as the author.
 */
class LogService {
  /**
   * @param {import('discord.js').Client} client
   * @param {object} settings config.logs: { enabled, channelId, messageContent, voice, delayMs }
   */
  constructor(client, settings) {
    this.client = client;
    this.settings = settings;
    this.held = new Map(); // guildId -> number of running jobs that mute structural logs
    this.deleteSeen = new Map(); // message-delete audit entry id -> last count seen
    this.removals = new Map(); // userId -> when an audit entry said they were kicked or banned
    this.queue = [];
    this.sending = false;
    this.dropped = 0;
    this.lastError = 0;
  }

  // ---- channel and sending ----

  /** The log channel, only when it belongs to this guild and can take messages. */
  channelFor(guild) {
    if (!this.settings.enabled || !guild) return null;
    const ch = guild.channels && guild.channels.cache.get(this.settings.channelId);
    return ch && typeof ch.send === 'function' ? ch : null;
  }

  /** Queue an embed for the guild's log channel. Never throws. */
  post(guild, embed) {
    const channel = this.channelFor(guild);
    if (!channel) return false;
    if (this.queue.length >= 200) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push({ channel, payload: { embeds: [embed], allowedMentions: { parse: [] } } });
    this._drain();
    return true;
  }

  async _drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const { channel, payload } = this.queue.shift();
        this.lastChannel = channel;
        try {
          await channel.send(payload);
        } catch (err) {
          this._warn(`could not post to the log channel: ${err.message}`);
        }
        if (this.settings.gapMs) await sleep(this.settings.gapMs);
      }
      if (this.dropped) {
        const n = this.dropped;
        this.dropped = 0;
        const channel = this.lastChannel;
        if (channel) await channel.send({ embeds: [card({ title: 'Log overflow', description: `${plural(n, 'event')} were skipped because too many came in at once.`, tone: 'warn', footer: 'logs' })] }).catch(() => {});
      }
    } finally {
      this.sending = false;
    }
  }

  /** Resolves when everything queued so far has been sent. */
  async flush() {
    while (this.sending || this.queue.length) await sleep(1);
  }

  _warn(message) {
    if (Date.now() - this.lastError < 30_000) return;
    this.lastError = Date.now();
    console.warn(`[35xw] logs: ${message}`);
  }

  // ---- muting during rebuilds and mass role changes ----

  /** Mute structural events for a guild until the returned function is called (plus a short grace period). */
  hold(guildId) {
    this.held.set(guildId, (this.held.get(guildId) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const t = setTimeout(() => {
        const n = (this.held.get(guildId) || 1) - 1;
        if (n <= 0) this.held.delete(guildId);
        else this.held.set(guildId, n);
      }, this.settings.graceMs ?? 15_000);
      if (typeof t.unref === 'function') t.unref();
    };
  }

  isQuiet(guildId) {
    return this.held.has(guildId);
  }

  // ---- wiring ----

  attach() {
    const c = this.client;
    const safe = (fn) => (...args) => Promise.resolve(fn.apply(this, args)).catch((err) => this._warn(`${err.message}`));
    c.on(Events.GuildAuditLogEntryCreate, safe(this.onAudit));
    c.on(Events.MessageDelete, safe(this.onMessageDelete));
    c.on(Events.MessageBulkDelete, safe(this.onBulkDelete));
    c.on(Events.MessageUpdate, safe(this.onMessageUpdate));
    c.on(Events.GuildMemberAdd, safe(this.onMemberAdd));
    c.on(Events.GuildMemberRemove, safe(this.onMemberRemove));
    if (this.settings.voice) c.on(Events.VoiceStateUpdate, safe(this.onVoice));
  }

  /** Say hello in the log channel so it is obvious that logging works. */
  announce(guild) {
    return this.post(
      guild,
      card({
        title: 'Logging is on',
        description: this.settings.messageContent
          ? 'Deleted and edited messages include their text.'
          : 'Message text is not logged. Turn on the Message Content Intent and LOG_MESSAGE_CONTENT to include it.',
        footer: 'logs',
        timestamp: true,
      }),
    );
  }

  // ---- messages ----

  /** Find out who deleted a message. Returns { executor, target } or null for a deletion by the author. */
  async _whoDeleted(guild, channelId, authorId) {
    await sleep(this.settings.delayMs);
    let entries;
    try {
      entries = await guild.fetchAuditLogs({ type: A.MessageDelete, limit: 6 });
    } catch {
      return null;
    }
    for (const e of entries.entries.values()) {
      if (!e.extra || !e.extra.channel || e.extra.channel.id !== channelId) continue;
      if (authorId && e.targetId && e.targetId !== authorId) continue;
      const count = e.extra.count || 1;
      const before = this.deleteSeen.get(e.id);
      this.deleteSeen.set(e.id, count);
      const fresh = before === undefined ? Date.now() - e.createdTimestamp < 10_000 : count > before;
      if (fresh) return { executorId: e.executorId, targetId: e.targetId };
    }
    return null;
  }

  async onMessageDelete(message) {
    const guild = message.guild;
    if (!this.channelFor(guild)) return;
    if (message.author && message.author.bot) return;
    const channelId = message.channelId;
    const cachedAuthor = message.author ? message.author.id : null;
    const found = await this._whoDeleted(guild, channelId, cachedAuthor);
    const authorId = cachedAuthor || (found && found.targetId) || null;

    const fields = [
      field('Author', authorId ? person(authorId) : 'Unknown, the message was not in the cache', true),
      field('Deleted by', found ? person(found.executorId) : authorId ? 'The author, no audit log entry' : 'Unknown', true),
      field('Channel', mention.channel(channelId), true),
    ];
    if (message.createdTimestamp) fields.push(field('Sent', time(message.createdTimestamp, 'F'), true));
    const text = message.content;
    if (this.settings.messageContent && text) fields.push(field('Content', codeBlock(truncate(text, 900))));
    else if (!message.partial) fields.push(field('Content', this.settings.messageContent ? 'No text' : 'Not logged'));
    const files = message.attachments && message.attachments.size ? [...message.attachments.values()].map((a) => a.name || a.url) : [];
    if (files.length) fields.push(field('Attachments', joinList(files.map((f) => `\`${truncate(f, 60)}\``), { max: 6 })));

    this.post(guild, card({ title: 'Message deleted', fields, tone: 'danger', footer: `logs · message ${message.id}`, timestamp: true }));
  }

  async onBulkDelete(messages, channel) {
    const guild = channel.guild;
    if (!this.channelFor(guild)) return;
    await sleep(this.settings.delayMs);
    let executorId = null;
    try {
      const entries = await guild.fetchAuditLogs({ type: A.MessageBulkDelete, limit: 5 });
      const hit = [...entries.entries.values()].find((e) => e.targetId === channel.id && Date.now() - e.createdTimestamp < 15_000);
      executorId = hit ? hit.executorId : null;
    } catch {
      /* the audit log is optional */
    }
    const authors = new Map();
    for (const m of messages.values()) if (m.author) authors.set(m.author.id, (authors.get(m.author.id) || 0) + 1);
    const top = [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${mention.user(id)} ${n}`);
    this.post(
      guild,
      card({
        title: 'Messages purged',
        fields: [
          field('Amount', num(messages.size), true),
          field('Channel', mention.channel(channel.id), true),
          field('Deleted by', executorId ? person(executorId) : 'Unknown', true),
          ...(top.length ? [field('Most affected', top.join('\n'))] : []),
        ],
        tone: 'danger',
        footer: 'logs',
        timestamp: true,
      }),
    );
  }

  async onMessageUpdate(before, after) {
    if (!this.settings.messageContent) return; // without the intent there is no text to compare
    const guild = after.guild;
    if (!this.channelFor(guild) || (after.author && after.author.bot)) return;
    if (!before.content || !after.content || before.content === after.content) return;
    this.post(
      guild,
      card({
        title: 'Message edited',
        description: `[Jump to the message](https://discord.com/channels/${guild.id}/${after.channelId}/${after.id})`,
        fields: [
          field('Author', after.author ? person(after.author.id) : 'Unknown', true),
          field('Channel', mention.channel(after.channelId), true),
          field('Before', codeBlock(truncate(before.content, 450))),
          field('After', codeBlock(truncate(after.content, 450))),
        ],
        tone: 'warn',
        footer: `logs · message ${after.id}`,
        timestamp: true,
      }),
    );
  }

  // ---- members ----

  async onMemberAdd(member) {
    if (!this.channelFor(member.guild)) return;
    const created = member.user && member.user.createdTimestamp;
    this.post(
      member.guild,
      card({
        title: 'Member joined',
        fields: [
          field('Member', person(member.id), true),
          field('Account created', created ? time(created, 'R') : 'Unknown', true),
          field('Members now', num(member.guild.memberCount), true),
        ],
        tone: 'ok',
        footer: 'logs',
        timestamp: true,
      }),
    );
  }

  async onMemberRemove(member) {
    if (!this.channelFor(member.guild)) return;
    await sleep(this.settings.delayMs);
    const at = this.removals.get(member.id);
    if (at && Date.now() - at < 15_000) return; // the kick or ban was already logged
    const roles = member.roles && member.roles.cache ? [...member.roles.cache.values()].filter((r) => r.id !== member.guild.id) : [];
    this.post(
      member.guild,
      card({
        title: 'Member left',
        fields: [
          field('Member', person(member.id), true),
          field('Joined', member.joinedTimestamp ? time(member.joinedTimestamp, 'R') : 'Unknown', true),
          field('Roles', roles.length ? joinList(roles.map((r) => mention.role(r.id)), { max: 10 }) : 'None'),
        ],
        footer: 'logs',
        timestamp: true,
      }),
    );
  }

  // ---- voice ----

  async onVoice(before, after) {
    const guild = after.guild || before.guild;
    if (!this.channelFor(guild) || before.channelId === after.channelId) return;
    const id = after.id || before.id;
    let title;
    let fields;
    if (!before.channelId) {
      title = 'Joined voice';
      fields = [field('Member', person(id), true), field('Channel', mention.channel(after.channelId), true)];
    } else if (!after.channelId) {
      title = 'Left voice';
      fields = [field('Member', person(id), true), field('Channel', mention.channel(before.channelId), true)];
    } else {
      title = 'Moved voice';
      fields = [field('Member', person(id), true), field('From', mention.channel(before.channelId), true), field('To', mention.channel(after.channelId), true)];
    }
    this.post(guild, card({ title, fields, footer: 'logs', timestamp: true }));
  }

  // ---- audit log ----

  async onAudit(entry, guild) {
    if (!this.channelFor(guild)) return;
    if (NOISY.has(entry.action) && this.isQuiet(guild.id)) return;
    const built = this._describe(entry, guild);
    if (built) this.post(guild, card({ ...built, footer: built.footer || 'logs', timestamp: true }));
  }

  /** Turn one audit log entry into an embed, or null when it is not worth a line. */
  _describe(entry, guild) {
    const by = field('By', person(entry.executorId), true);
    const reason = entry.reason ? [field('Reason', truncate(entry.reason, 500))] : [];
    const name = (key) => {
      const c = changeOf(entry, key);
      return c ? (c.new ?? c.old) : null;
    };
    const isMe = entry.executorId && this.client.user && entry.executorId === this.client.user.id;

    switch (entry.action) {
      case A.ChannelCreate:
      case A.ChannelDelete: {
        const created = entry.action === A.ChannelCreate;
        const chName = name('name');
        if (isMe && /^ticket-\d+$/.test(String(chName))) return null; // ticket channels have their own transcript
        const parentId = name('parent_id');
        const parent = parentId && guild.channels.cache.get(parentId);
        return {
          title: created ? 'Channel created' : 'Channel deleted',
          fields: [
            field('Channel', created && entry.targetId ? `${mention.channel(entry.targetId)} \`${chName}\`` : `\`${chName ?? entry.targetId}\``, true),
            field('Type', typeName(name('type')), true),
            field('Category', parent ? `\`${parent.name}\`` : parentId ? `\`${parentId}\`` : 'None', true),
            by,
            ...reason,
          ],
          tone: created ? 'ok' : 'danger',
        };
      }
      case A.ChannelUpdate: {
        const lines = describeChanges(entry);
        if (!lines.length) return null;
        return { title: 'Channel updated', fields: [field('Channel', mention.channel(entry.targetId), true), by, field('Changes', truncate(lines.join('\n'), 1000)), ...reason], tone: 'warn' };
      }
      case A.ChannelOverwriteCreate:
      case A.ChannelOverwriteUpdate:
      case A.ChannelOverwriteDelete: {
        const verb = entry.action === A.ChannelOverwriteCreate ? 'added' : entry.action === A.ChannelOverwriteDelete ? 'removed' : 'changed';
        const chan = guild.channels.cache.get(entry.targetId);
        if (isMe && chan && /^ticket-\d+$/.test(chan.name)) return null; // the /add command on a ticket
        const who = entry.extra && entry.extra.id ? (isRoleTarget(entry.extra) ? mention.role(entry.extra.id) : mention.user(entry.extra.id)) : 'Unknown';
        const lines = describeChanges(entry);
        return { title: 'Channel permissions changed', description: `Permissions ${verb} for ${who} on ${mention.channel(entry.targetId)}.`, fields: [by, ...(lines.length ? [field('Changes', truncate(lines.join('\n'), 1000))] : []), ...reason], tone: 'warn' };
      }
      case A.RoleCreate:
      case A.RoleDelete: {
        const created = entry.action === A.RoleCreate;
        return { title: created ? 'Role created' : 'Role deleted', fields: [field('Role', created ? `${mention.role(entry.targetId)} \`${name('name')}\`` : `\`${name('name') ?? entry.targetId}\``, true), by, ...reason], tone: created ? 'ok' : 'danger' };
      }
      case A.RoleUpdate: {
        const lines = describeChanges(entry);
        if (!lines.length) return null;
        return { title: 'Role updated', fields: [field('Role', mention.role(entry.targetId), true), by, field('Changes', truncate(lines.join('\n'), 1000)), ...reason], tone: 'warn' };
      }
      case A.MemberKick:
        this.removals.set(entry.targetId, Date.now());
        return { title: 'Member kicked', fields: [field('Member', person(entry.targetId), true), by, ...reason], tone: 'danger' };
      case A.MemberBanAdd:
        this.removals.set(entry.targetId, Date.now());
        return { title: 'Member banned', fields: [field('Member', person(entry.targetId), true), by, ...reason], tone: 'danger' };
      case A.MemberBanRemove:
        return { title: 'Member unbanned', fields: [field('Member', person(entry.targetId), true), by, ...reason], tone: 'ok' };
      case A.MemberUpdate: {
        const timeout = changeOf(entry, 'communication_disabled_until');
        if (timeout) {
          const until = timeout.new ? time(new Date(timeout.new).getTime(), 'R') : null;
          return { title: timeout.new ? 'Member timed out' : 'Timeout removed', fields: [field('Member', person(entry.targetId), true), by, ...(until ? [field('Until', until, true)] : []), ...reason], tone: 'warn' };
        }
        const nick = changeOf(entry, 'nick');
        if (nick) return { title: 'Nickname changed', fields: [field('Member', person(entry.targetId), true), by, field('Before', fmt(nick.old), true), field('After', fmt(nick.new), true)], tone: 'neutral' };
        return null;
      }
      case A.MemberRoleUpdate: {
        const add = (changeOf(entry, '$add') || {}).new || [];
        const remove = (changeOf(entry, '$remove') || {}).new || [];
        if (!add.length && !remove.length) return null;
        return {
          title: 'Member roles changed',
          fields: [
            field('Member', person(entry.targetId), true),
            by,
            ...(add.length ? [field('Added', joinList(add.map((r) => mention.role(r.id)), { max: 8 }))] : []),
            ...(remove.length ? [field('Removed', joinList(remove.map((r) => mention.role(r.id)), { max: 8 }))] : []),
          ],
          tone: 'neutral',
        };
      }
      case A.InviteCreate:
        return { title: 'Invite created', fields: [field('Code', `\`${name('code')}\``, true), field('Channel', name('channel_id') ? mention.channel(name('channel_id')) : 'Unknown', true), by, field('Max uses', name('max_uses') || 'Unlimited', true)], tone: 'neutral' };
      case A.InviteDelete:
        return { title: 'Invite deleted', fields: [field('Code', `\`${name('code')}\``, true), by], tone: 'neutral' };
      case A.WebhookCreate:
      case A.WebhookUpdate:
      case A.WebhookDelete:
        return { title: entry.action === A.WebhookCreate ? 'Webhook created' : entry.action === A.WebhookDelete ? 'Webhook deleted' : 'Webhook updated', fields: [field('Webhook', `\`${name('name') ?? entry.targetId}\``, true), by], tone: 'warn' };
      case A.EmojiCreate:
      case A.EmojiDelete:
        return { title: entry.action === A.EmojiCreate ? 'Emoji added' : 'Emoji removed', fields: [field('Emoji', `\`${name('name') ?? entry.targetId}\``, true), by], tone: 'neutral' };
      case A.GuildUpdate: {
        const lines = describeChanges(entry);
        if (!lines.length) return null;
        return { title: 'Server updated', fields: [by, field('Changes', truncate(lines.join('\n'), 1000)), ...reason], tone: 'warn' };
      }
      default:
        return null; // message deletes are logged from the message events
    }
  }

  // ---- bot commands ----

  /** One line for an admin command that was used, with its options. */
  commandUsed(interaction) {
    const guild = interaction.guild;
    if (!this.channelFor(guild)) return false;
    const render = (opts) =>
      (opts || [])
        .map((o) => (o.options && o.options.length && !('value' in o) ? `${o.name} ${render(o.options)}` : `${o.name}:${o.type === 6 ? mention.user(o.value) : o.type === 8 ? mention.role(o.value) : o.type === 7 ? mention.channel(o.value) : o.value}`))
        .join(' ');
    const used = `/${interaction.commandName}${interaction.options && interaction.options.data ? ` ${render(interaction.options.data)}` : ''}`.trim();
    return this.post(
      guild,
      card({
        title: 'Command used',
        fields: [field('Command', `\`${truncate(used.replace(/`/g, "'"), 180)}\``), field('By', person(interaction.user.id), true), field('Channel', interaction.channelId ? mention.channel(interaction.channelId) : 'Unknown', true)],
        footer: 'logs',
        timestamp: true,
      }),
    );
  }
}

module.exports = { LogService, describeChanges, permissionDiff, typeName, NOISY };
