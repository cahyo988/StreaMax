import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";

export type NetworkCounters = { received: number; sent: number };

export function parseNetworkCounters(input: string): NetworkCounters {
  const totals = { received: 0, sent: 0 };
  for (const line of input.split("\n").slice(2)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (
      fields.length < 9 ||
      !Number.isFinite(fields[0]) ||
      !Number.isFinite(fields[8])
    )
      continue;
    totals.received += fields[0];
    totals.sent += fields[8];
  }
  return totals;
}

export function readNetworkCounters(): NetworkCounters | null {
  try {
    return parseNetworkCounters(readFileSync("/proc/net/dev", "utf8"));
  } catch {
    return null;
  }
}

export function readTemperatureC(): number | null {
  try {
    const temperatures = readdirSync("/sys/class/thermal")
      .filter((name) => /^thermal_zone\d+$/.test(name))
      .map((name) => {
        const value = Number(
          readFileSync(`/sys/class/thermal/${name}/temp`, "utf8").trim(),
        );
        return value > 1000 ? value / 1000 : value;
      })
      .filter((value) => Number.isFinite(value) && value > 0 && value < 200);
    return temperatures.length
      ? Math.round(Math.max(...temperatures) * 10) / 10
      : null;
  } catch {
    return null;
  }
}
