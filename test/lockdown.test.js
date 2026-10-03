'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { Storage } = require('../src/storage');
const O = require('../src/services/overwrites');
const { LockdownService, planSos } = require('../src/services/lockdown');
const { G, VIEW, SEND, ADMIN, ow, makeServer, kit, typical } = require('./fakeServer');

// ---------- the permission maths ----------

test('memberCanView follows Discord: base, @everyone, role overwrites together, then the member', () => {
  const roles = [
    { id: G, permissions: String(VIEW) },
    { id: 'A', permissions: '0' },
    { id: 'B', permissions: '0' },
    { id: 'ADM', permissions: String(ADMIN) },
  ];
  const view = (over) => O.memberCanView({ memberId: 'U', roleIds: over.roles || [], roles, channel: { overwrites: over.ow }, everyoneId: G, ownerId: 'OWNER' });
  assert.equal(view({ ow: [] }), true, 'base view');
  assert.equal(view({ ow: [ow(G, 0, 0n, VIEW)] }), false, '@everyone deny');
  assert.equal(view({ roles: ['A'], ow: [ow(G, 0, 0n, VIEW), ow('A', 0, VIEW, 0n)] }), true, 'a role allow beats the @everyone deny');
  assert.equal(view({ roles: ['A', 'B'], ow: [ow('A', 0, VIEW, 0n), ow('B', 0, 0n, VIEW)] }), true, 'allow and deny between roles: allow wins');
  assert.equal(view({ roles: ['A'], ow: [ow('A', 0, VIEW, 0n), ow('U', 1, 0n, VIEW)] }), false, 'the member overwrite wins over roles');
  assert.equal(view({ roles: ['ADM'], ow: [ow(G, 0, 0n, VIEW), ow('U', 1, 0n, VIEW)] }), true, 'Administrator ignores overwrites');
  assert.equal(O.memberCanView({ memberId: 'OWNER', roleIds: [], roles, channel: { overwrites: [ow(G, 0, 0n, VIEW), ow('OWNER', 1, 0n, VIEW)] }, everyoneId: G, ownerId: 'OWNER' }), true, 'the owner sees everything');
});

test('planOverwrites: allows turn into denies, @everyone is denied, grants come first and unchanged ones are not written', () => {
  const current = [ow(G, 0, 0n, 0n), ow('R1', 0, VIEW | SEND, 0n), ow('R2', 0, SEND, VIEW), ow('R3', 0, 0n, 0n), ow('M1', 1, VIEW, 0n)];
  const plan = O.planOverwrites(current, { mask: VIEW, everyoneId: G, grants: [{ id: 'M1', type: 1, allow: VIEW }, { id: 'NEW', type: 1, allow: VIEW }] });
  const by = Object.fromEntries(plan.puts.map((p) => [p.id, p]));
  assert.equal(BigInt(by[G].deny) & VIEW, VIEW, '@everyone denied');
  assert.deepEqual([BigInt(by.R1.allow) & VIEW, BigInt(by.R1.deny) & VIEW], [0n, VIEW], 'allow became deny');
  assert.equal(BigInt(by.R1.allow) & SEND, SEND, 'other bits untouched');
  assert.ok(!by.R2, 'already denied: not written');
  assert.ok(!by.R3, 'neutral: not written, @everyone covers it');
  assert.ok(!by.M1, 'a grant that already holds it is not written');
  assert.deepEqual(by.NEW, { id: 'NEW', type: 1, allow: String(VIEW), deny: '0' });
  assert.deepEqual(plan.added, ['NEW']);
  assert.equal(plan.puts[0].id, 'NEW', 'people who keep access are written first');
});

test('planRestore writes what differs and deletes only what was added by us', () => {
  const saved = [ow(G, 0, 0n, 0n), ow('R1', 0, VIEW, 0n)];
  const current = [ow(G, 0, 0n, VIEW), ow('R1', 0, 0n, VIEW), ow('OURS', 1, VIEW, 0n), ow('THEIRS', 1, SEND, 0n)];
  const plan = O.planRestore(current, saved, ['OURS']);
  assert.deepEqual(plan.puts.map((p) => p.id).sort(), [G, 'R1']);
  assert.deepEqual(plan.deletes.map((d) => d.id), ['OURS'], "an overwrite somebody else added is left alone");
  assert.deepEqual(O.planRestore(saved, saved, []), { puts: [], deletes: [] }, 'nothing to do when it already matches');
});

