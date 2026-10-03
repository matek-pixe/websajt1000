'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AuditLogEvent: A, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { LogService, describeChanges, permissionDiff, typeName } = require('../src/services/logs');

const SETTINGS = { enabled: true, channelId: 'LOG', messageContent: false, voice: true, delayMs: 0, gapMs: 0, graceMs: 0 };

/** A guild with a log channel, some channels for lookups and a scriptable audit log. */
function mk(settings = {}) {
  const client = new EventEmitter();
  client.user = { id: 'BOT' };
  const sent = [];
  const log = { id: 'LOG', name: 'logs', send: async (p) => sent.push(p) };
  const channels = new Map([
    ['LOG', log],
    ['CAT', { id: 'CAT', name: 'osjetljivo' }],
    ['C1', { id: 'C1', name: 'chat' }],
    ['T1', { id: 'T1', name: 'ticket-0007' }],
  ]);
  const guild = {
    id: 'G',
    memberCount: 42,
    channels: { cache: channels },
    audit: [],
    async fetchAuditLogs({ type }) {
      return { entries: new Map(this.audit.filter((e) => e.action === type).map((e) => [e.id, e])) };
    },
  };
  const logs = new LogService(client, { ...SETTINGS, ...settings });
  const embeds = () => sent.map((p) => p.embeds[0].toJSON());
  const last = () => embeds()[embeds().length - 1];
  const val = (e, name) => (e.fields.find((f) => f.name === name) || {}).value;
  return { client, sent, guild, logs, embeds, last, val };
}

const entry = (over) => ({ id: `e${Math.random()}`, executorId: 'MOD', targetId: null, reason: null, changes: [], extra: null, createdTimestamp: Date.now(), ...over });
const message = (guild, over = {}) => ({
  id: 'm1',
  guild,
  channelId: 'C1',
  author: { id: 'U1', bot: false },
  createdTimestamp: Date.now() - 5000,
  content: 'hello there',
  partial: false,
  attachments: new Map(),
  ...over,
});

test('a message deleted by a moderator shows the author, the moderator and the channel', async () => {
  const t = mk();
  t.guild.audit.push(entry({ id: 'del1', action: A.MessageDelete, targetId: 'U1', extra: { channel: { id: 'C1' }, count: 1 } }));
  await t.logs.onMessageDelete(message(t.guild));
  await t.logs.flush();
  const e = t.last();
  assert.equal(e.title, 'Message deleted');
  assert.equal(t.val(e, 'Author'), '<@U1> `U1`');
  assert.equal(t.val(e, 'Deleted by'), '<@MOD> `MOD`');
  assert.equal(t.val(e, 'Channel'), '<#C1>');
  assert.equal(t.val(e, 'Content'), 'Not logged'); // no Message Content Intent
  assert.deepEqual(t.sent[0].allowedMentions, { parse: [] });
});

test('message text is included only when content logging is on', async () => {
  const t = mk({ messageContent: true });
  await t.logs.onMessageDelete(message(t.guild, { attachments: new Map([['a', { name: 'photo.png' }]]) }));
  await t.logs.flush();
  const e = t.last();
  assert.match(t.val(e, 'Content'), /hello there/);
  assert.match(t.val(e, 'Attachments'), /photo\.png/);
});

test('a deletion without an audit entry is reported as the author', async () => {
  const t = mk();
  await t.logs.onMessageDelete(message(t.guild));
  await t.logs.flush();
  assert.equal(t.val(t.last(), 'Deleted by'), 'The author, no audit log entry');
});

test('one audit entry is merged by Discord: only a higher count counts as a new deletion, old entries never do', async () => {
  const t = mk();
  const e = entry({ id: 'merged', action: A.MessageDelete, targetId: 'U1', extra: { channel: { id: 'C1' }, count: 1 } });
  t.guild.audit.push(e);
  await t.logs.onMessageDelete(message(t.guild));
  await t.logs.onMessageDelete(message(t.guild, { id: 'm2' })); // same count: the author deleted this one
  e.extra.count = 2;
  await t.logs.onMessageDelete(message(t.guild, { id: 'm3' })); // count went up: the moderator again
  await t.logs.flush();
  assert.deepEqual(
    t.embeds().map((x) => t.val(x, 'Deleted by')),
    ['<@MOD> `MOD`', 'The author, no audit log entry', '<@MOD> `MOD`'],
  );

  const old = mk();
  old.guild.audit.push(entry({ id: 'ancient', action: A.MessageDelete, targetId: 'U1', extra: { channel: { id: 'C1' }, count: 4 }, createdTimestamp: Date.now() - 3600_000 }));
  await old.logs.onMessageDelete(message(old.guild));
  await old.logs.flush();
  assert.equal(old.val(old.last(), 'Deleted by'), 'The author, no audit log entry');
});

