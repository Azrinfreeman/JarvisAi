import { UserError } from './errors.js';

export class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<string>();
  private cooldowns = new Map<string, number>();
  constructor(private capacity = 4, private cooldownMs = 5000) {}

  isBusy(key: string) { return this.active.has(key); }
  run<T>(key: string, task: () => Promise<T>, cooldownKey = key): Promise<T> {
    if (this.active.has(key)) return Promise.reject(new UserError('You already have a request running. Wait for it before asking or resetting.'));
    if (this.active.size >= this.capacity) return Promise.reject(new UserError('The bot is busy. Try again shortly.'));
    const now = Date.now();
    for (const [entry, time] of this.cooldowns) if (now - time > Math.max(this.cooldownMs, 60000)) this.cooldowns.delete(entry);
    if (now - (this.cooldowns.get(cooldownKey) ?? 0) < this.cooldownMs) return Promise.reject(new UserError('Wait a few seconds before your next question.'));
    this.active.add(key);
    this.cooldowns.set(cooldownKey, now);
    const result = this.tail.then(task).finally(() => { this.active.delete(key); });
    this.tail = result.catch(() => {});
    return result;
  }
}

export function splitReply(text: string, limit = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    // Avoid separating a UTF-16 surrogate pair (for example an emoji).
    const code = remaining.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['No text response was returned.'];
}