// ---------- /sos ----------

test('scan changes nothing and explains the server', async () => {
  const k = kit(typical());
  try {
    const before = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    assert.equal(scan.ok, true);
    assert.deepEqual(k.server.dump(), before);
    assert.ok(!k.server.calls.some(([m]) => m !== 'GET'), 'only reads');
    assert.equal(k.svc.isActive(G), false);
    assert.equal(fs.existsSync(path.join(k.dir, 'sos')), false, 'no backup yet');
    // the report says who can see what and which roles matter
    assert.match(scan.report, /ADMINISTRATOR ROLES/);
    assert.match(scan.report, /Admin \(ADMINR\): loses Administrator until \/sos end/);
    assert.match(scan.report, /Head admin \(HIGHADM\): CANNOT be hidden from, above my highest role/);
    assert.match(scan.report, /Other bot \(OTHERBOT\): CANNOT be hidden from, managed by an integration/);
    assert.match(scan.report, /\[GENERAL\] \(category, CAT2\): visible to everyone/);
    assert.match(scan.report, /vipchat \(text, vipchat\): visible to VIP \+1 member overwrite/);
    assert.match(scan.report, /staff \(text, staff\): visible to Mod \+1 member overwrite/);
    assert.match(scan.report, /Mod: Manage Messages, View Channels/);
    assert.equal(scan.summary.total, 7);
  } finally {
    k.done();
  }
});

test('start saves everything first, then nobody but the owner, the manager and the bot sees any channel', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);

    // the saved copy must exist before the first change is made
    let firstWrite = true;
    const realPut = k.server.rest.put;
    k.server.rest.put = async (...a) => {
      if (firstWrite) {
        firstWrite = false;
        const files = fs.readdirSync(path.join(k.dir, 'sos'));
        assert.equal(files.length, 1, 'backup file written before the first change');
        assert.equal(k.svc.state(G).active, true);
        assert.equal(k.svc.state(G).phase, 'applying', 'the record exists before the first change');
      }
      return realPut(...a);
    };

    const res = await k.svc.start(k.server.guild, scan, 'OWNER');
    assert.equal(res.ok, true);
    assert.equal(res.failed.length, 0);
    assert.equal(k.svc.state(G).phase, 'on');

    const channelIds = [...k.server.state.channels.keys()];
    for (const m of ['OWNER', 'MGR', 'BOT']) for (const c of channelIds) assert.equal(k.server.canSee(m, c), true, `${m} still sees ${c}`);
    // everybody else, whatever their roles or personal overwrites, sees nothing, except those under a role that cannot be touched
    for (const m of ['ADMIN1', 'MOD1', 'VIP1', 'PLAIN', 'U_ALLOWED']) for (const c of channelIds) assert.equal(k.server.canSee(m, c), false, `${m} must not see ${c}`);
    for (const c of channelIds) assert.equal(k.server.canSee('HEAD', c), true, 'a role above the bot cannot be hidden from, and is reported');
    assert.equal(k.server.state.roles.get('ADMINR').permissions & ADMIN, 0n, 'editable admin role lost Administrator');
    assert.equal(k.server.state.roles.get('HIGHADM').permissions & ADMIN, ADMIN, 'role above the bot untouched');
    assert.equal(k.server.state.roles.get('BOTR').permissions & ADMIN, ADMIN, "the bot's own role is never touched");
    assert.deepEqual(scan.plan.stuck.map((r) => r.id).sort(), ['HIGHADM', 'OTHERBOT']);

    // the backup holds the original state
    const file = JSON.parse(fs.readFileSync(res.backupFile, 'utf8'));
    assert.equal(file.kind, '35xw-sos');
    assert.equal(file.guildId, G);
    assert.deepEqual(file.snapshot.channels.find((c) => c.id === 'vipchat').overwrites, [ow(G, 0, 0n, VIEW), ow('VIPR', 0, VIEW | SEND, 0n), ow('LEFT', 1, VIEW, 0n)]);

    // ...and end puts back exactly that
    const end = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(end.ok, true, JSON.stringify(end));
    assert.deepEqual(k.server.dump(), original, 'every role and channel is exactly as it was');
    assert.equal(k.svc.isActive(G), false);
    assert.ok(fs.existsSync(res.backupFile), 'the backup file stays');
  } finally {
    k.done();
  }
});

