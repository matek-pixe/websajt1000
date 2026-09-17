'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { Storage } = require('../src/storage');
const { TicketService, BUTTONS } = require('../src/services/tickets');
const { RoleMemoryService } = require('../src/services/roleMemory');
const {
  SetupService,
  BLANK_ROLE_NAME,
  normalizeName,
  isBlankName,
  permsFor,
  findChannel,
  hasOpenButton,
  overwritesDiffer,
} = require('../src/services/setup');
const { tmpDir, rm } = require('./helpers');

const VERIFIED = '1545185363327193228';
const SENSITIVE = '1000782828402917406';
const CFG = {
  manager: { id: 'MGR' },
  tickets: { categoryName: '🎫 Tickets', transcriptChannelName: 'transcripts', maxTranscriptMessages: 2000, reopenCooldownMs: 600000, deleteDelayMs: 0 },
  setup: { verifiedRoleId: VERIFIED, sensitiveRoleId: SENSITIVE, siteName: '35xw.top' },
};

class Cache extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

/** Fake guild with just enough of discord.js for the setup + ticket services. */
function mkGuild({ admin = true, roles = [], channels = [] } = {}) {
  let seq = 100;
  const g = {
    id: 'G',
    name: 'Guild',
    ownerId: 'OWNER',
    roles: { cache: new Cache() },
    members: {
      me: { id: 'BOT', permissions: { has: (p) => admin || [P.ManageChannels, P.ManageRoles, P.ViewChannel].includes(p) }, roles: { highest: { position: 50 } } },
      cache: new Cache([['OWNER', { id: 'OWNER' }]]),
    },
    channels: { cache: new Cache(), positions: null },
    log: [],
  };
  const mkRole = (o) => {
    const r = {
      id: o.id || String(seq++),
      name: o.name,
      hoist: !!o.hoist,
      managed: !!o.managed,
      position: o.position || 1,
      async edit(patch) {
        Object.assign(r, patch);
        g.log.push(['role.edit', r.id, patch]);
        return r;
      },
    };
    g.roles.cache.set(r.id, r);
    return r;
  };
  g.roles.create = async (o) => {
    g.log.push(['role.create', o.name]);
    return mkRole({ name: o.name, hoist: o.hoist });
  };
  const toOverwrites = (list) =>
    new Map(
      (list || []).map((w) => [w.id, { id: w.id, allow: { bitfield: PermissionsBitField.resolve(w.allow || []) }, deny: { bitfield: PermissionsBitField.resolve(w.deny || []) } }]),
    );
  const mkChannel = (o) => {
    const ch = {
      id: o.id || String(seq++),
      name: o.name,
      type: o.type,
      parentId: o.parent || o.parentId || null,
      guild: g,
      permissionsLocked: false,
      permissionOverwrites: { cache: toOverwrites(o.permissionOverwrites) },
      sent: [],
      history: o.history || [],
      async edit(patch) {
        g.log.push(['channel.edit', ch.name, Object.keys(patch).filter((k) => k !== 'reason')]);
        if (patch.name !== undefined) ch.name = patch.name;
        if (patch.parent !== undefined) ch.parentId = patch.parent;
        if (patch.permissionOverwrites) ch.permissionOverwrites.cache = toOverwrites(patch.permissionOverwrites);
        return ch;
      },
      async lockPermissions() {
        ch.permissionsLocked = true;
        const parent = g.channels.cache.get(ch.parentId);
        if (parent) ch.permissionOverwrites.cache = new Map(parent.permissionOverwrites.cache);
        return ch;
      },
      async send(p) {
        ch.sent.push(p);
        // mirror discord.js: a fetched message exposes camelCase `customId` on its buttons
        const rows = (p.components || []).map((r) => r.toJSON());
        ch.history.unshift({ author: { id: 'BOT' }, components: rows.map((r) => ({ components: r.components.map((c) => ({ customId: c.custom_id })) })) });
        return {};
      },
      messages: { fetch: async () => new Cache(ch.history.map((m, i) => [String(i), m])) },
    };
    g.channels.cache.set(ch.id, ch);
    return ch;
  };
  g.channels.create = async (o) => {
    g.log.push(['channel.create', o.name]);
    return mkChannel(o);
  };
  g.channels.setPositions = async (list) => {
    g.channels.positions = list;
    return g;
  };
  for (const r of roles) mkRole(r);
  for (const c of channels) mkChannel(c);
  g.mkChannel = mkChannel;
  return g;
}

