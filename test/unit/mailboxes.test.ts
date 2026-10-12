import type { ListResponse } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { Config } from '../../src/config.js';
import type { ImapManager } from '../../src/imap/client.js';
import {
  CREATE_NAMES,
  GMAIL_DEFAULT_PATHS,
  MailboxRegistry,
  SPECIAL_ALIASES,
  computeSpecialMap,
  isNotesMailbox,
  labelSpecials,
  resolveMailboxName,
  sortMailboxesForDisplay,
  toMailboxInfo,
  type MailboxInfo,
} from '../../src/imap/mailboxes.js';

function entry(path: string, opts: { flags?: string[]; specialUse?: string; source?: 'extension' | 'name'; messages?: number; unseen?: number; delimiter?: string } = {}): ListResponse {
  const delimiter = opts.delimiter ?? '/';
  const parts = path.split(delimiter);
  const e: ListResponse = {
    path,
    pathAsListed: path,
    name: parts[parts.length - 1] ?? path,
    delimiter,
    parent: parts.slice(0, -1),
    parentPath: parts.slice(0, -1).join(delimiter),
    flags: new Set(opts.flags ?? []),
    listed: true,
    subscribed: true,
    status: { path, messages: opts.messages ?? 0, unseen: opts.unseen ?? 0 },
  };
  if (opts.specialUse) {
    e.specialUse = opts.specialUse;
    e.specialUseSource = opts.source ?? 'extension';
  }
  return e;
}

/**
 * Gmail's listing as imapflow reports it when the server sends no SPECIAL-USE attributes: imapflow
 * guesses specialUse from names and, when several folders match one type, gives it to the first
 * candidate only, so user labels such as "Sent", "Bin", "Draft" and "Junk" get the guesses and
 * Gmail's real "[Gmail]/…" folders get nothing (and there is no \All flag either).
 */
function gmailNoSpecialUse(): MailboxInfo[] {
  return [
    entry('INBOX', { flags: ['\\HasNoChildren'], specialUse: '\\Inbox', messages: 10, unseen: 2 }),
    entry('[Gmail]', { flags: ['\\Noselect', '\\HasChildren'] }),
    entry('[Gmail]/All Mail'),
    entry('[Gmail]/Drafts'),
    entry('[Gmail]/Sent Mail'),
    entry('[Gmail]/Spam'),
    entry('[Gmail]/Starred'),
    entry('[Gmail]/Trash'),
    entry('Bin', { specialUse: '\\Trash', source: 'name' }),
    entry('Draft', { specialUse: '\\Drafts', source: 'name' }),
    entry('Junk', { specialUse: '\\Junk', source: 'name' }),
    entry('Notes'),
    entry('México'), // NFD, as created on a Mac
    entry('Work', { flags: ['\\Noselect', '\\HasChildren'] }),
    entry('Work/Reports'),
    entry('Personal/Reports'),
    entry('Sent', { specialUse: '\\Sent', source: 'name' }), // a user label named like a special folder
  ].map(toMailboxInfo);
}

/** Gmail's listing: SPECIAL-USE attributes, labels as folders, everything also in "[Gmail]/All Mail". */
function gmailLike(): ListResponse[] {
  return [
    entry('INBOX'),
    entry('Receipts'),
    entry('[Gmail]', { flags: ['\\Noselect', '\\HasChildren'] }),
    entry('[Gmail]/All Mail', { flags: ['\\All', '\\HasNoChildren'] }),
    entry('[Gmail]/Drafts', { flags: ['\\Drafts'], specialUse: '\\Drafts' }),
    entry('[Gmail]/Important', { flags: ['\\Important'] }),
    entry('[Gmail]/Sent Mail', { flags: ['\\Sent'], specialUse: '\\Sent' }),
    entry('[Gmail]/Spam', { flags: ['\\Junk'], specialUse: '\\Junk' }),
    entry('[Gmail]/Starred', { flags: ['\\Flagged'] }),
    entry('[Gmail]/Trash', { flags: ['\\Trash'], specialUse: '\\Trash' }),
  ];
}

const paths = (map: Record<string, MailboxInfo | null>): Record<string, string | null> => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v?.path ?? null]));

function resolve(input: string, list = gmailNoSpecialUse()): MailboxInfo {
  const { map } = computeSpecialMap(list, {});
  return resolveMailboxName(input, labelSpecials(list, map), map);
}

function errorOf(fn: () => unknown): MailError {
  try {
    fn();
  } catch (e) {
    return e as MailError;
  }
  throw new Error('expected a throw');
}

