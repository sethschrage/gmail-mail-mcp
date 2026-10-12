/**
 * Cloud entry: a web-standard (Request -> Response) MCP endpoint for Vercel, serving the same
 * tools as the local stdio server over stateless Streamable HTTP, for several Gmail accounts.
 *
 * One deployment, one connector URL per account: https://<project>.vercel.app/api/gmail/<account>.
 * Each account is configured with its own Vercel env vars, GMAIL_<ACCOUNT>_* (account name in
 * capitals):
 * - GMAIL_<ACCOUNT>_ACCESS_KEY (32+ characters): required on every request for that account, as
 *   `?key=` or `Authorization: Bearer`, compared in constant time. Each account has its own key, so
 *   one leaked connector URL exposes one mailbox, and a key never opens another account.
 * - GMAIL_<ACCOUNT>_EMAIL and GMAIL_<ACCOUNT>_PASSWORD (a Google app password): the Gmail login.
 * - GMAIL_<ACCOUNT>_IMAP_USER, _FROM_ADDRESS, _FROM_NAME, _ALLOWED_FROM: optional identity settings.
 * - GMAIL_<ACCOUNT>_MAIL_<SETTING>: any MAIL_* setting for this account only (for example
 *   GMAIL_WORK_MAIL_READ_ONLY=true); unprefixed MAIL_* settings apply to every account.
 * An account without a usable access key does not exist as far as the outside can tell: 404.
 *
 * One MailService (IMAP connection, limits) per account, cached while the instance stays warm and
 * rebuilt when the account's settings change. Credentials are never logged or returned, and the
 * request URL (which carries the key) is never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { log as defaultLogger, redact, registerSecret, type Logger } from '../log.js';
import { setRuntime } from '../runtime.js';
import { buildServer } from '../server.js';
import { MailService, type MailServiceDeps } from '../service.js';

export const MIN_ACCESS_KEY_LENGTH = 32;
/** Accounts kept warm per instance; the least recently used one is closed beyond this. */
export const MAX_CACHED_LOGINS = 16;
/**
 * Account names: letters and digits only. No underscores, so GMAIL_<ACCOUNT>_<SETTING> always
 * splits one way (an account "work_mail" would clash with account "work"'s MAIL_* settings).
 */
export const ACCOUNT_NAME = /^[a-z0-9]{1,32}$/i;
/** The URL path the accounts live under (api/gmail/[account].js on Vercel). */
export const ROUTE_PREFIX = '/api/gmail/';

/** Global vars that belong to one account and must never leak into another account's service. */
const IDENTITY_VARS = ['GMAIL_EMAIL', 'GMAIL_PASSWORD', 'GMAIL_APP_PASSWORD', 'GMAIL_IMAP_USER', 'GMAIL_SMTP_USER', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'MAIL_ALLOWED_FROM', 'MAIL_ACCOUNT_NAME'];

/** GMAIL_<ACCOUNT>_<suffix> -> the variable the service reads. */
const ACCOUNT_VAR_MAP: Readonly<Record<string, string>> = {
  EMAIL: 'GMAIL_EMAIL',
  PASSWORD: 'GMAIL_PASSWORD',
  IMAP_USER: 'GMAIL_IMAP_USER',
  SMTP_USER: 'GMAIL_SMTP_USER',
  FROM_ADDRESS: 'MAIL_FROM_ADDRESS',
  FROM_NAME: 'MAIL_FROM_NAME',
  ALLOWED_FROM: 'MAIL_ALLOWED_FROM',
};

export type AccessResult = 'ok' | 'unauthorized' | 'misconfigured';

/** The account name in the request path, lower-cased, or null when the path is not an account route. */
export function accountFromRequest(request: Request): string | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const rest = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '');
  return ACCOUNT_NAME.test(rest) ? rest.toLowerCase() : null;
}

export function accountPrefix(account: string): string {
  return `GMAIL_${account.toUpperCase()}_`;
}

/** The access-key check (buxfer-mcp's checkAccess, plus telling a missing key apart from a wrong one). */
export function checkAccess(request: Request, expected: string | undefined): AccessResult {
  const want = (expected ?? '').trim();
  if (want.length < MIN_ACCESS_KEY_LENGTH) return 'misconfigured';
  let given = '';
  try {
    given = new URL(request.url).searchParams.get('key') ?? '';
  } catch {
    given = '';
  }
  const auth = request.headers.get('authorization') ?? '';
  if (!given && auth.toLowerCase().startsWith('bearer ')) given = auth.slice(7).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}

/**
 * The env one account's MailService sees: the global env without any account's identity or
 * GMAIL_<OTHER>_* variables, plus this account's variables mapped to the names the service reads.
 */
