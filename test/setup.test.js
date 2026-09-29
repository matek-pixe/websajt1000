'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ChannelType, OverwriteType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { Storage } = require('../src/storage');
const { TicketService, BUTTONS } = require('../src/services/tickets');
const { RoleMemoryService } = require('../src/services/roleMemory');
const {
  SetupService,
  BLANK_ROLE_NAME,
  ROLE_STACK,
  normalizeName,
  isBlankName,
  isPlusRole,
  permsFor,
  overwritesDiffer,
  hasOpenButton,
  classifyChannels,
  classifyRoles,
  computePrivRoles,
  planRoleOrder,
} = require('../src/services/setup');
const { tmpDir, rm } = require('./helpers');

const T = ChannelType;
const VERIFIED = '1545185363327193228';
const SENSITIVE = '1000782828402917406';
const CFG = {
  manager: { id: 'MGR' },
  autoRole: { id: '', name: 'Member' },
  web: { roleIds: [] },
  tickets: { categoryName: '🎫 Tickets', transcriptChannelName: 'transcripts', maxTranscriptMessages: 2000, reopenCooldownMs: 600000, deleteDelayMs: 0 },
  setup: { verifiedRoleId: VERIFIED, sensitiveRoleId: SENSITIVE, siteName: '35xw.top', keepCategories: ['osjetljivo'], protectedRoleIds: [], confirmTtlMs: 600000 },
};

class Cache extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

const perm = (...flags) => ({ has: (p) => flags.includes(p) });

/**
 * Fake guild with just enough of discord.js for the setup and ticket services. Every mutating call
 * is written to g.log so tests can prove what was and was not touched.
 */
function mkGuild({ roles = [], channels = [], admin = true, failCreateAt = 0, rulesChannelId = null, invites = [], invitesFail = false, afkChannelId = null, systemChannelId = null, failRoleCreate = 0, failRoleEdit = false, undeletable = [] } = {}) {
  let seq = 1000;
  let creates = 0;
  const g = {
    id: 'G',
    name: 'Guild',
    ownerId: 'OWNER',
    rulesChannelId,
    publicUpdatesChannelId: null,
    afkChannelId,
    afkTimeout: 300,
    systemChannelId,
    invitesList: invites,
    roles: { cache: new Cache() },
    members: {
      me: {
        id: 'BOT',
        permissions: { has: (p) => admin || [P.ManageChannels, P.ManageRoles, P.ViewChannel].includes(p) },
        roles: { highest: { position: 50 } },
      },
      cache: new Cache([['OWNER', { id: 'OWNER' }]]),
    },
    channels: { cache: new Cache(), positions: null },
    log: [],
    deleted: { channels: [], roles: [] },
    invited: [],
    edited: { channels: [], roles: [] },
  };
  const toOverwrites = (list) =>
    new Map(
      (list || []).map((w) => [
        w.id,
        { id: w.id, type: w.type, allow: { bitfield: PermissionsBitField.resolve(w.allow || []) }, deny: { bitfield: PermissionsBitField.resolve(w.deny || []) } },
      ]),
    );

  const mkRole = (o) => {
    const r = {
      id: o.id || String(seq++),
      name: o.name,
      hoist: !!o.hoist,
      managed: !!o.managed,
      position: o.position ?? 1,
      permissions: o.admin ? perm(P.Administrator) : perm(),
      async edit(patch) {
        if (failRoleEdit) throw new Error('Missing Permissions');
        g.log.push(['role.edit', r.name, Object.keys(patch).filter((k) => k !== 'reason')]);
        g.edited.roles.push(r.id);
        Object.assign(r, patch);
        return r;
      },
      async delete() {
        g.log.push(['role.delete', r.name]);
        g.deleted.roles.push(r.id);
        g.roles.cache.delete(r.id);
      },
    };
    g.roles.cache.set(r.id, r);
    return r;
  };
  g.roles.fetch = async () => g.roles.cache;
  let roleCreates = 0;
  g.roles.create = async (o) => {
    roleCreates += 1;
    if (failRoleCreate && roleCreates >= failRoleCreate) throw new Error('Maximum number of server roles reached');
    g.log.push(['role.create', o.name]);
    return mkRole({ name: o.name, hoist: o.hoist, position: 1 });
  };
  g.roles.setPositions = async (list) => {
    g.roles.positions = list;
    for (const e of list) g.roles.cache.get(e.role).position = e.position;
  };

  const mkChannel = (o) => {
    const ch = {
      id: o.id || String(seq++),
      name: o.name,
      type: o.type,
      parentId: o.parent || o.parentId || null,
      rawPosition: o.rawPosition ?? seq,
      topic: o.topic || null,
      guild: g,
      permissionOverwrites: {
        cache: toOverwrites(o.permissionOverwrites),
        async edit(id) {
          g.log.push(['channel.overwrite', ch.name, id]);
          g.edited.channels.push(ch.id);
          ch.permissionOverwrites.cache.set(id, { id, allow: { bitfield: 1n }, deny: { bitfield: 0n } });
        },
      },
      sent: [],
      async createInvite() {
        g.log.push(['invite.create', ch.name]);
        g.invited.push(ch.id);
        return { url: 'https://discord.gg/newinvite' };
      },
      async edit(patch) {
        g.log.push(['channel.edit', ch.name, Object.keys(patch).filter((k) => k !== 'reason')]);
        g.edited.channels.push(ch.id);
        if (patch.name !== undefined) ch.name = patch.name;
        if (patch.parent !== undefined) ch.parentId = patch.parent;
        if (patch.permissionOverwrites) ch.permissionOverwrites.cache = toOverwrites(patch.permissionOverwrites);
        return ch;
      },
      async setName(name) {
        g.log.push(['channel.edit', ch.name, ['name']]);
        ch.name = name;
        return ch;
      },
      async delete() {
        if (undeletable.includes(ch.id)) throw new Error('Missing Access');
        g.log.push(['channel.delete', ch.name]);
        g.deleted.channels.push(ch.id);
        g.channels.cache.delete(ch.id);
      },
      async send(p) {
        ch.sent.push(p);
        return {};
      },
    };
    g.channels.cache.set(ch.id, ch);
    return ch;
  };
  g.channels.fetch = async () => g.channels.cache;
  g.channels.create = async (o) => {
    creates += 1;
    if (failCreateAt && creates === failCreateAt) throw new Error('Missing Permissions');
    g.log.push(['channel.create', o.name]);
    // Discord lowercases text channel names and turns spaces into hyphens; categories and voice keep theirs.
    const name = o.type === T.GuildText ? o.name.toLowerCase().replace(/\s+/g, '-') : o.name;
    return mkChannel({ ...o, name });
  };
  g.invites = {
    fetch: async () => {
      if (invitesFail) throw new Error('Missing Permissions');
      return new Map(g.invitesList.map((i) => [i.code, i]));
    },
  };
  g.setAFKChannel = async (ch) => {
    g.afkChannelId = ch.id;
  };
  g.setSystemChannel = async (ch) => {
    g.systemChannelId = ch.id;
  };
  g.channels.setPositions = async (list) => {
    g.channels.positions = list;
  };

  g.mkRole = mkRole;
  g.mkChannel = mkChannel;
  mkRole({ id: 'G', name: '@everyone', position: 0 });
  for (const r of roles) mkRole(r);
  for (const c of channels) mkChannel(c);
  return g;
}

/** The server as it looks today, plus a few leftovers a rebuild should clear. */
function currentServer(extra = {}) {
  return {
    roles: [
      { id: 'BOTROLE', name: '35xw', position: 50, managed: true },
      { id: 'ABOVE', name: 'Above the bot', position: 60 },
      { id: VERIFIED, name: '+', position: 5 },
      { id: SENSITIVE, name: 'Admin', position: 20, admin: true },
      { id: 'MEMBER', name: 'Member', position: 2 },
      { id: 'VIP', name: 'vip', position: 3 },
      { id: 'FRIENDS', name: 'Friends', position: 4 },
      { id: 'BOOST', name: 'Server Booster', position: 6, managed: true },
      { id: 'MUTED', name: 'Muted', position: 7 },
      { id: 'OLDSTAFF', name: 'Old staff', position: 8 },
      { id: 'MOD', name: 'Moderator', position: 9, admin: true },
    ],
    channels: [
      { id: 'site', name: '35xw.top', type: T.GuildVoice },
      { id: 'oldchat', name: 'old-chat', type: T.GuildText },
      { id: 'cat-tickets', name: '🎫 Tickets', type: T.GuildCategory },
      { id: 'transcripts', name: 'transcripts', type: T.GuildText, parent: 'cat-tickets' },
      { id: 'ticket-1', name: 'ticket-0001', type: T.GuildText, parent: 'cat-tickets' },
      { id: 'cat-verify', name: 'VERIFY', type: T.GuildCategory },
      { id: 'ticket', name: '🎫ticket', type: T.GuildText, parent: 'cat-verify' },
      { id: 'cat-voice', name: 'VOICE', type: T.GuildCategory },
      { id: 'voice', name: '🔊VOICE', type: T.GuildVoice, parent: 'cat-voice' },
      { id: 'cat-general', name: 'general', type: T.GuildCategory },
      { id: 'general', name: 'general', type: T.GuildText, parent: 'cat-general' },
      { id: 'cat-osj', name: 'osjetljivo', type: T.GuildCategory },
      { id: 'o1', name: 'verzije-stranice', type: T.GuildText, parent: 'cat-osj' },
      { id: 'o2', name: 'logovi-stranice', type: T.GuildText, parent: 'cat-osj' },
      { id: 'o3', name: 'detalji-stranice', type: T.GuildText, parent: 'cat-osj' },
      { id: 'o4', name: 'cmd-matija', type: T.GuildText, parent: 'cat-osj' },
      { id: 'o5', name: 'logovi-dump', type: T.GuildText, parent: 'cat-osj' },
    ],
    ...extra,
  };
}

function mkServices(dir, file = 'db.json', cfg = CFG) {
  const storage = new Storage(path.join(dir, file));
  const tickets = new TicketService(storage, cfg);
  const roleMemory = new RoleMemoryService(storage, cfg.autoRole);
  const setup = new SetupService(storage, cfg, tickets, roleMemory);
  return { storage, tickets, roleMemory, setup };
}

