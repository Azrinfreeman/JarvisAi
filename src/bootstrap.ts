// Evaluate before modules that resolve configuration-dependent paths.
import { SettingsStore } from './settings.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from './app-paths.js';
if (existsSync(join(stateRoot,'data/import.pending'))) throw new Error('An interrupted desktop import needs verified recovery before starting the bot.');
const settings = new SettingsStore().effective();
for (const [key, value] of Object.entries(settings.env)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
process.env.BOT_CONFIG_REVISION = settings.revision;
