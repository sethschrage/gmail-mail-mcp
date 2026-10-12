/**
 * Mailbox changes (SPEC §6.3): mark_messages, label_messages, move_messages, archive_messages,
 * trash_messages, create_mailbox, rename_mailbox, delete_mailbox. Not registered in read-only mode.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_LABELS_PER_CALL, MAX_LABEL_LENGTH } from '../imap/labels.js';
import type { MoveResult } from '../imap/ops.js';
import { renderJson } from '../render.js';
import {
  DESTRUCTIVE_NON_IDEMPOTENT_HINTS,
  WRITE_IDEMPOTENT_HINTS,
  WRITE_NON_IDEMPOTENT_HINTS,
  annotations,
  mailboxField,
  notFoundNote,
  runTool,
  textResult,
  uidsField,
  type ToolRuntime,
} from './common.js';

export const MAILBOX_TOOL_NAMES = ['mark_messages', 'label_messages', 'move_messages', 'archive_messages', 'trash_messages', 'create_mailbox', 'rename_mailbox', 'delete_mailbox'] as const;

const newPathField = (what: string): z.ZodString =>
  z
    .string()
    .min(1)
    .max(500)
    .describe(`${what} Use "/" between levels for a nested folder (e.g. "Projects/2026"); it is mapped to the server's hierarchy delimiter.`);

function moveText(r: MoveResult): string {
  const note = notFoundNote(r.source, r.not_found);
  return renderJson(note ? { ...r, note } : r);
}

export function registerMailboxTools(server: McpServer, rt: ToolRuntime): void {
  const { service } = rt;

  const markTitle = 'Mark Messages';
  server.registerTool(
    'mark_messages',
    {
      title: markTitle,
      description:
        'Change the read state and/or the star of messages in one mailbox: read=true/false marks them read or unread; flagged=true/false stars or unstars them (Gmail\'s star is the IMAP \\Flagged flag). Give at least one of read or flagged. Changes show up in Gmail on every device. Returns how many messages were changed, counts of the state in effect afterwards (and the per-message state for up to 20 messages), anything that did not take effect, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField(),
        uids: uidsField(),
        read: z.boolean().describe('true = mark as read; false = mark as unread.').optional(),
        flagged: z.boolean().describe('true = star; false = remove the star.').optional(),
      }),
      annotations: annotations(markTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(
        rt,
        'mark_messages',
        ctx,
        async (signal) => {
          const r = await service.markMessages({ mailbox: args.mailbox, uids: args.uids, read: args.read, flagged: args.flagged }, { signal });
          const note = notFoundNote(r.mailbox, r.not_found);
          return textResult(renderJson(note ? { ...r, note } : r));
        },
        { audit: () => ({ mailbox: args.mailbox, uids: args.uids, read: args.read, flagged: args.flagged }) },
      ),
  );

  const labelTitle = 'Add or Remove Gmail Labels';
  const labelList = (what: string): z.ZodArray<z.ZodString> =>
    z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).min(1).max(MAX_LABELS_PER_CALL).describe(what);
  server.registerTool(
    'label_messages',
    {
      title: labelTitle,
      description:
        'Add and/or remove Gmail labels on messages in one mailbox, the way Gmail\'s label button does: the messages stay where they are and gain or lose labels. Use label names as Gmail shows them (nested labels with "/", e.g. "Clients/Acme"); a label that does not exist yet is created by Gmail. The system labels "Inbox", "Important" and "Starred" can also be added or removed (removing "Inbox" archives; adding it moves mail back to the inbox). Sent, Drafts, Spam and Trash are not labels here: use trash_messages or move_messages. Removing the label of the mailbox you are in makes the messages leave that mailbox (they stay in All Mail). Returns the labels of each message afterwards (up to 20 messages), anything that did not take effect, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
        add: labelList('Labels to add.').optional(),
        remove: labelList('Labels to remove.').optional(),
      }),
      annotations: annotations(labelTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(
        rt,
        'label_messages',
        ctx,
        async (signal) => {
          const r = await service.labelMessages({ mailbox: args.mailbox, uids: args.uids, add: args.add, remove: args.remove }, { signal });
          const note = notFoundNote(r.mailbox, r.not_found);
          return textResult(renderJson(note ? { ...r, note: r.note ? `${r.note} ${note}` : note } : r));
        },
        { audit: () => ({ mailbox: args.mailbox, uids: args.uids, add: args.add, remove: args.remove }) },
      ),
  );

  const moveTitle = 'Move Messages';
  server.registerTool(
    'move_messages',
    {
      title: moveTitle,
      description:
        'Move messages from one mailbox to another existing mailbox, e.g. into a project folder. The destination is matched by exact path, by alias (inbox, sent, drafts, archive, junk, trash) or by unique folder name; it must already exist (create it first with create_mailbox) and differ from the source. On Gmail a folder is a label, so moving from INBOX or a label to another label swaps the labels (the message is not copied); to add a label while keeping the others, use label_messages. For the common cases prefer archive_messages or trash_messages. Returns the number moved, the new UIDs in the destination when the server reports them, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Source mailbox'),
        uids: uidsField(),
        destination: mailboxField('Destination mailbox (must already exist)'),
      }),
      annotations: annotations(moveTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'move_messages', ctx, async (signal) => textResult(moveText(await service.moveMessages({ mailbox: args.mailbox, uids: args.uids, destination: args.destination }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids, destination: args.destination }),
      }),
  );

  const archiveTitle = 'Archive Messages';
  server.registerTool(
    'archive_messages',
    {
      title: archiveTitle,
      description:
        'Archive messages the way Gmail\'s Archive button does: remove the Inbox label, keeping every other label, so the messages leave the inbox and stay in All Mail. Use this when the user wants to archive or clear mail from the inbox without deleting it. Works from INBOX or any label. Returns the number archived, a note on where the messages are now, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
      }),
      annotations: annotations(archiveTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'archive_messages', ctx, async (signal) => textResult(moveText(await service.archiveMessages({ mailbox: args.mailbox, uids: args.uids }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids }),
      }),
  );

  const trashTitle = 'Move Messages to Trash';
  server.registerTool(
    'trash_messages',
    {
      title: trashTitle,
      description:
        'Move messages to Trash ("[Gmail]/Trash"), as Gmail\'s Delete button does: the messages lose all their labels. This is the normal, recoverable way to delete mail: the user can restore it from Trash for 30 days, after which Gmail deletes it for good. Messages that are already in Trash are refused (permanent deletion is a separate tool that may be disabled). Returns the number moved, the new UIDs in Trash when the server reports them, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
      }),
      annotations: annotations(trashTitle, WRITE_NON_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'trash_messages', ctx, async (signal) => textResult(moveText(await service.trashMessages({ mailbox: args.mailbox, uids: args.uids }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids }),
      }),
  );

  const createTitle = 'Create Mailbox';
  server.registerTool(
    'create_mailbox',
    {
      title: createTitle,
      description:
        'Create a new Gmail label (shown over IMAP as a folder), e.g. "Receipts 2026" or the nested "Projects/2026". Labels cannot be created inside INBOX or "[Gmail]". Refused when a label with that name already exists. It appears in Gmail right away. Returns the created path.',
      inputSchema: z.strictObject({
        path: newPathField('Path of the new mailbox.'),
      }),
      annotations: annotations(createTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'create_mailbox', ctx, async (signal) => textResult(renderJson(await service.createMailbox({ path: args.path }, { signal }))), {
        audit: () => ({ mailbox: args.path }),
      }),
  );

  const renameTitle = 'Rename Mailbox';
  server.registerTool(
    'rename_mailbox',
    {
      title: renameTitle,
      description:
        'Rename a user-created label (folder), or nest it under another one: e.g. path "Receipts" with new_path "Finance/Receipts". Its messages and sublabels go with it. INBOX and the system folders (Sent Mail, Drafts, All Mail, Spam, Trash) cannot be renamed, and new_path must not exist yet. Returns the old and new paths.',
      inputSchema: z.strictObject({
        path: mailboxField('Mailbox to rename'),
        new_path: newPathField('New full path for the mailbox.'),
      }),
      annotations: annotations(renameTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'rename_mailbox', ctx, async (signal) => textResult(renderJson(await service.renameMailbox({ path: args.path, newPath: args.new_path }, { signal }))), {
        audit: () => ({ mailbox: args.path, destination: args.new_path }),
      }),
  );

  const deleteTitle = 'Delete Empty Mailbox';
  server.registerTool(
    'delete_mailbox',
    {
      title: deleteTitle,
      description:
        'Delete an empty, user-created label (folder). Only allowed when it contains no messages and no sublabels, and never for INBOX or the system folders (Sent Mail, Drafts, All Mail, Spam, Trash); otherwise nothing is changed and the error explains why (move or trash the messages first). The folder itself cannot be restored afterwards.',
      inputSchema: z.strictObject({
        path: mailboxField('Mailbox to delete'),
      }),
      annotations: annotations(deleteTitle, DESTRUCTIVE_NON_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'delete_mailbox', ctx, async (signal) => textResult(renderJson(await service.deleteMailbox({ path: args.path }, { signal }))), {
        audit: () => ({ mailbox: args.path }),
      }),
  );
}