describe('special folders', () => {
  it('maps specials from real SPECIAL-USE attributes (Gmail), with All Mail as the archive', () => {
    const { map } = computeSpecialMap(gmailLike().map(toMailboxInfo), {});
    expect(paths(map)).toEqual({
      inbox: 'INBOX',
      sent: '[Gmail]/Sent Mail',
      trash: '[Gmail]/Trash',
      drafts: '[Gmail]/Drafts',
      junk: '[Gmail]/Spam',
      archive: '[Gmail]/All Mail',
    });
  });

  // imap-1 / tests-1: a name guess never beats Gmail's own folder paths.
  it("prefers Gmail's own paths over imapflow name guesses for user labels when SPECIAL-USE is missing", () => {
    const list = gmailNoSpecialUse();
    const { map } = computeSpecialMap(list, {});
    expect(paths(map)).toEqual({
      inbox: 'INBOX',
      sent: '[Gmail]/Sent Mail',
      trash: '[Gmail]/Trash',
      drafts: '[Gmail]/Drafts',
      junk: '[Gmail]/Spam',
      // No \All flag without SPECIAL-USE, and "[Gmail]/All Mail" is never taken by name.
      archive: null,
    });
    expect(list.find((m) => m.path === 'Sent')?.serverSpecialUseSource).toBe('name');
    expect(list.find((m) => m.path === 'Bin')?.serverSpecialUse).toBe('trash');
  });

  it('understands the "[Google Mail]" paths (UK/German accounts), including Bin', () => {
    const list = [
      entry('INBOX'),
      entry('[Google Mail]', { flags: ['\\Noselect', '\\HasChildren'] }),
      entry('[Google Mail]/All Mail'),
      entry('[Google Mail]/Bin'),
      entry('[Google Mail]/Drafts'),
      entry('[Google Mail]/Sent Mail'),
      entry('[Google Mail]/Spam'),
      entry('Sent Items', { specialUse: '\\Sent', source: 'name' }),
    ].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(paths(map)).toEqual({
      inbox: 'INBOX',
      sent: '[Google Mail]/Sent Mail',
      trash: '[Google Mail]/Bin',
      drafts: '[Google Mail]/Drafts',
      junk: '[Google Mail]/Spam',
      archive: null,
    });
    expect(computeSpecialMap([entry('INBOX'), entry('[Google Mail]/Trash')].map(toMailboxInfo), {}).map.trash?.path).toBe('[Google Mail]/Trash');
  });

  it('matches the Gmail paths case-insensitively, but only as the whole path', () => {
    const list = [entry('INBOX'), entry('[GMAIL]/SENT MAIL'), entry('[gmail]/trash'), entry('Old/[Gmail]/Drafts'), entry('Spam')].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('[GMAIL]/SENT MAIL');
    expect(map.trash?.path).toBe('[gmail]/trash');
    // A nested copy of a Gmail path, or a plain "Spam" label without a name guess, is a user folder.
    expect(map.drafts).toBeNull();
    expect(map.junk).toBeNull();
  });

  it('never uses an unselectable Gmail path', () => {
    const list = [entry('INBOX'), entry('[Gmail]/Trash', { flags: ['\\Noselect'] }), entry('Deleted', { specialUse: '\\Trash', source: 'name' })].map(toMailboxInfo);
    expect(computeSpecialMap(list, {}).map.trash?.path).toBe('Deleted');
  });

  it('trusts a real SPECIAL-USE attribute, ignores nested name guesses, and uses one folder for one kind only', () => {
    const list = [
      entry('INBOX'),
      entry('[Gmail]/Gesendet', { specialUse: '\\Sent', source: 'extension' }),
      entry('[Gmail]/Sent Mail'),
      entry('Old Mail', { flags: ['\\HasChildren'] }),
      entry('Old Mail/Trash', { specialUse: '\\Trash', source: 'name' }),
      entry('Sent Items', { specialUse: '\\Sent', source: 'name' }),
    ].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('[Gmail]/Gesendet');
    expect(map.trash).toBeNull();
    const guessOnly = computeSpecialMap([entry('INBOX'), entry('Sent Items', { specialUse: '\\Sent', source: 'name' })].map(toMailboxInfo), {});
    expect(guessOnly.map.sent?.path).toBe('Sent Items');
    const both = computeSpecialMap([entry('INBOX'), entry('Archive')].map(toMailboxInfo), { sent: 'Archive' });
    expect(both.map.sent?.path).toBe('Archive');
    expect(both.map.archive).toBeNull();
  });

  it('falls back to the Gmail default paths when special-use is missing entirely', () => {
    const list = [entry('INBOX'), entry('[Gmail]/Sent Mail'), entry('[Gmail]/Trash'), entry('[Gmail]/Drafts')].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('[Gmail]/Sent Mail');
    expect(map.trash?.path).toBe('[Gmail]/Trash');
    expect(map.drafts?.path).toBe('[Gmail]/Drafts');
    expect(map.archive).toBeNull();
    expect(map.junk).toBeNull();
  });

  it('env overrides win, and missing overrides are reported', () => {
    const { map, missingOverrides } = computeSpecialMap(gmailNoSpecialUse(), { sent: 'sent', archive: 'Old Archive' });
    expect(map.sent?.path).toBe('Sent');
    expect(map.archive).toBeNull();
    expect(missingOverrides).toEqual({ archive: 'Old Archive' });
  });
});

