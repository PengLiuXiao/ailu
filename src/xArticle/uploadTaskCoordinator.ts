import { randomUUID } from 'crypto';

import type {
  XArticleProgress,
  XArticleUploadOutcome,
} from './types';

export type XArticleUploadTaskStatus = 'running' | 'settled' | 'failed';

export interface XArticleUploadTaskSnapshot {
  taskId: string;
  sourcePath: string;
  sourceHash: string;
  status: XArticleUploadTaskStatus;
  progressLabel: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: XArticleUploadOutcome | null;
  error: string | null;
}

export interface StartXArticleUploadTaskInput {
  sourcePath: string;
  sourceHash: string;
  run: (
    signal: AbortSignal,
    onProgress: (progress: XArticleProgress) => void,
  ) => Promise<XArticleUploadOutcome>;
}

export interface XArticleUploadTaskHandle {
  taskId: string;
  completion: Promise<XArticleUploadOutcome>;
}

interface ActiveXArticleUploadTask {
  controller: AbortController;
  completion: Promise<XArticleUploadOutcome>;
  snapshot: XArticleUploadTaskSnapshot;
}

/**
 * Owns a confirmed X upload independently from whichever Studio panel happens
 * to be mounted. Switching between Chat and Draft replaces the Obsidian view;
 * it must not terminate a browser mutation that the user already confirmed.
 */
export class XArticleUploadTaskCoordinator {
  private task: ActiveXArticleUploadTask | null = null;
  private readonly listeners = new Set<() => void>();
  private closed = false;

  snapshot(): XArticleUploadTaskSnapshot | null {
    return this.task ? { ...this.task.snapshot } : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(input: StartXArticleUploadTaskInput): XArticleUploadTaskHandle {
    if (this.closed) throw new Error('X Article upload service is shutting down.');
    if (this.task) {
      throw new Error(this.task.snapshot.status === 'running'
        ? '另一项 X 草稿任务仍在运行。'
        : '上一个 X 草稿结果仍待核对。');
    }
    const controller = new AbortController();
    const taskId = randomUUID();
    const snapshot: XArticleUploadTaskSnapshot = {
      taskId,
      sourcePath: input.sourcePath,
      sourceHash: input.sourceHash,
      status: 'running',
      progressLabel: '正在启动独立 Playwright 浏览器…',
      startedAt: Date.now(),
      finishedAt: null,
      outcome: null,
      error: null,
    };
    const execute = Promise.resolve().then(() => input.run(
      controller.signal,
      progress => this.recordProgress(taskId, progress.message),
    ));
    const completion = execute.then(
      outcome => {
        if (this.task?.snapshot.taskId === taskId) {
          this.task.snapshot = {
            ...this.task.snapshot,
            status: 'settled',
            progressLabel: '',
            finishedAt: Date.now(),
            outcome,
            error: null,
          };
          this.notify();
        }
        return outcome;
      },
      error => {
        if (this.task?.snapshot.taskId === taskId) {
          this.task.snapshot = {
            ...this.task.snapshot,
            status: 'failed',
            progressLabel: '',
            finishedAt: Date.now(),
            outcome: null,
            error: error instanceof Error ? error.message : String(error),
          };
          this.notify();
        }
        throw error;
      },
    );
    this.task = { controller, completion, snapshot };
    // A detached panel may stop awaiting the task. Keep the coordinator-owned
    // rejection observed while retaining the same promise for mounted panels.
    void completion.catch(() => {});
    this.notify();
    return { taskId, completion };
  }

  acknowledge(taskId: string): boolean {
    if (!this.task || this.task.snapshot.taskId !== taskId) return false;
    if (this.task.snapshot.status === 'running') return false;
    this.task = null;
    this.notify();
    return true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const current = this.task;
    if (current?.snapshot.status === 'running') {
      current.controller.abort('plugin-shutdown');
      await current.completion.catch(() => {});
    }
    this.listeners.clear();
  }

  private recordProgress(taskId: string, message: string): void {
    if (!this.task || this.task.snapshot.taskId !== taskId) return;
    if (this.task.snapshot.status !== 'running') return;
    this.task.snapshot = { ...this.task.snapshot, progressLabel: message };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A stale UI listener cannot affect the background upload contract.
      }
    }
  }
}