export function accountEnv(env: NodeJS.ProcessEnv, account: string): NodeJS.ProcessEnv {
  const prefix = accountPrefix(account);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (IDENTITY_VARS.includes(k)) continue;
    // GMAIL_<anything>_… belongs to some account (or is an identity var): only this account's are mapped below.
    if (k.startsWith('GMAIL_')) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(prefix) || v === undefined) continue;
    const suffix = k.slice(prefix.length);
    if (suffix === 'ACCESS_KEY') continue;
    const mapped = ACCOUNT_VAR_MAP[suffix];
    if (mapped) out[mapped] = v;
    else if (suffix.startsWith('MAIL_') && !IDENTITY_VARS.includes(suffix)) out[suffix] = v;
  }
  out['MAIL_ACCOUNT_NAME'] = account;
  return out;
}

/** Cache key for an account's settings: sha256 over its env, never the raw values. */
export function loginCacheKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface CloudHandlerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Extra MailService dependencies (tests: fake fetch for the limit store, clocks, ...). */
  serviceDeps?: MailServiceDeps;
}

interface CacheEntry {
  key: string;
  service: MailService;
  mcp: McpHttpHandler;
}

export type CloudHandler = ((request: Request) => Promise<Response>) & {
  /** Close every cached account (tests, shutdown). */
  close(): Promise<void>;
  /** Number of accounts currently cached (tests). */
  readonly cachedLogins: number;
};

export function createCloudHandler(options: CloudHandlerOptions = {}): CloudHandler {
  setRuntime('cloud');
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const cache = new Map<string, CacheEntry>(); // key: account name
  const warnedMisconfigured = new Set<string>();
  // Every account's secrets are redacted from logs from the start, whichever account is called.
  for (const [k, v] of Object.entries(env)) {
    if (v && /^GMAIL_[A-Z0-9_]+_(ACCESS_KEY|PASSWORD)$/.test(k)) registerSecret(v.trim());
  }

  const closeEntry = (entry: CacheEntry | undefined): void => {
    void entry?.service.close().catch(() => undefined);
    void entry?.mcp.close().catch(() => undefined);
  };

  const entryFor = (account: string): CacheEntry => {
    const serviceEnv = accountEnv(env, account);
    const key = loginCacheKey(Object.entries(serviceEnv).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([k, v]) => [k, v ?? '']));
    const hit = cache.get(account);
    if (hit && hit.key === key) {
      // Refresh recency (Map keeps insertion order).
      cache.delete(account);
      cache.set(account, hit);
      return hit;
    }
    if (hit) {
      cache.delete(account);
      closeEntry(hit);
    }
    const configResult = loadConfig(serviceEnv, { runtime: 'cloud' });
    const service = new MailService(configResult, {
      // Without an injected logger the service sets the shared stderr logger to MAIL_LOG_LEVEL.
      ...(options.logger ? { logger } : {}),
      ...options.serviceDeps,
      credentialOptions: { ...options.serviceDeps?.credentialOptions, sourceLabel: `${accountPrefix(account)}PASSWORD environment variable (Vercel)` },
    });
    for (const w of service.configWarnings) logger.warn(`configuration warning (${account}): ${w}`);
    for (const e of service.configErrors) logger.warn(`configuration problem (${account}): ${e}`);
    const mcp = createMcpHandler(() => buildServer(service, { logger }), {
      legacy: 'stateless',
      onerror: (err) => logger.warn('MCP request error', { account, err: redact(errorMessage(err)) }),
    });
    const entry: CacheEntry = { key, service, mcp };
    cache.set(account, entry);
    while (cache.size > MAX_CACHED_LOGINS) {
      const oldestKey = cache.keys().next().value as string;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      closeEntry(oldest);
    }
    return entry;
  };

  const handler = async (request: Request): Promise<Response> => {
    const started = Date.now();
    const account = accountFromRequest(request);
    if (!account) return json({ error: 'not found' }, 404);
    const access = checkAccess(request, env[`${accountPrefix(account)}ACCESS_KEY`]);
    if (access === 'misconfigured') {
      // Unknown accounts and accounts without a usable key look the same from outside.
      if (env[`${accountPrefix(account)}EMAIL`] && !warnedMisconfigured.has(account)) {
        warnedMisconfigured.add(account);
        logger.error(
          `${accountPrefix(account)}ACCESS_KEY is missing or shorter than ${MIN_ACCESS_KEY_LENGTH} characters: refusing every request for "${account}". Set it (Sensitive) in the Vercel project's environment variables and redeploy.`,
        );
      }
      return json({ error: 'not found' }, 404);
    }
    if (access !== 'ok') return json({ error: 'unauthorized' }, 401);
    try {
      const { mcp } = entryFor(account);
      const response = await mcp.fetch(request);
      logger.info('MCP request', { account, method: request.method, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      logger.error('MCP request failed', { account, err: redact(errorMessage(err)) });
      return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }, 500);
    }
  };

  const close = async (): Promise<void> => {
    const entries = [...cache.values()];
    cache.clear();
    await Promise.all(entries.flatMap((e) => [e.service.close().catch(() => undefined), e.mcp.close().catch(() => undefined)]));
  };
  // defineProperty, not Object.assign: assign would copy the getter's current value, not the getter.
  Object.defineProperty(handler, 'close', { value: close });
  Object.defineProperty(handler, 'cachedLogins', { get: () => cache.size });
  return handler as CloudHandler;
}