/** Matija's server as it looks today (see the screenshots): decorated names, wrong perms. */
function currentServer() {
  const T = ChannelType;
  return {
    roles: [
      { id: VERIFIED, name: 'Verified', position: 5 },
      { id: SENSITIVE, name: 'Admin', position: 20 },
      { name: 'Member', position: 2 },
      { id: 'vip', name: 'vip', position: 3 },
    ],
    channels: [
      { id: 'site', name: '35xw.top', type: T.GuildAnnouncement },
      { id: 'cat-tickets', name: '🎫 Tickets', type: T.GuildCategory },
      { id: 'transcripts', name: 'transcripts', type: T.GuildText, parent: 'cat-tickets' },
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
  };
}

function mkServices(dir) {
  const storage = new Storage(path.join(dir, 'db.json'));
  const tickets = new TicketService(storage, CFG);
  const roleMemory = new RoleMemoryService(storage, { id: '', name: 'Member' });
  const setup = new SetupService(storage, CFG, tickets, roleMemory);
  return { storage, tickets, roleMemory, setup };
}

const ow = (ch, id) => ch.permissionOverwrites.cache.get(id);
const allows = (ch, id, flag) => !!ow(ch, id) && (ow(ch, id).allow.bitfield & flag) === flag;
const denies = (ch, id, flag) => !!ow(ch, id) && (ow(ch, id).deny.bitfield & flag) === flag;
const byName = (g, name) => [...g.channels.cache.values()].find((c) => c.name === name);
const names = (g) => [...g.channels.cache.values()].map((c) => c.name).sort();

test('normalizeName / isBlankName ignore decorations', () => {
  assert.equal(normalizeName('🎫 ıl VERIFY'), 'verify');
  assert.equal(normalizeName('🎫ticket'), 'ticket');
  assert.equal(normalizeName('🔊 ıl VOICE #1'), 'voice#1');
  assert.equal(normalizeName('35xw.top'), '35xw.top');
  assert.equal(normalizeName('🔒 ıl PRIV-CHAT'), 'privchat');
  assert.equal(isBlankName(BLANK_ROLE_NAME), true);
  assert.equal(isBlankName('  '), true);
  assert.equal(isBlankName('a'), false);
});

test('permsFor: verify hides the panel from VERIFIED but staff still sees it; filtered to held perms', () => {
  const ids = { everyone: 'G', bot: 'BOT', verified: 'V', staff: 'S', manager: null };
  const rows = permsFor('verify', ids, (f) => f);
  const get = (id) => rows.find((r) => r.id === id);
  assert.ok(get('G').allow.includes(P.ViewChannel));
  assert.ok(get('G').deny.includes(P.SendMessages));
  assert.deepEqual(get('V').deny, [P.ViewChannel]);
  assert.ok(get('S').allow.includes(P.ViewChannel));
  // a bot without Connect/Speak never asks for them
  const held = (f) => f.filter((x) => x !== P.Connect && x !== P.Speak);
  const v = permsFor('verified', { ...ids, verified: 'V' }, held).find((r) => r.id === 'V');
  assert.ok(!v.allow.includes(P.Connect));
  assert.ok(v.allow.includes(P.ViewChannel));
  assert.throws(() => permsFor('nope', ids, (f) => f));
});

test('findChannel prefers the remembered id, then the wanted parent, then uncategorised; never a claimed one', () => {
  const T = ChannelType;
  const chans = [
    { id: 'a', name: 'chat', type: T.GuildText, parentId: 'other' },
    { id: 'b', name: '💬 chat', type: T.GuildText, parentId: 'cat' },
    { id: 'c', name: 'chat', type: T.GuildText, parentId: null },
  ];
  const spec = { name: '💬 ıl CHAT', match: ['chat'] };
  const base = { kinds: [T.GuildText], parentId: 'cat', claimed: new Set() };
  assert.equal(findChannel(chans, spec, base).id, 'b');
  assert.equal(findChannel(chans, spec, { ...base, storedId: 'c' }).id, 'c');
  assert.equal(findChannel(chans, spec, { ...base, claimed: new Set(['b']) }).id, 'c');
  assert.equal(findChannel(chans, spec, { ...base, claimed: new Set(['b', 'c']) }), null); // 'a' is in another category
  assert.equal(findChannel(chans, { ...spec, anywhere: true }, { ...base, claimed: new Set(['b', 'c']) }).id, 'a');
});

test('hasOpenButton / overwritesDiffer', () => {
  assert.equal(hasOpenButton({ components: [{ components: [{ customId: BUTTONS.open }] }] }), true);
  assert.equal(hasOpenButton({ components: [{ components: [{ customId: 'x' }] }] }), false);
  assert.equal(hasOpenButton({}), false);
  const ch = { permissionOverwrites: { cache: new Map([['G', { allow: { bitfield: 0n }, deny: { bitfield: P.ViewChannel } }]]) } };
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.ViewChannel] }]), false);
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.SendMessages] }]), true);
  assert.equal(overwritesDiffer(ch, [{ id: 'G', deny: [P.ViewChannel] }, { id: 'X', allow: [P.ViewChannel] }]), true);
  assert.equal(overwritesDiffer({}, []), true);
});

