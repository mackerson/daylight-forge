/**
 * Where sessions live between requests.
 *
 * The interface is the point: the cache is tested against the in-memory store, and a
 * deployment swaps in something durable without the cache noticing.
 */

export interface Session {
  id: string;
  userId: string;
  /** Epoch milliseconds after which the session must not be served. */
  expiresAt: number;
  /** Idle timeout; a read inside the window extends `expiresAt` by this much. */
  ttlMs: number;
}

export interface SessionStore {
  read(id: string): Session | undefined;
  write(session: Session): void;
  remove(id: string): void;
  /** Every stored id, for sweeping. */
  ids(): string[];
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  read(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  write(session: Session): void {
    this.sessions.set(session.id, { ...session });
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }
}
