/**
 * Server behaviour the Dovecot profiles cannot reproduce, against a scripted fake IMAP server with the
 * real imapflow: name-guess conflicts between special folders (Gmail without SPECIAL-USE), ghost
 * \Deleted UIDs, failures between COPY and EXPUNGE, failed SEARCHes, commands that never get an
 * answer, login refusals, the STARTTLS requirement, the command budget of ordinary calls, and Gmail's
 * label commands (X-GM-EXT-1): label_messages, archive and permanent deletion through Trash.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { withDeadline } from '../../src/deadline.js';
import { MailError } from '../../src/errors.js';
import { createLogger } from '../../src/log.js';
import { MailService } from '../../src/service.js';
import { GMAIL_CAPS, GMAIL_FOLDERS, startFakeImap, type FakeFolder, type FakeOptions, type FakeServer } from '../helpers/fake-imap.js';

/** Gmail's folders as a server without SPECIAL-USE lists them: no attributes, so imapflow guesses from names. */
const GMAIL_NO_SPECIAL_USE: FakeFolder[] = [{ path: '[Gmail]', flags: ['\\Noselect'] }, ...['[Gmail]/All Mail', '[Gmail]/Drafts', '[Gmail]/Sent Mail', '[Gmail]/Spam', '[Gmail]/Trash'].map((p) => ({ path: p }))];
const NO_UIDPLUS = 'IMAP4rev1 LITERAL+ IDLE QUOTA';

const home = mkdtempSync(path.join(os.tmpdir(), 'fake-imap-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

let server: FakeServer | undefined;
let svc: MailService | undefined;
afterEach(async () => {
  await svc?.close().catch(() => undefined);
  await server?.close();
  svc = undefined;
  server = undefined;
});

async function setup(extraFolders: Array<string | FakeFolder>, opts: FakeOptions = {}, env: Record<string, string> = {}, standard: FakeFolder[] = GMAIL_NO_SPECIAL_USE): Promise<{ s: MailService; srv: FakeServer }> {
  server = await startFakeImap([...standard, ...extraFolders.map((f) => (typeof f === 'string' ? { path: f } : f))], opts);
  const cfg = loadConfig(
    {
      GMAIL_EMAIL: 'me@gmail.com',
      GMAIL_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT: String(server.port),
      IMAP_SECURE: 'false',
      IMAP_ALLOW_PLAINTEXT: 'true',
      MAIL_AUDIT_LOG: 'off',
      MAIL_TIMEZONE: 'UTC',
      ...env,
    },
    { platform: 'linux', home },
  );
  svc = new MailService(cfg, { logger: createLogger({ level: 'error', sink: () => undefined }), platform: 'linux' });
  return { s: svc, srv: server };
}

async function failure(p: Promise<unknown>): Promise<MailError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  return e as MailError;
}

// imap-1 / tests-1
describe('special folders without SPECIAL-USE', () => {
  it("baseline: only Gmail's folders -> canonical mapping", async () => {
    const { s } = await setup([]);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: '[Gmail]/Sent Mail', trash: '[Gmail]/Trash', drafts: '[Gmail]/Drafts', junk: '[Gmail]/Spam' });
  });

  it("stray Outlook/Thunderbird/Apple labels never replace Gmail's folders", async () => {
    const { s } = await setup(['Deleted Items', 'Sent Items', 'Bulk Mail', 'Bin', 'Draft', 'Sent', 'Junk', 'Deleted Messages']);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: '[Gmail]/Sent Mail', trash: '[Gmail]/Trash', drafts: '[Gmail]/Drafts', junk: '[Gmail]/Spam' });
    expect((await s.resolveMailbox('trash')).path).toBe('[Gmail]/Trash');
    expect((await s.resolveMailbox('sent mail')).path).toBe('[Gmail]/Sent Mail');
    const list = await s.listMailboxes({ includeCounts: false });
    expect(list.find((m) => m.path === '[Gmail]/Trash')?.special_use).toBe('trash');
    expect(list.find((m) => m.path === 'Bin')?.special_use).toBeNull();
    expect(list.find((m) => m.path === 'Sent')?.special_use).toBeNull();
  });

  it('nested folders named like special folders are ordinary folders', async () => {
    const { s } = await setup(['Old Mail', 'Old Mail/Sent', 'Clients', 'Clients/Trash', 'Clients/Drafts']);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: '[Gmail]/Sent Mail', trash: '[Gmail]/Trash', drafts: '[Gmail]/Drafts' });
  });

  it('trash_messages moves into [Gmail]/Trash even when a "Bin" exists', async () => {
    const { s, srv } = await setup(['Bin', 'Deleted Items'], { uids: { INBOX: [7] } });
    const r = await s.trashMessages({ mailbox: 'INBOX', uids: [7] });
    expect(r).toMatchObject({ destination: '[Gmail]/Trash', moved: 1 });
    expect(srv.commands.find((c) => c.includes('UID COPY'))).toMatch(/"\[Gmail\]\/Trash"$/);
  });

  it("falls back to a top-level name guess when Gmail's folder is missing", async () => {
    server = await startFakeImap([{ path: '[Gmail]/Drafts' }, { path: 'Sent Items' }, { path: '[Gmail]/Trash' }, { path: '[Gmail]/Spam' }]);
    const cfg = loadConfig(
      { GMAIL_EMAIL: 'me@gmail.com', GMAIL_APP_PASSWORD: 'x', IMAP_HOST: '127.0.0.1', IMAP_PORT: String(server.port), IMAP_SECURE: 'false', IMAP_ALLOW_PLAINTEXT: 'true', MAIL_AUDIT_LOG: 'off' },
      { platform: 'linux', home },
    );
    svc = new MailService(cfg, { logger: createLogger({ level: 'error', sink: () => undefined }), platform: 'linux' });
    expect((await svc.getAccountInfo())['special_folders']).toMatchObject({ sent: 'Sent Items', trash: '[Gmail]/Trash' });
  });
});