describe('name resolution', () => {
  it('prefers an exact path match', () => {
    expect(resolve('Sent').path).toBe('Sent');
    expect(resolve('[Gmail]/Sent Mail').path).toBe('[Gmail]/Sent Mail');
    expect(resolve('Junk').path).toBe('Junk');
  });

  it('understands aliases case-insensitively', () => {
    const cases: Record<string, string> = {
      inbox: 'INBOX',
      Inbox: 'INBOX',
      sent: '[Gmail]/Sent Mail',
      'Sent Mail': '[Gmail]/Sent Mail',
      'SENT ITEMS': '[Gmail]/Sent Mail',
      'sent messages': '[Gmail]/Sent Mail',
      trash: '[Gmail]/Trash',
      Deleted: '[Gmail]/Trash',
      bin: '[Gmail]/Trash',
      spam: '[Gmail]/Spam',
      junk: '[Gmail]/Spam',
      drafts: '[Gmail]/Drafts',
      // No archive folder here: "all mail" then finds "[Gmail]/All Mail" by its unique name.
      'all mail': '[Gmail]/All Mail',
    };
    for (const [input, expected] of Object.entries(cases)) expect(resolve(input).path, input).toBe(expected);
  });

  it('maps "archive" and "All Mail" to the \\All mailbox on Gmail', () => {
    const list = gmailLike().map(toMailboxInfo);
    expect(resolve('archive', list).path).toBe('[Gmail]/All Mail');
    expect(resolve('All Mail', list).path).toBe('[Gmail]/All Mail');
    expect(resolve('receipts', list).path).toBe('Receipts');
  });

  it('matches NFC input against NFD server names and returns the exact server path', () => {
    const found = resolve('México'.normalize('NFC'));
    expect(found.path).toBe('México');
    expect(resolve('MÉXICO').path).toBe('México');
  });

  it('matches case-folded paths and unique names', () => {
    expect(resolve('work/reports').path).toBe('Work/Reports');
    expect(resolve('notes').path).toBe('Notes');
    expect(resolve('starred').path).toBe('[Gmail]/Starred');
  });

  it('reports ambiguous names', () => {
    const e = errorOf(() => resolve('Reports'));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/ambiguous.*Work\/Reports.*Personal\/Reports/);
  });

  it('lists available mailboxes when nothing matches', () => {
    const e = errorOf(() => resolve('Receipts'));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('Available mailboxes: INBOX, [Gmail] (not selectable), [Gmail]/All Mail');
    expect(e.message).toContain('Work (not selectable)');
  });

  it('explains when an alias has no folder on this account', () => {
    const list = [entry('INBOX')].map(toMailboxInfo);
    const e = errorOf(() => resolve('archive', list));
    expect(e.message).toMatch(/no archive folder/);
  });

  it('maps "/" to another server delimiter', () => {
    const list = [entry('INBOX', { delimiter: '.' }), entry('Projects.Acme', { delimiter: '.' })].map(toMailboxInfo);
    expect(resolve('projects/acme', list).path).toBe('Projects.Acme');
  });
});