const ow = (ch, id) => ch.permissionOverwrites.cache.get(id);
const allows = (ch, id, flag) => !!ow(ch, id) && (ow(ch, id).allow.bitfield & flag) === flag;
const denies = (ch, id, flag) => !!ow(ch, id) && (ow(ch, id).deny.bitfield & flag) === flag;
const byName = (g, name) => [...g.channels.cache.values()].find((c) => c.name === name);
const roleByName = (g, name) => [...g.roles.cache.values()].find((r) => r.name === name);
const touched = (g, name) => g.log.filter((l) => l[1] === name);

test('name helpers ignore decoration and recognise the + role', () => {
  assert.equal(normalizeName('🎫・verify'), 'verify');
  assert.equal(normalizeName('🎫ticket'), 'ticket');
  assert.equal(normalizeName('🔐 osjetljivo'), 'osjetljivo');
  assert.equal(normalizeName('🔊 ıl VOICE #1'), 'voice#1');
  assert.equal(isBlankName(BLANK_ROLE_NAME), true);
  assert.equal(isBlankName('a'), false);
  assert.equal(isPlusRole({ name: '+' }), true);
  assert.equal(isPlusRole({ name: ' + ' }), true);
  assert.equal(isPlusRole({ name: '++' }), false);
  assert.equal(isPlusRole({ name: 'plus' }), false);
});

test('permsFor: explicit overwrite types, verified hidden from verify, priv limited, filtered to held perms', () => {
  const ids = { everyone: 'G', bot: 'BOT', verified: 'V', support: 'S', privRoles: ['PR', 'PR2'], owner: 'OWNER', manager: null };
  const all = (f) => f;
  const get = (rows, id) => rows.find((r) => r.id === id);

  const verify = permsFor('verify', ids, all);
  assert.ok(get(verify, 'G').allow.includes(P.ViewChannel));
  assert.ok(get(verify, 'G').deny.includes(P.SendMessages));
  assert.deepEqual(get(verify, 'V').deny, [P.ViewChannel]);
  assert.ok(get(verify, 'S').allow.includes(P.ViewChannel));
  assert.equal(get(verify, 'G').type, OverwriteType.Role);
  assert.equal(get(verify, 'BOT').type, OverwriteType.Member);

  const priv = permsFor('private', ids, all);
  assert.ok(get(priv, 'G').deny.includes(P.ViewChannel));
  assert.ok(get(priv, 'PR').allow.includes(P.Connect));
  assert.ok(get(priv, 'PR2').allow.includes(P.ViewChannel));
  assert.equal(get(priv, 'OWNER').type, OverwriteType.Member);
  assert.equal(get(priv, 'V'), undefined);

  const reminder = permsFor('reminder', ids, all);
  assert.ok(get(reminder, 'G').allow.includes(P.ViewChannel));
  assert.ok(get(reminder, 'G').deny.includes(P.Connect));

  const held = (f) => f.filter((x) => x !== P.Connect && x !== P.Speak);
  const members = permsFor('members', ids, held);
  assert.ok(!get(members, 'V').allow.includes(P.Connect));
  assert.ok(get(members, 'V').allow.includes(P.ViewChannel));
  const withVip = { ...ids, vip: 'VIP', coowner: 'CO' };
  const info = permsFor('info', withVip, all);
  assert.ok(get(info, 'V').allow.includes(P.ViewChannel));
  assert.ok(get(info, 'V').deny.includes(P.SendMessages));
  assert.ok(get(info, 'S').allow.includes(P.SendMessages));
  const vip = permsFor('vip', withVip, all);
  assert.ok(get(vip, 'VIP').allow.includes(P.ViewChannel));
  assert.equal(get(vip, 'V'), undefined);
  const staff = permsFor('staff', withVip, all);
  assert.ok(get(staff, 'S').allow.includes(P.ViewChannel));
  assert.ok(get(staff, 'CO').allow.includes(P.ViewChannel));
  assert.equal(get(staff, 'VIP'), undefined);
  assert.throws(() => permsFor('nope', ids, all));
});

test('overwritesDiffer and hasOpenButton', () => {
  assert.equal(hasOpenButton({ components: [{ components: [{ customId: BUTTONS.open }] }] }), true);
  assert.equal(hasOpenButton({ components: [{ components: [{ custom_id: BUTTONS.open }] }] }), true);
  assert.equal(hasOpenButton({ components: [{ components: [{ customId: 'x' }] }] }), false);
  assert.equal(hasOpenButton({}), false);
  const ch = { permissionOverwrites: { cache: new Map([['G', { allow: { bitfield: 0n }, deny: { bitfield: P.ViewChannel } }]]) } };
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.ViewChannel] }]), false);
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.SendMessages] }]), true);
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.ViewChannel] }, { id: 'X', allow: [P.ViewChannel] }]), true);
  assert.equal(overwritesDiffer({}, []), true);
});

test('classifyChannels: kept roots and their children stay, Community channels are blocked, children go before categories', () => {
  const list = [
    { id: 'k', type: T.GuildCategory, name: 'keep', rawPosition: 1 },
    { id: 'k1', type: T.GuildText, name: 'in-keep', parentId: 'k', rawPosition: 0 },
    { id: 'c', type: T.GuildCategory, name: 'gone', rawPosition: 0 },
    { id: 'c1', type: T.GuildText, name: 'gone-child', parentId: 'c', rawPosition: 0 },
    { id: 'loose', type: T.GuildText, name: 'loose', rawPosition: 5 },
    { id: 'rules', type: T.GuildText, name: 'rules', rawPosition: 6 },
    { id: 'th', type: T.PublicThread, name: 'thread', isThread: () => true },
  ];
  const r = classifyChannels(list, { keepRoots: new Set(['k']), undeletable: new Set(['rules']) });
  assert.deepEqual(r.kept.map((c) => c.id).sort(), ['k', 'k1']);
  assert.deepEqual(r.blocked.map((c) => c.id), ['rules']);
  assert.deepEqual(r.remove.map((c) => c.id), ['c1', 'loose', 'c']);
});

test('classifyRoles: protects +, ids, admin and managed roles; reuses template roles; deletes the rest', () => {
  const mk = (id, name, position, extra = {}) => ({ id, name, position, managed: false, permissions: perm(), ...extra });
  const roles = [
    mk('G', '@everyone', 0),
    mk('PLUS', '+', 5),
    mk('ADM', 'Admin', 20, { permissions: perm(P.Administrator) }),
    mk('ACC', 'Access', 21),
    mk('B', 'Booster', 6, { managed: true }),
    mk('TOP', 'Higher', 60),
    mk('VIP', 'vip', 3),
    mk('CO', 'Co-Owner', 30),
    mk('M', 'member', 2),
    mk('X', 'Muted', 7),
    mk('BL', BLANK_ROLE_NAME, 1),
  ];
  const out = classifyRoles(roles, { botTop: 50, everyoneId: 'G', protectedIds: new Map([['ACC', 'gives access']]), autoRoleNames: ['member'], needVerified: false });
  const keptNames = out.kept.map((k) => k.name).sort();
  assert.deepEqual(keptNames, ['+', 'Access', 'Admin', 'Booster', 'Higher', 'member'].sort());
  assert.deepEqual(out.adopt.map((a) => [a.key, a.id]).sort(), [['blank', 'BL'], ['coowner', 'CO'], ['vip', 'VIP']].sort());
  assert.deepEqual(out.create.map((c) => c.key).sort(), ['friend', 'support']);
  assert.deepEqual(out.remove.map((r) => r.name), ['Muted']);
  const off = classifyRoles(roles, { botTop: 50, everyoneId: 'G', protectedIds: new Map(), autoRoleNames: [], deleteRoles: false });
  assert.deepEqual(off.remove, []);
  assert.ok(off.kept.some((k) => k.name === 'Muted' && k.reason === 'left alone'));
  const need = classifyRoles(roles, { botTop: 50, everyoneId: 'G', protectedIds: new Map(), needVerified: true });
  assert.ok(need.create.some((c) => c.key === 'verified'));
});

test('computePrivRoles: admins, everything above the lowest admin role, never ordinary member roles', () => {
  const mk = (id, name, position, extra = {}) => ({ id, name, position, managed: false, permissions: perm(), ...extra });
  const roles = [
    mk('G', '@everyone', 0),
    mk('MEM', 'Member', 2),
    mk('PLUS', '+', 11),
    mk('VER', 'Verified', 12),
    mk('MOD', 'Moderator', 10, { permissions: perm(P.Administrator) }),
    mk('DEC', 'Founder label', 15),
    mk('OWN', 'Owner', 30, { permissions: perm(P.Administrator) }),
    mk('BOT', 'a bot', 40, { managed: true }),
    mk('WEB', 'Website', 41),
    mk('LOW', 'Helper', 5),
    mk('X', 'Extra', 4),
  ];
  const out = computePrivRoles(roles, { everyoneId: 'G', exclude: new Set(['VER', 'WEB']), autoRoleNames: ['member'], extraIds: new Set(['X']) });
  assert.deepEqual(out.map((r) => [r.id, r.why]), [
    ['OWN', 'admin role'],
    ['DEC', 'above the admin roles'],
    ['MOD', 'admin role'],
    ['X', 'chosen in the command'],
  ]);
  // member-marking roles are skipped even when they carry Administrator
  const odd = computePrivRoles(
    [mk('G', '@everyone', 0), mk('PLUS', '+', 3, { permissions: perm(P.Administrator) }), mk('VER', 'Verified', 4, { permissions: perm(P.Administrator) }), mk('A', 'Admin', 5, { permissions: perm(P.Administrator) })],
    { everyoneId: 'G', exclude: new Set(['VER']), extraIds: new Set() },
  );
  assert.deepEqual(odd.map((r) => r.id), ['A']);
  // no admin role anywhere: nobody qualifies by position
  const none = computePrivRoles(roles.map((r) => ({ ...r, permissions: perm() })), { everyoneId: 'G', exclude: new Set(), extraIds: new Set() });
  assert.deepEqual(none, []);
});

