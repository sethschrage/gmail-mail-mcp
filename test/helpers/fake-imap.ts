/**
 * Minimal scripted IMAP server for behaviour the Dovecot profiles cannot reproduce. By default it
 * advertises no MOVE, no SPECIAL-USE and no LIST-STATUS (so imapflow guesses special folders from
 * names), and lists an arbitrary folder set. It speaks just enough IMAP for imapflow: LOGIN,
 * LIST/LSUB, STATUS, SELECT/EXAMINE, UID SEARCH, (UID) FETCH of UID/FLAGS/INTERNALDATE, UID COPY,
 * UID STORE, UID EXPUNGE and NOOP. Used for name-guess conflicts, ghost \Deleted UIDs, failures
 * between COPY and EXPUNGE, commands that never get an answer and login refusals with response codes.
 *
 * With X-GM-EXT-1 in `caps` (see GMAIL_CAPS) it also behaves like Gmail for labels: FETCH responses
 * carry X-GM-LABELS, and UID STORE +X-GM-LABELS / -X-GM-LABELS changes them. Like real Gmail
 * (verified live), a STORE that removes the selected folder's own label (\Inbox in INBOX) is
 * ignored: that label goes away only when the message is moved or expunged out of the folder.
 * X-GM-THRID is reported in FETCH responses and understood by SEARCH.
 * No TLS: clients must set IMAP_ALLOW_PLAINTEXT=true (or expect STARTTLS to be required).
 */
import net from 'node:net';

export interface FakeFolder {
  path: string;
  flags?: string[];
}

export interface FakeServer {
  port: number;
  /** Every command line received, in order. */
  commands: string[];
  /** Number of LOGIN / AUTHENTICATE commands received. */
  logins(): number;
  /** Current flags of a message. */
  flagsOf(mailbox: string, uid: number): string[];
  /** Current X-GM-LABELS of a message (system labels as "\\Inbox", user labels as sent on the wire, unquoted). */
  labelsOf(mailbox: string, uid: number): string[];
  /** UIDs currently in a mailbox. */
  uidsIn(mailbox: string): number[];
  /** Every X-GM-LABELS STORE, with the list items as the server parsed them. */
  labelStores: Array<{ mailbox: string; uids: number[]; op: '+' | '-'; items: Array<{ type: 'ATOM' | 'STRING'; value: string }> }>;
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Messages per mailbox (UIDs, ascending). */
  uids?: Record<string, number[]>;
  /** Initial flags per "mailbox/uid" key. */
  flags?: Record<string, string[]>;
  /** Reply NO to UID EXPUNGE (a transient failure after COPY + STORE succeeded). */
  failExpunge?: boolean;
  /** Reply NO to UID STORE (a failure right after COPY). */
  failStore?: boolean;
  /** Reply NO to SEARCH commands whose arguments match (e.g. /^DELETED$/). */
  failSearch?: RegExp;
  /** Override the advertised capabilities. */
  caps?: string;
  /** "Ghost" UIDs: returned by UID SEARCH DELETED (as iCloud did) but invisible to FETCH/EXISTS. */
  ghostDeleted?: number[];
  /** Commands (e.g. "UID SEARCH") that never get an answer, like a socket that died mid-command. */
  hangOn?: string[];
  /** Answer LOGIN with this (e.g. 'NO [UNAVAILABLE] Maximum number of connections'); default OK. */
  loginResponse?: string;
  /** Initial X-GM-LABELS per "mailbox/uid" key (only reported when caps include X-GM-EXT-1). */
  labels?: Record<string, string[]>;
  /** X-GM-THRID per "mailbox/uid" key (only reported, and searchable, with X-GM-EXT-1). */
  threads?: Record<string, string>;
}

const DEFAULT_CAPS = 'IMAP4rev1 LITERAL+ UIDPLUS IDLE QUOTA';
/** Gmail's label extension on top of the defaults (still no MOVE, so moves are COPY + EXPUNGE). */
export const GMAIL_CAPS = 'IMAP4rev1 LITERAL+ UIDPLUS IDLE QUOTA X-GM-EXT-1 SPECIAL-USE';

