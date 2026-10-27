import { z } from 'zod';
import {
  BachsApiError,
  BachsProtocolError,
  BachsTransportError,
  UncertainProviderOutcomeError,
} from './errors.js';

const SANDBOX_API_ORIGIN = 'https://sandbox-api.bachs.io';
const timeoutSchema = z.number().int().min(100).max(120_000);

interface RequestOptions<T> {
  method: 'GET' | 'POST';
  path: string;
  schema: z.ZodType<T>;
  body?: unknown;
  accountReference?: string;
  idempotencyKey?: string;
  operationReference?: string;
}

interface BachsClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

export class BachsApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: BachsClientOptions) {
    if (!options.apiKey.startsWith('sk_sandbox_')) {
      throw new TypeError('Bachs adapter accepts sandbox API keys only');
    }
    if (/[\r\n]/.test(options.apiKey))
      throw new TypeError('Invalid Bachs API key');

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = timeoutSchema.parse(options.timeoutMs ?? 10_000);
  }

  async request<T>(options: RequestOptions<T>): Promise<T> {
    const url = new URL(options.path, SANDBOX_API_ORIGIN);
    if (url.origin !== SANDBOX_API_ORIGIN)
      throw new TypeError('Bachs API requests must use the sandbox origin');
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
    };
    if (options.body !== undefined)
      headers['content-type'] = 'application/json';
    if (options.accountReference)
      headers['X-Account-Id'] = options.accountReference;
    if (options.idempotencyKey)
      headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (!isFetchFailure(error)) throw error;
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'the request may have reached Bachs but its response was not received',
        );
      }
      throw new BachsTransportError();
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      if (!isFetchFailure(error)) throw error;
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'Bachs accepted the request but its response could not be read',
        );
      }
      throw new BachsTransportError();
    }

    if (!response.ok) {
      const providerCode = this.getProviderCode(responseText);
      if (
        options.method === 'POST' &&
        (response.status >= 500 || response.status === 409)
      ) {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          `Bachs returned HTTP ${response.status}`,
        );
      }
      throw new BachsApiError(response.status, providerCode);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'Bachs returned a successful response that could not be parsed',
        );
      }
      throw new BachsProtocolError('Bachs returned invalid JSON');
    }

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      if (options.method === 'POST') {
        throw new UncertainProviderOutcomeError(
          options.operationReference ?? 'unknown',
          'Bachs returned a successful response with an invalid shape',
        );
      }
      throw new BachsProtocolError(
        'Bachs returned an unexpected response shape',
      );
    }

    return parsed.data;
  }

  private getProviderCode(responseText: string): string | undefined {
    try {
      const payload: unknown = JSON.parse(responseText);
      if (!isRecord(payload) || !isRecord(payload['error'])) return undefined;
      const code = payload['error']['code'];
      return typeof code === 'string' ? code.slice(0, 80) : undefined;
    } catch {
      return undefined;
    }
  }
}

export { SANDBOX_API_ORIGIN };
