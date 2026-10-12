/**
 * Gmail labels over IMAP (X-GM-EXT-1): reading them (X-GM-LABELS in FETCH) and changing them
 * (UID STORE +X-GM-LABELS / -X-GM-LABELS).
 *
 * Labels are written with our own command tokens, not imapflow's messageFlagsAdd(useLabels): that
 * sends each label as a bare ATOM, which breaks on spaces and would let a crafted label name (one
 * Claude copied out of an email, say) add arbitrary tokens to the command. User labels go out as
 * quoted IMAP strings in modified UTF-7 (RFC 3501 §5.1.3), the same encoding Gmail uses for label
 * folder names; the few system labels Gmail accepts here go out as their fixed backslash atoms.
 */
import type { ImapFlow } from 'imapflow';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';
import type { MailboxInfo } from './mailboxes.js';
import { validateUids, verifyUids } from './ops.js';
import { toSequenceSet } from './uids.js';

/** System labels that can be added or removed here (user-facing name -> X-GM-LABELS atom). */
export const SYSTEM_LABELS: Readonly<Record<string, string>> = {
  inbox: '\\Inbox',
  important: '\\Important',
  starred: '\\Starred',
};

/** System labels that have their own tool or cannot be set as labels. */
const RESERVED_LABELS: Readonly<Record<string, string>> = {
  sent: 'Sent is set by Gmail when mail is sent.',
  draft: 'Drafts are created with save_draft.',
  drafts: 'Drafts are created with save_draft.',
  trash: 'Use trash_messages to move mail to Trash.',
  spam: 'Spam cannot be set as a label here.',
  junk: 'Spam cannot be set as a label here.',
  chats: 'Chats cannot be set as a label.',
  'all mail': 'All Mail is not a label; every message not in Spam or Trash is in it.',
};

export const MAX_LABELS_PER_CALL = 20;
/** Gmail's own limit on a label name is 225 characters. */
export const MAX_LABEL_LENGTH = 225;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Modified UTF-7 (RFC 3501 §5.1.3), as used for mailbox names and Gmail labels. */
export function encodeModifiedUtf7(text: string): string {
  let out = '';
  let pending = '';
  const flush = (): void => {
    if (!pending) return;
    const utf16 = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) utf16.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    pending = '';
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else {
      pending += ch; // a surrogate pair stays two UTF-16 units, as the encoding requires
    }
  }
  flush();
  return out;
}

export function decodeModifiedUtf7(text: string): string {
  return text.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (b64 === '') return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s;
  });
}

/**
 * The X-GM-LABELS value a message necessarily has because it is in `mailboxPath`, or null for
 * folders that are not labels (All Mail, Sent Mail, Drafts, Spam, Trash). Gmail may leave the
 * selected folder's own label out of X-GM-LABELS, so it is added back wherever labels are read.
 */
export function implicitLabelOf(mailboxPath: string): string | null {
  if (mailboxPath.toUpperCase() === 'INBOX') return '\\Inbox';
  const system = /^\[(gmail|google mail)\]\/(.+)$/i.exec(mailboxPath);
  if (system) {
    const name = (system[2] ?? '').toLowerCase();
    if (name === 'starred') return '\\Starred';
    if (name === 'important') return '\\Important';
    return null;
  }
  return encodeModifiedUtf7(mailboxPath);
}

/** The message's labels plus the selected folder's own label (see implicitLabelOf). */
export function withImplicitLabel(labels: Set<string> | undefined, mailboxPath: string): Set<string> | undefined {
  if (!labels) return labels;
  const implicit = implicitLabelOf(mailboxPath);
  if (!implicit || [...labels].some((l) => l.toLowerCase() === implicit.toLowerCase())) return labels;
  return new Set([...labels, implicit]);
}

/** A label as shown to Claude: system labels without the backslash ("Inbox", "Important"), user labels decoded. */
export function displayLabel(raw: string): string {
  if (raw.startsWith('\\')) return raw.slice(1);
  return decodeModifiedUtf7(raw);
}

/** Sorted display labels of a message (system labels first). */
export function displayLabels(labels: Iterable<string> | undefined): string[] {
  if (!labels) return [];
  const all = [...labels];
  const system = all.filter((l) => l.startsWith('\\')).map(displayLabel).sort();
  const user = all.filter((l) => !l.startsWith('\\')).map(displayLabel).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return [...system, ...user];
}

export interface LabelToken {
  /** As the user gave it (trimmed). */
  name: string;
  /** Command token: a system atom or a quoted string. */
  token: { type: 'ATOM' | 'STRING'; value: string };
  /** The form Gmail reports back in X-GM-LABELS, for the read-back check. */
  reported: string;
}

/** Validate one label name and turn it into a STORE token. */
export function labelToken(input: string): LabelToken {
  const name = input.trim().replace(/^\\/, '');
  if (!name) throw new MailError('INVALID_INPUT', 'A label name is empty.');
  if (CONTROL.test(name)) throw new MailError('INVALID_INPUT', `Label "${name.slice(0, 80)}" contains line breaks or control characters.`);
  if (name.length > MAX_LABEL_LENGTH) throw new MailError('INVALID_INPUT', `Label "${name.slice(0, 80)}…" is longer than ${MAX_LABEL_LENGTH} characters.`);
  const key = name.toLowerCase();
  const system = SYSTEM_LABELS[key];
  if (system) return { name, token: { type: 'ATOM', value: system }, reported: system };
  const reserved = RESERVED_LABELS[key] ?? (/^\[(gmail|google mail)\]/i.test(name) ? 'Gmail system folders cannot be used as labels.' : undefined);
  if (reserved) throw new MailError('INVALID_INPUT', `"${name}" cannot be added or removed as a label. ${reserved}`);
  const encoded = encodeModifiedUtf7(name);
  return { name, token: { type: 'STRING', value: encoded }, reported: encoded };
}

