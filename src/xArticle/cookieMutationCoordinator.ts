export class XCookieMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private readonly controllers = new Set<AbortController>();

  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error('Ailu 正在关闭，已停止接收 X 登录态写入。'));
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const previous = this.tail;
    const result = previous.catch(() => undefined).then(async () => {
      if (!this.accepting || controller.signal.aborted) {
        throw new Error('X 登录态写入已取消。');
      }
      return operation(controller.signal);
    });
    this.tail = result.then(() => undefined, () => undefined);
    void result.finally(() => this.controllers.delete(controller)).catch(() => undefined);
    return result;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const controller of this.controllers) controller.abort();
    await this.tail;
  }
}