test('a second start never replaces the first saved copy', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    await k.svc.start(k.server.guild, scan, 'OWNER');
    const saved = JSON.stringify(k.svc.state(G).snapshot);
    assert.deepEqual((await k.svc.scan(k.server.guild)).reason, 'active', 'cannot even scan while it is on');
    assert.deepEqual((await k.svc.start(k.server.guild, scan, 'OWNER')).reason, 'active');
    assert.equal(JSON.stringify(k.svc.state(G).snapshot), saved, 'the original copy is untouched');
    await k.svc.end(k.server.guild, 'OWNER');
    assert.deepEqual(k.server.dump(), original);
  } finally {
    k.done();
  }
});

test('keep_admins leaves the admin roles alone and says so', async () => {
  const k = kit(typical());
  try {
    const scan = await k.svc.scan(k.server.guild, { keepAdmins: true });
    assert.equal(scan.plan.strip.length, 0);
    assert.ok(scan.plan.kept.some((r) => r.id === 'ADMINR'));
    const original = k.server.dump();
    await k.svc.start(k.server.guild, scan, 'OWNER');
    assert.equal(k.server.state.roles.get('ADMINR').permissions & ADMIN, ADMIN);
    assert.equal(k.server.canSee('ADMIN1', 'staff'), true, 'admins still see: that is what keep_admins means');
    assert.equal(k.server.canSee('PLAIN', 'chat'), false);
    await k.svc.end(k.server.guild, 'OWNER');
    assert.deepEqual(k.server.dump(), original);
  } finally {
    k.done();
  }
});

test('writes that fail are reported, and end still puts back everything', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    k.server.failWhen = (m, route) => (m === 'PUT' && route.includes('/channels/staff/') ? Object.assign(new Error('Missing Permissions'), { code: 50013 }) : null);
    const res = await k.svc.start(k.server.guild, scan, 'OWNER');
    assert.equal(res.ok, true);
    assert.deepEqual(res.failed.map((f) => [f.kind, f.id]), [['channel', 'staff']], 'the one channel that could not be hidden is named');
    k.server.failWhen = null;
    const end = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(end.ok, true);
    assert.deepEqual(k.server.dump(), original);
  } finally {
    k.done();
  }
});

test('a start that died halfway is still undone completely', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    let writes = 0;
    k.server.failWhen = (m) => (m !== 'GET' && ++writes > 5 ? Object.assign(new Error('network down'), { code: 0 }) : null);
    await k.svc.start(k.server.guild, scan, 'OWNER'); // most writes fail, as in a crash
    assert.notDeepEqual(k.server.dump(), original, 'it did change something');
    k.server.failWhen = null;
    const end = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(end.ok, true);
    assert.deepEqual(k.server.dump(), original);
  } finally {
    k.done();
  }
});

test('a channel or role deleted during SOS is reported, and everything else still comes back', async () => {
  const k = kit(typical());
  try {
    const scan = await k.svc.scan(k.server.guild);
    await k.svc.start(k.server.guild, scan, 'OWNER');
    k.server.state.channels.delete('chat');
    k.server.state.roles.delete('VIPR');
    for (const c of k.server.state.channels.values()) c.permission_overwrites = c.permission_overwrites.filter((o) => o.id !== 'VIPR'); // Discord does this itself
    k.server.state.members.delete('LEFT'); // a member who left keeps their overwrites, but cannot be written to any more
    const end = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(end.ok, true, JSON.stringify(end));
    assert.deepEqual(end.channels.gone, ['chat']);
    const vip = k.server.state.channels.get('vipchat').permission_overwrites;
    assert.ok(!vip.some((o) => o.id === 'VIPR'), 'a deleted role is not brought back');
    const staff = k.server.state.channels.get('staff').permission_overwrites;
    assert.deepEqual(staff.find((o) => o.id === 'MODR'), ow('MODR', 0, VIEW | SEND, 0n), 'other channels are exactly as before');
    assert.equal(k.server.state.roles.get('ADMINR').permissions & ADMIN, ADMIN);
  } finally {
    k.done();
  }
});

test('what somebody else added while SOS was on is not deleted', async () => {
  const k = kit(typical());
  try {
    const scan = await k.svc.scan(k.server.guild);
    await k.svc.start(k.server.guild, scan, 'OWNER');
    k.server.state.channels.get('chat').permission_overwrites.push(ow('PLAIN', 1, SEND, 0n));
    await k.svc.end(k.server.guild, 'OWNER');
    assert.ok(k.server.state.channels.get('chat').permission_overwrites.some((o) => o.id === 'PLAIN'));
  } finally {
    k.done();
  }
});