test('a message that was not cached still names the author when the audit log knows it', async () => {
  const t = mk();
  const partial = { id: 'm9', guild: t.guild, channelId: 'C1', author: null, content: null, partial: true, createdTimestamp: null, attachments: null };
  await t.logs.onMessageDelete(partial);
  await t.logs.flush();
  assert.equal(t.val(t.last(), 'Author'), 'Unknown, the message was not in the cache');
  assert.equal(t.val(t.last(), 'Content'), undefined);

  t.guild.audit.push(entry({ id: 'p1', action: A.MessageDelete, targetId: 'U7', extra: { channel: { id: 'C1' }, count: 1 } }));
  await t.logs.onMessageDelete({ ...partial, id: 'm10' });
  await t.logs.flush();
  assert.equal(t.val(t.last(), 'Author'), '<@U7> `U7`');
  assert.equal(t.val(t.last(), 'Deleted by'), '<@MOD> `MOD`');
});

test('deleted messages from bots and guilds without a log channel are ignored', async () => {
  const t = mk();
  await t.logs.onMessageDelete(message(t.guild, { author: { id: 'B', bot: true } }));
  await t.logs.flush();
  assert.equal(t.sent.length, 0);
  const other = { ...t.guild, id: 'H', channels: { cache: new Map() } };
  await t.logs.onMessageDelete(message(other));
  assert.equal(t.sent.length, 0);
  const off = mk({ enabled: false });
  await off.logs.onMessageDelete(message(off.guild));
  assert.equal(off.sent.length, 0);
});

test('a purge names the channel, the moderator and the most affected members', async () => {
  const t = mk();
  t.guild.audit.push(entry({ id: 'b1', action: A.MessageBulkDelete, targetId: 'C1', extra: { count: 3 } }));
  const msgs = new Map([
    ['1', { author: { id: 'U1' } }],
    ['2', { author: { id: 'U1' } }],
    ['3', { author: { id: 'U2' } }],
  ]);
  await t.logs.onBulkDelete(msgs, { id: 'C1', guild: t.guild });
  await t.logs.flush();
  const e = t.last();
  assert.equal(e.title, 'Messages purged');
  assert.equal(t.val(e, 'Amount'), '3');
  assert.equal(t.val(e, 'Deleted by'), '<@MOD> `MOD`');
  assert.match(t.val(e, 'Most affected'), /<@U1> 2/);
});

test('edits are logged only with content logging on, and only when the text changed', async () => {
  const off = mk();
  await off.logs.onMessageUpdate(message(off.guild), message(off.guild, { content: 'changed' }));
  await off.logs.flush();
  assert.equal(off.sent.length, 0);

  const t = mk({ messageContent: true });
  await t.logs.onMessageUpdate(message(t.guild), message(t.guild));
  await t.logs.onMessageUpdate(message(t.guild), message(t.guild, { content: 'changed text' }));
  await t.logs.flush();
  assert.equal(t.sent.length, 1);
  const e = t.last();
  assert.equal(e.title, 'Message edited');
  assert.match(t.val(e, 'Before'), /hello there/);
  assert.match(t.val(e, 'After'), /changed text/);
  assert.match(e.description, /discord\.com\/channels\/G\/C1\/m1/);
});

test('a deleted channel shows its name, type, category and who deleted it', async () => {
  const t = mk();
  await t.logs.onAudit(
    entry({
      action: A.ChannelDelete,
      targetId: 'X9',
      changes: [
        { key: 'name', old: 'logovi-stranice' },
        { key: 'type', old: ChannelType.GuildText },
        { key: 'parent_id', old: 'CAT' },
      ],
      reason: 'cleanup',
    }),
    t.guild,
  );
  await t.logs.flush();
  const e = t.last();
  assert.equal(e.title, 'Channel deleted');
  assert.equal(t.val(e, 'Channel'), '`logovi-stranice`');
  assert.equal(t.val(e, 'Type'), 'Text channel');
  assert.equal(t.val(e, 'Category'), '`osjetljivo`');
  assert.equal(t.val(e, 'By'), '<@MOD> `MOD`');
  assert.equal(t.val(e, 'Reason'), 'cleanup');
});

