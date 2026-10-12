/**
 * Helpers for the cloud (Vercel) entry: an in-memory stand-in for Upstash Redis's REST pipeline
 * API, and an MCP client wired straight into a CloudHandler (no network, no port).
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { CloudHandler } from '../../src/http/handler.js';
import type { FetchFn } from '../../src/quota.js';
import { ACCOUNT, CA_FILE, PASSWORD } from './infra.js';

export const ACCESS_KEY = 'test-access-key-0123456789abcdefghijklmnopqrstuvwxyz';
/** The account name the cloud tests use, and its connector URL. */
export const TEST_ACCOUNT = 'test';
export const ENDPOINT = `https://gmail-mail.test/api/gmail/${TEST_ACCOUNT}`;

/** INCRBY / DECRBY / GET / PEXPIRE over a Map, answering like POST {url}/pipeline does. */
export class FakeUpstash {
  readonly data = new Map<string, number>();
  readonly requests: Array<{ url: string; authorization: string | undefined; commands: string[][] }> = [];
  /** 'network' = fetch rejects; a number = that HTTP status. */
  fail: 'network' | number | null = null;

  readonly fetch: FetchFn = async (url, init) => {
    const commands = JSON.parse(init.body) as string[][];
    this.requests.push({ url, authorization: init.headers['authorization'], commands });
    if (this.fail === 'network') throw new Error('getaddrinfo ENOTFOUND upstash.test');
    if (typeof this.fail === 'number') return { ok: false, status: this.fail, json: async () => ({ error: 'nope' }) };
    const results = commands.map(([cmd, key, arg]) => {
      const k = key ?? '';
      switch (cmd) {
        case 'INCRBY': {
          const v = (this.data.get(k) ?? 0) + Number(arg);
          this.data.set(k, v);
          return { result: v };
        }
        case 'DECRBY': {
          const v = (this.data.get(k) ?? 0) - Number(arg);
          this.data.set(k, v);
          return { result: v };
        }
        case 'GET':
          return { result: this.data.has(k) ? String(this.data.get(k)) : null };
        case 'PEXPIRE':
          return { result: 1 };
        default:
          return { error: `ERR unknown command '${cmd}'` };
      }
    });
    return { ok: true, status: 200, json: async () => results };
  };

  /** Sum of the counters whose key contains `metric` (e.g. "sends_h"). */
  total(metric: string): number {
    let n = 0;
    for (const [k, v] of this.data) if (k.includes(`:${metric}:`)) n += v;
    return n;
  }
}

/**
 * The env one account's MailService sees in the cloud (what accountEnv() produces from the Vercel
 * env), against the local test-infra servers. For loadConfig/MailService tests.
 */
export function cloudEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GMAIL_EMAIL: ACCOUNT,
    GMAIL_PASSWORD: PASSWORD,
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: '1993',
    IMAP_SECURE: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1587',
    SMTP_SECURE: 'false',
    MAIL_TLS_CA_FILE: CA_FILE,
    MAIL_TIMEZONE: 'America/Los_Angeles',
    MAIL_ALLOWED_FROM: 'testuser.alias@icloud.test',
    MAIL_FROM_NAME: 'Test User',
    MAIL_LOG_LEVEL: 'error',
    MAIL_AUDIT_LOG: 'off',
    UPSTASH_REDIS_REST_URL: 'https://upstash.test',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-token-123',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Service settings that are per account in the Vercel env (GMAIL_<ACCOUNT>_<suffix>). */
const PER_ACCOUNT: Readonly<Record<string, string>> = {
  GMAIL_EMAIL: 'EMAIL',
  GMAIL_PASSWORD: 'PASSWORD',
  MAIL_ALLOWED_FROM: 'ALLOWED_FROM',
  MAIL_FROM_NAME: 'FROM_NAME',
};

/**
 * The Vercel project env for the cloud handler: cloudEnv()'s identity settings moved to
 * GMAIL_<ACCOUNT>_* for `account`, plus that account's access key. Overrides apply last, to the
 * Vercel-level names (e.g. { GMAIL_TEST_PASSWORD: undefined }).
 */
export function vercelEnv(overrides: Record<string, string | undefined> = {}, account = TEST_ACCOUNT): NodeJS.ProcessEnv {
  const prefix = `GMAIL_${account.toUpperCase()}_`;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(cloudEnv())) {
    const suffix = PER_ACCOUNT[k];
    env[suffix ? `${prefix}${suffix}` : k] = v;
  }
  env[`${prefix}ACCESS_KEY`] = ACCESS_KEY;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** An MCP client whose HTTP requests go straight into `handler`. */
export async function connectCloud(
  handler: CloudHandler,
  options: { key?: string | null; headers?: Record<string, string>; bearer?: boolean; endpoint?: string } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const key = options.key === undefined ? ACCESS_KEY : options.key;
  const url = new URL(options.endpoint ?? ENDPOINT);
  const headers: Record<string, string> = { ...options.headers };
  if (key !== null && options.bearer) headers['authorization'] = `Bearer ${key}`;
  else if (key !== null) url.searchParams.set('key', key);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: async (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)),
  });
  const client = new Client({ name: 'gmail-mail-cloud-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function resultText(r: unknown): string {
  const content = (r as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}