test('planRoleOrder stacks the template roles above the anchor and only returns changes', () => {
  const roles = [
    { id: 'G', position: 0 },
    { id: 'A', position: 1 },
    { id: 'PLUS', position: 2 },
    { id: 'B', position: 3 },
    { id: 'new1', position: 4 },
    { id: 'new2', position: 5 },
    { id: 'BOT', position: 6 },
  ];
  const moves = planRoleOrder(roles, { botTop: 6, everyoneId: 'G', anchorId: 'PLUS', stack: ['new1', 'new2'] });
  const finalOrder = roles
    .filter((r) => r.id !== 'G')
    .map((r) => ({ ...r, position: (moves.find((m) => m.role === r.id) || { position: r.position }).position }))
    .sort((a, b) => a.position - b.position)
    .map((r) => r.id);
  assert.deepEqual(finalOrder, ['A', 'PLUS', 'new1', 'new2', 'B', 'BOT']);
  assert.ok(!moves.some((m) => m.role === 'BOT' || m.role === 'G'));
  assert.ok(!moves.some((m) => m.role === 'A'));
  // no anchor: the stack goes to the top of the band below the bot
  const top = planRoleOrder(roles, { botTop: 6, everyoneId: 'G', anchorId: null, stack: ['new1'] });
  assert.equal(top.find((m) => m.role === 'new1').position, 5); // highest slot below the bot
  assert.equal(top.find((m) => m.role === 'new2').position, 4);
  // a stack member that is not below the bot is ignored instead of moved
  assert.deepEqual(planRoleOrder(roles, { botTop: 6, everyoneId: 'G', anchorId: 'PLUS', stack: ['BOT'] }), []);
  assert.deepEqual(ROLE_STACK, ['blank', 'friend', 'vip', 'support', 'coowner']);
});

test('preview on the current server: keeps osjetljivo, tickets and the protected roles, lists what goes', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const res = await setup.preview(g, {});
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    const plan = res.plan;

    assert.deepEqual(plan.keepCategories.map((c) => c.name), ['osjetljivo']);
    assert.equal(plan.ticketCategory.name, '🎫 Tickets');
    const removed = plan.remove.map((c) => c.name).sort();
    assert.deepEqual(removed, ['35xw.top', '🎫ticket', '🔊VOICE', 'VERIFY', 'VOICE', 'general', 'general', 'old-chat'].sort());
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'cat-osj', 'transcripts', 'ticket-1', 'cat-tickets']) {
      assert.ok(!plan.remove.some((c) => c.id === id), `${id} must not be removed`);
    }

    const keptRoles = plan.roles.kept.map((r) => r.name).sort();
    assert.deepEqual(keptRoles, ['+', 'Admin', 'Above the bot', 'Member', 'Moderator', 'Server Booster', '35xw'].sort());
    assert.deepEqual(plan.roles.adopt.map((a) => a.key).sort(), ['friend', 'vip']);
    assert.deepEqual(plan.roles.create.map((c) => c.key).sort(), ['blank', 'coowner', 'support']);
    assert.deepEqual(plan.roles.remove.map((r) => r.name).sort(), ['Muted', 'Old staff']);
    assert.equal(plan.verified.id, VERIFIED);
    assert.equal(plan.verified.source, 'the configured role');
    assert.deepEqual(plan.warnings, []);
  } finally {
    rm(dir);
  }
});

test('preview refuses when the kept category is missing or the bot lacks permissions, and accepts the keep option', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const data = currentServer();
    data.channels = data.channels.map((c) => (c.id === 'cat-osj' ? { ...c, name: 'private stuff' } : c));
    const g = mkGuild(data);
    let res = await setup.preview(g, {});
    assert.equal(res.ok, false);
    assert.match(res.problems.join(' '), /osjetljivo/);

    res = await setup.preview(g, { keep: { id: 'cat-osj' } });
    assert.equal(res.ok, true);
    assert.ok(!res.plan.remove.some((c) => ['cat-osj', 'o1', 'o5'].includes(c.id)));

    const g2 = mkGuild({ ...currentServer(), admin: false });
    g2.members.me.permissions.has = (p) => p === P.ViewChannel;
    res = await setup.preview(g2, {});
    assert.equal(res.ok, false);
    assert.match(res.problems.join(' '), /Administrator/);
  } finally {
    rm(dir);
  }
});

test('preview finds the + role by name when the configured id does not exist, and honours the verified option', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const data = currentServer();
    data.roles = data.roles.map((r) => (r.id === VERIFIED ? { ...r, id: 'PLUSROLE' } : r));
    const g = mkGuild(data);
    let res = await setup.preview(g, {});
    assert.equal(res.plan.verified.id, 'PLUSROLE');
    assert.equal(res.plan.verified.source, 'the + role');
    assert.ok(res.plan.roles.kept.some((r) => r.id === 'PLUSROLE'));

    res = await setup.preview(g, { verified: g.roles.cache.get('MEMBER') });
    assert.equal(res.plan.verified.id, 'MEMBER');
    assert.ok(res.plan.roles.kept.some((r) => r.id === 'PLUSROLE')); // still never deleted

    const none = currentServer();
    none.roles = none.roles.filter((r) => r.id !== VERIFIED);
    res = await setup.preview(mkGuild(none), {});
    assert.equal(res.plan.verified.id, null);
    assert.ok(res.plan.roles.create.some((c) => c.key === 'verified'));
  } finally {
    rm(dir);
  }
});

test('execute rebuilds the layout: new things exist, old ones are gone, kept things are never touched', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets, storage } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, {});
    const steps = [];
    const res = await setup.execute(g, plan, { onProgress: async (s) => steps.push(s) });
    assert.equal(res.ok, true, JSON.stringify(res.report && res.report.failed));
    assert.deepEqual(res.report.failed, []);
    assert.deepEqual(steps, ['Roles', 'Building', 'Removing old channels', 'Removing old roles', 'Ordering']);

    // kept: osjetljivo and its channels, tickets and transcripts, the + role, admin and managed roles
    for (const n of ['osjetljivo', 'verzije-stranice', 'logovi-stranice', 'detalji-stranice', 'cmd-matija', 'logovi-dump', 'ticket-0001']) {
      assert.ok(byName(g, n), `${n} must survive`);
      assert.deepEqual(touched(g, n), [], `${n} must not be edited or deleted`);
    }
    for (const n of ['+', 'Admin', 'Moderator', 'Member', 'Server Booster', 'Above the bot']) {
      assert.ok(roleByName(g, n), `${n} must survive`);
      assert.deepEqual(touched(g, n), [], `role ${n} must not be edited or deleted`);
    }
    assert.equal(g.roles.cache.get(VERIFIED).name, '+');

    // old layout is gone
    for (const n of ['old-chat', '🎫ticket', '🔊VOICE', 'general', 'VERIFY', 'VOICE', '35xw.top']) assert.equal(byName(g, n), undefined, `${n} must be deleted`);
    assert.equal(roleByName(g, 'Muted'), undefined);
    assert.equal(roleByName(g, 'Old staff'), undefined);

    // new layout
    const site = byName(g, '🌐 ıl 35xw.top');
    assert.equal(site.type, T.GuildVoice);
    assert.equal(site.parentId, null);
    assert.ok(allows(site, 'G', P.ViewChannel));
    assert.ok(denies(site, 'G', P.Connect));

    const cat = (n) => byName(g, n);
    const kids = (c) => [...g.channels.cache.values()].filter((x) => x.parentId === c.id).map((x) => x.name);
    assert.deepEqual(kids(cat('🔒 ıl PRIVATE')), ['🔒・priv-chat', '🔒 ıl PRIV']);
    assert.deepEqual(kids(cat('✅ ıl VERIFY')), ['🎫・verify']);
    assert.deepEqual(kids(cat('📌 ıl INFO')), ['📜・rules', '📢・announcements', '🛠️・changelog', 'ℹ️・information', '🛒・buy-triggers', '🆗・joins']);
    assert.deepEqual(kids(cat('🌍 ıl GENERAL')), ['💬・chat', '🌍・balkan', '🤖・cmds', '🎮・gen', '♾️・triggers', '📢・server', '🗑️・dump']);
    assert.deepEqual(kids(cat('🔊 ıl VOICE')), ['🔊 ıl VOICE #1', '🔊 ıl VOICE #2', '🔊 ıl VOICE #3', '🌍 ıl BALKAN', '💤 ıl AFK']);
    assert.deepEqual(kids(cat('💎 ıl VIP')), ['💎・vip-chat', '💎 ıl VIP VOICE']);
    assert.deepEqual(kids(cat('🛡️ ıl STAFF')), ['📣・staff-news', '💬・staff-chat', '🚩・reports', '📋・logs', '🛡️ ıl STAFF VOICE']);
    assert.equal(byName(g, '🔒 ıl PRIV').type, T.GuildVoice);
    assert.equal(byName(g, '💬・chat').topic, 'General chat for verified members.');

    // roles: vip and Friends reused in place, three created, blank one is not hoisted
    assert.equal(g.roles.cache.get('VIP').name, '💎 ıl VIP');
    assert.equal(g.roles.cache.get('FRIENDS').name, '🤝 ıl FRIEND');
    const support = roleByName(g, '🎫 ıl SUPPORT');
    const coowner = roleByName(g, '👑 ıl CO-OWNER');
    const blank = roleByName(g, BLANK_ROLE_NAME);
    assert.ok(support && coowner && blank);
    assert.equal(blank.hoist, false);
    assert.equal(tickets.getStaffRole('G'), support.id);

    // permissions
    const verify = byName(g, '🎫・verify');
    assert.ok(allows(verify, 'G', P.ViewChannel));
    assert.ok(denies(verify, 'G', P.SendMessages));
    assert.ok(denies(verify, VERIFIED, P.ViewChannel));
    assert.ok(allows(verify, support.id, P.ViewChannel));
    for (const n of ['🌍 ıl GENERAL', '💬・chat', '🔊 ıl VOICE', '🔊 ıl VOICE #3']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, VERIFIED, P.ViewChannel), n);
    }
    for (const n of ['🔒 ıl PRIVATE', '🔒 ıl PRIV', '🔒・priv-chat']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, 'OWNER', P.ViewChannel), n);
      assert.ok(allows(ch, coowner.id, P.ViewChannel), n);
      // admins and every role above the lowest admin role
      for (const id of [SENSITIVE, 'MOD', 'ABOVE']) assert.ok(allows(ch, id, P.ViewChannel), `${n} ${id}`);
      // ordinary member roles never, however the hierarchy looks
      for (const id of [VERIFIED, 'VIP', 'FRIENDS', 'MEMBER', 'MUTED', 'OLDSTAFF']) assert.ok(!ow(ch, id), `${n} ${id}`);
    }
    // info is read-only for verified members, staff can post
    for (const n of ['📌 ıl INFO', '📜・rules', 'ℹ️・information', '🛒・buy-triggers', '🆗・joins']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, VERIFIED, P.ViewChannel), n);
      assert.ok(denies(ch, VERIFIED, P.SendMessages), n);
      assert.ok(allows(ch, support.id, P.SendMessages), n);
    }
    // VIP area: the VIP role and staff, not plain verified members
    const vipRole = g.roles.cache.get('VIP');
    for (const n of ['💎 ıl VIP', '💎・vip-chat', '💎 ıl VIP VOICE']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, vipRole.id, P.ViewChannel), n);
      assert.ok(allows(ch, support.id, P.ViewChannel), n);
      assert.ok(!ow(ch, VERIFIED), n);
    }
    // staff area: support and co-owner only
    for (const n of ['🛡️ ıl STAFF', '📋・logs', '🛡️ ıl STAFF VOICE']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, support.id, P.ViewChannel), n);
      assert.ok(allows(ch, coowner.id, P.ViewChannel), n);
      assert.ok(!ow(ch, VERIFIED) && !ow(ch, vipRole.id), n);
    }
    // tickets category and transcripts stay private and now include the new support role
    const tcat = byName(g, '🎫 Tickets');
    assert.ok(denies(tcat, 'G', P.ViewChannel));
    assert.ok(allows(tcat, support.id, P.ViewChannel));
    assert.ok(allows(byName(g, 'transcripts'), support.id, P.ViewChannel));

    // panel posted once, in the new verify channel
    assert.equal(verify.sent.length, 1);
    assert.equal(verify.sent[0].embeds[0].toJSON().title, '35xw verification');

    // order: reminder first, kept category last
    const order = g.channels.positions.sort((a, b) => a.position - b.position).map((p) => g.channels.cache.get(p.channel).name);
    assert.deepEqual(order, ['🌐 ıl 35xw.top', '🔒 ıl PRIVATE', '✅ ıl VERIFY', '🎫 Tickets', '📌 ıl INFO', '🌍 ıl GENERAL', '🔊 ıl VOICE', '💎 ıl VIP', '🛡️ ıl STAFF', 'osjetljivo']);
    // role order: stack sits directly above the + role
    const asc = [...g.roles.cache.values()].filter((r) => r.id !== 'G').sort((a, b) => a.position - b.position).map((r) => r.name);
    const at = asc.indexOf('+');
    assert.deepEqual(asc.slice(at + 1, at + 6), [BLANK_ROLE_NAME, '🤝 ıl FRIEND', '💎 ıl VIP', '🎫 ıl SUPPORT', '👑 ıl CO-OWNER']);

    // remembered for the next run, and the gate now points at the new verify channel
    const saved = storage.data.setup.G;
    assert.equal(saved.roles.verified, VERIFIED);
    assert.equal(saved.channels.verify_ch, verify.id);
    assert.deepEqual(saved.keep, ['cat-osj']);
    assert.equal(setup.getVerifyChannelId(g), verify.id);
    assert.equal(setup.isRunning('G'), false);
    assert.ok(res.report.kept.includes('osjetljivo'));
  } finally {
    rm(dir);
  }
});

