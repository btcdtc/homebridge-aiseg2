export class LatestActionQueue<T> {
  private running = false;
  private hasQueuedValue = false;
  private queuedValue?: T;

  constructor(private readonly handler: (value: T) => Promise<void>) {
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasQueued(): boolean {
    return this.hasQueuedValue;
  }

  enqueue(value: T): Promise<void> {
    this.queuedValue = value;
    this.hasQueuedValue = true;

    if (this.running) {
      return Promise.resolve();
    }

    this.running = true;
    return this.drain();
  }

  private async drain(): Promise<void> {
    let firstError: unknown;

    try {
      while (this.hasQueuedValue) {
        const value = this.queuedValue as T;
        this.queuedValue = undefined;
        this.hasQueuedValue = false;
        try {
          await this.handler(value);
        } catch (error) {
          firstError ??= error;
        }
      }
    } finally {
      this.running = false;
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