// imap-6 / tests-6
describe('a move that fails after COPY (no MOVE)', () => {
  it('EXPUNGE failed but the originals are flagged deleted: reported as moved, with a warning', async () => {
    const { s, srv } = await setup(['Receipts'], { uids: { INBOX: [5] }, failExpunge: true });
    const r = await s.moveMessages({ mailbox: 'INBOX', uids: [5], destination: 'Receipts' });
    expect(r.moved).toBe(1);
    expect(r.new_uids).toEqual({ '5': 101 });
    expect(r.warning).toMatch(/copied to "Receipts".*do not move them again/);
    expect(srv.flagsOf('INBOX', 5)).toContain('\\Deleted');
  });

  it('STORE failed after COPY: the error says copies exist and not to retry', async () => {
    const { s } = await setup(['Receipts'], { uids: { INBOX: [5, 6] }, failStore: true });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [5, 6], destination: 'Receipts' }));
    expect(e.code).toBe('SERVER');
    expect(e.message).toMatch(/Copied 2 message\(s\) to "Receipts" \(new UIDs there: 101, 102\).*Do not retry the move/);
    expect(e.details).toMatchObject({ copied: 2, new_uids: { '5': 101, '6': 102 } });
  });
});

// imap-2
describe('a failed SEARCH is an error, never "no results"', () => {
  it('the expunge guard fails closed: nothing is copied when SEARCH DELETED fails (no UIDPLUS)', async () => {
    const { s, srv } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [1, 2, 3] }, failSearch: /^DELETED$/i });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' }));
    expect(e.code).toBe('SERVER');
    expect(srv.commands.some((c) => /UID (COPY|STORE|EXPUNGE)|\bEXPUNGE\b/.test(c))).toBe(false);
  });

  it('a failed verify SEARCH is reported as an error, not as not_found', async () => {
    const { s } = await setup([], { uids: { INBOX: [1, 2] }, failSearch: /UNDELETED/i });
    const e = await failure(s.markMessages({ mailbox: 'INBOX', uids: [1, 2], read: true }));
    expect(e.code).toBe('SERVER');
  });
});

// tests-9
describe('ghost \\Deleted UIDs (no UIDPLUS)', () => {
  it('UIDs that SEARCH DELETED returns but FETCH does not show do not block a move', async () => {
    const { s } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [10] }, ghostDeleted: [1, 2, 3] });
    const r = await s.moveMessages({ mailbox: 'INBOX', uids: [10], destination: 'Receipts' });
    expect(r.moved).toBe(1);
  });

  it('a visible \\Deleted message still blocks it', async () => {
    const { s, srv } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [9, 10] }, flags: { 'INBOX/9': ['\\Deleted'] } });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [10], destination: 'Receipts' }));
    expect(e.code).toBe('EXPUNGE_GUARD');
    expect(e.message).toContain('9');
    expect(srv.commands.some((c) => c.includes('COPY'))).toBe(false);
  });
});