test('if db.json is lost, the backup file brings everything back', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    const res = await k.svc.start(k.server.guild, scan, 'OWNER');
    // a new bot with an empty database (the host lost data/db.json)
    const fresh = new LockdownService({ storage: new Storage(path.join(k.dir, 'other.json')), config: { manager: { id: 'MGR' }, dataDir: k.dir }, rest: k.server.rest });
    assert.equal((await fresh.end(k.server.guild, 'OWNER')).reason, 'not_active', 'nothing remembered');
    const record = JSON.parse(fs.readFileSync(res.backupFile, 'utf8'));
    const end = await fresh.end(k.server.guild, 'OWNER', { record });
    assert.equal(end.ok, true);
    assert.deepEqual(k.server.dump(), original);
    // a backup of another server is refused
    assert.equal((await fresh.end(k.server.guild, 'OWNER', { record: { ...record, guildId: 'OTHER' } })).reason, 'wrong_server');
  } finally {
    k.done();
  }
});

test('state survives a restart: a new service instance can end what the old one started', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    await k.svc.start(k.server.guild, await k.svc.scan(k.server.guild), 'OWNER');
    const again = new LockdownService({ storage: new Storage(k.storage.file), config: { manager: { id: 'MGR' }, dataDir: k.dir }, rest: k.server.rest });
    assert.equal(again.isActive(G), true);
    assert.equal((await again.end(k.server.guild, 'OWNER')).ok, true);
    assert.deepEqual(k.server.dump(), original);
  } finally {
    k.done();
  }
});

test('when the restore cannot finish, SOS stays on so it can be run again', async () => {
  const k = kit(typical());
  try {
    const original = k.server.dump();
    await k.svc.start(k.server.guild, await k.svc.scan(k.server.guild), 'OWNER');
    k.server.failWhen = (m, route) => (m === 'PUT' && route.includes('/channels/staff/') ? Object.assign(new Error('rate limited'), { code: 0 }) : null);
    const end = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(end.ok, false);
    assert.equal(k.svc.isActive(G), true, 'still on, nothing is forgotten');
    assert.equal(k.svc.state(G).phase, 'restore_incomplete');
    k.server.failWhen = null;
    const again = await k.svc.end(k.server.guild, 'OWNER');
    assert.equal(again.ok, true);
    assert.deepEqual(k.server.dump(), original);
    assert.equal(k.svc.isActive(G), false);
  } finally {
    k.done();
  }
});

test('a bot without Administrator keeps its own access, and a bot without the permissions refuses to start', async () => {
  const spec = typical();
  spec.roles.find((r) => r.id === 'BOTR').permissions = P.ManageRoles | P.ManageChannels | VIEW;
  const k = kit(spec);
  try {
    const original = k.server.dump();
    const scan = await k.svc.scan(k.server.guild);
    assert.ok(scan.plan.grants.some((g) => g.id === 'BOT'), 'the bot gets its own overwrite');
    await k.svc.start(k.server.guild, scan, 'OWNER');
    for (const c of k.server.state.channels.keys()) assert.equal(k.server.canSee('BOT', c), true);
    await k.svc.end(k.server.guild, 'OWNER');
    assert.deepEqual(k.server.dump(), original);

    k.server.state.roles.get('BOTR').permissions = VIEW;
    assert.equal((await k.svc.scan(k.server.guild)).reason, 'permissions');
  } finally {
    k.done();
  }
});

test('a manager who is not the owner keeps seeing everything', async () => {
  const k = kit(typical(), { manager: 'ADMIN1' }); // an admin who is neither owner nor bot
  try {
    const scan = await k.svc.scan(k.server.guild);
    assert.ok(scan.plan.grants.some((g) => g.id === 'ADMIN1'));
    await k.svc.start(k.server.guild, scan, 'OWNER');
    for (const c of k.server.state.channels.keys()) assert.equal(k.server.canSee('ADMIN1', c), true, c);
    assert.equal(k.server.canSee('MOD1', 'chat'), false);
  } finally {
    k.done();
  }
});

