import { createHash } from "node:crypto";
import he from "he";

export function cleanTweetText(input: string): string {
  return he
    .decode(input)
    .replace(/\\?<br\s*\/?\\?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

export function stableId(...parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u001f"))
    .digest("hex")
    .slice(0, 24);
}

export function truncate(input: string, length: number): string {
  if (input.length <= length) return input;
  return `${input.slice(0, Math.max(0, length - 1))}…`;
}