test('the verified role is never renamed or deleted, even when it is a role other than +', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, { verified: g.roles.cache.get('MUTED') });
    await setup.execute(g, plan);
    assert.ok(g.roles.cache.get('MUTED'));
    assert.equal(g.roles.cache.get('MUTED').name, 'Muted');
    assert.ok(g.roles.cache.get(VERIFIED)); // the + role as well
  } finally {
    rm(dir);
  }
});

test('delete_roles false leaves every role alone, and the priv role option controls priv access', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, { deleteRoles: false, priv: g.roles.cache.get('OLDSTAFF') });
    assert.deepEqual(plan.roles.remove, []);
    await setup.execute(g, plan);
    assert.ok(g.log.every((l) => l[0] !== 'role.delete'));
    assert.ok(g.roles.cache.get('OLDSTAFF')); // chosen for priv, so protected as well
    const priv = byName(g, '🔒 ıl PRIV');
    assert.ok(allows(priv, 'OLDSTAFF', P.ViewChannel)); // the extra role
    assert.ok(allows(priv, roleByName(g, '👑 ıl CO-OWNER').id, P.ViewChannel)); // always
    assert.ok(allows(priv, SENSITIVE, P.ViewChannel)); // admins as well
  } finally {
    rm(dir);
  }
});

test('a failed build removes what it created, reverts the roles and deletes nothing old', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets } = mkServices(dir);
    const g = mkGuild({ ...currentServer(), failCreateAt: 6 });
    const before = [...g.channels.cache.keys()].sort();
    const { plan } = await setup.preview(g, {});
    const res = await setup.execute(g, plan);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'build_failed');
    assert.match(res.message, /Missing Permissions/);
    assert.deepEqual([...g.channels.cache.keys()].sort(), before);
    assert.deepEqual(res.left, { channels: [], roles: [] });
    const made = g.log.filter((l) => l[0] === 'channel.create').map((l) => l[1].toLowerCase());
    assert.ok(g.log.filter((l) => l[0] === 'channel.delete').every((l) => made.includes(l[1].toLowerCase())), 'only channels this run made were deleted');
    // roles: the new ones are gone again and the renamed ones have their name back
    assert.equal(roleByName(g, '🎫 ıl SUPPORT'), undefined);
    assert.equal(roleByName(g, '👑 ıl CO-OWNER'), undefined);
    assert.equal(g.roles.cache.get('VIP').name, 'vip');
    assert.equal(g.roles.cache.get('FRIENDS').name, 'Friends');
    assert.deepEqual(g.deleted.roles.filter((id) => ['MUTED', 'OLDSTAFF'].includes(id)), []);
    assert.equal(tickets.getStaffRole('G'), null); // ticket state untouched
    assert.deepEqual(g.log.filter((l) => l[0] === 'channel.edit' || l[0] === 'channel.overwrite'), []);
    assert.equal(setup.isRunning('G'), false);
  } finally {
    rm(dir);
  }
});

test('rollback only touches what the run created, and says what it could not remove', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets } = mkServices(dir);
    // a member opens a ticket while the ticket service resolves its category
    const g = mkGuild({ ...currentServer(), failCreateAt: 9 });
    const realTranscript = tickets.ensureTranscriptChannel.bind(tickets);
    tickets.ensureTranscriptChannel = async (guild) => {
      guild.mkChannel({ id: 'ticket-2', name: 'ticket-0002', type: T.GuildText, parent: 'cat-tickets' });
      guild.mkChannel({ id: 'foreign', name: 'made-by-a-site-bot', type: T.GuildText, parent: 'cat-osj' });
      return realTranscript(guild);
    };
    const { plan } = await setup.preview(g, {});
    const res = await setup.execute(g, plan);
    assert.equal(res.reason, 'build_failed');
    assert.ok(g.channels.cache.has('ticket-2'), 'the ticket opened meanwhile survives');
    assert.ok(g.channels.cache.has('foreign'), 'channels other actors made survive');

    // deletes of the new channels fail: they are listed instead of claimed as removed
    const g2 = mkGuild({ ...currentServer(), failCreateAt: 9 });
    const { plan: plan2 } = await setup.preview(g2, {});
    const original = g2.channels.create;
    g2.channels.create = async (o) => {
      const ch = await original(o);
      if (o.name !== '🌐 ıl 35xw.top') ch.delete = async () => { throw new Error('Missing Access'); };
      return ch;
    };
    const res2 = await setup.execute(g2, plan2);
    assert.equal(res2.reason, 'build_failed');
    assert.ok(res2.left.channels.length > 0);
    const { _failureCard } = require('../src/commands/setup');
    const text = _failureCard(res2).toJSON().description;
    assert.match(text, /could not be removed again/);
  } finally {
    rm(dir);
  }
});

test('a role that cannot be created stops the rebuild before anything is deleted', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild({ ...currentServer(), failRoleCreate: 2 });
    const { plan } = await setup.preview(g, {});
    const res = await setup.execute(g, plan);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'roles_failed');
    assert.deepEqual(g.deleted.channels, []);
    assert.deepEqual(g.deleted.roles.filter((id) => ['MUTED', 'OLDSTAFF'].includes(id)), []);
    assert.equal(g.log.filter((l) => l[0] === 'channel.create').length, 0);
    assert.equal(g.roles.cache.get('VIP').name, 'vip'); // renamed roles were put back

    // the verified role vanished after the preview
    const g2 = mkGuild(currentServer());
    const { plan: plan2 } = await setup.preview(g2, {});
    g2.roles.cache.delete(VERIFIED);
    const res2 = await setup.execute(g2, plan2);
    assert.equal(res2.reason, 'verified_missing');
    assert.deepEqual(g2.log, []);
  } finally {
    rm(dir);
  }
});

test('only what the preview listed is deleted: later channels and channels moved into a kept category survive', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, {});
    g.mkChannel({ id: 'late', name: 'made-after-preview', type: T.GuildText });
    g.channels.cache.get('general').parentId = 'cat-osj'; // moved into the kept category
    g.mkRole({ id: 'LATEROLE', name: 'late role', position: 10 });
    await setup.execute(g, plan);
    assert.ok(byName(g, 'made-after-preview'));
    assert.ok(g.channels.cache.get('general'));
    assert.ok(g.roles.cache.get('LATEROLE'));
    assert.equal(byName(g, 'old-chat'), undefined);
  } finally {
    rm(dir);
  }
});

test('Community required channels are reported and left alone; deleting failures do not stop the run', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const data = currentServer();
    data.channels.push({ id: 'rules', name: 'rules', type: T.GuildText });
    data.channels.push({ id: 'stuck', name: 'stuck', type: T.GuildText });
    const g = mkGuild({ ...data, rulesChannelId: 'rules' });
    const { plan } = await setup.preview(g, {});
    assert.deepEqual(plan.blocked.map((c) => c.name), ['rules']);
    assert.match(plan.warnings.join(' '), /rules/);
    g.channels.cache.get('stuck').delete = async () => {
      throw new Error('Missing Access');
    };
    const res = await setup.execute(g, plan);
    assert.equal(res.ok, true);
    assert.ok(byName(g, 'rules'));
    assert.ok(res.report.failed.some((f) => f.startsWith('stuck')));
    assert.equal(byName(g, 'old-chat'), undefined);
  } finally {
    rm(dir);
  }
});

