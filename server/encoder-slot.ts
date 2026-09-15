/** One CPU encoder across uploads and live outputs. Copy never takes a slot. */
export class EncoderSlot {
  private active = false;
  private waiters: Array<() => void> = [];
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.waiters = this.waiters.filter((entry) => entry !== enter);
        reject(new Error("Encoder wait interrupted"));
      };
      const enter = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          cancel();
          this.next();
          return;
        }
        this.active = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.next();
        });
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      if (this.active) this.waiters.push(enter);
      else enter();
    });
  }
  private next() {
    this.active = false;
    this.waiters.shift()?.();
  }
}
