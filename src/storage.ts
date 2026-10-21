import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Message = { role: 'user' | 'assistant'; content: string };

export class Conversations {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY, messages TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        key TEXT PRIMARY KEY, claimed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS processed_events_claimed ON processed_events(claimed);`);
    this.purge();
  }
  private purge() {
    this.db.prepare('DELETE FROM conversations WHERE updated < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  }
  get(key: string): Message[] {
    this.purge();
    const row = this.db.prepare('SELECT messages FROM conversations WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.messages)) as Message[] : [];
  }
  append(key: string, prompt: string, answer: string) {
    let messages = [...this.get(key), { role: 'user', content: prompt }, { role: 'assistant', content: answer }] as Message[];
    // Retain whole turns, at most ten, and at most 24,000 characters of history.
    while (messages.length > 20 || (messages.length > 2 && messages.reduce((n, m) => n + m.content.length, 0) > 24_000)) {
      messages = messages.slice(2);
    }
    this.db.prepare('INSERT OR REPLACE INTO conversations (key, messages, updated) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(messages), Date.now());
  }
  reset(key: string) { this.db.prepare('DELETE FROM conversations WHERE key = ?').run(key); }
  claimEvent(key: string): boolean {
    const now = Date.now();
    this.db.prepare('DELETE FROM processed_events WHERE claimed < ?').run(now - 7 * 24 * 60 * 60 * 1000);
    // A unique SQLite key coordinates duplicate deliveries, restarts, and processes sharing this database.
    return this.db.prepare('INSERT OR IGNORE INTO processed_events (key, claimed) VALUES (?, ?)').run(key, now).changes === 1;
  }
  close() { this.db.close(); }
}