describe('listing helpers', () => {
  it('marks \\Noselect mailboxes and legacy Notes', () => {
    const list = gmailNoSpecialUse();
    expect(list.find((m) => m.path === 'Work')?.selectable).toBe(false);
    expect(list.find((m) => m.path === 'Work')?.total).toBeNull();
    expect(list.find((m) => m.path === '[Gmail]')?.selectable).toBe(false);
    expect(list.find((m) => m.path === 'INBOX')).toMatchObject({ total: 10, unread: 2 });
    expect(isNotesMailbox(list.find((m) => m.path === 'Notes') as MailboxInfo)).toBe(true);
    expect(isNotesMailbox(list.find((m) => m.path === '[Gmail]/Drafts') as MailboxInfo)).toBe(false);
  });

  it('orders INBOX, then specials, then the rest alphabetically', () => {
    const list = gmailLike().map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    const sorted = sortMailboxesForDisplay(labelSpecials(list, map)).map((m) => m.path);
    expect(sorted.slice(0, 6)).toEqual(['INBOX', '[Gmail]/Drafts', '[Gmail]/Sent Mail', '[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash']);
    expect(sorted.slice(6)).toEqual(['[Gmail]', '[Gmail]/Important', '[Gmail]/Starred', 'Receipts']);
  });

  it('sorts user labels after the special folders even when a label is named like one', () => {
    const list = gmailNoSpecialUse();
    const { map } = computeSpecialMap(list, {});
    const sorted = sortMailboxesForDisplay(labelSpecials(list, map)).map((m) => m.path);
    expect(sorted.slice(0, 5)).toEqual(['INBOX', '[Gmail]/Drafts', '[Gmail]/Sent Mail', '[Gmail]/Spam', '[Gmail]/Trash']);
    expect(sorted.indexOf('Sent')).toBeGreaterThan(sorted.indexOf('Bin'));
    expect(sorted.slice(5)).toContain('Junk');
  });
});

// imap-8 / imap-5: the registry's two caches and refresh generations.
describe('MailboxRegistry', () => {
  function registryWith(listImpl: (opts?: { statusQuery?: unknown }) => Promise<ListResponse[]>) {
    const calls: Array<{ status: boolean }> = [];
    const imap = {
      onMailboxMissing: undefined as undefined | (() => void),
      run: <T>(fn: (c: unknown) => Promise<T>) =>
        fn({
          list: (opts?: { statusQuery?: unknown }) => {
            calls.push({ status: !!opts?.statusQuery });
            return listImpl(opts);
          },
        }),
    };
    const config = { mailboxOverrides: {} } as unknown as Config;
    return { reg: new MailboxRegistry(imap as unknown as ImapManager, config), calls, imap };
  }

  it('a refresh never returns a load that started before the change', async () => {
    let folders = ['INBOX', 'Drafts'];
    let releaseFirst: (() => void) | undefined;
    let n = 0;
    const { reg } = registryWith(async () => {
      const snapshot = folders.map((f) => entry(f));
      if (n++ === 0) await new Promise<void>((r) => (releaseFirst = r));
      return snapshot;
    });
    const first = reg.list();
    await new Promise((r) => setTimeout(r, 10));
    folders = ['INBOX', 'Drafts', 'Created Just Now'];
    const refreshed = reg.list({ refresh: true });
    releaseFirst?.();
    expect((await refreshed).map((m) => m.path)).toContain('Created Just Now');
    expect((await first).map((m) => m.path)).not.toContain('Created Just Now');
    // The stale load was not cached either.
    expect((await reg.list()).map((m) => m.path)).toContain('Created Just Now');
  });

  it('loads names without STATUS; counts only on request, and invalidateCounts keeps the names', async () => {
    const { reg, calls } = registryWith(async (opts) => ['INBOX', 'Drafts'].map((f) => entry(f, opts?.statusQuery ? { messages: 5, unseen: 1 } : {})));
    const names = await reg.list();
    expect(names.every((m) => m.total === null || m.total === 0 || m.total === undefined || typeof m.total === 'number')).toBe(true);
    expect(calls).toEqual([{ status: false }]);
    await reg.resolve('drafts');
    expect(calls).toHaveLength(1);
    const withCounts = await reg.list({ counts: true });
    expect(withCounts.find((m) => m.path === 'INBOX')).toMatchObject({ total: 5, unread: 1 });
    expect(calls).toEqual([{ status: false }, { status: true }]);
    reg.invalidateCounts();
    await reg.resolve('inbox');
    expect(calls).toHaveLength(2);
    await reg.list({ counts: true });
    expect(calls).toHaveLength(3);
  });

  it('drops the folder list when a mailbox turned out to be missing', async () => {
    const { reg, calls, imap } = registryWith(async () => [entry('INBOX')]);
    await reg.list();
    imap.onMailboxMissing?.();
    await reg.list();
    expect(calls).toHaveLength(2);
  });
});

