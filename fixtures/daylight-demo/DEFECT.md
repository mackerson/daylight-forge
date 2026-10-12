# The planted defect

PLANTED — this defect was placed deliberately for the Daylight demonstration and is not an
independently discovered production defect.

## Where

`src/session-cache.ts`, `SessionCache.get`, lines 30–42; the unreachable check is line 37.

## Mechanism

`get` implements a sliding idle timeout: a read inside the window is supposed to extend the
session's expiry by its ttl, and a read after the window is supposed to evict it. The
implementation refreshes first and checks second:

```ts
const refreshed: Session = { ...session, expiresAt: now + session.ttlMs };
this.store.write(refreshed);

if (refreshed.expiresAt <= now) {   // now + ttl <= now, with ttl > 0: never true
  this.store.remove(id);
  return undefined;
}
return refreshed;
```

`set` rejects a non-positive ttl, so `refreshed.expiresAt` is always strictly greater than
`now` and the eviction branch is unreachable. Every stored session is served forever on
read, however long it has been idle. Only `sweep` — which checks the stored `expiresAt`
without refreshing — can remove an expired session, and only if it runs before the next read
resurrects it.

Why it is plausible to miss: the comment on `get` describes sliding expiry correctly, the
refresh *is* the right thing to do for a live session, and the expiry check is present and
looks like the guard it is meant to be. Why it is plausible to catch: the condition compares
a value just computed as `now + ttl` against `now`.

## The test that exposes it

`test/session-cache.test.js`, "an expired session is not served": set a session with ttl
1000 at t=0, read at t=5000, expect `undefined`. At the planted commit the read returns the
session with `expiresAt: 6000`.

## The fix

Check the stored expiry before refreshing:

```ts
if (session.expiresAt <= now) {
  this.store.remove(id);
  return undefined;
}
const refreshed: Session = { ...session, expiresAt: now + session.ttlMs };
this.store.write(refreshed);
return refreshed;
```

## Consequence in this library

`AuthenticatedClient.get` treats a served session as a valid credential, so with the defect
an idle session authorises requests indefinitely.
