'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Storage } = require('../src/storage');
const {
  TicketService,
  DISCORD_MAX_CHANNELS_PER_CATEGORY,
  formatTicketName,
  formatClosedName,
  formatTranscriptName,
  formatTranscriptCategory,
  defaultGuildBucket,
  evaluateOpen,
  recordTranscriptPosted,
  skipTranscriptSlot,
  formatDuration,
} = require('../src/services/tickets');
const { tmpDir, rm } = require('./helpers');

const CFG = {
  manager: { id: 'MGR' },
  tickets: {
    categoryName: '🎫 Tickets',
    transcriptCategoryPrefix: 'Transcript-',
    transcriptsPerCategory: 3,
    reopenCooldownMs: 10 * 60 * 1000,
    deleteDelayMs: 0,
    editTimeoutMs: 1000,
  },
};

test('a ticket keeps one number through every state; only the prefix changes', () => {
  assert.equal(formatTicketName(1), 'ticket-0001');
  assert.equal(formatClosedName(1), 'close-0001');
  assert.equal(formatTranscriptName(1), 'transcript-0001');
  assert.equal(formatTicketName(42), 'ticket-0042');
  assert.equal(formatClosedName(42), 'close-0042');
  assert.equal(formatTranscriptName(42), 'transcript-0042');
  assert.equal(formatTicketName(12345), 'ticket-12345');
});

test('transcript categories are two-digit: Transcript-01, Transcript-02, ...', () => {
  assert.equal(formatTranscriptCategory('Transcript-', 1), 'Transcript-01');
  assert.equal(formatTranscriptCategory('Transcript-', 2), 'Transcript-02');
  assert.equal(formatTranscriptCategory('Transcript-', 10), 'Transcript-10');
  assert.equal(formatTranscriptCategory('Transcript-', 100), 'Transcript-100');
});

test('evaluateOpen: one open ticket per user', () => {
  const b = defaultGuildBucket();
  b.tickets.C1 = { userId: 'U1', status: 'open' };
  const r = evaluateOpen(b, 'U1', 0, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_open');
  assert.equal(r.channelId, 'C1');
  assert.equal(evaluateOpen(b, 'U2', 0, 1000).ok, true);
});

test('evaluateOpen: 10-minute cooldown after close, then allowed again', () => {
  const b = defaultGuildBucket();
  const tenMin = 10 * 60 * 1000;
  b.users.U1 = { lastClosedAt: 1_000_000 };
  const during = evaluateOpen(b, 'U1', 1_000_000 + tenMin - 1, tenMin);
  assert.equal(during.ok, false);
  assert.equal(during.reason, 'cooldown');
  assert.equal(during.retryInMs, 1);
  assert.equal(evaluateOpen(b, 'U1', 1_000_000 + tenMin, tenMin).ok, true);
});

test('evaluateOpen: closed and archived tickets do not count as open', () => {
  const b = defaultGuildBucket();
  b.tickets.C1 = { userId: 'U1', status: 'closed' };
  b.tickets.C2 = { userId: 'U1', status: 'archived' };
  assert.equal(evaluateOpen(b, 'U1', 0, 1000).ok, true);
});

test('transcript category advances only when full, and never goes back', () => {
  const b = defaultGuildBucket();
  recordTranscriptPosted(b, 3);
  recordTranscriptPosted(b, 3);
  assert.deepEqual(b.transcript, { index: 1, count: 2 });
  recordTranscriptPosted(b, 3); // third one fills Transcript-01
  assert.deepEqual(b.transcript, { index: 2, count: 0 });
  skipTranscriptSlot(b); // unusable category -> skip for good
  assert.deepEqual(b.transcript, { index: 3, count: 0 });
});

test('perCategory never exceeds the Discord hard limit of 50', () => {
  const dir = tmpDir();
  try {
    const big = { ...CFG, tickets: { ...CFG.tickets, transcriptsPerCategory: 999 } };
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), big);
    assert.equal(svc.perCategory, DISCORD_MAX_CHANNELS_PER_CATEGORY);
    const small = new TicketService(new Storage(path.join(dir, 'db2.json')), CFG);
    assert.equal(small.perCategory, 3);
  } finally {
    rm(dir);
  }
});

test('formatDuration renders minutes and seconds', () => {
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(61_000), '1m 1s');
  assert.equal(formatDuration(10 * 60 * 1000), '10m 0s');
});

test('service: counter, staff role and records persist across a reload', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'db.json');
    const svc = new TicketService(new Storage(file), CFG);
    svc.setStaffRole('G', 'STAFF');
    const b = svc._guild('G');
    b.counter = 7;
    b.tickets.CHAN = { number: 7, userId: 'U1', status: 'open', openedAt: 1 };
    svc.storage.save();

    const svc2 = new TicketService(new Storage(file), CFG);
    assert.equal(svc2._guild('G').counter, 7);
    assert.equal(svc2.getStaffRole('G'), 'STAFF');
    assert.equal(svc2.get('G', 'CHAN').number, 7);
    assert.equal(svc2.get('G', 'nope'), null);
  } finally {
    rm(dir);
  }
});

test('service: forgetChannel clears a record and starts the cooldown if it was open', () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    const b = svc._guild('G');
    b.tickets.CHAN = { number: 1, userId: 'U1', status: 'open', openedAt: 1 };
    assert.equal(svc.forgetChannel('G', 'CHAN'), true);
    assert.equal(svc.get('G', 'CHAN'), null);
    assert.ok(b.users.U1 && b.users.U1.lastClosedAt > 0);
    assert.equal(svc.forgetChannel('G', 'CHAN'), false);
  } finally {
    rm(dir);
  }
});

test('service: isStaff recognises manager, admins and the staff role', () => {
  const dir = tmpDir();
  try {
    const svc = new TicketService(new Storage(path.join(dir, 'db.json')), CFG);
    svc.setStaffRole('G', 'STAFF');
    const mk = (id, perms = [], roles = []) => ({
      id,
      permissions: { has: (p) => perms.includes(p) },
      roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
    });
    const { PermissionFlagsBits } = require('discord.js');
    assert.equal(svc.isStaff(mk('MGR'), 'G'), true);
    assert.equal(svc.isStaff(mk('A', [PermissionFlagsBits.Administrator]), 'G'), true);
    assert.equal(svc.isStaff(mk('B', [], ['STAFF']), 'G'), true);
    assert.equal(svc.isStaff(mk('C'), 'G'), false);
    assert.equal(svc.isStaff(null, 'G'), false);
  } finally {
    rm(dir);
  }
});
