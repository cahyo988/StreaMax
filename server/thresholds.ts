import { cpus } from "node:os";
import { statfs } from "node:fs/promises";
import type { Store } from "./store.ts";

export class ThresholdMonitor {
  private previous = cpus().map((cpu) => cpu.times);
  private active = new Set<string>();
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  constructor(
    private store: Store,
    private directory: string,
  ) {}
  evaluate(cpu: number, disk: number) {
    const settings = this.store.get("settings", "system");
    if (!settings?.thresholdAlerts) {
      this.active.clear();
      return;
    }
    for (const [name, value, threshold] of [
      ["CPU", cpu, settings.cpuThreshold ?? 90],
      ["Disk", disk, settings.diskThreshold ?? 90],
    ] as const) {
      if (value >= threshold && !this.active.has(name)) {
        this.active.add(name);
        this.store.event(
          "monitor",
          "system.threshold",
          name,
          `${name} usage ${Math.round(value)}% exceeds ${threshold}%`,
        );
      } else if (value < threshold - 5) this.active.delete(name);
    }
  }
  async sample() {
    const current = cpus().map((cpu) => cpu.times);
    let idle = 0,
      total = 0;
    current.forEach((times, i) => {
      const previous = this.previous[i] || times;
      idle += times.idle - previous.idle;
      total +=
        Object.values(times).reduce((a, b) => a + b, 0) -
        Object.values(previous).reduce((a, b) => a + b, 0);
    });
    this.previous = current;
    const disk = await statfs(this.directory);
    this.evaluate(
      total ? (1 - idle / total) * 100 : 0,
      disk.blocks ? (1 - disk.bavail / disk.blocks) * 100 : 0,
    );
  }
  start() {
    this.timer = setInterval(() => {
      if (!this.pending)
        this.pending = this.sample()
          .catch(() => {})
          .finally(() => {
            this.pending = undefined;
          });
    }, 30000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await this.pending;
  }
}
