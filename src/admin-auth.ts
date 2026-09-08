import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;

export function createPasswordHash(password: string): string {
  if ([...password].length < 20) throw new Error("管理员密码至少需要 20 位");
  const salt = randomBytes(24);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024
  });
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [scheme, costText, blockText, parallelText, saltText, keyText] = encoded.split("$");
    if (scheme !== "scrypt" || !costText || !blockText || !parallelText || !saltText || !keyText) return false;
    const cost = Number(costText);
    const blockSize = Number(blockText);
    const parallelization = Number(parallelText);
    if (cost !== SCRYPT_COST || blockSize !== SCRYPT_BLOCK_SIZE || parallelization !== SCRYPT_PARALLELIZATION) return false;
    const expected = Buffer.from(keyText, "base64url");
    if (expected.length !== KEY_LENGTH) return false;
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, {
      cost,
      blockSize,
      parallelization,
      maxmem: 64 * 1024 * 1024
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

interface Session {
  csrf: string;
  expiresAt: number;
}

export class AdminSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly durationMs: number) {}

  create(now = Date.now()): { token: string; csrf: string; expiresAt: number } {
    this.cleanup(now);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now + this.durationMs;
    this.sessions.set(token, { csrf, expiresAt });
    return { token, csrf, expiresAt };
  }

  get(token: string | undefined, now = Date.now()): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(token);
      return null;
    }
    return session;
  }

  delete(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private cleanup(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maximum = 5,
    private readonly windowMs = 15 * 60 * 1000
  ) {}

  canAttempt(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((instant) => instant > now - this.windowMs);
    if (recent.length === 0) this.attempts.delete(key);
    else this.attempts.set(key, recent);
    return recent.length < this.maximum;
  }

  fail(key: string, now = Date.now()): void {
    const recent = (this.attempts.get(key) ?? []).filter((instant) => instant > now - this.windowMs);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  success(key: string): void {
    this.attempts.delete(key);
  }
}
