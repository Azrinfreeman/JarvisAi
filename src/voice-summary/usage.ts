import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UserError } from '../errors.js';

export class VoiceUsage {
  private db:DatabaseSync;
  constructor(path:string, private limitSeconds:number, private now=()=>new Date()) {
    mkdirSync(dirname(path),{recursive:true}); this.db=new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, seconds INTEGER NOT NULL)');
  }
  get month() { return this.now().toISOString().slice(0,7); }
  get seconds() { return Number(this.db.prepare('SELECT seconds FROM usage WHERE month=?').get(this.month)?.seconds ?? 0); }
  reserve(seconds:number) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new UserError('Invalid transcription usage.');
    const reserved=Math.ceil(seconds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.seconds+reserved > this.limitSeconds) throw new UserError('The local monthly transcription allowance is exhausted. Check voice-summary settings and API billing.');
      this.db.prepare('INSERT INTO usage(month,seconds) VALUES(?,?) ON CONFLICT(month) DO UPDATE SET seconds=seconds+excluded.seconds').run(this.month,reserved);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