test('execute refuses a second run at the same time and when a kept category vanished', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, {});
    setup.running.add('G');
    assert.equal((await setup.execute(g, plan)).reason, 'in_progress');
    setup.running.delete('G');
    g.channels.cache.delete('cat-osj');
    const res = await setup.execute(g, plan);
    assert.equal(res.reason, 'keep_missing');
    assert.equal(g.log.filter((l) => l[0] === 'channel.delete' || l[0] === 'channel.create').length, 0);
    assert.equal(setup.isRunning('G'), false);
  } finally {
    rm(dir);
  }
});

test('pending confirmations are single use, bound to the user and the server, and expire', () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const plan = { guildId: 'G', warnings: [] };
    let token = setup.createPending(plan, 'OWNER');
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'OWNER' }), plan);
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'OWNER' }), null); // used up
    token = setup.createPending(plan, 'OWNER');
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'SOMEONE' }), null);
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'OWNER' }), null); // wrong attempt burns it
    token = setup.createPending(plan, 'OWNER');
    assert.equal(setup.takePending(token, { guildId: 'OTHER', userId: 'OWNER' }), null);
    token = setup.createPending(plan, 'OWNER');
    setup.pending.get(token).expires = Date.now() - 1;
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'OWNER' }), null);
    token = setup.createPending(plan, 'OWNER');
    setup.dropPending(token);
    assert.equal(setup.takePending(token, { guildId: 'G', userId: 'OWNER' }), null);
  } finally {
    rm(dir);
  }
});

/** A fake interaction plus ctx for the /setup command. */
function mkInteraction(g, setup, { userId = 'OWNER', customId = null, sub = 'server', options = {}, editFails = false, dmFails = false } = {}) {
  const st = { replies: [], edits: [], updates: [], dms: [], deferred: null };
  const it = {
    user: {
      id: userId,
      username: userId,
      send: async (p) => {
        if (dmFails) throw new Error('Cannot send messages to this user');
        st.dms.push(p);
      },
    },
    guild: g,
    guildId: g.id,
    customId,
    options: {
      getSubcommand: () => sub,
      getRole: (n) => (options[n] && g.roles.cache.get(options[n])) || null,
      getChannel: (n) => (options[n] && g.channels.cache.get(options[n])) || null,
      getBoolean: (n) => (n in options ? options[n] : null),
    },
    get deferred() {
      return !!st.deferred;
    },
    replied: false,
    async reply(p) {
      st.replies.push(p);
      return {};
    },
    async deferReply(p) {
      st.deferred = p;
      return {};
    },
    async editReply(p) {
      if (editFails && p.embeds && /rebuilt/i.test(p.embeds[0].toJSON().title || '')) throw new Error('Unknown Channel');
      st.edits.push(p);
      return {};
    },
    async update(p) {
      st.updates.push(p);
      return {};
    },
  };
  const ctx = {
    setup,
    isManager: (u) => u.id === 'MGR',
    isOwnerOrManager: () => userId === 'OWNER' || userId === 'MGR',
  };
  return { it, ctx, st };
}

const titleOf = (p) => p.embeds[0].toJSON().title;

test('/setup server: preview card with a confirm and a cancel button, nothing deleted yet', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const { it, ctx, st } = mkInteraction(g, setup);
    await cmd.execute(it, ctx);
    assert.ok(st.deferred);
    const p = st.edits[0];
    assert.equal(titleOf(p), 'Rebuild the server?');
    const e = p.embeds[0].toJSON();
    const names = e.fields.map((f) => f.name);
    assert.deepEqual(names.slice(0, 6).map((n) => n.replace(/ \(\d+\)$/, '')), ['Stays as it is', 'Categories deleted', 'Channels deleted', 'Roles deleted', 'Will be created', 'Access']);
    const all = e.fields.map((f) => f.value).join('\n');
    assert.match(all, /osjetljivo/);
    assert.match(all, /Muted/);
    const ids = p.components[0].toJSON().components.map((c) => c.custom_id);
    assert.match(ids[0], /^setup:go:[0-9a-f]{16}$/);
    assert.match(ids[1], /^setup:no:[0-9a-f]{16}$/);
    assert.equal(g.log.length, 0);
    assert.equal(setup.pending.size, 1);
    for (const f of e.fields) assert.ok(f.value.length <= 1024, `${f.name} fits an embed field`);
  } finally {
    rm(dir);
  }
});

test('/setup server: refuses non-owners, stops when a rebuild runs, explains missing pieces', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());

    let x = mkInteraction(g, setup, { userId: 'ADMIN' });
    await cmd.execute(x.it, x.ctx);
    assert.match(x.st.replies[0].embeds[0].toJSON().description, /server owner/);
    assert.equal(setup.pending.size, 0);

    setup.running.add('G');
    x = mkInteraction(g, setup);
    await cmd.execute(x.it, x.ctx);
    assert.match(x.st.replies[0].embeds[0].toJSON().description, /already running/);
    setup.running.delete('G');

    const bare = mkGuild({ roles: [], channels: [] });
    x = mkInteraction(bare, setup);
    await cmd.execute(x.it, x.ctx);
    assert.equal(titleOf(x.st.edits[0]), 'Cannot rebuild yet');
    assert.equal(setup.pending.size, 0);
  } finally {
    rm(dir);
  }
});

test('/setup server buttons: cancel, wrong person, expired, and a full confirmed run', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const start = async () => {
      const x = mkInteraction(g, setup);
      await cmd.execute(x.it, x.ctx);
      return x.st.edits[0].components[0].toJSON().components.map((c) => c.custom_id);
    };

    // cancel
    let [go, no] = await start();
    let b = mkInteraction(g, setup, { customId: no });
    await cmd.handleButton(b.it, b.ctx);
    assert.equal(titleOf(b.st.updates[0]), 'Cancelled');
    assert.equal(setup.pending.size, 0);
    assert.equal(g.log.length, 0);

    // somebody else pressing it
    [go] = await start();
    b = mkInteraction(g, setup, { userId: 'ADMIN', customId: go });
    await cmd.handleButton(b.it, b.ctx);
    assert.match(b.st.replies[0].embeds[0].toJSON().description, /server owner/);
    assert.equal(g.log.length, 0);

    // expired
    [go] = await start();
    for (const v of setup.pending.values()) v.expires = Date.now() - 1;
    b = mkInteraction(g, setup, { customId: go });
    await cmd.handleButton(b.it, b.ctx);
    assert.equal(titleOf(b.st.updates[0]), 'Preview expired');
    assert.equal(g.log.length, 0);

    // confirmed: progress first, then the summary; a second press of the same button does nothing
    [go] = await start();
    b = mkInteraction(g, setup, { customId: go });
    await cmd.handleButton(b.it, b.ctx);
    assert.equal(titleOf(b.st.updates[0]), 'Rebuilding the server');
    assert.deepEqual(b.st.updates[0].components, []);
    const last = b.st.edits[b.st.edits.length - 1];
    assert.equal(titleOf(last), 'Server rebuilt');
    assert.ok(byName(g, '✅ ıl VERIFY'));
    assert.equal(byName(g, 'old-chat'), undefined);
    const again = mkInteraction(g, setup, { customId: go });
    await cmd.handleButton(again.it, again.ctx);
    assert.equal(again.st.updates.length, 0, 'a second press must not overwrite the progress or the summary');
    assert.match(again.st.replies[0].embeds[0].toJSON().description, /already started/);
  } finally {
    rm(dir);
  }
});

test('/setup server: when the reply cannot be edited any more the summary goes to a direct message', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const first = mkInteraction(g, setup);
    await cmd.execute(first.it, first.ctx);
    const go = first.st.edits[0].components[0].toJSON().components[0].custom_id;
    const b = mkInteraction(g, setup, { customId: go, editFails: true });
    await cmd.handleButton(b.it, b.ctx);
    assert.equal(b.st.dms.length, 1);
    assert.equal(titleOf(b.st.dms[0]), 'Server rebuilt');
  } finally {
    rm(dir);
  }
});

test('the summary card reports problems and stays inside embed limits', () => {
  const { _summaryCard, _previewCard } = require('../src/commands/setup');
  const many = Array.from({ length: 60 }, (_, i) => `item number ${i}`);
  const e = _summaryCard({ created: many, updated: many, deleted: many, kept: many, failed: ['x: boom'], warnings: many }).toJSON();
  assert.equal(e.title, 'Server rebuilt with problems');
  for (const f of e.fields) assert.ok(f.value.length <= 1024);
  const total = (e.title.length + (e.description || '').length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0));
  assert.ok(total <= 6000);
  assert.equal(typeof _previewCard, 'function');
});

test('verifiedGate: the verified role, owner, admins, manager and bypass pass; everyone else is sent to the verify channel', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const member = (roles = [], perms = []) => ({ roles: { cache: new Set(roles) }, permissions: { has: (p) => perms.includes(p) } });
    const opts = { isManager: (u) => u.id === 'MGR', isBypass: (u) => u.id === 'BYP' };

    assert.equal(setup.getVerifiedRoleId(g), VERIFIED);
    let r = setup.verifiedGate(g, member([]), { id: 'U1' }, opts);
    assert.equal(r.ok, false);
    assert.equal(r.roleId, VERIFIED);
    assert.equal(r.channelId, null);
    assert.equal(setup.verifiedGate(g, member([VERIFIED]), { id: 'U1' }, opts).ok, true);
    assert.equal(setup.verifiedGate(g, member([]), { id: 'OWNER' }, opts).ok, true);
    assert.equal(setup.verifiedGate(g, member([]), { id: 'MGR' }, opts).ok, true);
    assert.equal(setup.verifiedGate(g, member([]), { id: 'BYP' }, opts).ok, true);
    assert.equal(setup.verifiedGate(g, member([], [P.Administrator]), { id: 'U2' }, opts).ok, true);
    assert.equal(setup.verifiedGate(g, member([], [P.ManageGuild]), { id: 'U2' }, opts).ok, true);

    const { plan } = await setup.preview(g, {});
    await setup.execute(g, plan);
    r = setup.verifiedGate(g, member([]), { id: 'U1' }, opts);
    assert.equal(r.ok, false);
    assert.equal(r.channelId, byName(g, '🎫・verify').id);

    const g2 = mkGuild({});
    assert.equal(setup.getVerifiedRoleId(g2), null);
    assert.equal(setup.verifiedGate(g2, member([]), { id: 'U1' }, opts).ok, true); // no known role: open
  } finally {
    rm(dir);
  }
});