// ---------- property test: random servers ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomServer(seed) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const flags = [VIEW, SEND, P.Connect, P.ManageMessages, P.AddReactions, VIEW | SEND];
  const nRoles = 3 + Math.floor(r() * 8);
  const roles = [{ id: G, name: '@everyone', permissions: r() < 0.7 ? VIEW | SEND : SEND, position: 0 }];
  for (let i = 0; i < nRoles; i++) {
    roles.push({ id: `R${i}`, name: `Role ${i}`, permissions: r() < 0.25 ? ADMIN : pick(flags), position: 1 + Math.floor(r() * 8), managed: r() < 0.1 });
  }
  roles.push({ id: 'BOTR', name: 'Bot', permissions: r() < 0.5 ? ADMIN : P.ManageRoles | P.ManageChannels | VIEW, position: 6, managed: true });
  const memberIds = ['OWNER', 'MGR', 'BOT', ...Array.from({ length: 12 }, (_, i) => `M${i}`)];
  const targets = () => [...roles.map((x) => ({ id: x.id, type: 0 })).filter((x) => x.id !== 'BOTR'), ...memberIds.slice(3).map((id) => ({ id, type: 1 })), { id: 'LEFT1', type: 1 }];
  const channels = [];
  const nCats = 1 + Math.floor(r() * 3);
  for (let c = 0; c < nCats; c++) channels.push({ id: `CAT${c}`, type: 4, permission_overwrites: [] });
  const nCh = 4 + Math.floor(r() * 14);
  for (let c = 0; c < nCh; c++) channels.push({ id: `CH${c}`, type: pick([0, 0, 2, 5]), parent_id: `CAT${Math.floor(r() * nCats)}`, permission_overwrites: [] });
  for (const ch of channels) {
    const used = new Set();
    for (let i = 0, n = Math.floor(r() * 6); i < n; i++) {
      const t = pick(targets());
      if (used.has(t.id)) continue;
      used.add(t.id);
      const allow = r() < 0.5 ? pick([VIEW, VIEW | SEND, SEND, 0n]) : 0n;
      const deny = r() < 0.5 ? pick([VIEW, SEND, VIEW | P.Connect, 0n]) : 0n;
      ch.permission_overwrites.push(ow(t.id, t.type, allow & ~deny, deny));
    }
  }
  const members = memberIds.map((id) => ({ id, roles: id === 'BOT' ? ['BOTR'] : id === 'OWNER' ? [] : roles.filter((x) => x.id !== G && x.id !== 'BOTR' && r() < 0.3).map((x) => x.id) }));
  return { roles, channels, members };
}

test('property: on 200 random servers SOS hides everything from everyone else and end restores it bit for bit', async () => {
  for (let seed = 1; seed <= 200; seed++) {
    const k = kit(randomServer(seed));
    try {
      const original = k.server.dump();
      const scan = await k.svc.scan(k.server.guild, { keepAdmins: seed % 5 === 0 });
      if (!scan.ok) {
        assert.equal(scan.reason, 'permissions', `seed ${seed}`);
        assert.deepEqual(k.server.dump(), original);
        continue;
      }
      const res = await k.svc.start(k.server.guild, scan, 'OWNER');
      assert.equal(res.ok, true, `seed ${seed}`);
      assert.equal(res.failed.filter((f) => f.kind === 'channel').length, 0, `seed ${seed}: a member who left must not count as a failure`);

      const stuck = new Set(scan.plan.stuck.map((r) => r.id));
      const kept = new Set(scan.plan.kept.map((r) => r.id));
      for (const [memberId, member] of k.server.state.members) {
        const exempt = ['OWNER', 'MGR', 'BOT'].includes(memberId);
        const untouchableAdmin = (member.roles || []).some((id) => stuck.has(id) || kept.has(id));
        // a member under a role that still has Administrator keeps seeing: those are listed in the scan
        for (const channelId of k.server.state.channels.keys()) {
          const sees = k.server.canSee(memberId, channelId);
          if (exempt) assert.equal(sees, true, `seed ${seed}: ${memberId} must see ${channelId}`);
          else if (!untouchableAdmin) assert.equal(sees, false, `seed ${seed}: ${memberId} must not see ${channelId}`);
        }
      }

      const end = await k.svc.end(k.server.guild, 'OWNER');
      assert.equal(end.ok, true, `seed ${seed}: ${JSON.stringify(end)}`);
      assert.deepEqual(k.server.dump(), original, `seed ${seed}: not restored exactly`);
    } finally {
      k.done();
    }
  }
});

// ---------- /lock and /unlock ----------

