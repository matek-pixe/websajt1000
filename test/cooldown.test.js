'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Cooldown } = require('../src/services/cooldown');

test('remaining is 0 before any hit', () => {
  const c = new Cooldown(30_000);
  assert.equal(c.remaining('steam:1', 1000), 0);
});

test('hit blocks until it expires', () => {
  const c = new Cooldown(30_000);
  c.hit('steam:1', 1000);
  assert.equal(c.remaining('steam:1', 1000), 30_000);
  assert.equal(c.remaining('steam:1', 16_000), 15_000);
  assert.equal(c.remaining('steam:1', 31_000), 0); // exactly expired
  assert.equal(c.remaining('steam:1', 40_000), 0);
});

test('keys are independent per user and per command', () => {
  const c = new Cooldown(30_000);
  c.hit('steam:1', 0);
  assert.equal(c.remaining('steam:2', 0), 0);
  assert.equal(c.remaining('5m:1', 0), 0);
  assert.equal(c.remaining('steam:1', 0), 30_000);
});

test('reset clears a cooldown (refund)', () => {
  const c = new Cooldown(30_000);
  c.hit('steam:1', 0);
  c.reset('steam:1');
  assert.equal(c.remaining('steam:1', 0), 0);
});

test('sweep drops expired entries', () => {
  const c = new Cooldown(30_000);
  c.hit('a', 0);
  c.hit('b', 100_000);
  c.sweep(50_000);
  assert.equal(c.until.has('a'), false);
  assert.equal(c.until.has('b'), true);
});
