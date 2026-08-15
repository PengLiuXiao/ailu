import type { FeishuPublishState, FeishuSnapshot } from './types';
import { verifyFeishuRemoteContent } from './remoteVerification';
import { stageFeishuSnapshotAssets } from './assetStaging';

export interface FeishuPublishingClient {
  runPublishingOperation<T>(operation: () => Promise<T>): Promise<T>;
  createDocument(markdown: string, parentToken: string, title?: string): Promise<{
    documentId: string;
    url: string;
  }>;
  updateDocument(documentId: string, markdown: string): Promise<void>;
  insertAssets(
    documentId: string,
    vaultBasePath: string,
    assets: FeishuSnapshot['assets'],
  ): Promise<void>;
  fetchDocumentContent(documentId: string): Promise<string>;
}

export type FeishuPublishStage =
  | 'persist_pending'
  | 'create_document'
  | 'update_document'
  | 'insert_assets'
  | 'fetch_remote'
  | 'verify_remote'
  | 'persist_complete';

export interface FeishuPublishStageEvent {
  stage: FeishuPublishStage;
  status: 'started' | 'succeeded' | 'failed';
  message?: string;
}

export interface PublishFeishuSnapshotOptions {
  cli: FeishuPublishingClient;
  snapshot: FeishuSnapshot;
  existing: FeishuPublishState | null;
  /** Used only when creating a new document. Empty means My Library root. */
  parentToken?: string;
  persistState: (state: FeishuPublishState) => Promise<void>;
  onPendingState?: (state: FeishuPublishState) => void;
  onStage?: (event: FeishuPublishStageEvent) => void;
  /**
   * Final local intent check. Runs after the CLI has pinned the Feishu profile,
   * and frozen the confirmed assets, but before persisting pending state or
   * writing remotely.
   */
  beforeRemoteWrite?: () => Promise<void> | void;
  onCleanupWarning?: (error: unknown) => void;
  now?: () => string;
}

async function runPublishStage<T>(
  options: PublishFeishuSnapshotOptions,
  stage: FeishuPublishStage,
  operation: () => Promise<T> | T,
): Promise<T> {
  const report = (event: FeishuPublishStageEvent): void => {
    try {
      options.onStage?.(event);
    } catch {
      // Diagnostics must never interrupt the document transaction.
    }
  };
  report({ stage, status: 'started' });
  try {
    const result = await operation();
    report({ stage, status: 'succeeded' });
    return result;
  } catch (error) {
    report({
      stage,
      status: 'failed',
      message: error instanceof Error ? error.message : '飞书发布阶段失败',
    });
    throw error;
  }
}

/**
 * Execute one serialized Feishu write transaction. A linked document is marked
 * pending before overwrite so any partial remote success can never retain a
 * stale content hash and masquerade as fully synchronized.
 */
export async function publishFeishuSnapshot(
  options: PublishFeishuSnapshotOptions,
): Promise<FeishuPublishState> {
  const now = options.now ?? (() => new Date().toISOString());
  return options.cli.runPublishingOperation(async () => {
    const staged = await stageFeishuSnapshotAssets(options.snapshot);
    let result: FeishuPublishState | undefined;
    let operationError: unknown;
    try {
      await options.beforeRemoteWrite?.();
      let documentId: string;
      let url: string;

      if (options.existing) {
        documentId = options.existing.documentId;
        url = options.existing.url;
        const pending = pendingState(documentId, url, options.snapshot.title, now());
        await runPublishStage(options, 'persist_pending', () => options.persistState(pending));
        options.onPendingState?.(pending);
        // Persisting the pending marker writes the source note's frontmatter and
        // may yield long enough for the user (or another plugin) to edit the
        // note. Revalidate the confirmed local intent immediately before the
        // first remote overwrite; a stale snapshot must never reach Feishu.
        await options.beforeRemoteWrite?.();
        await runPublishStage(
          options,
          'update_document',
          () => options.cli.updateDocument(documentId, options.snapshot.markdown),
        );
      } else {
        const created = await runPublishStage(
          options,
          'create_document',
          () => options.cli.createDocument(
            options.snapshot.markdown,
            options.parentToken?.trim() ?? '',
            options.snapshot.title,
          ),
        );
        documentId = created.documentId;
        url = created.url;
        const pending = pendingState(documentId, url, options.snapshot.title, now());
        await runPublishStage(options, 'persist_pending', () => options.persistState(pending));
        options.onPendingState?.(pending);
      }

      await runPublishStage(
        options,
        'insert_assets',
        () => options.cli.insertAssets(
          documentId,
          staged.vaultBasePath,
          staged.assets,
        ),
      );
      const remoteContent = await runPublishStage(
        options,
        'fetch_remote',
        () => options.cli.fetchDocumentContent(documentId),
      );
      await runPublishStage(options, 'verify_remote', () => {
        const verification = verifyFeishuRemoteContent(options.snapshot, remoteContent);
        if (!verification.ok) {
          throw new Error(`${verification.message}；关联已保留，请先打开文档核对后再重试。`);
        }
      });

      const completed: FeishuPublishState = {
        documentId,
        url,
        contentHash: options.snapshot.contentHash,
        updatedAt: now(),
        title: options.snapshot.title,
      };
      await runPublishStage(options, 'persist_complete', () => options.persistState(completed));
      result = completed;
    } catch (error) {
      operationError = error;
    }
    try {
      await staged.cleanup();
    } catch (cleanupError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          '飞书同步失败，且图片临时目录未能清理。',
        );
      }
      try {
        options.onCleanupWarning?.(cleanupError);
        options.onStage?.({
          stage: 'insert_assets',
          status: 'failed',
          message: '飞书同步已完成，但图片临时目录未能自动清理。',
        });
      } catch {
        // Cleanup diagnostics must not turn a completed remote transaction into a failure.
      }
    }
    if (operationError !== undefined) {
      throw operationError instanceof Error
        ? operationError
        : new Error('飞书同步失败。', { cause: operationError });
    }
    if (!result) {
      throw new Error('飞书同步未返回完成状态。');
    }
    return result;
  });
}

function pendingState(
  documentId: string,
  url: string,
  title: string,
  updatedAt: string,
): FeishuPublishState {
  return {
    documentId,
    url,
    contentHash: '',
    updatedAt,
    title,
  };
}
