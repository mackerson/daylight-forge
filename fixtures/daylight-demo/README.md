# daylight-demo

A small session-cache and retrying HTTP client, with no dependencies. **This is a PLANTED
fixture for the Daylight demonstration**: it contains exactly one deliberately placed defect,
documented in [DEFECT.md](DEFECT.md). Nothing found in it is an independently discovered
production defect, and it should never be presented as one.

## What it is

```
src/session-store.ts   Session shape and the store interface; an in-memory implementation
src/session-cache.ts   Sliding idle-timeout sessions over a store
src/retry.ts           Bounded exponential backoff with injected sleep
src/http-client.ts     A transport abstraction and a client that retries server errors
src/auth.ts            Requests authorised by a live session
src/index.ts           Public surface
```

Every time-dependent function takes `now` (or `sleep`) as an argument, so the behaviour is
deterministic under test and nothing in the library touches a clock.

## Running

```bash
node --test          # the suite; one test is red at the planted commit, by design
```

Needs Node 22.18 or newer: the tests import the TypeScript sources directly and rely on
Node stripping the types.

## Why it exists

Daylight needs a repository where two independent reviewers can plausibly disagree about a
behavioural claim, and where the disagreement can be settled by running something rather
than by arguing. This tree is that repository. `engine/demo/fixture.ts` materialises it as a
git repository at a deterministic commit so that every demo, on every machine, is about the
same revision.
