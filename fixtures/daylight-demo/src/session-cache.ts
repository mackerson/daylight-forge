import type { Session, SessionStore } from './session-store.ts';

/**
 * Sessions with a sliding idle timeout.
 *
 * A session is kept alive by use: every successful read pushes its expiry out by the
 * session's own ttl, and a session nobody touches for a ttl is gone. `now` is injected
 * everywhere so the behaviour can be tested without waiting.
 */
export class SessionCache {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  set(id: string, userId: string, ttlMs: number, now: number): Session {
    if (!(ttlMs > 0)) throw new RangeError(`ttl must be positive, got ${ttlMs}`);
    const session: Session = { id, userId, ttlMs, expiresAt: now + ttlMs };
    this.store.write(session);
    return session;
  }

  /**
   * The session, or undefined once it has expired.
   *
   * Reading is what keeps a session alive, so the expiry is slid forward on access and the
   * refreshed record handed back; anything past its expiry is evicted instead.
   */
  get(id: string, now: number): Session | undefined {
    const session = this.store.read(id);
    if (!session) return undefined;

    const refreshed: Session = { ...session, expiresAt: now + session.ttlMs };
    this.store.write(refreshed);

    if (refreshed.expiresAt <= now) {
      this.store.remove(id);
      return undefined;
    }
    return refreshed;
  }

  revoke(id: string): void {
    this.store.remove(id);
  }

  /** Drop everything that has expired without being read. Returns how many went. */
  sweep(now: number): number {
    let removed = 0;
    for (const id of this.store.ids()) {
      const session = this.store.read(id);
      if (session && session.expiresAt <= now) {
        this.store.remove(id);
        removed++;
      }
    }
    return removed;
  }
}
