import { App, TFile } from 'obsidian';

import {
  freezeVerifiedImageAttachment,
  MAX_FROZEN_ATTACHMENT_COUNT,
  MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES,
} from '../runtime/frozenAttachments';
import type { FileAttachment } from '../types';
import { getVaultBasePath, guessMimeType, readVerifiedVaultFile } from './vault';
export { findMentionQuery, findSlashQuery } from './inputQueries';

export interface MentionResolution {
  prompt: string;
  attachments: FileAttachment[];
}

const MENTION_RE = /@(?:"([^"]+)"|([^\s]+))/g;
const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;

export async function resolveMentions(app: App, prompt: string, maxChars: number): Promise<MentionResolution> {
  const attachments: FileAttachment[] = [];
  const contextSections: string[] = [];
  const seen = new Set<string>();

  for (const match of prompt.matchAll(MENTION_RE)) {
    const rawPath = (match[1] || match[2] || '').trim();
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = app.vault.getAbstractFileByPath(rawPath);
    if (!(file instanceof TFile)) continue;
    const mimeType = guessMimeType(file);
    try {
      const verified = await readVerifiedVaultFile(
        app,
        file,
        MAX_CONTEXT_FILE_BYTES,
        !mimeType?.startsWith('image/'),
      );
      if (mimeType?.startsWith('image/')) {
        const totalBytes = attachments.reduce((total, attachment) => (
          total + (attachment.byteLength ?? 0)
        ), 0);
        if (
          attachments.length >= MAX_FROZEN_ATTACHMENT_COUNT
          || totalBytes + verified.body.byteLength > MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES
        ) {
          throw new Error('Image attachments exceed the per-turn safety budget.');
        }
        attachments.push(freezeVerifiedImageAttachment({
          vaultPath: file.path,
          vaultRoot: getVaultBasePath(app) ?? '',
          body: verified.body,
          mimeType,
        }));
        continue;
      }
      if (mimeType !== 'text/markdown' && mimeType !== 'text/plain') {
        contextSections.push(`File: ${file.path}\n[Unsupported file type]`);
        continue;
      }
      const text = verified.body.toString('utf8');
      contextSections.push([
        `File: ${file.path}`,
        '```',
        text.slice(0, maxChars),
        text.length > maxChars ? '\n[truncated]' : '',
        '```',
      ].join('\n'));
    } catch {
      contextSections.push(`File: ${file.path}\n[Could not read file]`);
    }
  }

  if (contextSections.length === 0) {
    return { prompt, attachments };
  }

  return {
    prompt: `${prompt}\n\nReferenced vault context:\n\n${contextSections.join('\n\n')}`,
    attachments,
  };
}