test('command flags: verified-only account commands, owner-only /n and /setup', () => {
  const { commands } = require('../src/commands');
  for (const n of ['steam', '5m', 'combo', 'stats', 'help', 'ping']) {
    assert.equal(commands.get(n).requiresVerified, true, n);
    assert.ok(!commands.get(n).ownerOnly, n);
  }
  for (const n of ['n', 'setup']) {
    assert.equal(commands.get(n).ownerOnly, true, n);
    assert.equal(commands.get(n).managerOnly, false, n);
  }
  assert.equal(commands.get('setup').buttonPrefix, 'setup:');
  for (const n of ['v', 'close', 'add', 'aa', 'f', 'roles', 'b', 'refills', 'refill5']) {
    assert.ok(!commands.get(n).requiresVerified, n);
  }
});

/** Small deterministic generator so a failing seed can be replayed. */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test('property: on random servers nothing protected is lost and only previewed things are deleted', async () => {
  const dir = tmpDir();
  try {
    let rebuilt = 0;
    let refused = 0;
    let rolledBack = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed);
      const int = (n) => Math.floor(r() * n);
      const chance = (p) => r() < p;

      // ---- random roles, remembering which ones must survive untouched ----
      const roles = [{ id: 'BOTROLE', name: '35xw', position: 50, managed: true }];
      const mustKeepRoles = new Set(['BOTROLE']); // never deleted
      const untouchedRoles = new Set(['BOTROLE']); // never edited either
      const adminRoles = new Map(); // admin roles may be renamed only when they already look like a template role
      let pos = 1;
      const roleNames = ['+', 'Admin', 'Member', 'vip', 'Friends', 'Muted', 'Moderator', 'staff', 'Co-owner', 'random', 'Ninja'];
      const count = 2 + int(9);
      for (let i = 0; i < count; i++) {
        const name = roleNames[int(roleNames.length)] + (chance(0.4) ? ` ${i}` : '');
        const role = { id: `R${i}`, name, position: pos++, managed: chance(0.1), admin: chance(0.15) };
        roles.push(role);
        if (role.managed || role.admin || name.trim() === '+') mustKeepRoles.add(role.id);
        if (role.managed || name.trim() === '+') untouchedRoles.add(role.id);
        else if (role.admin) adminRoles.set(role.id, name);
      }
      const verifiedName = chance(0.5) ? '+' : 'Verified';
      roles.push({ id: VERIFIED, name: verifiedName, position: pos++ });
      for (const id of [VERIFIED]) [mustKeepRoles, untouchedRoles].forEach((set) => set.add(id));
      if (chance(0.7)) {
        roles.push({ id: SENSITIVE, name: 'Access', position: pos++ });
        [mustKeepRoles, untouchedRoles].forEach((set) => set.add(SENSITIVE));
      }
      if (chance(0.3)) {
        roles.push({ id: 'TOP', name: 'Top', position: 60 });
        [mustKeepRoles, untouchedRoles].forEach((set) => set.add('TOP'));
      }
      roles.push({ id: 'MEMBER', name: 'Member', position: pos++ });
      [mustKeepRoles, untouchedRoles].forEach((set) => set.add('MEMBER')); // the auto role

      // ---- random channels ----
      const channels = [];
      const mustKeepChannels = new Set();
      const hasOsj = chance(0.9);
      const hasTickets = chance(0.7);
      const cats = 1 + int(4);
      for (let c = 0; c < cats; c++) {
        channels.push({ id: `cat${c}`, name: `category ${c}`, type: T.GuildCategory });
        for (let k = int(4); k > 0; k--) channels.push({ id: `cat${c}-ch${k}`, name: `chan ${c}-${k}`, type: chance(0.3) ? T.GuildVoice : T.GuildText, parent: `cat${c}` });
      }
      if (hasOsj) {
        channels.push({ id: 'OSJ', name: chance(0.5) ? 'osjetljivo' : '🔐 OSJETLJIVO', type: T.GuildCategory });
        mustKeepChannels.add('OSJ');
        for (let k = 1 + int(5); k > 0; k--) {
          channels.push({ id: `osj-${k}`, name: `secret ${k}`, type: T.GuildText, parent: 'OSJ' });
          mustKeepChannels.add(`osj-${k}`);
        }
        // a role that only appears in a permission overwrite of the kept category must survive too
        const named = roles.filter((x) => x.id.startsWith('R'));
        if (named.length && chance(0.6)) {
          const pick = named[int(named.length)];
          channels.find((c) => c.id === 'OSJ').permissionOverwrites = [{ id: pick.id, allow: [P.ViewChannel] }];
          mustKeepRoles.add(pick.id);
          untouchedRoles.add(pick.id);
          adminRoles.delete(pick.id);
        }
      }
      if (hasTickets) {
        channels.push({ id: 'TCAT', name: '🎫 Tickets', type: T.GuildCategory });
        mustKeepChannels.add('TCAT');
        for (let k = int(4); k > 0; k--) {
          channels.push({ id: `tk-${k}`, name: `ticket-000${k}`, type: T.GuildText, parent: 'TCAT' });
          mustKeepChannels.add(`tk-${k}`);
        }
      }
      for (let k = int(4); k > 0; k--) channels.push({ id: `loose${k}`, name: `loose ${k}`, type: chance(0.5) ? T.GuildVoice : T.GuildText });
      const rules = chance(0.3) ? 'loose1' : null;
      if (rules && !channels.some((c) => c.id === rules)) channels.push({ id: rules, name: 'rules', type: T.GuildText });

      const { setup } = mkServices(dir, `db${seed}.json`); // every random server starts with its own database
      const g = mkGuild({ roles, channels, rulesChannelId: rules, failCreateAt: chance(0.15) ? 1 + int(30) : 0, failRoleCreate: chance(0.08) ? 1 + int(3) : 0 });
      const before = new Set(g.channels.cache.keys());
      const deleteRoles = !chance(0.2);

      const res = await setup.preview(g, { deleteRoles });
      if (!hasOsj) {
        assert.equal(res.ok, false, `seed ${seed}: must refuse without the kept category`);
        assert.deepEqual(g.log, [], `seed ${seed}: a refused preview changes nothing`);
        refused += 1;
        continue;
      }
      assert.equal(res.ok, true, `seed ${seed}: ${JSON.stringify(res.problems)}`);
      const listedChannels = new Set(res.plan.remove.map((c) => c.id));
      const listedRoles = new Set(res.plan.roles.remove.map((x) => x.id));
      for (const id of mustKeepChannels) assert.ok(!listedChannels.has(id), `seed ${seed}: ${id} must never be previewed for deletion`);
      for (const id of mustKeepRoles) assert.ok(!listedRoles.has(id), `seed ${seed}: role ${id} must never be previewed for deletion`);
      if (rules) assert.ok(!listedChannels.has(rules), `seed ${seed}: the Community rules channel cannot be deleted`);

      // things that appear after the preview must be left alone
      g.mkChannel({ id: 'late', name: 'late', type: T.GuildText });
      g.mkRole({ id: 'LATE', name: 'late role', position: 10 });

      const out = await setup.execute(g, res.plan);
      if (!out.ok) {
        rolledBack += 1;
        assert.ok(['build_failed', 'roles_failed'].includes(out.reason), `seed ${seed}: ${out.reason}`);
        for (const id of before) assert.ok(g.channels.cache.has(id), `seed ${seed}: a failed run must delete nothing old (${id})`);
        const originalRoles = new Set(roles.map((x) => x.id));
        for (const id of g.deleted.roles) assert.ok(!originalRoles.has(id), `seed ${seed}: a failed run deletes no old role (${id})`);
        for (const x of roles) assert.equal(g.roles.cache.get(x.id).name, x.name, `seed ${seed}: role ${x.id} got its name back`);
        assert.equal([...g.channels.cache.keys()].length, before.size + 1, `seed ${seed}: the created channels are cleaned up (only "late" is new)`);
        assert.equal(setup.isRunning('G'), false);
        continue;
      }
      rebuilt += 1;

      for (const id of mustKeepChannels) assert.ok(g.channels.cache.has(id), `seed ${seed}: kept channel ${id} disappeared`);
      for (const id of mustKeepChannels) {
        if (id === 'TCAT') continue; // its permissions are re-applied for the new support role
        assert.ok(!g.edited.channels.includes(id), `seed ${seed}: kept channel ${id} was edited`);
      }
      for (const id of mustKeepRoles) assert.ok(g.roles.cache.has(id), `seed ${seed}: protected role ${id} disappeared`);
      for (const id of untouchedRoles) assert.ok(!g.edited.roles.includes(id), `seed ${seed}: protected role ${id} was edited`);
      const templateWords = ['coowner', 'suvlasnik', 'support', 'ticketsupport', 'staff', 'ticketstaff', 'vip', 'vips', 'friend', 'friends'];
      for (const [id, original] of adminRoles) {
        if (g.edited.roles.includes(id)) assert.ok(templateWords.includes(normalizeName(original)), `seed ${seed}: admin role ${original} (${id}) was renamed but is not a template role; staff=${setup.tickets.getStaffRole('G')} edits=${JSON.stringify(g.log.filter((l) => l[0] === 'role.edit'))}`);
      }
      assert.ok(g.channels.cache.has('late'), `seed ${seed}: a channel made after the preview must survive`);
      assert.ok(g.roles.cache.has('LATE'), `seed ${seed}: a role made after the preview must survive`);
      for (const id of g.deleted.channels) assert.ok(listedChannels.has(id), `seed ${seed}: channel ${id} was deleted without being previewed`);
      for (const id of g.deleted.roles) assert.ok(listedRoles.has(id), `seed ${seed}: role ${id} was deleted without being previewed`);
      if (!deleteRoles) assert.deepEqual(g.deleted.roles, [], `seed ${seed}: delete_roles false deletes no roles`);
      if (rules) assert.ok(g.channels.cache.has(rules), `seed ${seed}: the rules channel is still there`);
      assert.ok(byName(g, '🎫・verify'), `seed ${seed}: the new layout exists`);
      // the private channels are never opened to ordinary members
      const privCh = byName(g, '🔒 ıl PRIV');
      const adminFloor = Math.min(...roles.filter((x) => x.admin && !x.managed).map((x) => x.position), Infinity);
      const coRole = [...g.roles.cache.values()].find((x) => normalizeName(x.name) === 'coowner' && x.name.includes('ıl'));
      for (const [id] of privCh.permissionOverwrites.cache) {
        if (['G', 'BOT', 'OWNER'].includes(id)) continue;
        const rr = g.roles.cache.get(id);
        assert.ok(rr, `seed ${seed}: overwrite ${id} points at a role that exists`);
        assert.notEqual(id, VERIFIED, `seed ${seed}: the verified role must never reach the priv channel`);
        assert.notEqual(id, 'MEMBER', `seed ${seed}: the auto role must never reach the priv channel`);
        assert.notEqual(rr.name.trim(), '+', `seed ${seed}: the + role must never reach the priv channel`);
        const before = roles.find((x) => x.id === id); // positions change while the roles are reordered, so judge by the originals
        const ok = (coRole && coRole.id === id) || (before && (before.admin || before.position > adminFloor));
        assert.ok(ok, `seed ${seed}: ${rr.name} has no reason to reach the priv channel`);
      }
      assert.equal(setup.isRunning('G'), false);
    }
    assert.ok(rebuilt > 100 && refused > 5 && rolledBack > 5, `the generator should cover every branch (rebuilt ${rebuilt}, refused ${refused}, rolled back ${rolledBack})`);
  } finally {
    rm(dir);
  }
});