const lockServer = () => ({
  roles: [
    { id: G, name: '@everyone', permissions: VIEW | SEND, position: 0 },
    { id: 'ADMINR', name: 'Admin', permissions: ADMIN, position: 3 },
    { id: 'VIPR', name: 'VIP', permissions: VIEW | SEND, position: 1 },
    { id: 'BOTR', name: '35xw', permissions: VIEW | SEND, position: 5, managed: true },
  ],
  channels: [
    { id: 'chat', permission_overwrites: [ow('VIPR', 0, SEND | P.CreatePublicThreads, 0n), ow('U1', 1, SEND, 0n)] },
    { id: 'other', permission_overwrites: [] },
  ],
  members: [
    { id: 'OWNER', roles: [] },
    { id: 'BOT', roles: ['BOTR'] },
    { id: 'ADMIN1', roles: ['ADMINR'] },
    { id: 'VIP1', roles: ['VIPR'] },
    { id: 'U1', roles: [] },
    { id: 'PLAIN', roles: [] },
  ],
});
/** Can this member write in the channel? (Discord's order again, for the write bit.) */
function canWrite(server, memberId, channelId) {
  const roleList = [...server.state.roles.values()];
  const mem = server.state.members.get(memberId);
  let perms = 0n;
  for (const id of [G, ...(mem.roles || [])]) perms |= (roleList.find((r) => r.id === id) || { permissions: 0n }).permissions;
  if (perms & ADMIN || memberId === 'OWNER') return true;
  const owr = new Map(server.state.channels.get(channelId).permission_overwrites.map((o) => [o.id, o]));
  const ev = owr.get(G);
  if (ev) perms = (perms & ~BigInt(ev.deny)) | BigInt(ev.allow);
  let deny = 0n;
  let allow = 0n;
  for (const id of mem.roles || []) if (owr.has(id)) { deny |= BigInt(owr.get(id).deny); allow |= BigInt(owr.get(id).allow); }
  perms = (perms & ~deny) | allow;
  const me = owr.get(memberId);
  if (me && me.type === 1) perms = (perms & ~BigInt(me.deny)) | BigInt(me.allow);
  return !!(perms & SEND);
}

test('/lock: only admins and the owner can write, everyone else cannot, the bot still can; /unlock restores it exactly', async () => {
  const k = kit(lockServer());
  try {
    const original = k.server.dump();
    assert.equal(canWrite(k.server, 'PLAIN', 'chat'), true);
    assert.equal(canWrite(k.server, 'VIP1', 'chat'), true);
    assert.equal(canWrite(k.server, 'U1', 'chat'), true);

    const res = await k.svc.lockChannel(k.server.guild, 'chat', 'ADMIN1', { botId: 'BOT', botIsAdmin: false });
    assert.equal(res.ok, true);
    for (const m of ['PLAIN', 'VIP1', 'U1']) assert.equal(canWrite(k.server, m, 'chat'), false, `${m} cannot write`);
    for (const m of ['ADMIN1', 'OWNER', 'BOT']) assert.equal(canWrite(k.server, m, 'chat'), true, `${m} can write`);
    assert.equal(canWrite(k.server, 'PLAIN', 'other'), true, 'other channels are not touched');
    assert.equal(k.svc.isLocked(G, 'chat'), true);

    assert.equal((await k.svc.lockChannel(k.server.guild, 'chat', 'ADMIN1', { botId: 'BOT', botIsAdmin: false })).reason, 'already', 'a second lock never replaces the saved copy');

    const un = await k.svc.unlockChannel(k.server.guild, 'chat', 'ADMIN1');
    assert.equal(un.ok, true);
    assert.deepEqual(k.server.dump(), original, 'exactly as before');
    assert.equal(k.svc.isLocked(G, 'chat'), false);
    assert.equal((await k.svc.unlockChannel(k.server.guild, 'chat', 'ADMIN1')).reason, 'not_locked');
  } finally {
    k.done();
  }
});

test('/lock: a write that fails is rolled back and nothing stays half locked', async () => {
  const k = kit(lockServer());
  try {
    const original = k.server.dump();
    let n = 0;
    k.server.failWhen = (m, route) => (m === 'PUT' && ++n === 2 ? Object.assign(new Error('Missing Permissions'), { code: 50013 }) : null);
    const res = await k.svc.lockChannel(k.server.guild, 'chat', 'ADMIN1', { botId: 'BOT', botIsAdmin: false });
    assert.equal(res.ok, false);
    assert.equal(res.code, 50013);
    k.server.failWhen = null;
    assert.deepEqual(k.server.dump(), original, 'rolled back');
    assert.equal(k.svc.isLocked(G, 'chat'), false);
  } finally {
    k.done();
  }
});

