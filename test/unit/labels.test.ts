/**
 * Gmail labels (src/imap/labels.ts): modified UTF-7, display names and the STORE tokens. The
 * command itself (UID STORE ... X-GM-LABELS) is tested against the fake server in fake-imap.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { MAX_LABEL_LENGTH, SYSTEM_LABELS, decodeModifiedUtf7, displayLabel, displayLabels, encodeModifiedUtf7, implicitLabelOf, labelToken, withImplicitLabel } from '../../src/imap/labels.js';

function refusal(input: string): MailError {
  try {
    labelToken(input);
  } catch (e) {
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).code).toBe('INVALID_INPUT');
    return e as MailError;
  }
  throw new Error(`expected "${input}" to be refused`);
}

describe('modified UTF-7 (RFC 3501 §5.1.3)', () => {
  it('leaves printable ASCII alone and escapes "&" as "&-"', () => {
    expect(encodeModifiedUtf7('Receipts/2026 (Q1)')).toBe('Receipts/2026 (Q1)');
    expect(encodeModifiedUtf7('R&D')).toBe('R&-D');
    expect(encodeModifiedUtf7('&&')).toBe('&-&-');
    expect(decodeModifiedUtf7('R&-D')).toBe('R&D');
  });

  it('encodes non-ASCII runs as base64 of UTF-16BE with "," for "/" and no padding', () => {
    // RFC 3501's own example.
    expect(encodeModifiedUtf7('~peter/mail/台北/日本語')).toBe('~peter/mail/&U,BTFw-/&ZeVnLIqe-');
    expect(encodeModifiedUtf7('Café')).toBe('Caf&AOk-');
    expect(encodeModifiedUtf7('Grüße')).toBe('Gr&APwA3w-e');
    expect(encodeModifiedUtf7('Привет')).toBe('&BB8EQAQ4BDIENQRC-');
    expect(decodeModifiedUtf7('~peter/mail/&U,BTFw-/&ZeVnLIqe-')).toBe('~peter/mail/台北/日本語');
  });

  it('keeps emoji as a surrogate pair inside one base64 run', () => {
    const enc = encodeModifiedUtf7('Fun 🎉 stuff');
    expect(enc).toBe('Fun &2DzfiQ- stuff');
    expect(decodeModifiedUtf7(enc)).toBe('Fun 🎉 stuff');
    expect(encodeModifiedUtf7('🎉🎉')).toBe('&2Dzfidg834k-');
  });

  it('encodes control characters and DEL rather than passing them through', () => {
    expect(encodeModifiedUtf7('a\tb')).toBe('a&AAk-b');
    expect(encodeModifiedUtf7('\u007f')).toBe('&AH8-');
  });

  it('round-trips mixed text', () => {
    for (const s of ['', 'plain', 'R&D & Ops', 'Café & Bar', 'naïve/Ünïcödé', '日本語 & English', '👩‍👩‍👧 family', 'a&b&c', 'x) \\Deleted', 'Say "hi"', 'tab\there']) {
      expect(decodeModifiedUtf7(encodeModifiedUtf7(s)), s).toBe(s);
    }
  });
});

describe('display labels', () => {
  it('drops the backslash of system labels and decodes user labels', () => {
    expect(displayLabel('\\Inbox')).toBe('Inbox');
    expect(displayLabel('\\Important')).toBe('Important');
    expect(displayLabel('Caf&AOk-')).toBe('Café');
    expect(displayLabel('R&-D')).toBe('R&D');
  });

  it('lists system labels first (sorted), then user labels case-insensitively', () => {
    expect(displayLabels(['zeta', '\\Starred', 'Alpha', '\\Inbox', 'beta', '\\Important', '&AMk-t&AOk-'])).toEqual(['Important', 'Inbox', 'Starred', 'Alpha', 'beta', 'Été', 'zeta']);
    expect(displayLabels(new Set(['b', 'A']))).toEqual(['A', 'b']);
    expect(displayLabels(undefined)).toEqual([]);
    expect(displayLabels([])).toEqual([]);
  });
});

describe('labelToken', () => {
  it('maps inbox, important and starred to their system atoms, whatever the case or a leading backslash', () => {
    expect(SYSTEM_LABELS).toEqual({ inbox: '\\Inbox', important: '\\Important', starred: '\\Starred' });
    expect(labelToken('Inbox')).toEqual({ name: 'Inbox', token: { type: 'ATOM', value: '\\Inbox' }, reported: '\\Inbox' });
    expect(labelToken(' IMPORTANT ')).toEqual({ name: 'IMPORTANT', token: { type: 'ATOM', value: '\\Important' }, reported: '\\Important' });
    expect(labelToken('\\Starred')).toEqual({ name: 'Starred', token: { type: 'ATOM', value: '\\Starred' }, reported: '\\Starred' });
  });

  it('sends user labels as one quoted STRING in modified UTF-7', () => {
    expect(labelToken('Receipts')).toEqual({ name: 'Receipts', token: { type: 'STRING', value: 'Receipts' }, reported: 'Receipts' });
    expect(labelToken('Clients/Acme Inc')).toEqual({ name: 'Clients/Acme Inc', token: { type: 'STRING', value: 'Clients/Acme Inc' }, reported: 'Clients/Acme Inc' });
    expect(labelToken('Café & Bar').token).toEqual({ type: 'STRING', value: 'Caf&AOk- &- Bar' });
    // IMAP syntax inside a label stays data: one STRING, never extra atoms or flags.
    expect(labelToken('x) \\Deleted').token).toEqual({ type: 'STRING', value: 'x) \\Deleted' });
    expect(labelToken('a" "b').token).toEqual({ type: 'STRING', value: 'a" "b' });
    // A leading backslash is dropped, so "\Deleted" cannot become a system atom.
    expect(labelToken('\\Deleted').token).toEqual({ type: 'STRING', value: 'Deleted' });
  });

  it('refuses Gmail system folders and labels that have their own tool', () => {
    for (const name of ['Sent', 'draft', 'Drafts', 'TRASH', 'Spam', 'junk', 'Chats', 'All Mail', '\\Trash']) {
      expect(refusal(name).message, name).toMatch(/cannot be added or removed as a label/);
    }
    expect(refusal('Trash').message).toMatch(/trash_messages/);
    expect(refusal('[Gmail]/Sent Mail').message).toMatch(/Gmail system folders cannot be used as labels/);
    expect(refusal('[Google Mail]/Bin').message).toMatch(/Gmail system folders/);
    expect(refusal('[gmail]').message).toMatch(/Gmail system folders/);
    // Only the exact reserved names: a label that merely contains one is fine.
    expect(labelToken('Sent by clients').token.type).toBe('STRING');
    expect(labelToken('Old [Gmail] stuff').token.type).toBe('STRING');
  });

  it('refuses empty labels, control characters and labels over 225 characters', () => {
    expect(refusal('').message).toMatch(/empty/);
    expect(refusal('   ').message).toMatch(/empty/);
    expect(refusal('\\').message).toMatch(/empty/);
    expect(refusal('a\r\nA1 LOGOUT').message).toMatch(/control characters/);
    expect(refusal('tab\there').message).toMatch(/control characters/);
    expect(refusal('nul\u0000').message).toMatch(/control characters/);
    expect(refusal('del\u007f').message).toMatch(/control characters/);
    expect(MAX_LABEL_LENGTH).toBe(225);
    expect(labelToken('x'.repeat(225)).token.value).toHaveLength(225);
    expect(refusal('x'.repeat(226)).message).toMatch(/longer than 225 characters/);
  });
});

describe('implicit label of the selected folder', () => {
  it('maps INBOX, Starred, Important and user labels; system folders are not labels', () => {
    expect(implicitLabelOf('INBOX')).toBe('\\Inbox');
    expect(implicitLabelOf('[Gmail]/Starred')).toBe('\\Starred');
    expect(implicitLabelOf('[Google Mail]/Important')).toBe('\\Important');
    for (const p of ['[Gmail]/All Mail', '[Gmail]/Sent Mail', '[Gmail]/Trash', '[Google Mail]/Bin', '[Gmail]/Spam', '[Gmail]/Drafts']) expect(implicitLabelOf(p)).toBeNull();
    expect(implicitLabelOf('Clients/Café')).toBe('Clients/Caf&AOk-');
  });

  it('adds the folder label when Gmail leaves it out, without duplicating it', () => {
    expect([...(withImplicitLabel(new Set(['\\Important']), 'INBOX') ?? [])]).toEqual(['\\Important', '\\Inbox']);
    expect([...(withImplicitLabel(new Set(['\\Inbox']), 'INBOX') ?? [])]).toEqual(['\\Inbox']);
    expect(withImplicitLabel(undefined, 'INBOX')).toBeUndefined(); // not a Gmail server: no labels at all
    expect([...(withImplicitLabel(new Set<string>(), '[Gmail]/All Mail') ?? [])]).toEqual([]);
  });
});