export interface LabelRequest {
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
}

export interface LabelResult {
  mailbox: string;
  /** Messages found in the mailbox (the change was applied to all of them). */
  affected: number;
  /** Messages whose labels actually changed (an added label was missing or a removed one was set). */
  changed: number;
  not_found: number[];
  added: string[];
  removed: string[];
  /** Labels of each affected message afterwards (up to LABEL_DETAIL_MAX messages). */
  messages?: Array<{ uid: number; labels: string[] }>;
  /** Messages that are no longer in this mailbox because the label it shows was removed. */
  left_mailbox?: number[];
  /** UIDs where the read-back shows a change did not take effect, with the reason. */
  not_applied: Array<{ uid: number; reason: string }>;
  note?: string;
}

export const LABEL_DETAIL_MAX = 20;

type ExecFn = (command: string, attributes: unknown[], options?: unknown) => Promise<{ next: () => void }>;

async function storeLabels(client: ImapFlow, uids: readonly number[], op: '+' | '-', tokens: readonly LabelToken[]): Promise<void> {
  if (tokens.length === 0) return;
  // imapflow's exec is public at runtime but not in its type declarations.
  const exec = (client as unknown as { exec: ExecFn }).exec.bind(client);
  const response = await exec('UID STORE', [
    { type: 'SEQUENCE', value: toSequenceSet(uids) },
    { type: 'ATOM', value: `${op}X-GM-LABELS` },
    tokens.map((t) => t.token),
  ]);
  response.next();
}

/** Add and/or remove Gmail labels on messages of one mailbox, then read the labels back. */
export async function labelMessages(imap: ImapManager, mailbox: MailboxInfo, uidsIn: readonly number[], req: LabelRequest): Promise<LabelResult> {
  const uids = validateUids(uidsIn);
  const add = (req.add ?? []).map(labelToken);
  const remove = (req.remove ?? []).map(labelToken);
  if (add.length === 0 && remove.length === 0) throw new MailError('INVALID_INPUT', 'Give at least one label to add or remove.');
  if (add.length + remove.length > MAX_LABELS_PER_CALL) throw new MailError('INVALID_INPUT', `At most ${MAX_LABELS_PER_CALL} labels per call.`);
  const both = add.filter((a) => remove.some((r) => r.reported.toLowerCase() === a.reported.toLowerCase()));
  if (both.length) throw new MailError('INVALID_INPUT', `Label "${both[0]?.name}" is both added and removed.`);
  if (!(await imap.hasCapability('X-GM-EXT-1'))) {
    throw new MailError('INVALID_INPUT', 'Labels need a Gmail server (X-GM-EXT-1), and this server is not one. Use move_messages to file mail in folders instead.');
  }
  return imap.withMailbox(
    mailbox.path,
    async (client) => {
      const { found, notFound } = await verifyUids(client, uids);
      const base: LabelResult = { mailbox: mailbox.path, affected: found.length, changed: 0, not_found: notFound, added: add.map((t) => t.name), removed: remove.map((t) => t.name), not_applied: [] };
      if (found.length === 0) return base;
      const has = (labels: Set<string> | undefined, t: LabelToken): boolean => [...(labels ?? [])].some((l) => l.toLowerCase() === t.reported.toLowerCase());
      const before = await client.fetchAll(toSequenceSet(found), { uid: true, labels: true }, { uid: true });
      const labelsBefore = (m: (typeof before)[number]): Set<string> | undefined => withImplicitLabel(m.labels, mailbox.path);
      base.changed = before.filter((m) => add.some((t) => !has(labelsBefore(m), t)) || remove.some((t) => has(labelsBefore(m), t))).length;
      await storeLabels(client, found, '+', add);
      await storeLabels(client, found, '-', remove);
      const after = await client.fetchAll(toSequenceSet(found), { uid: true, labels: true }, { uid: true });
      const seen = new Set(after.map((m) => m.uid));
      const leftMailbox = found.filter((u) => !seen.has(u));
      for (const m of after) {
        const reasons: string[] = [];
        for (const t of add) if (!has(withImplicitLabel(m.labels, mailbox.path), t)) reasons.push(`"${t.name}" was not added`);
        for (const t of remove) if (has(m.labels, t)) reasons.push(`"${t.name}" is still set`);
        if (reasons.length) base.not_applied.push({ uid: m.uid, reason: reasons.join('; ') });
      }
      if (after.length <= LABEL_DETAIL_MAX) {
        base.messages = after.map((m) => ({ uid: m.uid, labels: displayLabels(withImplicitLabel(m.labels, mailbox.path)) })).sort((a, b) => a.uid - b.uid);
      }
      if (leftMailbox.length) {
        base.left_mailbox = leftMailbox;
        base.note = `${leftMailbox.length} message(s) left "${mailbox.path}" because the label it shows was removed; they are still in All Mail.`;
      }
      return base;
    },
    { readOnly: false, retry: false },
  );
}
