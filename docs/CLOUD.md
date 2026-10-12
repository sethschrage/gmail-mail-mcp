# Gmail for Claude: cloud version (Vercel)

One Vercel deployment that gives Claude access to several Gmail or Google Workspace accounts, each
at its own connector URL, from claude.ai, the Claude mobile and desktop apps, and Claude Code. Your
Mac doesn't need to be on.

The local Claude Desktop extension (`src/index.ts`) keeps working; the cloud version is a second
entry point (`api/gmail/[account].js`, built from `src/http/`) in the same repository.

**Contents**

- [How it works](#how-it-works)
- [Deploy](#deploy): [1. Project](#1-create-the-vercel-project) · [2. Upstash](#2-add-upstash-for-redis-send-limits) ·
  [3. Environment variables](#3-environment-variables) · [4. Deploy and check](#4-deploy-and-check) · [5. Connect Claude](#5-connect-claude)
- [Adding, changing and removing accounts](#adding-changing-and-removing-accounts)
- [Send limits: why Upstash](#send-limits-why-upstash)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
Claude (claude.ai, mobile, desktop, Claude Code)
   │  HTTPS, MCP (stateless Streamable HTTP)
   │  /api/gmail/<account>?key=<that account's access key>   (or Authorization: Bearer)
   ▼
Vercel function  api/gmail/[account].js     ← unknown account, no key configured or wrong key: 404
   │  IMAP imap.gmail.com:993 (TLS)          ← login: GMAIL_<ACCOUNT>_EMAIL / GMAIL_<ACCOUNT>_PASSWORD
   │  SMTP smtp.gmail.com:587 (STARTTLS)
   ▼
Gmail  ──►  Gmail on all your devices

Send limits ─► Upstash Redis (shared by every Vercel instance, counted per account)
Audit trail ─► Vercel logs (lines starting with gmail-mail-audit)
```

- **Accounts.** The last part of the URL is the account name: letters and digits, case-insensitive
  (`personal`, `shop2`). Its settings are the Vercel env vars `GMAIL_<ACCOUNT>_*` with the name in
  capitals (`GMAIL_PERSONAL_*`).
- **Access key per account.** Every request needs that account's `GMAIL_<ACCOUNT>_ACCESS_KEY`
  (32+ characters), as `?key=…` in the connector URL or as `Authorization: Bearer …`, compared in
  constant time. One account's key never opens another account. A request without the right key
  gets `404`, exactly like an account that doesn't exist, so account names can't be probed.
- **Isolation.** Each account gets its own mail service, built only from the global `MAIL_*`
  settings and its own `GMAIL_<ACCOUNT>_*` variables; another account's variables are never visible
  to it.
- **Connection reuse.** An account's IMAP connection is kept while the Vercel instance stays warm.
- **Secrets stay hidden.** Passwords and access keys are never logged or returned. Error messages
  repeat only what Google's servers said.

## Deploy

You need a Vercel account, this repository on GitHub, and an app password for each Gmail account
(see the [README](../README.md#before-you-start-an-app-password-per-account)).

### 1. Create the Vercel project

1. In Vercel: **Add New… → Project**, import this repository.
2. Framework preset: **Other**. Leave the build and output settings at their defaults: Vercel runs
   `npm run vercel-build`, which bundles the server into `build/vercel/handler.mjs`, and
   `api/gmail/[account].js` re-exports that bundle.
3. Pushing to `main` deploys to production from then on.

### 2. Add Upstash for Redis (send limits)

1. In the project: **Storage → Create Database → Upstash for Redis** (from the Marketplace; the free
   plan is plenty).
2. Connect it to the project for **Production**.
3. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`; the server reads those (or
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` if you created the database on upstash.com).

Without Upstash, sending is refused with a message explaining this step; drafts still work. To run
without it on purpose, set `MAIL_RATE_LIMIT_STORE=memory` (see [below](#send-limits-why-upstash)).

### 3. Environment variables

In **Settings → Environment Variables**, for **Production**. Mark secrets **Sensitive**: Vercel then
never shows the value again, and only the deployed function can read it.

Once, for every account:

| Variable | Value | Sensitive |
|---|---|---|
| `MAIL_TIMEZONE` | Your time zone, e.g. `America/New_York`. Vercel runs in UTC. | no |

Per account (here `PERSONAL`; repeat with another name for each account):

| Variable | Value | Sensitive |
|---|---|---|
| `GMAIL_PERSONAL_ACCESS_KEY` | A new random key, see below. Keep it in your password manager. | yes |
| `GMAIL_PERSONAL_EMAIL` | The account's address | no |
| `GMAIL_PERSONAL_PASSWORD` | Its app password (spaces are fine) | yes |
| `GMAIL_PERSONAL_FROM_NAME` | Optional: your name as recipients see it | no |
| `GMAIL_PERSONAL_FROM_ADDRESS` | Optional: a verified *Send mail as* address to send from by default | no |
| `GMAIL_PERSONAL_ALLOWED_FROM` | Optional: further *Send mail as* addresses, comma-separated | no |
| `GMAIL_PERSONAL_MAIL_<SETTING>` | Optional: any `MAIL_*` setting for this account only, e.g. `GMAIL_PERSONAL_MAIL_READ_ONLY=true` or `GMAIL_PERSONAL_MAIL_ALLOW_SEND=false` | no |

Generate each access key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Global `MAIL_*` settings (for example `MAIL_MAX_SENDS_PER_HOUR`) apply to every account unless the
account sets its own. The full list is in the [README](../README.md#configuration-reference). Settings
about local folders (`MAIL_ATTACHMENT_DIR`, `MAIL_ATTACH_FROM_DIRS`) are ignored in the cloud, and
`MAIL_CONFIRM_DIALOG` is refused, because the dialog only exists on a Mac.

### 4. Deploy and check

Deploy (or redeploy after changing variables). Then, for each account:

```bash
URL="https://<project>.vercel.app/api/gmail/personal"
KEY="<GMAIL_PERSONAL_ACCESS_KEY>"

# 404 without the key
curl -s -X POST "$URL" -H 'content-type: application/json' -d '{}'

# initialize with it
curl -s -X POST "$URL?key=$KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

### 5. Connect Claude

**claude.ai, the mobile apps and Claude Desktop:**

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: one per account, e.g. `Gmail (personal)`.
3. URL: `https://<project>.vercel.app/api/gmail/personal?key=<GMAIL_PERSONAL_ACCESS_KEY>`.
4. Leave the OAuth fields empty.
5. Ask: "Use Gmail (personal) to show the account info." It should show `"account": "personal"`,
   the right address, the Gmail folders (*[Gmail]/Sent Mail*, *[Gmail]/Trash*, *[Gmail]/All Mail*,
   …), `X-GM-EXT-1: true` among the capabilities, and `shared_send_limits.store` `upstash`.

**Claude Code** (the key in a header instead of the URL):

```bash
claude mcp add --transport http gmail-personal https://<project>.vercel.app/api/gmail/personal \
  --header "Authorization: Bearer <GMAIL_PERSONAL_ACCESS_KEY>"
```

## Adding, changing and removing accounts

- **Add:** set the new account's `GMAIL_<NAME>_*` variables, redeploy, and add a connector with the
  new URL.
- **Change a password:** update `GMAIL_<NAME>_PASSWORD` and redeploy.
- **Revoke access:** change or delete `GMAIL_<NAME>_ACCESS_KEY` and redeploy; the old URL stops
  working at once (`404`). Then revoke the app password at
  myaccount.google.com/apppasswords too.

## Send limits: why Upstash

The hourly and daily caps exist so a runaway loop or a prompt-injected email can't send a flood of
mail (Gmail suspends sending for a day at about 500 recipients). On Vercel, several instances can
run at once and each cold start forgets in-memory counts, so the counts live in Upstash:

- Every instance counts in the same place, per account (keyed by a hash of the address).
- **It fails closed:** if Upstash can't be reached, nothing is sent (drafts still work).
- Counters use a sliding window, so a burst at the top of the hour can't double the limit.
- With `MAIL_RATE_LIMIT_STORE=memory` each instance counts on its own instead (weaker, no setup).

## Security notes

- **Who can use an account.** Anyone with an account's connector URL (which contains its key) can
  use that mailbox through this server. Treat each URL like a password. Keys are per account, so a
  leaked URL exposes one mailbox. Prefer `Authorization: Bearer` where the client supports headers
  (Claude Code).
- **The key in the URL.** The server never logs URLs or request headers; Vercel's own request logs,
  visible to your team only, may show request paths.
- **App passwords** give full mail access to that account (not the Google Account itself). They are
  stored as Sensitive Vercel variables. Revoke them at myaccount.google.com/apppasswords; changing
  the Google password revokes them all.
- **Untrusted email content** is marked as such, and every send is a destructive tool, so Claude asks
  for approval (depending on your permission settings).
- **Audit trail.** The Vercel logs keep an entry for every change and send (tool, recipients,
  subject, Message-ID; never bodies). Search the logs for `gmail-mail-audit`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `404 not found` | The key in the connector URL (or Bearer header) doesn't match the account's `GMAIL_<ACCOUNT>_ACCESS_KEY`, the account has no key of 32+ characters, or you didn't redeploy after adding it. Account names are letters and digits only. The Vercel logs say "wrong access key" when the account exists but the key doesn't match. |
| "No Gmail login is set for this account" | Set `GMAIL_<ACCOUNT>_EMAIL` and `GMAIL_<ACCOUNT>_PASSWORD`, then redeploy. |
| Gmail rejected the login | Use an app password, not the Google password; create a new one if the Google password changed; check 2-Step Verification and, for Workspace, that the admin allows IMAP and app passwords. |
| "Not sent: … Upstash …" | Add Upstash for Redis (step 2) and redeploy, or check that its token is still valid. |
| Dates are in UTC | Set `MAIL_TIMEZONE`. |
| A tool times out | The function may run 60 s (`vercel.json`). Narrow the search (a date range, a label, or `gmail_query`). |
| Logs | Vercel → the project → **Logs**. Set `MAIL_LOG_LEVEL=info` for more detail (never passwords or message text). |
