import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class SessionStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('silent', 'rain', 'sunny')),
        state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'disabled')),
        reason TEXT,
        rain_style TEXT NOT NULL DEFAULT 'variety',
        updated_at TEXT NOT NULL
      )
    `);
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'rain_style')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN rain_style TEXT NOT NULL DEFAULT 'variety'");
    }
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().sql;
    if (!schema.includes("'sunny'")) {
      // SQLite cannot alter a CHECK constraint in place. Copy all saved fields
      // in one transaction so existing sessions survive the mode upgrade.
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE sessions_mode_upgrade (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('silent', 'rain', 'sunny')),
            state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'disabled')),
            reason TEXT,
            rain_style TEXT NOT NULL DEFAULT 'variety',
            updated_at TEXT NOT NULL
          );
          INSERT INTO sessions_mode_upgrade (guild_id, channel_id, mode, state, reason, rain_style, updated_at)
            SELECT guild_id, channel_id, mode, state, reason, rain_style, updated_at FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_mode_upgrade RENAME TO sessions;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        this.db.close();
        throw error;
      }
    }
    this.getStmt = this.db.prepare('SELECT * FROM sessions WHERE guild_id = ?');
    this.activeStmt = this.db.prepare("SELECT * FROM sessions WHERE state = 'active'");
    this.upsertStmt = this.db.prepare(`
      INSERT INTO sessions (guild_id, channel_id, mode, state, reason, updated_at, rain_style)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id=excluded.channel_id, mode=excluded.mode,
        state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at,
        rain_style=excluded.rain_style
    `);
  }

  get(guildId) { return this.getStmt.get(guildId) ?? null; }
  active() { return this.activeStmt.all(); }
  save({ guildId, channelId, mode, state, reason = null, rainStyle }) {
    const style = rainStyle ?? this.get(guildId)?.rain_style ?? 'variety';
    this.upsertStmt.run(guildId, channelId, mode, state, reason, new Date().toISOString(), style);
    return this.get(guildId);
  }
  close() { this.db.close(); }
}
