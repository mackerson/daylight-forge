import { withRetry, type RetryPolicy, type Sleep } from './retry.ts';

/** The narrow slice of fetch this library uses, named so it can be stubbed. */
export interface Transport {
  send(request: { url: string; headers: Record<string, string> }): Promise<{ status: number; body: string }>;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Server trouble is worth another try; a client mistake is not. */
export const retryOnServerError: RetryPolicy['retryable'] = (error) =>
  error instanceof HttpError && error.status >= 500;

export class HttpClient {
  private readonly transport: Transport;
  private readonly policy: RetryPolicy;
  private readonly sleep: Sleep;

  constructor(transport: Transport, policy: RetryPolicy, sleep: Sleep) {
    this.transport = transport;
    this.policy = policy;
    this.sleep = sleep;
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    return withRetry(async () => {
      const response = await this.transport.send({ url, headers });
      if (response.status >= 400) {
        throw new HttpError(response.status, `${url} responded ${response.status}`);
      }
      return response.body;
    }, this.policy, this.sleep);
  }
}
