/** Single-process FIFO executor. All normalization (including remux) uses this lane. */
export class MediaQueue {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private closed = false;
  private abort = new AbortController();
  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Media queue is closed"));
    this.count++;
    const result = this.tail.then(() => job(this.abort.signal));
    this.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.count--;
      });
    return result;
  }
  size() {
    return this.count;
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.tail;
  }
}
