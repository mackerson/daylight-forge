import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionCache } from '../src/session-cache.ts';
import { MemorySessionStore } from '../src/session-store.ts';

const cache = () => new SessionCache(new MemorySessionStore());

test('a fresh session is served', () => {
  const c = cache();
  c.set('s1', 'alice', 1000, 0);
  assert.equal(c.get('s1', 500)?.userId, 'alice');
});

test('reading inside the window slides the expiry forward', () => {
  const c = cache();
  c.set('s1', 'alice', 1000, 0);
  assert.equal(c.get('s1', 800)?.expiresAt, 1800);
});

test('an expired session is not served', () => {
  const c = cache();
  c.set('s1', 'alice', 1000, 0);
  assert.equal(c.get('s1', 5000), undefined);
});

test('a revoked session is gone', () => {
  const c = cache();
  c.set('s1', 'alice', 1000, 0);
  c.revoke('s1');
  assert.equal(c.get('s1', 10), undefined);
});

test('sweep removes only what has expired', () => {
  const c = cache();
  c.set('old', 'alice', 1000, 0);
  c.set('new', 'bob', 1000, 900);
  assert.equal(c.sweep(1500), 1);
  assert.equal(c.get('new', 1500)?.userId, 'bob');
});
