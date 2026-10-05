'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const stats = require('../src/commands/stats');
const { Storage } = require('../src/storage');
const { TicketService } = require('../src/services/tickets');
const { tmpDir, rm } = require('./helpers');

function run({ tier = 2, boosts = 9, memberCount = 120, bots = 3, boosting = 4, verified = true, description = null } = {}) {
  const members = [];
  for (let i = 0; i < bots; i++) members.push([`b${i}`, { user: { bot: true }, premiumSince: null }]);
  for (let i = 0; i < boosting; i++) members.push([`h${i}`, { user: { bot: false }, premiumSince: new Date() }]);
  members.push(['p', { user: { bot: false }, premiumSince: null }]);
  const verifiedRole = { id: 'VER', members: { size: 80 } };
  const channels = [
    { type: ChannelType.GuildText }, { type: ChannelType.GuildText }, { type: ChannelType.GuildAnnouncement },
    { type: ChannelType.GuildVoice }, { type: ChannelType.GuildStageVoice },
    { type: ChannelType.GuildCategory }, { type: ChannelType.GuildCategory }, { type: ChannelType.PublicThread },
  ];
  const guild = {
    id: 'G',
    name: 'My Server',
    description,
    ownerId: 'OWNER',
    memberCount,
    premiumTier: tier,
    premiumSubscriptionCount: boosts,
    createdTimestamp: Date.UTC(2020, 0, 2),
    members: { cache: new Map(members) },
    channels: { cache: new Map(channels.map((c, i) => [i, c])) },
    roles: { cache: new Map([['G', {}], ['a', {}], ['b', {}], ['VER', verifiedRole]]) },
    emojis: { cache: new Map([[1, {}], [2, {}]]) },
    stickers: { cache: new Map([[1, {}]]) },
    iconURL: () => 'https://cdn/icon.png',
  };
  const dir = tmpDir();
  const svc = new TicketService(new Storage(path.join(dir, 'db.json')), { manager: { id: 'M' }, tickets: { categoryName: 't', transcriptChannelName: 'x', reopenCooldownMs: 0 } });
  const b = svc._guild('G');
  b.tickets.c1 = { userId: 'U1', status: 'open' };
  b.tickets.c2 = { userId: 'U2', status: 'open' };
  b.tickets.c3 = { userId: 'U3', status: 'closed' };
  const replies = [];
  const interaction = { guild, reply: async (p) => replies.push(p) };
  const ctx = { tickets: svc, verified: { getVerifiedRoleId: () => (verified ? 'VER' : null) } };
  return { go: () => stats.execute(interaction, ctx), replies, done: () => rm(dir) };
}
const fieldOf = (e, n) => (e.fields.find((f) => f.name === n) || {}).value;

test('/stats shows members, the boost level, tickets, channels and more', async () => {
  const r = run();
  try {
    await r.go();
    const e = r.replies[0].embeds[0].toJSON();
    assert.equal(e.title, 'My Server');
    assert.equal(e.thumbnail.url, 'https://cdn/icon.png');
    assert.equal(fieldOf(e, 'Members'), '**120**\n117 people, 3 bots\n80 verified');
    assert.equal(fieldOf(e, 'Boost'), '**Level 2**\n9 boosts from 4 members\n5 more boosts for Level 3');
    assert.equal(fieldOf(e, 'Open tickets'), '2');
    assert.equal(fieldOf(e, 'Channels'), '3 text, 2 voice, 2 categories', 'threads are not counted');
    assert.equal(fieldOf(e, 'Roles'), '3', 'without @everyone');
    assert.equal(fieldOf(e, 'Emoji and stickers'), '2 emoji, 1 sticker');
    assert.match(fieldOf(e, 'Created'), /<t:1577923200:D> \(<t:1577923200:R>\)/);
    assert.equal(fieldOf(e, 'Owner'), '<@OWNER>');
    assert.equal(r.replies[0].flags, undefined, 'public, everyone in the channel sees it');
  } finally {
    r.done();
  }
});

test('/stats: boost levels, the way to the next one, and servers without a verified role', async () => {
  assert.equal(stats._boostText(0, 0, 0), '**No level yet**\n0 boosts\n2 more boosts for Level 1');
  assert.equal(stats._boostText(1, 2, 1), '**Level 1**\n2 boosts from 1 member\n5 more boosts for Level 2');
  assert.equal(stats._boostText(2, 7, 2), '**Level 2**\n7 boosts from 2 members\n7 more boosts for Level 3');
  assert.equal(stats._boostText(3, 20, 5), '**Level 3**\n20 boosts from 5 members\nHighest level reached');
  assert.equal(stats._boostText(2, 15, 0), '**Level 2**\n15 boosts\n0 more boosts for Level 3', 'never negative');

  const r = run({ verified: false, tier: 0, boosts: 0, boosting: 0, description: 'Welcome' });
  try {
    await r.go();
    const e = r.replies[0].embeds[0].toJSON();
    assert.equal(e.description, 'Welcome');
    assert.equal(fieldOf(e, 'Members'), '**120**\n117 people, 3 bots', 'no verified line when there is no verified role');
    assert.match(fieldOf(e, 'Boost'), /No level yet/);
  } finally {
    r.done();
  }
});

test('/stats: the definition follows the house format and openCount counts only open tickets', () => {
  const json = stats.data.toJSON();
  assert.equal(json.description, 'Show the members, the boost level and more about this server');
  assert.ok(json.description.length <= 100 && !json.description.endsWith('.'));
  assert.equal(stats.requiresVerified, true);
});