test('/lock and /unlock are refused while SOS is on, and a lock survives a restart', async () => {
  const k = kit(lockServer());
  try {
    await k.svc.lockChannel(k.server.guild, 'chat', 'ADMIN1', { botId: 'BOT', botIsAdmin: true });
    const again = new LockdownService({ storage: new Storage(k.storage.file), config: { manager: { id: 'MGR' }, dataDir: k.dir }, rest: k.server.rest });
    assert.equal(again.isLocked(G, 'chat'), true);
    assert.equal((await again.unlockChannel(k.server.guild, 'chat', 'X')).ok, true);

    await k.svc.lockChannel(k.server.guild, 'other', 'ADMIN1', { botId: 'BOT', botIsAdmin: true });
    // pretend SOS is on
    k.svc._sos()[G] = { active: true };
    assert.equal((await k.svc.lockChannel(k.server.guild, 'chat', 'X', { botId: 'BOT', botIsAdmin: true })).reason, 'sos');
    assert.equal((await k.svc.unlockChannel(k.server.guild, 'other', 'X')).reason, 'sos');
  } finally {
    k.done();
  }
});

test('an Administrator bot gets no extra overwrite when locking', async () => {
  const k = kit(lockServer());
  try {
    await k.svc.lockChannel(k.server.guild, 'other', 'ADMIN1', { botId: 'BOT', botIsAdmin: true });
    assert.ok(!k.server.state.channels.get('other').permission_overwrites.some((o) => o.id === 'BOT'));
    assert.ok(k.server.state.channels.get('other').permission_overwrites.some((o) => o.id === G), 'only @everyone is denied');
  } finally {
    k.done();
  }
});

test('planSos is pure: the same snapshot gives the same plan', () => {
  const snapshot = { guildId: G, channels: [{ id: 'c', name: 'c', type: 0, overwrites: [ow('R', 0, VIEW, 0n)] }], roles: [{ id: G, permissions: String(VIEW), position: 0 }, { id: 'A', permissions: String(ADMIN), position: 1, managed: false, name: 'A' }] };
  const opts = { everyoneId: G, ownerId: 'O', managerId: 'M', managerInGuild: true, botId: 'B', botIsAdmin: false, botRoleIds: new Set(), botTop: 5 };
  assert.deepEqual(planSos(snapshot, opts), planSos(snapshot, opts));
  const p = planSos(snapshot, opts);
  assert.deepEqual(p.grants.map((g) => g.id), ['M', 'B']);
  assert.deepEqual(p.strip.map((r) => r.id), ['A']);
});

test('start saves the server as it is when you press the button, not as it was in the preview', async () => {
  const k = kit(typical());
  try {
    const preview = await k.svc.scan(k.server.guild);
    // somebody changes a permission between the preview and the button
    k.server.state.channels.get('chat').permission_overwrites.push(ow('VIPR', 0, SEND, 0n));
    k.server.state.channels.set('late', { id: 'late', type: 0, name: 'late', parent_id: null, position: 99, permission_overwrites: [] });
    const changed = k.server.dump();
    const res = await k.svc.start(k.server.guild, preview, 'OWNER');
    assert.equal(res.ok, true);
    const saved = k.svc.state(G).snapshot;
    assert.ok(saved.channels.some((c) => c.id === 'late'), 'a channel made in between is saved and hidden too');
    assert.deepEqual(saved.channels.find((c) => c.id === 'chat').overwrites, [ow('VIPR', 0, SEND, 0n)]);
    assert.equal(k.server.canSee('PLAIN', 'late'), false);
    await k.svc.end(k.server.guild, 'OWNER');
    assert.deepEqual(k.server.dump(), changed, 'end brings back the server as it was at the button, including the in-between change');
  } finally {
    k.done();
  }
});

test('a community server is warned that its rules and updates channels may stay visible', async () => {
  const k = kit(typical());
  try {
    k.server.guild.rulesChannelId = 'rules';
    const scan = await k.svc.scan(k.server.guild);
    assert.deepEqual(scan.community, ['rules']);
  } finally {
    k.done();
  }
});
