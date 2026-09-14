import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type DestinationProbeResult = { transport: "tcp" | "tls" };

export function probeDestination(
  address: string,
  timeoutMs = 5000,
): Promise<DestinationProbeResult> {
  const url = new URL(address);
  if (!["rtmp:", "rtmps:"].includes(url.protocol) || !url.hostname)
    return Promise.reject(new Error("Unsupported destination protocol"));
  const transport = url.protocol === "rtmps:" ? "tls" : "tcp";
  const port = Number(url.port || (transport === "tls" ? 443 : 1935));
  return new Promise((resolve, reject) => {
    const socket =
      transport === "tls"
        ? tlsConnect({ host: url.hostname, port, servername: url.hostname })
        : tcpConnect({ host: url.hostname, port });
    const connected = transport === "tls" ? "secureConnect" : "connect";
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new Error("Destination probe timed out")),
    );
    socket.once(connected, () => {
      socket.destroy();
      resolve({ transport });
    });
    socket.once("error", reject);
  });
}
