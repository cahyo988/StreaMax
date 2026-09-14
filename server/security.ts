import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, value] = stored.split(":");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(value, "hex");
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function decrypt(value: string, key: string) {
  const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function redact(value: string) {
  return value.replace(/rtmps?:\/\/[^\s'"\]]+/gi, "[destination redacted]");
}
