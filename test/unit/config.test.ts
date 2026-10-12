import { describe, expect, it } from 'vitest';
import { ATTACH_FROM_DIRS_FLAG, defaultAuditLogPath, effectiveFeatures, isAllowedFrom, isGmailHost, isUnsetValue, loadConfig, parseBoolean, parseCommandLine, parseList } from '../../src/config.js';

const HOME = '/Users/alex';
const load = (env: Record<string, string | undefined>, platform: NodeJS.Platform = 'darwin') =>
  loadConfig(env, { platform, home: HOME, systemTimezone: 'Europe/Berlin' });

describe('placeholders and unset values', () => {
  it('treats empty strings and unexpanded ${user_config.*} placeholders as unset', () => {
    expect(isUnsetValue(undefined)).toBe(true);
    expect(isUnsetValue('')).toBe(true);
    expect(isUnsetValue('   ')).toBe(true);
    expect(isUnsetValue('${user_config.imap_username}')).toBe(true);
    expect(isUnsetValue('${anything}')).toBe(true);
    expect(isUnsetValue('x${user_config.a}')).toBe(false);
    expect(isUnsetValue('value')).toBe(false);
  });

  it('keeps path variables such as ${HOME} as real values', () => {
    expect(isUnsetValue('${HOME}')).toBe(false);
    expect(isUnsetValue('${DOWNLOADS}')).toBe(false);
  });

  it('ignores placeholders for every optional setting', () => {
    const { config, errors } = load({
      GMAIL_EMAIL: 'me@gmail.com',
      GMAIL_APP_PASSWORD: '${user_config.app_specific_password}',
      GMAIL_IMAP_USER: '${user_config.imap_username}',
      MAIL_FROM_ADDRESS: '${user_config.from_address}',
      MAIL_FROM_NAME: '${user_config.from_name}',
      MAIL_ALLOWED_FROM: '${user_config.allowed_from}',
      MAIL_ALLOW_SEND: '${user_config.allow_send}',
      MAIL_MAX_BODY_CHARS: '${user_config.max_body_chars}',
      MAIL_ATTACH_FROM_DIRS: '${user_config.attach_from_dirs}',
    });
    expect(errors).toEqual([]);
    expect(config.password).toBeUndefined();
    expect(config.imapUser).toBeUndefined();
    expect(config.fromAddress).toBe('me@gmail.com');
    expect(config.fromName).toBeUndefined();
    expect(config.allowedFrom).toEqual(['me@gmail.com']);
    expect(config.allowSend).toBe(true);
    expect(config.maxBodyChars).toBe(20_000);
    // unset => the documented default folders
    expect(config.attachFromDirs).toEqual(['/Users/alex/Desktop', '/Users/alex/Documents', '/Users/alex/Downloads']);
  });
});

describe('booleans', () => {
  it('accepts true/false/1/0/yes/no in any case', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'Yes']) expect(parseBoolean(v)).toBe(true);
    for (const v of ['false', 'False', '0', 'no', 'NO']) expect(parseBoolean(v)).toBe(false);
    expect(parseBoolean('maybe')).toBeUndefined();
  });

  it('reports invalid booleans as config errors (fail closed)', () => {
    const { errors, config } = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_READ_ONLY: 'sure' });
    expect(errors).toEqual([expect.stringMatching(/"Read-only mode" \(MAIL_READ_ONLY\) must be true\/false/)]);
    expect(config.readOnly).toBe(false);
  });
});