test('/setup on the current server: adopts what exists, creates the rest, fixes permissions, posts the panel', async () => {
  const dir = tmpDir();
  try {
    const { setup, tickets, storage } = mkServices(dir);
    const g = mkGuild(currentServer());
    const res = await setup.run(g, {});
    assert.equal(res.ok, true, JSON.stringify(res.report.errors));
    assert.deepEqual(res.report.errors, []);

    // roles: verified + sensitive adopted by id, staff/co-owner/blank created; sensitive never renamed
    const roleNames = [...g.roles.cache.values()].map((r) => r.name);
    assert.ok(roleNames.includes('✅ ıl VERIFIED'));
    assert.ok(roleNames.includes('🎫 ıl TICKET SUPPORT'));
    assert.ok(roleNames.includes('👑 ıl CO-OWNER'));
    assert.ok(roleNames.includes('🤝 ıl FRIEND'));
    assert.ok(roleNames.includes('💎 ıl VIP'));
    assert.ok(roleNames.includes('Admin'));
    assert.ok(roleNames.includes(BLANK_ROLE_NAME));
    assert.equal(g.roles.cache.get('vip').name, '💎 ıl VIP'); // adopted + restyled, not duplicated
    assert.equal([...g.roles.cache.values()].filter((r) => /vip/i.test(r.name)).length, 1);
    const blank = [...g.roles.cache.values()].find((r) => r.name === BLANK_ROLE_NAME);
    assert.equal(blank.hoist, false);
    const staffId = tickets.getStaffRole('G');
    assert.equal(g.roles.cache.get(staffId).name, '🎫 ıl TICKET SUPPORT');

    // existing channels were adopted (renamed), not duplicated
    assert.equal(byName(g, '🎫 ıl VERIFY').id, 'ticket');
    assert.equal(byName(g, '✅ ıl VERIFY').id, 'cat-verify');
    assert.equal(byName(g, '💬 ıl CHAT').id, 'general');
    assert.equal(byName(g, '🌍 ıl GENERAL').id, 'cat-general');
    assert.equal(byName(g, '🔊 ıl VOICE #1').id, 'voice');
    assert.equal(byName(g, '🔊 ıl VOICE').id, 'cat-voice');
    assert.equal(byName(g, '🔐 ıl OSJETLJIVO').id, 'cat-osj');
    assert.equal(byName(g, '🌐 ıl 35xw.top').id, 'site');
    for (const n of ['🤖 ıl CMDS', '📢 ıl SERVER', '🗑️ ıl DUMP', '🔊 ıl VOICE #2', '🔊 ıl VOICE #3', '🔒 ıl PRIVATE', '🔒 ıl PRIV', '🔒 ıl PRIV-CHAT']) {
      assert.ok(byName(g, n), `missing ${n}`);
    }
    assert.equal(byName(g, '🔒 ıl PRIV').type, ChannelType.GuildVoice);
    assert.equal(byName(g, '🔒 ıl PRIV').parentId, byName(g, '🔒 ıl PRIVATE').id);
    // nothing deleted
    assert.equal(g.channels.cache.size, 15 + 8);
    for (const n of ['verzije-stranice', 'logovi-stranice', 'detalji-stranice', 'cmd-matija', 'logovi-dump', 'transcripts', '🎫 Tickets']) {
      assert.ok(byName(g, n), `deleted ${n}`);
    }

    // verify channel: everyone sees but cannot type, VERIFIED does not see, staff sees
    const verify = byName(g, '🎫 ıl VERIFY');
    assert.ok(allows(verify, 'G', P.ViewChannel));
    assert.ok(denies(verify, 'G', P.SendMessages));
    assert.ok(denies(verify, VERIFIED, P.ViewChannel));
    assert.ok(allows(verify, staffId, P.ViewChannel));
    // panel posted exactly once
    assert.equal(verify.sent.length, 1);
    assert.equal(verify.sent[0].embeds[0].toJSON().title, '35xw verification');

    // general / voice: hidden from everyone, visible to VERIFIED
    for (const n of ['🌍 ıl GENERAL', '💬 ıl CHAT', '🔊 ıl VOICE', '🔊 ıl VOICE #3']) {
      const ch = byName(g, n);
      assert.ok(denies(ch, 'G', P.ViewChannel), n);
      assert.ok(allows(ch, VERIFIED, P.ViewChannel), n);
    }
    // private: owner + co-owner only
    const coowner = [...g.roles.cache.values()].find((r) => r.name === '👑 ıl CO-OWNER');
    const priv = byName(g, '🔒 ıl PRIV-CHAT');
    assert.ok(denies(priv, 'G', P.ViewChannel));
    assert.ok(allows(priv, 'OWNER', P.ViewChannel));
    assert.ok(allows(priv, coowner.id, P.ViewChannel));
    assert.ok(!ow(priv, VERIFIED));
    // sensitive: only that role, and every channel inside synced to the category
    const osj = byName(g, '🔐 ıl OSJETLJIVO');
    assert.ok(denies(osj, 'G', P.ViewChannel));
    assert.ok(allows(osj, SENSITIVE, P.ViewChannel));
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5']) {
      const ch = g.channels.cache.get(id);
      assert.equal(ch.permissionsLocked, true, id);
      assert.ok(denies(ch, 'G', P.ViewChannel), id);
      assert.ok(allows(ch, SENSITIVE, P.ViewChannel), id);
    }
    // site: everyone reads, nobody posts
    const site = byName(g, '🌐 ıl 35xw.top');
    assert.ok(allows(site, 'G', P.ViewChannel));
    assert.ok(denies(site, 'G', P.SendMessages));
    // tickets category + transcripts: private, staff can see, and the ticket service still owns it
    const tcat = byName(g, '🎫 Tickets');
    const tr = byName(g, 'transcripts');
    assert.ok(denies(tcat, 'G', P.ViewChannel));
    assert.ok(allows(tcat, staffId, P.ViewChannel));
    assert.ok(denies(tr, 'G', P.ViewChannel));
    assert.ok(allows(tr, staffId, P.ViewChannel));
    assert.equal(tr.parentId, tcat.id);
    assert.equal(storage.data.tickets.G.categoryId, tcat.id);

    // order: verify, tickets, general, voice, private, sensitive
    const catOrder = g.channels.positions
      .filter((p) => g.channels.cache.get(p.channel).type === ChannelType.GuildCategory)
      .sort((a, b) => a.position - b.position)
      .map((p) => g.channels.cache.get(p.channel).name);
    assert.deepEqual(catOrder, ['✅ ıl VERIFY', '🎫 Tickets', '🌍 ıl GENERAL', '🔊 ıl VOICE', '🔒 ıl PRIVATE', '🔐 ıl OSJETLJIVO']);

    // a ticket opened afterwards is still visible to its opener even though the category is hidden
    const t = await tickets.createTicket(g, { id: 'U1', user: { tag: 'u1', username: 'u1' } });
    assert.equal(t.ok, true);
    assert.ok(allows(t.channel, 'U1', P.ViewChannel));
    assert.ok(denies(t.channel, 'G', P.ViewChannel));

    // remembered for the next run
    assert.equal(storage.data.setup.G.channels.verify_ch, 'ticket');
    assert.equal(storage.data.setup.G.roles.verified, VERIFIED);
    assert.ok(res.report.warnings.some((w) => w.includes('obrisano')));
  } finally {
    rm(dir);
  }
});

