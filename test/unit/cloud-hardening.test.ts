/**
 * Pre-deploy review fixes for the cloud entry (ported from icloud-mail-mcp): an evicted account's
 * service waits for in-flight requests (including a still-streaming response body), the cloud
 * deadline stays inside Vercel's limit, post-send work is kept alive on Vercel, and cloud tool
 * texts don't mention the Mac.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createCloudHandler, MAX_CACHED_LOGINS, type CloudHandler } from '../../src/http/handler.js';
import { keepAlive, setKeepAlive, setRuntime } from '../../src/runtime.js';
import { MailService } from '../../src/service.js';
import { ACCESS_KEY, cloudEnv, connectCloud, vercelEnv } from '../helpers/cloud.js';

afterAll(() => {
  setRuntime('local');
  setKeepAlive(null);
});

/** A raw tools/list POST for one account, as claude.ai sends it. */
const toolsList = (account: string) =>
  new Request(`https://gmail-mail.test/api/gmail/${account}?key=${ACCESS_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('evicted accounts', () => {
  let handler: CloudHandler | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await handler?.close();
    handler = undefined;
  });

  it('closes an evicted account only once its in-flight request (and response body) has finished', async () => {
    const closed: MailService[] = [];
    const original = MailService.prototype.close;
    vi.spyOn(MailService.prototype, 'close').mockImplementation(function (this: MailService) {
      closed.push(this);
      return original.call(this);
    });
    const extra: Record<string, string> = {};
    for (let i = 0; i <= MAX_CACHED_LOGINS; i++) {
      extra[`GMAIL_U${i}_EMAIL`] = `u${i}@gmail.com`;
      extra[`GMAIL_U${i}_PASSWORD`] = `pw-${i}`;
      extra[`GMAIL_U${i}_ACCESS_KEY`] = ACCESS_KEY;
    }
    handler = createCloudHandler({ env: vercelEnv({ IMAP_PORT: '9', ...extra }) });
    // Account u0's response is not read yet: its tool call is still "running" as far as we know.
    const a = await handler(toolsList('u0'));
    for (let i = 1; i <= MAX_CACHED_LOGINS; i++) {
      const res = await handler(toolsList(`u${i}`));
      await res.text();
    }
    expect(handler.cachedLogins).toBe(MAX_CACHED_LOGINS);
    expect(closed).toHaveLength(0); // u0 was evicted, but is still in use
    expect(await a.text()).toMatch(/"tools"/);
    expect(closed).toHaveLength(1);
  });
});

describe('cloud limits and texts', () => {
  afterEach(() => setRuntime('local'));

  it('caps the per-call deadline below Vercel\'s 60 s function limit', () => {
    const cloud = loadConfig(cloudEnv({ MAIL_OPERATION_TIMEOUT_SECONDS: '120' }), { runtime: 'cloud' });
    expect(cloud.config.operationTimeoutSeconds).toBe(50);
    expect(cloud.warnings.join(' ')).toMatch(/MAIL_OPERATION_TIMEOUT_SECONDS/);
    const local = loadConfig(cloudEnv({ MAIL_OPERATION_TIMEOUT_SECONDS: '120' }), { runtime: 'local' });
    expect(local.config.operationTimeoutSeconds).toBe(120);
  });

  it('keeps post-send work alive through the registered hook (Vercel waitUntil)', async () => {
    expect(keepAlive(Promise.resolve())).toBe(false);
    const kept: Promise<unknown>[] = [];
    setKeepAlive((p) => kept.push(p));
    try {
      // A rejection is swallowed before it reaches the platform.
      expect(keepAlive(Promise.reject(new Error('late')))).toBe(true);
      expect(kept).toHaveLength(1);
      await expect(kept[0]).resolves.toBeUndefined();
    } finally {
      setKeepAlive(null);
    }
  });

  it('does not mention a Mac dialog for permanent deletion in the cloud', async () => {
    const handler = createCloudHandler({ env: vercelEnv({ IMAP_PORT: '9', MAIL_ALLOW_PERMANENT_DELETE: 'true' }) });
    const { client, close } = await connectCloud(handler);
    const tools = (await client.listTools()).tools;
    const del = tools.find((t) => t.name === 'delete_messages_permanently');
    expect(del?.description).toMatch(/CANNOT BE UNDONE/);
    expect(del?.description).not.toMatch(/on the Mac/);
    await close();
    await handler.close();
  });
});
