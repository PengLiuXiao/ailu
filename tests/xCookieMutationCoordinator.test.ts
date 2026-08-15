import { XCookieMutationCoordinator } from '../src/xArticle/cookieMutationCoordinator';

describe('X Cookie mutation coordinator', () => {
  test('serializes imports and exports in admission order', async () => {
    const coordinator = new XCookieMutationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = coordinator.run(async () => {
      events.push('first:start');
      await firstBarrier;
      events.push('first:end');
      return 1;
    });
    const second = coordinator.run(async () => {
      events.push('second:start');
      return 2;
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('aborts the active operation, rejects queued work, and closes admission on shutdown', async () => {
    const coordinator = new XCookieMutationCoordinator();
    let signalActive!: () => void;
    const started = new Promise<void>(resolve => { signalActive = resolve; });
    const active = coordinator.run(signal => new Promise<void>((_resolve, reject) => {
      signalActive();
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const queued = coordinator.run(async () => undefined);

    await started;
    await coordinator.shutdown();
    await expect(active).rejects.toThrow('aborted');
    await expect(queued).rejects.toThrow('取消');
    await expect(coordinator.run(async () => undefined)).rejects.toThrow('停止接收');
  });
});