test('/setup is idempotent: a second run changes nothing and posts no second panel', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild(currentServer());
    await setup.run(g, {});
    const size = g.channels.cache.size;
    const roles = g.roles.cache.size;
    g.log.length = 0;
    const res = await setup.run(g, {});
    assert.equal(res.ok, true);
    assert.deepEqual(res.report.created, []);
    assert.deepEqual(res.report.updated, []);
    assert.deepEqual(res.report.errors, []);
    assert.equal(g.channels.cache.size, size);
    assert.equal(g.roles.cache.size, roles);
    assert.equal(byName(g, '🎫 ıl VERIFY').sent.length, 1);
    assert.deepEqual(g.log.filter((l) => l[0] !== 'channel.edit' || l[2].length), []);
  } finally {
    rm(dir);
  }
});

test('/setup on an empty server creates the full layout and warns when the auto role is VERIFIED', async () => {
  const dir = tmpDir();
  try {
    const { setup, roleMemory } = mkServices(dir);
    const g = mkGuild({ roles: [] });
    const res = await setup.run(g, {});
    assert.equal(res.ok, true);
    assert.deepEqual(res.report.errors, []);
    const expected = [
      '🌐 ıl 35xw.top', '✅ ıl VERIFY', '🎫 ıl VERIFY', '🎫 Tickets', 'transcripts',
      '🌍 ıl GENERAL', '💬 ıl CHAT', '🤖 ıl CMDS', '📢 ıl SERVER', '🗑️ ıl DUMP',
      '🔊 ıl VOICE', '🔊 ıl VOICE #1', '🔊 ıl VOICE #2', '🔊 ıl VOICE #3',
      '🔒 ıl PRIVATE', '🔒 ıl PRIV', '🔒 ıl PRIV-CHAT', '🔐 ıl OSJETLJIVO',
    ].sort();
    assert.deepEqual(names(g), expected);
    // roles created because none of the ids exist here
    const roleNames = [...g.roles.cache.values()].map((r) => r.name).sort();
    assert.deepEqual(roleNames, ['✅ ıl VERIFIED', '🎫 ıl TICKET SUPPORT', '👑 ıl CO-OWNER', '🤝 ıl FRIEND', '💎 ıl VIP', '🔐 ıl OSJETLJIVO', BLANK_ROLE_NAME].sort());

    const verified = [...g.roles.cache.values()].find((r) => r.name === '✅ ıl VERIFIED');
    roleMemory.setGuildAutoRole('G', verified.id, { id: 'OWNER', username: 'o' });
    const res2 = await setup.run(g, {});
    assert.ok(res2.report.warnings.some((w) => w.includes('/aa')));
  } finally {
    rm(dir);
  }
});