// imap-4 / integ-1 / tests-7
describe('a command that never gets an answer', () => {
  it('after a timed-out call the connection is replaced, so the next call works right away', async () => {
    const { s, srv } = await setup([], { uids: { INBOX: [1, 2, 3] }, hangOn: ['UID SEARCH'] });
    const first = await failure(withDeadline(() => s.search({ mailbox: 'INBOX', subject: 'x' }), { timeoutMs: 1500, what: 'search_messages' }));
    expect(first.code).toBe('TIMEOUT');
    const started = Date.now();
    const second = await withDeadline(() => s.search({ mailbox: 'INBOX', limit: 1 }), { timeoutMs: 20_000, what: 'search_messages' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(second.returned).toBe(1);
    expect(srv.logins()).toBe(2);
  });

  it('a write queued behind the stuck command is never sent once its call was abandoned', async () => {
    const { s, srv } = await setup(['Receipts'], { uids: { INBOX: [1, 2, 3] }, hangOn: ['UID SEARCH'] });
    const controller = new AbortController();
    const stuck = withDeadline(() => s.search({ mailbox: 'INBOX', subject: 'x' }), { timeoutMs: 60_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));
    const queued = withDeadline((signal) => s.createMailbox({ path: 'NewFolder' }, { signal }), { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect((await failure(stuck)).code).toBe('CANCELLED');
    expect((await failure(queued)).code).toBe('CANCELLED');
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.commands.some((c) => c.includes('CREATE'))).toBe(false);
  });
});

// integ-2
describe('login refusals', () => {
  it('NO [UNAVAILABLE] is a temporary connection problem: one LOGIN, server text quoted, no password advice', async () => {
    const { s, srv } = await setup([], { loginResponse: 'NO [UNAVAILABLE] Maximum number of connections from user+IP exceeded' });
    const e = await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(e.code).toBe('CONNECTION');
    expect(e.message).toContain('(server said: [UNAVAILABLE] Maximum number of connections from user+IP exceeded)');
    expect(e.message).not.toMatch(/revoked/);
    expect(srv.logins()).toBe(1);
  });

  it('NO [AUTHENTICATIONFAILED] is a credential problem: one LOGIN with the full address, Gmail advice', async () => {
    const { s, srv } = await setup([], { loginResponse: 'NO [AUTHENTICATIONFAILED] Invalid credentials' });
    const e = await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(e.code).toBe('AUTH');
    expect(e.message).toContain('rejected the login for "me@gmail.com" (server said: [AUTHENTICATIONFAILED] Invalid credentials)');
    expect(e.message).toContain('app password');
    expect(srv.logins()).toBe(1);
    expect(srv.commands.filter((c) => /\bLOGIN\b/i.test(c)).every((c) => c.includes('"me@gmail.com"') || c.includes('me@gmail.com'))).toBe(true);
  });
});

// tls-1
describe('STARTTLS is required without implicit TLS', () => {
  it('refuses to log in in plaintext when the server offers no STARTTLS', async () => {
    const { s, srv } = await setup([], {}, { IMAP_ALLOW_PLAINTEXT: 'false' });
    await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(srv.logins()).toBe(0);
    expect(srv.commands.some((c) => /LOGIN|AUTHENTICATE/i.test(c))).toBe(false);
  });

  it('the test-only plaintext switch is reported as a configuration warning', () => {
    const r = loadConfig({ GMAIL_EMAIL: 'me@gmail.com', IMAP_SECURE: 'false', IMAP_ALLOW_PLAINTEXT: 'true' }, { platform: 'linux', home });
    expect(r.warnings.join(' ')).toMatch(/IMAP_ALLOW_PLAINTEXT/);
  });
});

// imap-9
describe('no ENABLE after login', () => {
  it('does not enable CONDSTORE / UTF8=ACCEPT even when advertised', async () => {
    const { s, srv } = await setup([], { caps: 'IMAP4rev1 LITERAL+ UIDPLUS ENABLE CONDSTORE UTF8=ACCEPT', uids: { INBOX: [1] } });
    await s.search({ mailbox: 'INBOX', limit: 1 });
    expect(srv.commands.some((c) => /\bENABLE\b/i.test(c))).toBe(false);
    expect(srv.commands.some((c) => /MODSEQ/i.test(c))).toBe(false);
  });
});

// imap-5
describe('folder list caching', () => {
  it('a flag change does not make the next call relist every folder, and counts are only loaded on request', async () => {
    const { s, srv } = await setup(['A', 'B', 'C'], { uids: { INBOX: [1, 2] } });
    await s.search({ mailbox: 'INBOX', limit: 5 });
    await s.markMessages({ mailbox: 'INBOX', uids: [1], read: true });
    const before = srv.commands.length;
    await s.search({ mailbox: 'INBOX', limit: 5 });
    await s.listMailboxes({ includeCounts: false });
    const after = srv.commands.slice(before);
    expect(after.some((c) => /\b(LIST|LSUB|STATUS)\b/i.test(c))).toBe(false);
    await s.listMailboxes({ includeCounts: true });
    expect(srv.commands.slice(before).some((c) => /\bSTATUS\b|LIST .*RETURN \(STATUS/i.test(c))).toBe(true);
  });
});

// Gmail labels (X-GM-EXT-1): our own STORE tokens, read back with X-GM-LABELS.
describe('Gmail labels', () => {
  const gmail = (extra: Array<string | FakeFolder>, opts: FakeOptions = {}, env: Record<string, string> = {}) => setup(['Receipts', ...extra], { caps: GMAIL_CAPS, ...opts }, env, GMAIL_FOLDERS);
  const storeLines = (srv: FakeServer): string[] => srv.commands.filter((c) => /UID STORE \S+ [+-]X-GM-LABELS/.test(c)).map((c) => c.replace(/^\S+ /, ''));

  it('sends a crafted label as one quoted string, so it cannot add flags or tokens', async () => {
    const { s, srv } = await gmail([], { uids: { INBOX: [5] }, labels: { 'INBOX/5': ['\\Inbox'] } });
    const r = await s.labelMessages({ mailbox: 'INBOX', uids: [5], add: ['x) \\Deleted'] });
    expect(storeLines(srv)).toEqual(['UID STORE 5 +X-GM-LABELS ("x) \\\\Deleted")']);
    expect(srv.labelStores).toEqual([{ mailbox: 'INBOX', uids: [5], op: '+', items: [{ type: 'STRING', value: 'x) \\Deleted' }] }]);
    expect(srv.flagsOf('INBOX', 5)).not.toContain('\\Deleted');
    expect(srv.labelsOf('INBOX', 5)).toEqual(['\\Inbox', 'x) \\Deleted']);
    expect(r).toMatchObject({ mailbox: 'INBOX', affected: 1, changed: 1, not_found: [], added: ['x) \\Deleted'], removed: [], not_applied: [] });
    expect(r.messages).toEqual([{ uid: 5, labels: ['Inbox', 'x) \\Deleted'] }]);
  });

  it('encodes non-ASCII labels in modified UTF-7 and quotes labels with spaces and quotes', async () => {
    const { s, srv } = await gmail([], { uids: { INBOX: [5] }, labels: { 'INBOX/5': ['\\Inbox'] } });
    const r = await s.labelMessages({ mailbox: 'INBOX', uids: [5], add: ['Café & Bar', 'Say "hi"'] });
    expect(storeLines(srv)).toEqual(['UID STORE 5 +X-GM-LABELS ("Caf&AOk- &- Bar" "Say \\"hi\\"")']);
    expect(srv.labelsOf('INBOX', 5)).toEqual(['\\Inbox', 'Caf&AOk- &- Bar', 'Say "hi"']);
    expect(r.messages).toEqual([{ uid: 5, labels: ['Inbox', 'Café & Bar', 'Say "hi"'] }]);
    expect(r.not_applied).toEqual([]);
  });

  it('sends system labels as backslash atoms, adds before it removes, and reports labels that did not change', async () => {
    const { s, srv } = await gmail([], { uids: { Receipts: [3, 4] }, labels: { 'Receipts/3': ['Receipts', '\\Inbox'], 'Receipts/4': ['Receipts'] } });
    const r = await s.labelMessages({ mailbox: 'Receipts', uids: [3, 4, 99], add: ['starred', 'Important'], remove: ['inbox'] });
    expect(storeLines(srv)).toEqual(['UID STORE 3:4 +X-GM-LABELS (\\Starred \\Important)', 'UID STORE 3:4 -X-GM-LABELS (\\Inbox)']);
    expect(r).toMatchObject({ affected: 2, changed: 2, not_found: [99], added: ['starred', 'Important'], removed: ['inbox'], not_applied: [] });
    expect(r.messages).toEqual([
      { uid: 3, labels: ['Important', 'Starred', 'Receipts'] },
      { uid: 4, labels: ['Important', 'Starred', 'Receipts'] },
    ]);
  });

  it('reads the labels before changing them, and counts only messages whose labels change', async () => {
    const { s, srv } = await gmail([], { uids: { Receipts: [3, 4, 5] }, labels: { 'Receipts/3': ['Receipts', 'Clients'], 'Receipts/4': ['Receipts'], 'Receipts/5': ['Receipts', 'CLIENTS'] } });
    const r = await s.labelMessages({ mailbox: 'Receipts', uids: [3, 4, 5], add: ['clients'] });
    expect(r).toMatchObject({ affected: 3, changed: 1, not_applied: [] });
    const lines = srv.commands.map((c) => c.replace(/^\S+ /, ''));
    expect(lines.slice(lines.indexOf('SELECT Receipts'))).toEqual([
      'SELECT Receipts',
      'UID SEARCH UID 3:5 UNDELETED',
      'UID FETCH 3:5 (UID X-GM-MSGID X-GM-LABELS)',
      'UID STORE 3:5 +X-GM-LABELS ("clients")',
      'UID FETCH 3:5 (UID X-GM-MSGID X-GM-LABELS)',
    ]);
    const none = await s.labelMessages({ mailbox: 'Receipts', uids: [4], remove: ['Never Set'] });
    expect(none).toMatchObject({ affected: 1, changed: 0 });
  });

  it('reports messages that left the folder because its own label was removed', async () => {
    const { s, srv } = await gmail([], { uids: { Receipts: [3] }, labels: { 'Receipts/3': ['Receipts', '\\Inbox'] } });
    const r = await s.labelMessages({ mailbox: 'Receipts', uids: [3], remove: ['Receipts'] });
    expect(storeLines(srv)).toEqual(['UID STORE 3 -X-GM-LABELS ("Receipts")']);
    expect(srv.uidsIn('Receipts')).toEqual([]);
    expect(r.left_mailbox).toEqual([3]);
    expect(r.note).toMatch(/left "Receipts".*still in All Mail/);
  });

  it('refuses reserved and invalid labels before sending anything', async () => {
    const { s, srv } = await gmail([], { uids: { INBOX: [5] } });
    for (const bad of ['Trash', 'spam', '[Gmail]/Sent Mail', 'line\nbreak', '', 'x'.repeat(226)]) {
      expect((await failure(s.labelMessages({ mailbox: 'INBOX', uids: [5], add: [bad] }))).code, JSON.stringify(bad)).toBe('INVALID_INPUT');
    }
    expect((await failure(s.labelMessages({ mailbox: 'INBOX', uids: [5], add: ['A'], remove: ['a'] }))).message).toMatch(/both added and removed/);
    expect((await failure(s.labelMessages({ mailbox: 'INBOX', uids: [5] }))).message).toMatch(/at least one label/);
    expect(srv.labelStores).toEqual([]);
  });

  it('refuses labels on a server without X-GM-EXT-1', async () => {
    const { s, srv } = await setup(['Receipts'], { uids: { INBOX: [5] } });
    const e = await failure(s.labelMessages({ mailbox: 'INBOX', uids: [5], add: ['Receipts'] }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/X-GM-EXT-1/);
    expect(srv.commands.some((c) => /X-GM-LABELS/.test(c))).toBe(false);
  });

  it('search results carry the labels, system labels first', async () => {
    const { s } = await gmail([], { uids: { INBOX: [5] }, labels: { 'INBOX/5': ['zeta', '\\Inbox', 'Alpha', '\\Important'] } });
    const r = await s.search({ mailbox: 'INBOX', limit: 5 });
    expect(r.messages[0]?.labels).toEqual(['Important', 'Inbox', 'Alpha', 'zeta']);
  });
});

describe('gmail_query (X-GM-RAW)', () => {
  it('is sent as X-GM-RAW on a Gmail server', async () => {
    const { s, srv } = await setup([], { caps: GMAIL_CAPS, uids: { INBOX: [5] } }, {}, GMAIL_FOLDERS);
    await s.search({ mailbox: 'INBOX', gmailQuery: 'has:attachment "big deal"', limit: 5 });
    expect(srv.commands.find((c) => /SEARCH/.test(c) && /X-GM-RAW/.test(c))).toContain('X-GM-RAW "has:attachment \\"big deal\\""');
  });

  it('is refused on other servers before anything is searched', async () => {
    const { s, srv } = await setup([], { uids: { INBOX: [5] } });
    const e = await failure(s.search({ mailbox: 'INBOX', gmailQuery: 'is:unread' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/gmail_query needs a Gmail server/);
    expect(srv.commands.some((c) => /SEARCH/.test(c))).toBe(false);
  });
});

describe('Gmail archive and permanent deletion', () => {
  const gmail = (opts: FakeOptions, env: Record<string, string> = {}) => setup(['Receipts'], { caps: GMAIL_CAPS, ...opts }, env, GMAIL_FOLDERS);

  it('archive_messages removes the Inbox label instead of moving', async () => {
    const { s, srv } = await gmail({ uids: { INBOX: [7, 8] }, labels: { 'INBOX/7': ['\\Inbox', 'Receipts'], 'INBOX/8': ['\\Inbox'] } });
    const r = await s.archiveMessages({ mailbox: 'INBOX', uids: [7] });
    expect(r).toMatchObject({ source: 'INBOX', destination: '[Gmail]/All Mail', moved: 1, not_found: [] });
    expect(r.warning).toMatch(/Inbox label was removed/);
    expect(r.warning).not.toMatch(/not in the inbox/);
    expect(srv.commands.some((c) => /UID (COPY|MOVE|EXPUNGE)/.test(c))).toBe(false);
    expect(srv.labelStores).toEqual([{ mailbox: 'INBOX', uids: [7], op: '-', items: [{ type: 'ATOM', value: '\\Inbox' }] }]);
    expect(srv.labelsOf('INBOX', 7)).toEqual(['Receipts']);
    expect(srv.uidsIn('INBOX')).toEqual([8]);
  });

  it('archive_messages from a label folder keeps the message there, and counts only messages that were in the inbox', async () => {
    const { s, srv } = await gmail({ uids: { Receipts: [3, 4] }, labels: { 'Receipts/3': ['Receipts', '\\Inbox'], 'Receipts/4': ['Receipts'] } });
    const r = await s.archiveMessages({ mailbox: 'Receipts', uids: [3, 4] });
    expect(r).toMatchObject({ moved: 1, destination: '[Gmail]/All Mail', not_found: [] });
    expect(r.warning).toMatch(/and in "Receipts" with the same UIDs\. 1 message\(s\) were not in the inbox, so nothing changed for them\./);
    expect(srv.uidsIn('Receipts')).toEqual([3, 4]);
    expect(srv.labelsOf('Receipts', 3)).toEqual(['Receipts']);
  });

  it('archive_messages from Spam or Trash moves to All Mail instead of removing a label', async () => {
    for (const box of ['[Gmail]/Spam', '[Gmail]/Trash']) {
      const { s, srv } = await gmail({ uids: { [box]: [9] }, labels: { [`${box}/9`]: [] } });
      const r = await s.archiveMessages({ mailbox: box, uids: [9] });
      expect(r, box).toMatchObject({ source: box, destination: '[Gmail]/All Mail', moved: 1 });
      expect(srv.labelStores, box).toEqual([]);
      expect(srv.commands.some((c) => c.includes('UID COPY 9 "[Gmail]/All Mail"')), box).toBe(true);
      expect(srv.uidsIn(box)).toEqual([]);
      await svc?.close();
      await srv.close();
      svc = undefined;
      server = undefined;
    }
  });

  it('delete_messages_permanently moves to Trash first, then expunges there', async () => {
    const { s, srv } = await gmail({ uids: { INBOX: [7, 8] } }, { MAIL_ALLOW_PERMANENT_DELETE: 'true' });
    const r = await s.deleteMessagesPermanently({ mailbox: 'INBOX', uids: [7, 99] });
    expect(r).toEqual({ mailbox: 'INBOX', deleted: 1, not_found: [99] });
    const writes = srv.commands.map((c) => c.replace(/^\S+ /, '')).filter((c) => /^(SELECT|UID (COPY|STORE|EXPUNGE))/.test(c));
    expect(writes).toEqual([
      'SELECT INBOX',
      'UID COPY 7 "[Gmail]/Trash"',
      'UID STORE 7 +FLAGS (\\Deleted)',
      'UID EXPUNGE 7',
      'SELECT "[Gmail]/Trash"',
      'UID STORE 101 +FLAGS (\\Deleted)',
      'UID EXPUNGE 101',
    ]);
    expect(srv.uidsIn('INBOX')).toEqual([8]);
    expect(srv.uidsIn('[Gmail]/Trash')).toEqual([]);
  });

  it('delete_messages_permanently in Trash expunges in place', async () => {
    const { s, srv } = await gmail({ uids: { '[Gmail]/Trash': [4] } }, { MAIL_ALLOW_PERMANENT_DELETE: 'true' });
    const r = await s.deleteMessagesPermanently({ mailbox: 'trash', uids: [4] });
    expect(r).toEqual({ mailbox: '[Gmail]/Trash', deleted: 1, not_found: [] });
    expect(srv.commands.some((c) => c.includes('UID COPY'))).toBe(false);
    expect(srv.uidsIn('[Gmail]/Trash')).toEqual([]);
  });

  it('without X-GM-EXT-1, permanent deletion expunges in place', async () => {
    const { s, srv } = await setup([], { uids: { INBOX: [7] } }, { MAIL_ALLOW_PERMANENT_DELETE: 'true' });
    expect(await s.deleteMessagesPermanently({ mailbox: 'INBOX', uids: [7] })).toEqual({ mailbox: 'INBOX', deleted: 1, not_found: [] });
    expect(srv.commands.some((c) => c.includes('UID COPY'))).toBe(false);
  });
});

describe('Gmail threads (X-GM-THRID)', () => {
  const gmailSetup = (opts: FakeOptions) => setup([], { caps: GMAIL_CAPS, ...opts }, {}, GMAIL_FOLDERS);

  it('get_thread searches All Mail for the seed\'s thread id', async () => {
    const { s, srv } = await gmailSetup({
      uids: { INBOX: [5], '[Gmail]/All Mail': [20, 21, 22] },
      threads: { 'INBOX/5': '1234567890', '[Gmail]/All Mail/20': '1234567890', '[Gmail]/All Mail/21': '999', '[Gmail]/All Mail/22': '1234567890' },
    });
    const r = await s.getThread({ mailbox: 'INBOX', uid: 5 });
    expect(r.mailboxes_searched).toEqual(['[Gmail]/All Mail']);
    expect(r.messages.map((m) => m.uid)).toEqual([20, 22]);
    expect(srv.commands.some((c) => /SEARCH .*X-GM-THRID 1234567890/.test(c))).toBe(true);
  });

  it('a seed in Trash or Spam falls back to header-based discovery', async () => {
    for (const box of ['[Gmail]/Trash', '[Gmail]/Spam']) {
      const { s, srv } = await gmailSetup({ uids: { [box]: [4], '[Gmail]/All Mail': [20] }, threads: { [`${box}/4`]: '777', '[Gmail]/All Mail/20': '777' } });
      const r = await s.getThread({ mailbox: box, uid: 4 });
      expect(r.mailboxes_searched, box).not.toEqual(['[Gmail]/All Mail']);
      expect(r.mailboxes_searched, box).toContain(box);
      expect(r.messages.map((m) => `${m.mailbox}/${m.uid}`), box).toEqual([`${box}/4`]);
      expect(srv.commands.some((c) => /X-GM-THRID/.test(c)), box).toBe(false);
      await svc?.close();
      await srv.close();
      svc = undefined;
      server = undefined;
    }
  });

  it('without X-GM-EXT-1 the thread is found from headers', async () => {
    const { s, srv } = await setup([], { uids: { INBOX: [5] } });
    const r = await s.getThread({ mailbox: 'INBOX', uid: 5 });
    expect(r.messages.map((m) => m.uid)).toEqual([5]);
    expect(srv.commands.some((c) => /X-GM-THRID/.test(c))).toBe(false);
  });
});