// ---------- findings from the independent review ----------

const goButton = async (cmd, g, setup, options = {}, extra = {}) => {
  const first = mkInteraction(g, setup, { options });
  await cmd.execute(first.it, first.ctx);
  const go = first.st.edits[0].components[0].toJSON().components[0].custom_id;
  const b = mkInteraction(g, setup, { customId: go, ...extra });
  await cmd.handleButton(b.it, b.ctx);
  return { b, first };
};

test('roles that appear only in the permissions of a kept channel are never deleted, also when that changes after the preview', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const data = currentServer();
    data.roles.push({ id: 'DEV', name: 'Site devs', position: 1 });
    data.channels = data.channels.map((c) => (c.id === 'o2' ? { ...c, permissionOverwrites: [{ id: 'G', deny: [P.ViewChannel] }, { id: 'DEV', allow: [P.ViewChannel] }] } : c));
    const g = mkGuild(data);
    const { plan } = await setup.preview(g, {});
    assert.ok(plan.roles.kept.some((r) => r.id === 'DEV' && r.reason === 'used in a kept channel'));
    assert.ok(!plan.roles.remove.some((r) => r.id === 'DEV'));
    // a listed role starts being used by a kept channel after the preview
    g.channels.cache.get('o3').permissionOverwrites.cache.set('MUTED', { id: 'MUTED', allow: { bitfield: 1n }, deny: { bitfield: 0n } });
    await setup.execute(g, plan);
    assert.ok(g.roles.cache.has('DEV'));
    assert.ok(g.roles.cache.has('MUTED'));
    assert.ok(!g.deleted.roles.includes('DEV'));
    assert.equal(roleByName(g, 'Old staff'), undefined); // an unrelated listed role is still deleted
  } finally {
    rm(dir);
  }
});

test('a transcripts channel inside a kept category is never taken over; the ticket one is made in the tickets category', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets } = mkServices(dir);
    const data = currentServer();
    data.channels = data.channels.filter((c) => c.id !== 'transcripts');
    data.channels.push({ id: 'osj-tr', name: 'transcripts', type: T.GuildText, parent: 'cat-osj' });
    const g = mkGuild(data);
    const { plan } = await setup.preview(g, {});
    await setup.execute(g, plan);
    assert.equal(g.channels.cache.get('osj-tr').parentId, 'cat-osj');
    assert.ok(!g.edited.channels.includes('osj-tr'), 'the channel inside the kept category was not edited');
    assert.ok(!g.deleted.channels.includes('osj-tr'));
    const own = [...g.channels.cache.values()].find((c) => c.name === 'transcripts' && c.parentId === 'cat-tickets');
    assert.ok(own, 'a transcripts channel exists in the tickets category');
    assert.notEqual(own.id, 'osj-tr');
    assert.equal(tickets.findCategory(g).id, 'cat-tickets');
  } finally {
    rm(dir);
  }
});

test('preview and execution agree on the tickets category, whatever else is named like it', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets } = mkServices(dir);
    const data = currentServer();
    data.channels.unshift({ id: 'decoy', name: '🎫 tickets', type: T.GuildCategory, rawPosition: -5 }); // same name, empty, first in order
    let g = mkGuild(data);
    // the stored id wins over the name
    tickets._guild('G').categoryId = 'cat-tickets';
    assert.equal(tickets.findCategory(g).id, 'cat-tickets');
    const { plan } = await setup.preview(g, {});
    assert.equal(plan.ticketCategory.id, 'cat-tickets');
    assert.ok(plan.remove.some((c) => c.id === 'decoy'));
    await setup.execute(g, plan);
    assert.ok(g.channels.cache.has('cat-tickets') && g.channels.cache.has('transcripts') && g.channels.cache.has('ticket-1'));
    assert.equal(tickets._guild('G').categoryId, 'cat-tickets');

    // a stale stored id falls back to the name
    g = mkGuild(currentServer());
    tickets._guild('G').categoryId = 'gone';
    assert.equal(tickets.findCategory(g).id, 'cat-tickets');
  } finally {
    rm(dir);
  }
});

test('a preview goes stale after a rebuild: other tokens are dropped and an old plan is refused', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, {});
    const { plan: second } = await setup.preview(g, {});
    setup.createPending(plan, 'OWNER');
    setup.createPending(second, 'OWNER');
    assert.equal((await setup.execute(g, plan)).ok, true);
    assert.equal(setup.pending.size, 0);
    const creates = g.log.filter((l) => l[0] === 'channel.create').length;
    const res = await setup.execute(g, second);
    assert.equal(res.reason, 'stale');
    assert.equal(g.log.filter((l) => l[0] === 'channel.create').length, creates, 'the stale plan builds nothing');
    // a fresh preview works again
    const fresh = await setup.preview(g, {});
    assert.equal(fresh.plan.gen, 1);
  } finally {
    rm(dir);
  }
});

test('an error after the old layout is gone is reported as a partial rebuild, and a failed save is only a warning', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const { _failureCard } = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const { plan } = await setup.preview(g, {});
    setup._order = async () => {
      throw new Error('boom');
    };
    const res = await setup.execute(g, plan);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'partial');
    assert.ok(res.report.deleted.length > 0);
    assert.equal(res.fallbackChannelId, byName(g, '🔒・priv-chat').id);
    const card = _failureCard(res).toJSON();
    assert.equal(card.title, 'Rebuild stopped part way');
    assert.match(card.description, /boom/);
    assert.match(card.description, /Check the server/);
    assert.equal(setup.isRunning('G'), false);

    // saving fails only at the very end: the rebuild itself is done, so it is a warning
    const g2 = mkGuild(currentServer());
    const s2 = mkServices(dir, 'other.json');
    const realSave = s2.setup.storage.save.bind(s2.setup.storage);
    let armed = false;
    s2.setup.storage.save = () => {
      if (armed) throw new Error('ENOSPC');
      realSave();
    };
    const realSettings = s2.setup._settings.bind(s2.setup);
    s2.setup._settings = async (...args) => {
      await realSettings(...args);
      armed = true;
    };
    const { plan: plan3 } = await s2.setup.preview(g2, {});
    const ok = await s2.setup.execute(g2, plan3);
    assert.equal(ok.ok, true);
    assert.match(ok.report.warnings.join(' '), /ENOSPC/);
  } finally {
    rm(dir);
  }
});

test('the failure card says what really happened for every reason', () => {
  const { _failureCard } = require('../src/commands/setup');
  const t = (res) => _failureCard(res).toJSON();
  assert.equal(t({ reason: 'in_progress' }).title, 'Already running');
  assert.equal(t({ reason: 'stale' }).title, 'Preview expired');
  assert.equal(t({ reason: 'keep_missing', name: 'osjetljivo' }).title, 'Nothing was deleted');
  assert.match(t({ reason: 'verified_missing' }).description, /verified role/);
  assert.match(t({ reason: 'roles_failed', message: 'The support role could not be set up.', left: { channels: [], roles: ['x is still renamed to y'] } }).description, /still renamed/);
  assert.equal(t({ reason: 'partial', message: 'x', report: { deleted: ['a'], failed: ['b'] } }).title, 'Rebuild stopped part way');
  const generic = t({ reason: 'error' });
  assert.equal(generic.title, 'Rebuild failed');
  assert.doesNotMatch(generic.description, /Nothing was deleted/); // never claims a clean state it cannot know
});

test('invites for deleted channels are warned about and replaced; the AFK and system channels move to the new ones', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild({ ...currentServer(), invites: [{ code: 'abc', channelId: 'ticket' }, { code: 'keep', channelId: 'o1' }], afkChannelId: 'voice', systemChannelId: 'general' });
    const { plan } = await setup.preview(g, {});
    assert.equal(plan.invites, 1);
    assert.match(plan.warnings.join(' '), /1 invite/);
    assert.deepEqual(plan.afk, { timeout: 300 });
    assert.equal(plan.system, true);
    const res = await setup.execute(g, plan);
    assert.equal(res.invite, 'https://discord.gg/newinvite');
    assert.deepEqual(g.invited, [byName(g, '🎫・verify').id]);
    assert.equal(g.afkChannelId, byName(g, '💤 ıl AFK').id);
    assert.equal(g.systemChannelId, byName(g, '💬・chat').id);

    // without permission to read invites nothing breaks
    const g2 = mkGuild({ ...currentServer(), invitesFail: true });
    const p2 = await setup.preview(g2, {});
    assert.equal(p2.plan.invites, 0);
    assert.equal((await setup.execute(g2, p2.plan)).invite, null);
  } finally {
    rm(dir);
  }
});