describe('defaults', () => {
  it('uses the documented defaults', () => {
    const { config, errors, warnings } = load({ GMAIL_EMAIL: 'me@gmail.com', GMAIL_APP_PASSWORD: ' abcd-efgh-ijkl-mnop ' });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      email: 'me@gmail.com',
      password: 'abcd-efgh-ijkl-mnop',
      keychainService: 'gmail-mail-mcp',
      smtpUser: 'me@gmail.com',
      fromAddress: 'me@gmail.com',
      allowSend: true,
      allowPermanentDelete: false,
      readOnly: false,
      confirmDialog: false,
      maxSendsPerHour: 30,
      maxRecipients: 50,
      maxRecipientsPerHour: 100,
      maxRecipientsPerDay: 400,
      attachmentDir: '/Users/alex/Downloads/Gmail Attachments',
      attachFromDirs: ['/Users/alex/Desktop', '/Users/alex/Documents', '/Users/alex/Downloads'],
      maxBodyChars: 20_000,
      maxAttachmentMb: 25,
      auditLog: '/Users/alex/Library/Logs/gmail-mail-mcp/audit.jsonl',
      // Gmail files sent mail in Sent itself.
      saveSentCopy: false,
      operationTimeoutSeconds: 120,
      logLevel: 'warn',
      timezone: 'Europe/Berlin',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true },
      tlsCaFile: undefined,
    });
  });

  it('puts the audit log under ~/.local/state off macOS and supports "off"', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com' }, 'linux').config.auditLog).toBe('/Users/alex/.local/state/gmail-mail-mcp/audit.jsonl');
    expect(defaultAuditLogPath('darwin', '/h')).toBe('/h/Library/Logs/gmail-mail-mcp/audit.jsonl');
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_AUDIT_LOG: 'OFF' }).config.auditLog).toBeNull();
  });

  it('SMTP_SECURE=true drops requireTLS; SMTP_REQUIRE_TLS=false is honoured for STARTTLS', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', SMTP_SECURE: 'true', SMTP_PORT: '465' }).config.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false });
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', SMTP_REQUIRE_TLS: 'false' }).config.smtp.requireTLS).toBe(false);
  });
});

describe('required values and validation', () => {
  it('reports a missing email but still returns a usable config object', () => {
    const { config, errors } = load({});
    expect(config.email).toBe('');
    expect(errors).toEqual([expect.stringMatching(/GMAIL_EMAIL is not set/)]);
  });

  it('rejects invalid email addresses', () => {
    expect(load({ GMAIL_EMAIL: 'not an email' }).errors[0]).toMatch(/\(GMAIL_EMAIL\) is not a valid email address/);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_ALLOWED_FROM: 'ok@example.com, bad@' }).errors[0]).toMatch(/MAIL_ALLOWED_FROM/);
  });

  it('validates numbers and clamps to documented ceilings', () => {
    const r = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_BODY_CHARS: '500000', MAIL_MAX_RECIPIENTS: '900', MAIL_MAX_SENDS_PER_HOUR: 'ten' });
    expect(r.config.maxBodyChars).toBe(100_000);
    expect(r.config.maxRecipients).toBe(100); // Gmail's per-message ceiling
    expect(r.warnings).toHaveLength(2);
    expect(r.errors).toEqual([expect.stringMatching(/\(MAIL_MAX_SENDS_PER_HOUR\) must be a whole number/)]);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_SENDS_PER_HOUR: '0' }).config.maxSendsPerHour).toBe(0);
  });

  // integ-8: a decimal from the settings form never disables every tool.
  it('rounds and clamps non-integer limit settings with a warning; ports stay strict', () => {
    const a = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_BODY_CHARS: '1500.5' });
    expect(a.errors).toEqual([]);
    expect(a.config.maxBodyChars).toBe(1501);
    expect(a.warnings.join(' ')).toMatch(/Maximum email length shown to Claude/);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_BODY_CHARS: '2e4' }).config.maxBodyChars).toBe(20_000);
    const low = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_RECIPIENTS: '0' });
    expect(low.config.maxRecipients).toBe(1);
    expect(low.errors).toEqual([]);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_MAX_BODY_CHARS: 'abc' }).errors[0]).toMatch(/whole number/);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', IMAP_PORT: '993.5' }).errors[0]).toMatch(/IMAP_PORT must be a whole number/);
  });

  // integ-3: a full address in "IMAP login" is also the SMTP login.
  it('uses a full-address IMAP login for SMTP too', () => {
    expect(load({ GMAIL_EMAIL: 'jane@example.com', GMAIL_IMAP_USER: 'jane@gmail.com' }).config.smtpUser).toBe('jane@gmail.com');
    expect(load({ GMAIL_EMAIL: 'jane@gmail.com', GMAIL_IMAP_USER: 'jane' }).config.smtpUser).toBe('jane@gmail.com');
    expect(load({ GMAIL_EMAIL: 'jane@example.com', GMAIL_IMAP_USER: 'jane@gmail.com', GMAIL_SMTP_USER: 'other@gmail.com' }).config.smtpUser).toBe('other@gmail.com');
  });

  // own-1: @gmail.com and @googlemail.com reach the same mailbox, so both are own addresses (not allowed From).
  it('treats the @gmail.com/@googlemail.com equivalents as own addresses only', () => {
    const { config } = load({ GMAIL_EMAIL: 'jane@gmail.com' });
    expect(config.ownAddresses).toEqual(['jane@gmail.com', 'jane@googlemail.com']);
    expect(config.allowedFrom).toEqual(['jane@gmail.com']);
    expect(load({ GMAIL_EMAIL: 'Jane@GoogleMail.com' }).config.ownAddresses).toEqual(['Jane@GoogleMail.com', 'Jane@gmail.com']);
    expect(load({ GMAIL_EMAIL: 'jane@example.com' }).config.ownAddresses).toEqual(['jane@example.com']);
    // The iCloud domains are no longer special.
    expect(load({ GMAIL_EMAIL: 'jane@icloud.com' }).config.ownAddresses).toEqual(['jane@icloud.com']);
  });

  // docs-13: "none" switches local-file attachments off.
  it('accepts "none" for the attachment folders', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_ATTACH_FROM_DIRS: 'none' }).config.attachFromDirs).toEqual([]);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com' }).config.attachFromDirs).toHaveLength(3);
  });

  it('warns when SMTP TLS is not required', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', SMTP_REQUIRE_TLS: 'false' }).warnings.join(' ')).toMatch(/SMTP_REQUIRE_TLS=false/);
  });

  it('validates the time zone and log level', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_TIMEZONE: 'Mars/Olympus' }).errors[0]).toMatch(/MAIL_TIMEZONE/);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_TIMEZONE: 'America/Los_Angeles' }).config.timezone).toBe('America/Los_Angeles');
    const lvl = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_LOG_LEVEL: 'DEBUG' });
    expect(lvl.config.logLevel).toBe('debug');
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_LOG_LEVEL: 'loud' }).warnings[0]).toMatch(/MAIL_LOG_LEVEL/);
  });
});

