import { TRPCError } from '@trpc/server';

export class RateLimit {
  private entries = new Map<string, { count: number; expiresAt: number }>();

  check(key: string, maximum: number, windowMs: number, now = Date.now()) {
    if (this.entries.size > 10_000) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(entryKey);
      }
      if (this.entries.size > 10_000) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Server is busy. Try again shortly.' });
    }
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.entries.set(key, { count: 1, expiresAt: now + windowMs });
      return;
    }
    if (entry.count >= maximum) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Try again shortly.' });
    entry.count += 1;
  }
}
