import { describe, expect, test, vi } from 'vitest';

import { XArticleUploadTaskCoordinator } from '../src/xArticle/uploadTaskCoordinator';
import type {
  XArticlePreflight,
  XArticleUploadOutcome,
} from '../src/xArticle/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function failedOutcome(message = 'failed'): XArticleUploadOutcome {
  return {
    status: 'failed',
    message,
    draftUrl: null,
    artifacts: null,
    preflight: {} as XArticlePreflight,
    result: null,
  };
}

describe('XArticleUploadTaskCoordinator', () => {
  test('keeps a confirmed upload alive when its panel listener detaches', async () => {
    const coordinator = new XArticleUploadTaskCoordinator();
    const pending = deferred<XArticleUploadOutcome>();
    const progress: { report: ((message: string) => void) | null } = { report: null };
    const firstListener = vi.fn();
    const unsubscribe = coordinator.subscribe(firstListener);
    const task = coordinator.start({
      sourcePath: 'Article.md',
      sourceHash: 'source-hash',
      run: async (_signal, onProgress) => {
        progress.report = message => onProgress({ stage: 'upload', message });
        return pending.promise;
      },
    });
    await Promise.resolve();

    unsubscribe();
    progress.report?.('image 22/24');
    expect(coordinator.snapshot()).toMatchObject({
      taskId: task.taskId,
      sourcePath: 'Article.md',
      status: 'running',
      progressLabel: 'image 22/24',
    });

    const remountedListener = vi.fn();
    coordinator.subscribe(remountedListener);
    pending.resolve(failedOutcome('settled after remount'));
    await expect(task.completion).resolves.toMatchObject({ message: 'settled after remount' });
    expect(coordinator.snapshot()).toMatchObject({
      status: 'settled',
      outcome: { message: 'settled after remount' },
    });
    expect(remountedListener).toHaveBeenCalled();
  });

  test('blocks duplicate uploads until the previous result is acknowledged', async () => {
    const coordinator = new XArticleUploadTaskCoordinator();
    const pending = deferred<XArticleUploadOutcome>();
    const first = coordinator.start({
      sourcePath: 'Article.md',
      sourceHash: 'one',
      run: () => pending.promise,
    });

    expect(() => coordinator.start({
      sourcePath: 'Other.md',
      sourceHash: 'two',
      run: async () => failedOutcome(),
    })).toThrow('仍在运行');

    pending.resolve(failedOutcome());
    await first.completion;
    expect(() => coordinator.start({
      sourcePath: 'Other.md',
      sourceHash: 'two',
      run: async () => failedOutcome(),
    })).toThrow('结果仍待核对');
    expect(coordinator.acknowledge(first.taskId)).toBe(true);

    const second = coordinator.start({
      sourcePath: 'Other.md',
      sourceHash: 'two',
      run: async () => failedOutcome('second'),
    });
    await expect(second.completion).resolves.toMatchObject({ message: 'second' });
  });

  test('plugin shutdown aborts and waits for the real task edge', async () => {
    const coordinator = new XArticleUploadTaskCoordinator();
    let observedAbortReason: unknown;
    const task = coordinator.start({
      sourcePath: 'Article.md',
      sourceHash: 'source-hash',
      run: signal => new Promise<XArticleUploadOutcome>(resolve => {
        const settleAbort = () => {
          observedAbortReason = signal.reason;
          resolve(failedOutcome('cancelled by shutdown'));
        };
        if (signal.aborted) settleAbort();
        else signal.addEventListener('abort', settleAbort, { once: true });
      }),
    });

    await coordinator.shutdown();
    await expect(task.completion).resolves.toMatchObject({ message: 'cancelled by shutdown' });
    expect(observedAbortReason).toBe('plugin-shutdown');
    expect(() => coordinator.start({
      sourcePath: 'Other.md',
      sourceHash: 'two',
      run: async () => failedOutcome(),
    })).toThrow('shutting down');
  });

  test('retains a rejected task for a remounted panel to inspect', async () => {
    const coordinator = new XArticleUploadTaskCoordinator();
    const task = coordinator.start({
      sourcePath: 'Article.md',
      sourceHash: 'source-hash',
      run: async () => {
        throw new Error('browser crashed');
      },
    });

    await expect(task.completion).rejects.toThrow('browser crashed');
    expect(coordinator.snapshot()).toMatchObject({
      status: 'failed',
      error: 'browser crashed',
    });
  });
});