describe('path expansion', () => {
  it('expands ~, ${HOME}, ${DOWNLOADS}, ${DOCUMENTS} and ${DESKTOP}', () => {
    const { config, errors } = load({
      GMAIL_EMAIL: 'me@gmail.com',
      MAIL_ATTACHMENT_DIR: '${DOWNLOADS}/Mail',
      MAIL_ATTACH_FROM_DIRS: '~/Projects, ${DOCUMENTS},${DESKTOP}/x, ${HOME}/y, ${user_config.nothing}',
      MAIL_AUDIT_LOG: '~/logs/audit.jsonl',
      MAIL_TLS_CA_FILE: '${HOME}/ca.pem',
    });
    expect(errors).toEqual([]);
    expect(config.attachmentDir).toBe('/Users/alex/Downloads/Mail');
    expect(config.attachFromDirs).toEqual(['/Users/alex/Projects', '/Users/alex/Documents', '/Users/alex/Desktop/x', '/Users/alex/y']);
    expect(config.auditLog).toBe('/Users/alex/logs/audit.jsonl');
    expect(config.tlsCaFile).toBe('/Users/alex/ca.pem');
  });

  it('rejects relative paths', () => {
    const r = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_ATTACHMENT_DIR: 'relative/dir', MAIL_ATTACH_FROM_DIRS: 'docs' });
    expect(r.errors).toHaveLength(2);
  });

  it('parses lists', () => {
    expect(parseList(' a, ,b ,${user_config.x}')).toEqual(['a', 'b']);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('command line (.mcpb "Attach files from" folders)', () => {
  const loadArgs = (argv: string[], env: Record<string, string> = {}) =>
    loadConfig({ GMAIL_EMAIL: 'me@gmail.com', ...env }, { platform: 'darwin', home: HOME, systemTimezone: 'Europe/Berlin', argv });

  it('parses one folder per argument after --attach-from-dirs, dropping placeholders and blanks', () => {
    expect(parseCommandLine([ATTACH_FROM_DIRS_FLAG, '/Users/alex/Work, Inc', ' ', '${user_config.attach_from_dirs}', '${HOME}/Documents'])).toEqual({
      attachFromDirs: ['/Users/alex/Work, Inc', '${HOME}/Documents'],
      unknown: [],
    });
    expect(parseCommandLine([])).toEqual({ attachFromDirs: [], unknown: [] });
    expect(parseCommandLine(['--verbose', ATTACH_FROM_DIRS_FLAG])).toEqual({ attachFromDirs: [], unknown: ['--verbose'] });
  });

  it('uses the argument folders (expanded, commas kept) in preference to MAIL_ATTACH_FROM_DIRS', () => {
    const { config, errors } = loadArgs([ATTACH_FROM_DIRS_FLAG, '${HOME}/Desktop', '/Users/alex/Work, Inc', '~/Desktop'], { MAIL_ATTACH_FROM_DIRS: '/tmp/other' });
    expect(errors).toEqual([]);
    expect(config.attachFromDirs).toEqual(['/Users/alex/Desktop', '/Users/alex/Work, Inc']);
  });

  it('falls back to MAIL_ATTACH_FROM_DIRS, then the defaults, when no folder argument is given', () => {
    expect(loadArgs([ATTACH_FROM_DIRS_FLAG, '${user_config.attach_from_dirs}'], { MAIL_ATTACH_FROM_DIRS: '/tmp/other' }).config.attachFromDirs).toEqual(['/tmp/other']);
    expect(loadArgs([ATTACH_FROM_DIRS_FLAG]).config.attachFromDirs).toEqual(['/Users/alex/Desktop', '/Users/alex/Documents', '/Users/alex/Downloads']);
  });

  it('reports relative folders as errors and unknown arguments as warnings', () => {
    const r = loadArgs(['--bogus', ATTACH_FROM_DIRS_FLAG, 'relative']);
    expect(r.errors).toEqual([`The "Attach files from" folders (${ATTACH_FROM_DIRS_FLAG}) must be absolute paths (or start with ~/); got "relative".`]);
    expect(r.warnings).toEqual(['Ignoring unknown command-line argument(s): "--bogus".']);
  });
});

describe('allowed From set', () => {
  it('is GMAIL_EMAIL ∪ MAIL_FROM_ADDRESS ∪ MAIL_ALLOWED_FROM, deduplicated case-insensitively', () => {
    const { config } = load({
      GMAIL_EMAIL: 'me@gmail.com',
      MAIL_FROM_ADDRESS: 'hello@custom.dev',
      MAIL_ALLOWED_FROM: 'ME@Gmail.com, alias@gmail.com, Hello@Custom.dev',
    });
    expect(config.allowedFrom).toEqual(['me@gmail.com', 'hello@custom.dev', 'alias@gmail.com']);
    expect(config.fromAddress).toBe('hello@custom.dev');
    expect(isAllowedFrom(config, 'ALIAS@gmail.com')).toBe(true);
    expect(isAllowedFrom(config, 'other@gmail.com')).toBe(false);
  });
});

describe('effective features', () => {
  it('read-only overrides send and permanent delete', () => {
    const { config } = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_READ_ONLY: 'yes', MAIL_ALLOW_SEND: 'true', MAIL_ALLOW_PERMANENT_DELETE: '1' });
    expect(effectiveFeatures(config)).toEqual({ readOnly: true, send: false, permanentDelete: false, drafts: false, mailboxChanges: false });
    const rw = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_ALLOW_SEND: 'no', MAIL_ALLOW_PERMANENT_DELETE: 'true' }).config;
    expect(effectiveFeatures(rw)).toEqual({ readOnly: false, send: false, permanentDelete: true, drafts: true, mailboxChanges: true });
  });
});