/** Gmail's own folders, with their SPECIAL-USE attributes. */
export const GMAIL_FOLDERS: FakeFolder[] = [
  { path: '[Gmail]', flags: ['\\Noselect'] },
  { path: '[Gmail]/All Mail', flags: ['\\All'] },
  { path: '[Gmail]/Drafts', flags: ['\\Drafts'] },
  { path: '[Gmail]/Sent Mail', flags: ['\\Sent'] },
  { path: '[Gmail]/Spam', flags: ['\\Junk'] },
  { path: '[Gmail]/Trash', flags: ['\\Trash'] },
];

/**
 * Parse a parenthesised IMAP list of atoms and quoted strings starting at `text[start] === '('`.
 * Returns the items and the index after the closing parenthesis; a ")" inside a quoted string is data.
 */
export function parseImapList(text: string, start: number): { items: Array<{ type: 'ATOM' | 'STRING'; value: string }>; end: number } {
  if (text[start] !== '(') throw new Error(`expected "(" at ${start} in ${text}`);
  const items: Array<{ type: 'ATOM' | 'STRING'; value: string }> = [];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') {
      i++;
    } else if (c === ')') {
      return { items, end: i + 1 };
    } else if (c === '"') {
      let value = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        value += text[i] ?? '';
        i++;
      }
      if (text[i] !== '"') throw new Error(`unterminated string in ${text}`);
      i++;
      items.push({ type: 'STRING', value });
    } else {
      let value = '';
      while (i < text.length && text[i] !== ' ' && text[i] !== ')') value += text[i++];
      items.push({ type: 'ATOM', value });
    }
  }
  throw new Error(`unterminated list in ${text}`);
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Expand an IMAP sequence set ("1:3,7") against the known values (for "*" and open ranges). */
function expandSet(set: string, known: readonly number[]): number[] {
  const max = known.length ? Math.max(...known) : 0;
  const out = new Set<number>();
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    for (const k of known) if (k >= Math.min(lo, hi) && k <= Math.max(lo, hi)) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

export async function startFakeImap(folders: FakeFolder[], opts: FakeOptions = {}): Promise<FakeServer> {
  const CAPS = opts.caps ?? DEFAULT_CAPS;
  const gmail = CAPS.split(/\s+/).includes('X-GM-EXT-1');
  const labels = new Map<string, string[]>(Object.entries(opts.labels ?? {}).map(([k, v]) => [k, [...v]]));
  const labelList = (mb: string, uid: number): string[] => {
    const key = `${mb}/${uid}`;
    let l = labels.get(key);
    if (!l) {
      l = [];
      labels.set(key, l);
    }
    return l;
  };
  const labelStores: FakeServer['labelStores'] = [];
  const uids: Record<string, number[]> = Object.fromEntries(Object.entries(opts.uids ?? {}).map(([k, v]) => [k, [...v]]));
  const flags = new Map<string, Set<string>>(Object.entries(opts.flags ?? {}).map(([k, v]) => [k, new Set(v)]));
  const flagSet = (mb: string, uid: number): Set<string> => {
    const key = `${mb}/${uid}`;
    let s = flags.get(key);
    if (!s) {
      s = new Set();
      flags.set(key, s);
    }
    return s;
  };
  const commands: string[] = [];
  let loginCount = 0;
  const sockets = new Set<net.Socket>();
  const unq = (a: string): string => a.trim().replace(/^"(.*)"$/, '$1');

  const server = net.createServer((sock) => {
    sockets.add(sock);
    let selected = '';
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    sock.write(`* OK [CAPABILITY ${CAPS}] fake IMAP ready\r\n`);
    let buf = '';
    const w = (s: string): void => {
      if (!sock.destroyed) sock.write(`${s}\r\n`);
    };
    const thread = (uid: number): string | undefined => opts.threads?.[`${selected}/${uid}`];
    const gmLabels = (uid: number): string => {
      if (!gmail) return '';
      const thr = thread(uid);
      return ` X-GM-LABELS (${labelList(selected, uid).map((l) => (l.startsWith('\\') ? l : quote(l))).join(' ')})${thr ? ` X-GM-THRID ${thr}` : ''}`;
    };
    const fetchLine = (seq: number, uid: number): string =>
      `* ${seq} FETCH (UID ${uid} FLAGS (${[...flagSet(selected, uid)].join(' ')}) INTERNALDATE "01-Jan-2026 00:00:${String(uid % 60).padStart(2, '0')} +0000"${gmLabels(uid)})`;
    const handle = (line: string): void => {
      commands.push(line);
      const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return;
      const [, tag, cmdRaw, rest = ''] = m;
      let cmd = (cmdRaw ?? '').toUpperCase();
      let args = rest;
      if (cmd === 'UID') {
        const m2 = /^(\S+)\s*(.*)$/.exec(rest);
        cmd = `UID ${(m2?.[1] ?? '').toUpperCase()}`;
        args = m2?.[2] ?? '';
      }
      if (opts.hangOn?.includes(cmd)) return;
      const have = uids[selected] ?? [];
      switch (cmd) {
        case 'CAPABILITY':
          w(`* CAPABILITY ${CAPS}`);
          w(`${tag} OK done`);
          return;
        case 'LOGIN':
        case 'AUTHENTICATE':
          loginCount++;
          if (opts.loginResponse) w(`${tag} ${opts.loginResponse}`);
          else w(`${tag} OK [CAPABILITY ${CAPS}] logged in`);
          return;
        case 'LIST':
        case 'LSUB':
          if (/^""\s+""$/.test(args.trim())) {
            w(`* ${cmd} (\\Noselect) "/" ""`);
            w(`${tag} OK ${cmd} done`);
            return;
          }
          w(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`);
          for (const f of folders) w(`* ${cmd} (${['\\HasNoChildren', ...(f.flags ?? [])].join(' ')}) "/" ${quote(f.path)}`);
          w(`${tag} OK ${cmd} done`);
          return;
        case 'STATUS': {
          const nm = /^("(?:[^"\\]|\\.)*"|\S+)/.exec(args);
          const box = unq(nm?.[1] ?? 'INBOX');
          w(`* STATUS ${nm?.[1] ?? '"INBOX"'} (MESSAGES ${(uids[box] ?? []).length} UNSEEN 0)`);
          w(`${tag} OK status done`);
          return;
        }
        case 'SELECT':
        case 'EXAMINE':
          selected = unq(args.split(/\s+\(/)[0] ?? args);
          w('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
          w('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok');
          w(`* ${(uids[selected] ?? []).length} EXISTS`);
          w('* 0 RECENT');
          w('* OK [UIDVALIDITY 1] ok');
          w(`* OK [UIDNEXT ${Math.max(0, ...(uids[selected] ?? [])) + 1}] ok`);
          w(`${tag} OK [${cmd === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] done`);
          return;
        case 'UID SEARCH':
        case 'SEARCH': {
          if (opts.failSearch?.test(args)) {
            w(`${tag} NO [UNAVAILABLE] search failed`);
            return;
          }
          const m3 = /UID\s+(\S+)/i.exec(args);
          const wanted = m3 ? expandSet(m3[1] ?? '', have) : have;
          const deletedQuery = /(^|\s)DELETED/i.test(args) && !/UNDELETED/i.test(args);
          let hits: number[];
          if (deletedQuery) hits = [...have.filter((u) => flagSet(selected, u).has('\\Deleted')), ...(opts.ghostDeleted ?? [])];
          else hits = wanted.filter((u) => !(/UNDELETED/i.test(args) && flagSet(selected, u).has('\\Deleted')));
          const thrid = gmail ? /X-GM-THRID\s+"?(\d+)"?/i.exec(args)?.[1] : undefined;
          if (thrid) hits = hits.filter((u) => thread(u) === thrid);
          w(`* SEARCH${hits.length ? ` ${hits.join(' ')}` : ''}`);
          w(`${tag} OK search done`);
          return;
        }
        case 'UID FETCH': {
          const set = args.split(/\s+/)[0] ?? '';
          for (const u of expandSet(set, have)) w(fetchLine(have.indexOf(u) + 1, u));
          w(`${tag} OK fetch done`);
          return;
        }
        case 'FETCH': {
          const set = args.split(/\s+/)[0] ?? '';
          const seqs = expandSet(
            set,
            have.map((_, i) => i + 1),
          );
          for (const s of seqs) {
            const u = have[s - 1];
            if (u !== undefined) w(fetchLine(s, u));
          }
          w(`${tag} OK fetch done`);
          return;
        }
        case 'UID COPY': {
          const src = args.split(/\s+/)[0] ?? '';
          const dest = unq(args.slice(src.length));
          const copied = expandSet(src, have);
          const target = (uids[dest] ??= []);
          const newUids = copied.map(() => {
            const n = Math.max(100, ...target) + 1;
            target.push(n);
            return n;
          });
          w(`${tag} OK [COPYUID 1 ${copied.join(',')} ${newUids.join(',')}] copied`);
          return;
        }
        case 'UID STORE': {
          if (opts.failStore) {
            w(`${tag} NO [UNAVAILABLE] Server busy, try again later`);
            return;
          }
          const set = args.split(/\s+/)[0] ?? '';
          const gm = /^\S+\s+([+-])X-GM-LABELS\s+/i.exec(args);
          if (gm) {
            if (!gmail) {
              w(`${tag} BAD unknown STORE item`);
              return;
            }
            const op = gm[1] as '+' | '-';
            const { items, end } = parseImapList(args, gm[0].length);
            if (args.slice(end).trim() !== '') {
              w(`${tag} BAD trailing data after the label list`);
              return;
            }
            const targets = expandSet(set, have);
            labelStores.push({ mailbox: selected, uids: targets, op, items });
            const shown = selected.toUpperCase() === 'INBOX' ? '\\Inbox' : selected;
            for (const u of targets) {
              const list = labelList(selected, u);
              for (const it of items) {
                const at = list.findIndex((l) => l.toLowerCase() === it.value.toLowerCase());
                if (op === '+' && at < 0) list.push(it.value);
                // Gmail ignores removing the open folder's own label with STORE.
                if (op === '-' && at >= 0 && it.value.toLowerCase() !== shown.toLowerCase()) list.splice(at, 1);
              }
            }
            w(`${tag} OK store done`);
            return;
          }
          const add = /\+FLAGS/i.test(args);
          const names = /\(([^)]*)\)/.exec(args)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
          for (const u of expandSet(set, have)) for (const f of names) (add ? flagSet(selected, u).add(f) : flagSet(selected, u).delete(f));
          w(`${tag} OK store done`);
          return;
        }
        case 'UID EXPUNGE': {
          if (opts.failExpunge) {
            w(`${tag} NO [UNAVAILABLE] Server busy, try again later`);
            return;
          }
          const set = args.split(/\s+/)[0] ?? '';
          const gone = expandSet(set, have).filter((u) => flagSet(selected, u).has('\\Deleted'));
          uids[selected] = have.filter((u) => !gone.includes(u));
          w(`${tag} OK expunged`);
          return;
        }
        case 'GETQUOTAROOT':
          w(`${tag} NO no quota`);
          return;
        case 'LOGOUT':
          w('* BYE bye');
          w(`${tag} OK bye`);
          sock.end();
          return;
        default:
          w(`${tag} OK ${cmd} done`);
      }
    };
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handle(line);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    logins: () => loginCount,
    flagsOf: (mailbox, uid) => [...flagSet(mailbox, uid)],
    labelsOf: (mailbox, uid) => [...labelList(mailbox, uid)],
    uidsIn: (mailbox) => [...(uids[mailbox] ?? [])],
    labelStores,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