test('the preview card always names the categories and stays inside Discord limits, even for huge servers', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const { _previewCard } = require('../src/commands/setup');
    const data = currentServer();
    for (let i = 0; i < 40; i++) {
      data.channels.push({ id: `bc${i}`, name: `business-${i}`, type: T.GuildCategory });
      for (let k = 0; k < 6; k++) data.channels.push({ id: `bc${i}-${k}`, name: `business-${i}-chan-${k}`, type: T.GuildText, parent: `bc${i}` });
      data.roles.push({ id: `role${i}`, name: `some long role name number ${i}`, position: 1 });
    }
    const g = mkGuild(data);
    const { plan } = await setup.preview(g, {});
    const e = _previewCard(plan).toJSON();
    const total = (e.title || '').length + (e.description || '').length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) + (e.footer ? e.footer.text.length : 0);
    assert.ok(total <= 6000, `card is ${total} characters`);
    for (const f of e.fields) assert.ok(f.value.length <= 1024, f.name);
    const cats = e.fields.find((f) => f.name.startsWith('Categories deleted'));
    assert.match(cats.name, /\(4[0-9]\)/);
    assert.match(cats.value, /`business-0`/);
    assert.match(cats.value, /more/);

    // a moderate server lists every category by name even with dozens of channels
    const mid = currentServer();
    for (let i = 0; i < 5; i++) {
      mid.channels.push({ id: `mc${i}`, name: `site-backups-${i}`, type: T.GuildCategory });
      for (let k = 0; k < 8; k++) mid.channels.push({ id: `mc${i}-${k}`, name: `mc-${i}-${k}`, type: T.GuildText, parent: `mc${i}` });
    }
    const p2 = await setup.preview(mkGuild(mid), {});
    const cats2 = _previewCard(p2.plan).toJSON().fields.find((f) => f.name.startsWith('Categories deleted')).value;
    for (let i = 0; i < 5; i++) assert.match(cats2, new RegExp(`site-backups-${i}`));
  } finally {
    rm(dir);
  }
});

test('the command options reach the plan: delete_roles, keep, priv_role and verified', async () => {
  const dir = tmpDir();
  try {
    const cmd = require('../src/commands/setup');

    // delete_roles:false
    let t = mkServices(dir, 'a.json');
    let g = mkGuild(currentServer());
    await goButton(cmd, g, t.setup, { delete_roles: false });
    assert.deepEqual(g.deleted.roles, []);
    assert.ok(g.deleted.channels.length > 0);

    // keep: an extra category and its channels stay untouched
    t = mkServices(dir, 'b.json');
    const data = currentServer();
    data.channels.push({ id: 'xcat', name: 'site backups', type: T.GuildCategory }, { id: 'x1', name: 'dump-1', type: T.GuildText, parent: 'xcat' });
    g = mkGuild(data);
    await goButton(cmd, g, t.setup, { keep: 'xcat' });
    assert.ok(g.channels.cache.has('xcat') && g.channels.cache.has('x1'));
    assert.deepEqual(touched(g, 'site backups'), []);

    // priv_role and verified
    t = mkServices(dir, 'c.json');
    g = mkGuild(currentServer());
    await goButton(cmd, g, t.setup, { priv_role: 'OLDSTAFF', verified: 'MUTED' });
    assert.ok(allows(byName(g, '🔒 ıl PRIV'), 'OLDSTAFF', P.ViewChannel));
    assert.ok(g.roles.cache.has('OLDSTAFF') && g.roles.cache.has('MUTED'));
    assert.ok(denies(byName(g, '🎫・verify'), 'MUTED', P.ViewChannel));
    assert.ok(allows(byName(g, '💬・chat'), 'MUTED', P.ViewChannel));
    assert.equal(t.storage.data.setup.G.roles.verified, 'MUTED');
  } finally {
    rm(dir);
  }
});

test('website roles, settings-protected roles and the auto role are kept, and the live server is re-checked before deleting', async () => {
  const dir = tmpDir();
  try {
    const cfg = { ...CFG, web: { roleIds: ['W1'] }, autoRole: { id: 'CFGAUTO', name: 'Member' }, setup: { ...CFG.setup, protectedRoleIds: ['P1'] } };
    const { setup, roleMemory } = mkServices(dir, 'db.json', cfg);
    const data = currentServer();
    data.roles.push(
      { id: 'W1', name: 'Site access', position: 1 },
      { id: 'P1', name: 'Never touch', position: 1 },
      { id: 'AUTO', name: 'Newcomer', position: 1 },
      { id: 'CFGAUTO', name: 'Starter', position: 1 },
      { id: 'HIGH', name: 'Later above the bot', position: 1 },
    );
    const g = mkGuild(data);
    roleMemory.setGuildAutoRole('G', 'AUTO', { id: 'OWNER', username: 'o' });
    const { plan } = await setup.preview(g, {});
    const kept = new Map(plan.roles.kept.map((r) => [r.id, r.reason]));
    assert.equal(kept.get('W1'), 'used by the website');
    assert.equal(kept.get('P1'), 'protected in the settings');
    assert.equal(kept.get('AUTO'), 'auto role');
    assert.equal(kept.get('CFGAUTO'), 'auto role');
    assert.ok(plan.roles.remove.some((r) => r.id === 'HIGH'));

    // after the preview: an admin appears, one becomes the + role, one moves above the bot
    g.roles.cache.get('MUTED').permissions = perm(P.Administrator);
    g.roles.cache.get('OLDSTAFF').name = '+';
    g.roles.cache.get('HIGH').position = 99;
    await setup.execute(g, plan);
    for (const id of ['W1', 'P1', 'AUTO', 'CFGAUTO', 'MUTED', 'OLDSTAFF', 'HIGH']) assert.ok(g.roles.cache.has(id), `${id} survives`);
  } finally {
    rm(dir);
  }
});

test('the result reaches the owner in a channel of the new layout when the reply and the direct message both fail', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const { b } = await goButton(cmd, g, setup, {}, { editFails: true, dmFails: true });
    const priv = byName(g, '🔒・priv-chat');
    assert.equal(priv.sent.length, 1);
    assert.equal(priv.sent[0].embeds[0].toJSON().title, 'Server rebuilt');
    assert.match(priv.sent[0].content, /<@OWNER>/);
    assert.equal(b.st.dms.length, 0);
  } finally {
    rm(dir);
  }
});

test('progress shows every step, and a second press of the button leaves the card alone', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const { b } = await goButton(cmd, g, setup);
    const steps = b.st.edits.map((e) => (e.embeds[0].toJSON().description || '').match(/\*\*(.+?)\*\*/)).filter(Boolean).map((m) => m[1]);
    assert.deepEqual(steps, ['Roles', 'Building', 'Removing old channels', 'Removing old roles', 'Ordering']);
    assert.equal(setup.wasStarted('nope'), false);
  } finally {
    rm(dir);
  }
});

test('the ticket staff role becomes SUPPORT in place, an admin staff role stays untouched, and open tickets learn the new role', async () => {
  const dir = tmpDir();
  try {
    // an ordinary staff role with an odd name is reused as SUPPORT
    let t = mkServices(dir, 'a.json');
    let g = mkGuild(currentServer());
    t.tickets.setStaffRole('G', 'OLDSTAFF');
    let { plan } = await t.setup.preview(g, {});
    assert.ok(plan.roles.adopt.some((a) => a.key === 'support' && a.id === 'OLDSTAFF'));
    await t.setup.execute(g, plan);
    assert.equal(g.roles.cache.get('OLDSTAFF').name, '🎫 ıl SUPPORT');
    assert.equal(t.tickets.getStaffRole('G'), 'OLDSTAFF');
    assert.equal(roleByName(g, '🎫 ıl SUPPORT').id, 'OLDSTAFF');

    // an admin role used as staff is not renamed; a new SUPPORT role is created and tickets get it
    t = mkServices(dir, 'b.json');
    g = mkGuild(currentServer());
    t.tickets.setStaffRole('G', 'MOD');
    t.tickets._guild('G').tickets['ticket-1'] = { number: 1, userId: 'U1', username: 'u1', status: 'open' };
    ({ plan } = await t.setup.preview(g, {}));
    assert.ok(plan.roles.kept.some((r) => r.id === 'MOD' && r.reason === 'the ticket staff role'));
    await t.setup.execute(g, plan);
    assert.equal(g.roles.cache.get('MOD').name, 'Moderator');
    const support = roleByName(g, '🎫 ıl SUPPORT');
    assert.notEqual(support.id, 'MOD');
    assert.equal(t.tickets.getStaffRole('G'), support.id);
    assert.ok(g.log.some((l) => l[0] === 'channel.overwrite' && l[1] === 'ticket-0001' && l[2] === support.id), 'the open ticket lists the new support role');
  } finally {
    rm(dir);
  }
});

test('roles are recognised by their real names: Verified is found, VIP+ is not VIP', () => {
  const mk = (id, name, position) => ({ id, name, position, managed: false, permissions: perm() });
  const out = classifyRoles([mk('G', '@everyone', 0), mk('A', 'VIP+', 4), mk('B', 'vip', 3)], { botTop: 50, everyoneId: 'G', protectedIds: new Map() });
  assert.deepEqual(out.adopt.filter((a) => a.key === 'vip').map((a) => a.id), ['B']);
  assert.ok(out.remove.some((r) => r.id === 'A'));
});

test('the verified role is found by its name when the id and the + role are missing', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const data = currentServer();
    data.roles = data.roles.map((r) => (r.id === VERIFIED ? { ...r, id: 'NAMED', name: 'Verified' } : r));
    const { plan } = await setup.preview(mkGuild(data), {});
    assert.equal(plan.verified.id, 'NAMED');
    assert.equal(plan.verified.source, 'a role with that name');
    assert.ok(!plan.roles.create.some((c) => c.key === 'verified'));
  } finally {
    rm(dir);
  }
});

test('the preview needs View Channels as well as Manage Channels and Manage Roles', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild({ ...currentServer(), admin: false });
    g.members.me.permissions.has = (p) => [P.ManageChannels, P.ManageRoles].includes(p);
    const res = await setup.preview(g, {});
    assert.equal(res.ok, false);
    assert.match(res.problems.join(' '), /View Channels/);
  } finally {
    rm(dir);
  }
});

test('the layout survives Discord renaming rules and the co-owner sees what staff sees', () => {
  const { buildLayout } = require('../src/services/setup');
  const layout = buildLayout('35xw.top');
  const keys = new Set();
  for (const spec of [...layout.top, ...layout.categories.flatMap((c) => c.channels || [])]) {
    assert.ok(!keys.has(spec.key), `duplicate key ${spec.key}`);
    keys.add(spec.key);
    if (spec.type === T.GuildText) {
      assert.equal(spec.name, spec.name.toLowerCase(), `${spec.name} would be lowercased by Discord`);
      assert.ok(!/\s/.test(spec.name), `${spec.name} would get hyphens from Discord`);
    }
  }
  const ids = { everyone: 'G', bot: 'BOT', verified: 'V', support: 'S', coowner: 'CO', vip: 'VIP', privRoles: [], owner: null, manager: null };
  for (const kind of ['verify', 'members', 'info', 'vip', 'staff']) {
    assert.ok(permsFor(kind, ids, (f) => f).some((r) => r.id === 'CO'), `${kind} includes the co-owner role`);
  }
});