describe('special folder overrides', () => {
  it('reads MAIL_*_MAILBOX overrides', () => {
    const { config } = load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_SENT_MAILBOX: 'Sent', MAIL_ARCHIVE_MAILBOX: '${user_config.archive}' });
    expect(config.mailboxOverrides).toEqual({ sent: 'Sent' });
  });
});

describe('Gmail servers', () => {
  it('turns off the Sent copy for Gmail (the default host), since Gmail files sent mail itself', () => {
    expect(load({ GMAIL_EMAIL: 'me@gmail.com' }).config.saveSentCopy).toBe(false);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', IMAP_HOST: 'imap.gmail.com', SMTP_HOST: 'smtp.gmail.com' }).config.saveSentCopy).toBe(false);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', MAIL_SAVE_SENT_COPY: 'true' }).config.saveSentCopy).toBe(true);
    // Other servers (the local test server) need the copy.
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', IMAP_HOST: 'localhost' }).config.saveSentCopy).toBe(true);
    expect(load({ GMAIL_EMAIL: 'me@gmail.com', IMAP_HOST: 'localhost', MAIL_SAVE_SENT_COPY: 'false' }).config.saveSentCopy).toBe(false);
  });

  it('recognises only Google hosts', () => {
    expect(isGmailHost('imap.gmail.com')).toBe(true);
    expect(isGmailHost('SMTP.GMAIL.COM')).toBe(true);
    expect(isGmailHost('imap.mail.me.com')).toBe(false);
    expect(isGmailHost('notgmail.com.evil.test')).toBe(false);
    expect(isGmailHost(undefined)).toBe(false);
  });
});