test('ticket channels made and removed by the bot are not logged, other bot actions are', async () => {
  const t = mk();
  await t.logs.onAudit(entry({ executorId: 'BOT', action: A.ChannelCreate, targetId: 'T1', changes: [{ key: 'name', new: 'ticket-0007' }] }), t.guild);
  await t.logs.onAudit(entry({ executorId: 'BOT', action: A.ChannelDelete, targetId: 'T1', changes: [{ key: 'name', old: 'ticket-0007' }] }), t.guild);
  await t.logs.onAudit(entry({ executorId: 'BOT', action: A.ChannelOverwriteCreate, targetId: 'T1', extra: { id: 'U1', type: 1 } }), t.guild);
  await t.logs.flush();
  assert.equal(t.sent.length, 0);
  await t.logs.onAudit(entry({ executorId: 'BOT', action: A.ChannelDelete, targetId: 'X', changes: [{ key: 'name', old: 'general' }] }), t.guild);
  await t.logs.flush();
  assert.equal(t.sent.length, 1);
});

test('structural events are muted while a rebuild holds the guild, and come back after the grace period', async () => {
  const t = mk();
  const release = t.logs.hold('G');
  await t.logs.onAudit(entry({ action: A.ChannelDelete, targetId: 'X', changes: [{ key: 'name', old: 'a' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.RoleDelete, targetId: 'R', changes: [{ key: 'name', old: 'b' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberRoleUpdate, targetId: 'U', changes: [{ key: '$add', new: [{ id: 'R', name: 'x' }] }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberBanAdd, targetId: 'U' }), t.guild); // bans are never muted
  await t.logs.flush();
  assert.deepEqual(t.embeds().map((e) => e.title), ['Member banned']);
  assert.equal(t.logs.isQuiet('G'), true);
  release();
  release(); // releasing twice is harmless
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(t.logs.isQuiet('G'), false);
  await t.logs.onAudit(entry({ action: A.ChannelDelete, targetId: 'X', changes: [{ key: 'name', old: 'a' }] }), t.guild);
  await t.logs.flush();
  assert.equal(t.last().title, 'Channel deleted');
});

test('roles: created, deleted and updated with the permissions that changed', async () => {
  const t = mk();
  await t.logs.onAudit(entry({ action: A.RoleCreate, targetId: 'R1', changes: [{ key: 'name', new: 'new role' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.RoleDelete, targetId: 'R2', changes: [{ key: 'name', old: 'old role' }] }), t.guild);
  await t.logs.onAudit(
    entry({
      action: A.RoleUpdate,
      targetId: 'R3',
      changes: [
        { key: 'name', old: 'a', new: 'b' },
        { key: 'permissions', old: String(P.SendMessages), new: String(P.SendMessages | P.Administrator) },
      ],
    }),
    t.guild,
  );
  await t.logs.onAudit(entry({ action: A.RoleUpdate, targetId: 'R3', changes: [] }), t.guild); // nothing to say
  await t.logs.flush();
  assert.deepEqual(t.embeds().map((e) => e.title), ['Role created', 'Role deleted', 'Role updated']);
  assert.equal(t.val(t.embeds()[1], 'Role'), '`old role`');
  const changes = t.val(t.embeds()[2], 'Changes');
  assert.match(changes, /name: `a` to `b`/);
  assert.match(changes, /permissions added: `Administrator`/);
});

test('members: bans and kicks are logged once, leaving is logged otherwise, roles and timeouts show details', async () => {
  const t = mk();
  const member = { id: 'U1', guild: t.guild, joinedTimestamp: Date.now() - 86400_000, roles: { cache: new Map([['R1', { id: 'R1' }], ['G', { id: 'G' }]]) } };

  await t.logs.onAudit(entry({ action: A.MemberBanAdd, targetId: 'U1', reason: 'spam' }), t.guild);
  await t.logs.onMemberRemove(member); // the ban already covers this removal
  await t.logs.onMemberRemove({ ...member, id: 'U2' }); // a plain leave
  await t.logs.onAudit(entry({ action: A.MemberKick, targetId: 'U3' }), t.guild);
  await t.logs.onMemberRemove({ ...member, id: 'U3' });
  await t.logs.onAudit(entry({ action: A.MemberBanRemove, targetId: 'U1' }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberRoleUpdate, targetId: 'U1', changes: [{ key: '$add', new: [{ id: 'R5', name: 'x' }] }, { key: '$remove', new: [{ id: 'R6', name: 'y' }] }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberUpdate, targetId: 'U1', changes: [{ key: 'communication_disabled_until', new: new Date(Date.now() + 3600_000).toISOString() }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberUpdate, targetId: 'U1', changes: [{ key: 'communication_disabled_until', old: 'x' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MemberUpdate, targetId: 'U1', changes: [{ key: 'nick', old: 'old', new: 'new' }] }), t.guild);
  await t.logs.flush();
  assert.deepEqual(t.embeds().map((e) => e.title), [
    'Member banned',
    'Member left',
    'Member kicked',
    'Member unbanned',
    'Member roles changed',
    'Member timed out',
    'Timeout removed',
    'Nickname changed',
  ]);
  const es = t.embeds();
  assert.equal(t.val(es[0], 'Reason'), 'spam');
  assert.match(t.val(es[1], 'Roles'), /<@&R1>/);
  assert.match(t.val(es[4], 'Added'), /<@&R5>/);
  assert.match(t.val(es[4], 'Removed'), /<@&R6>/);
  assert.equal(t.val(es[7], 'After'), '`new`');
});

test('joining, and voice activity, are logged', async () => {
  const t = mk();
  await t.logs.onMemberAdd({ id: 'U1', guild: t.guild, user: { createdTimestamp: Date.now() - 86400_000 } });
  await t.logs.onVoice({ guild: t.guild, id: 'U1', channelId: null }, { guild: t.guild, id: 'U1', channelId: 'V1' });
  await t.logs.onVoice({ guild: t.guild, id: 'U1', channelId: 'V1' }, { guild: t.guild, id: 'U1', channelId: 'V2' });
  await t.logs.onVoice({ guild: t.guild, id: 'U1', channelId: 'V2' }, { guild: t.guild, id: 'U1', channelId: null });
  await t.logs.onVoice({ guild: t.guild, id: 'U1', channelId: 'V2', selfMute: false }, { guild: t.guild, id: 'U1', channelId: 'V2', selfMute: true }); // mute only
  await t.logs.flush();
  assert.deepEqual(t.embeds().map((e) => e.title), ['Member joined', 'Joined voice', 'Moved voice', 'Left voice']);
  assert.equal(t.val(t.embeds()[0], 'Members now'), '42');
  assert.equal(t.val(t.embeds()[2], 'From'), '<#V1>');
  assert.equal(t.val(t.embeds()[2], 'To'), '<#V2>');
});

test('invites, webhooks, emoji and server changes', async () => {
  const t = mk();
  await t.logs.onAudit(entry({ action: A.InviteCreate, changes: [{ key: 'code', new: 'abc' }, { key: 'channel_id', new: 'C1' }, { key: 'max_uses', new: 5 }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.InviteDelete, changes: [{ key: 'code', old: 'abc' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.WebhookCreate, targetId: 'W', changes: [{ key: 'name', new: 'hook' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.EmojiDelete, targetId: 'E', changes: [{ key: 'name', old: 'smile' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.GuildUpdate, changes: [{ key: 'name', old: 'a', new: 'b' }] }), t.guild);
  await t.logs.onAudit(entry({ action: A.MessagePin, changes: [] }), t.guild); // not interesting
  await t.logs.flush();
  assert.deepEqual(t.embeds().map((e) => e.title), ['Invite created', 'Invite deleted', 'Webhook created', 'Emoji removed', 'Server updated']);
  assert.equal(t.val(t.embeds()[0], 'Max uses'), '5');
});

test('channel permission changes name the role or member and the permissions', async () => {
  const t = mk();
  await t.logs.onAudit(
    entry({ action: A.ChannelOverwriteUpdate, targetId: 'C1', extra: { id: 'R9', type: 0 }, changes: [{ key: 'deny', old: '0', new: String(P.ViewChannel) }] }),
    t.guild,
  );
  await t.logs.onAudit(entry({ action: A.ChannelOverwriteCreate, targetId: 'C1', extra: { id: 'U9', type: 1 } }), t.guild);
  await t.logs.flush();
  assert.match(t.embeds()[0].description, /for <@&R9> on <#C1>/);
  assert.match(t.val(t.embeds()[0], 'Changes'), /deny added: `ViewChannel`/);
  assert.match(t.embeds()[1].description, /added for <@U9> on <#C1>/);
});

test('an unreachable log channel or a sending error never throws', async () => {
  const t = mk();
  t.guild.channels.cache.get('LOG').send = async () => {
    throw new Error('Missing Access');
  };
  const warn = console.warn;
  let warned = 0;
  console.warn = () => (warned += 1);
  try {
    assert.equal(t.logs.post(t.guild, { toJSON: () => ({}) }), true);
    await t.logs.flush();
    t.logs.post(t.guild, { toJSON: () => ({}) });
    await t.logs.flush();
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, 1); // warned once, not for every event
  assert.equal(t.logs.post({ id: 'H', channels: { cache: new Map() } }, {}), false);
});

test('a flood is capped and reported once', async () => {
  const t = mk();
  for (let i = 0; i < 250; i++) t.logs.post(t.guild, { toJSON: () => ({ title: `e${i}` }) });
  await t.logs.flush();
  assert.equal(t.sent.length, 202); // the first, the newest 200, and the overflow notice
  assert.equal(t.last().title, 'Log overflow');
  assert.match(t.last().description, /49 events/);
});

test('attach wires every event, and voice logging can be switched off', () => {
  const t = mk();
  t.logs.attach();
  for (const ev of ['guildAuditLogEntryCreate', 'messageDelete', 'messageDeleteBulk', 'messageUpdate', 'guildMemberAdd', 'guildMemberRemove', 'voiceStateUpdate']) {
    assert.equal(t.client.listenerCount(ev), 1, ev);
  }
  const quiet = mk({ voice: false });
  quiet.logs.attach();
  assert.equal(quiet.client.listenerCount('voiceStateUpdate'), 0);
});

test('a handler error is swallowed instead of crashing the bot', async () => {
  const t = mk();
  t.logs.attach();
  const warn = console.warn;
  console.warn = () => {};
  try {
    t.client.emit('guildAuditLogEntryCreate', null, t.guild); // entry is null: must not throw
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    console.warn = warn;
  }
  assert.equal(t.sent.length, 0);
});

test('commandUsed prints the command with its options, and announce says whether text is logged', async () => {
  const t = mk();
  const it = {
    guild: t.guild,
    commandName: 'setup',
    user: { id: 'OWNER' },
    channelId: 'C1',
    options: { data: [{ name: 'server', type: 1, options: [{ name: 'verified', type: 8, value: '123' }, { name: 'delete_roles', type: 5, value: false }, { name: 'keep', type: 7, value: 'CAT' }] }] },
  };
  assert.equal(t.logs.commandUsed(it), true);
  t.logs.announce(t.guild);
  t.logs.settings.messageContent = true;
  t.logs.announce(t.guild);
  await t.logs.flush();
  const [cmd, off, on] = t.embeds();
  assert.equal(cmd.title, 'Command used');
  assert.equal(t.val(cmd, 'Command'), '`/setup server verified:<@&123> delete_roles:false keep:<#CAT>`');
  assert.equal(t.val(cmd, 'By'), '<@OWNER> `OWNER`');
  assert.match(off.description, /not logged/);
  assert.match(on.description, /include their text/);
});

test('pure helpers: permission differences, change lines and channel type names', () => {
  const d = permissionDiff(String(P.SendMessages), String(P.ViewChannel | P.SendMessages));
  assert.deepEqual(d, { added: ['ViewChannel'], removed: [] });
  assert.deepEqual(permissionDiff('x', 'y'), { added: [], removed: [] });
  const lines = describeChanges({ changes: [{ key: 'name', old: 'a', new: 'b' }, { key: 'topic', new: 't' }, { key: 'nsfw', old: true }, { key: 'permission_overwrites', old: [], new: [] }] });
  assert.deepEqual(lines, ['name: `a` to `b`', 'topic: set to `t`', 'nsfw: was `true`']);
  assert.equal(typeName(ChannelType.GuildVoice), 'Voice channel');
  assert.equal(typeName(999), 'Channel');
});

test('a returning member whose roles could not all be restored is reported, a clean return is not', async () => {
  const t = mk();
  const member = { id: 'U9', guild: t.guild };
  assert.equal(t.logs.rolesNotRestored(member, { aboveBot: [], managed: [], missing: [] }), false);
  assert.equal(t.logs.rolesNotRestored(member, undefined), false);
  assert.equal(t.logs.rolesNotRestored(member, { aboveBot: ['R1'], managed: [], missing: ['R2', 'R3'] }), true);
  await t.logs.flush();
  const e = t.last();
  assert.equal(e.title, 'Roles not restored');
  assert.equal(t.val(e, 'Member'), '<@U9> `U9`');
  assert.equal(t.val(e, 'Above my role, move my role higher'), '<@&R1>');
  assert.equal(t.val(e, 'Deleted since'), '2 roles');
});
