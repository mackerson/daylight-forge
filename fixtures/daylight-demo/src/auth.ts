import type { HttpClient } from './http-client.ts';
import type { SessionCache } from './session-cache.ts';

/**
 * Authenticated requests: the session is the credential.
 *
 * A request with no live session is refused before anything leaves the process, which is
 * what makes the cache's expiry rule load-bearing rather than cosmetic.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthenticatedClient {
  private readonly sessions: SessionCache;
  private readonly http: HttpClient;
  private readonly now: () => number;

  constructor(sessions: SessionCache, http: HttpClient, now: () => number = () => Date.now()) {
    this.sessions = sessions;
    this.http = http;
    this.now = now;
  }

  async get(sessionId: string, url: string): Promise<string> {
    const session = this.sessions.get(sessionId, this.now());
    if (!session) throw new AuthError(`no live session ${sessionId}`);
    return this.http.get(url, { authorization: `Session ${session.id}` });
  }
}