describe('Gmail (\\All mailbox)', () => {
  it('archives to All Mail instead of creating an Archive label', () => {
    const { map } = computeSpecialMap(gmailLike().map(toMailboxInfo), {});
    expect(map.archive?.path).toBe('[Gmail]/All Mail');
    expect(map.sent?.path).toBe('[Gmail]/Sent Mail');
    expect(map.trash?.path).toBe('[Gmail]/Trash');
  });

  it('All Mail beats a user label named "Archive" (even when imapflow guesses \\Archive for it); an override still wins', () => {
    const withArchive = computeSpecialMap([...gmailLike(), entry('Archive', { specialUse: '\\Archive', source: 'name' })].map(toMailboxInfo), {});
    expect(withArchive.map.archive?.path).toBe('[Gmail]/All Mail');
    // A real \\Archive attribute from the server (not a name guess) still wins.
    const real = computeSpecialMap([...gmailLike(), entry('Archive', { specialUse: '\\Archive', source: 'extension' })].map(toMailboxInfo), {});
    expect(real.map.archive?.path).toBe('Archive');
    // A folder merely named "Archive" is not taken by name: Gmail's own paths are the only defaults.
    const plain = computeSpecialMap([...gmailLike(), entry('Archive')].map(toMailboxInfo), {});
    expect(plain.map.archive?.path).toBe('[Gmail]/All Mail');
    const overridden = computeSpecialMap(gmailLike().map(toMailboxInfo), { archive: 'Receipts' });
    expect(overridden.map.archive?.path).toBe('Receipts');
  });

  it('all_mailboxes searches only All Mail, so a message is not listed once per label', async () => {
    const imap = { run: <T>(fn: (c: unknown) => Promise<T>) => fn({ list: async () => gmailLike() }) };
    const reg = new MailboxRegistry(imap as unknown as ImapManager, { mailboxOverrides: {} } as unknown as Config);
    expect((await reg.searchableMailboxes()).map((m) => m.path)).toEqual(['[Gmail]/All Mail']);
    expect((await reg.excludedFromAllMailboxes()).map((m) => m.path).sort()).toEqual(['[Gmail]/Spam', '[Gmail]/Trash']);
  });

  it('without an \\All mailbox every folder but Trash, Junk and Notes is searched', async () => {
    const imap = { run: <T>(fn: (c: unknown) => Promise<T>) => fn({ list: async () => [entry('INBOX'), entry('Archive'), entry('Notes'), entry('Trash', { specialUse: '\\Trash', source: 'name' })] }) };
    const reg = new MailboxRegistry(imap as unknown as ImapManager, { mailboxOverrides: {} } as unknown as Config);
    expect((await reg.searchableMailboxes()).map((m) => m.path)).toEqual(['INBOX', 'Archive']);
  });

  it('archive_messages never creates an "Archive" label on Gmail; elsewhere a missing Archive is created as "Archive"', async () => {
    function registry(initial: ListResponse[]) {
      let folders = initial;
      const created: string[] = [];
      const imap = {
        run: <T>(fn: (c: unknown) => Promise<T>) =>
          fn({
            list: async () => folders,
            mailboxCreate: async (name: string) => {
              created.push(name);
              // imapflow names a new top-level "Archive" \\Archive from its name.
              folders = [...folders, entry(name, { specialUse: '\\Archive', source: 'name' })];
              return { path: name, created: true };
            },
          }),
      };
      return { reg: new MailboxRegistry(imap as unknown as ImapManager, { mailboxOverrides: {} } as unknown as Config), created };
    }
    const gmail = registry(gmailLike());
    expect((await gmail.reg.resolveSpecial('archive', { create: true }))?.path).toBe('[Gmail]/All Mail');
    expect(gmail.created).toEqual([]);
    const other = registry([entry('INBOX'), entry('Sent', { specialUse: '\\Sent', source: 'extension' })]);
    expect(await other.reg.resolveSpecial('archive')).toBeNull();
    expect(other.created).toEqual([]);
    expect(CREATE_NAMES.archive).toBe('Archive');
    expect((await other.reg.resolveSpecial('archive', { create: true }))?.path).toBe('Archive');
    expect(other.created).toEqual(['Archive']);
  });

  it('exposes the Gmail default paths for every special folder but Archive', () => {
    expect(GMAIL_DEFAULT_PATHS).toEqual({
      sent: ['[Gmail]/Sent Mail', '[Google Mail]/Sent Mail'],
      trash: ['[Gmail]/Trash', '[Google Mail]/Bin', '[Google Mail]/Trash'],
      drafts: ['[Gmail]/Drafts', '[Google Mail]/Drafts'],
      junk: ['[Gmail]/Spam', '[Google Mail]/Spam'],
    });
    expect(SPECIAL_ALIASES['sent mail']).toBe('sent');
    expect(SPECIAL_ALIASES['all mail']).toBe('archive');
  });
});