test('/setup refuses without Manage Channels + Manage Roles and while another run is in progress', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const g = mkGuild({ admin: false });
    g.members.me.permissions.has = (p) => p === P.ViewChannel;
    const res = await setup.run(g, {});
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing_permissions');

    const g2 = mkGuild({});
    setup.running.add('G');
    const res2 = await setup.run(g2, {});
    assert.equal(res2.reason, 'in_progress');
    setup.running.delete('G');
    assert.equal(setup.isRunning('G'), false);
  } finally {
    rm(dir);
  }
});

test('/setup command: only owner/admin/manager; reports the summary embed', async () => {
  const dir = tmpDir();
  try {
    const { setup } = mkServices(dir);
    const cmd = require('../src/commands/setup');
    const g = mkGuild(currentServer());
    const mk = (userId, perms = []) => {
      const st = { replies: [], edits: [], refunded: 0 };
      const it = {
        user: { id: userId, username: userId },
        member: { permissions: { has: (p) => perms.includes(p) } },
        guild: g,
        inGuild: () => true,
        options: { getRole: () => null, getBoolean: () => null },
        async reply(p) { st.replies.push(p); return {}; },
        async deferReply(p) { st.deferred = p; return {}; },
        async editReply(p) { st.edits.push(p); return {}; },
        get deferred() { return !!st.deferred; },
        replied: false,
      };
      const ctx = { setup, isManager: (u) => u.id === 'MGR', refundCooldown: () => { st.refunded += 1; } };
      return { it, ctx, st };
    };

    const a = mk('RANDO');
    await cmd.execute(a.it, a.ctx);
    assert.equal(a.st.refunded, 1);
    assert.match(a.st.replies[0].content, /vlasnik|administrator/);

    const b = mk('OWNER');
    await cmd.execute(b.it, b.ctx);
    assert.ok(b.st.deferred);
    const e = b.st.edits[0].embeds[0].toJSON();
    assert.match(e.title, /Server setup/);
    assert.ok(e.fields.some((f) => f.name.startsWith('✅ Napravljeno')));
    assert.ok(e.fields.some((f) => f.name.startsWith('ℹ️ Napomene')));

    const c = mk('ADMIN', [P.Administrator]);
    await cmd.execute(c.it, c.ctx);
    assert.ok(c.st.deferred);
  } finally {
    rm(dir);
  }
});
