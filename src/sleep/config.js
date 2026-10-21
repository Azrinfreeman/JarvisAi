import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const assets = resolve(process.env.SLEEP_ASSET_DIR || resolve(projectRoot, 'assets'));

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1000) {
    throw new Error(`${name} must be an integer of at least 1000 milliseconds`);
  }
  return value;
}

function rainVolume() {
  const value = Number(process.env.RAIN_VOLUME ?? 0.2);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('RAIN_VOLUME must be a number from 0 to 1');
  }
  return value;
}

export function loadConfig() {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  if (!token || token === 'replace-with-bot-token') throw new Error('DISCORD_TOKEN is required');
  if (!/^\d{15,25}$/.test(applicationId ?? '')) throw new Error('DISCORD_APPLICATION_ID must be a Discord ID');
  const minReconnectMs = positiveInteger('RECONNECT_MIN_MS', 5000);
  const maxReconnectMs = positiveInteger('RECONNECT_MAX_MS', 300000);
  if (maxReconnectMs < minReconnectMs) throw new Error('RECONNECT_MAX_MS must be >= RECONNECT_MIN_MS');
  const testGuildId = process.env.TEST_GUILD_ID || undefined;
  if (testGuildId && !/^\d{15,25}$/.test(testGuildId)) throw new Error('TEST_GUILD_ID must be a Discord ID');
  return {
    token,
    applicationId,
    testGuildId,
    databasePath: resolve(process.env.SLEEP_DATABASE_PATH || resolve(projectRoot, 'data/sleep/sessions.sqlite')),
    rainAssetPath: resolve(process.env.RAIN_ASSET_PATH || assets + '/rain-loop.pcm'),
    rainScenePaths: {
      soft: resolve(assets + '/rain-soft-loop.pcm'),
      forest: resolve(process.env.RAIN_ASSET_PATH || assets + '/rain-loop.pcm'),
      indoor: resolve(assets + '/rain-indoor-loop.pcm'),
      glass: resolve(assets + '/rain-glass-loop.pcm'),
      heavy: resolve(assets + '/rain-heavy-loop.pcm'),
    },
    thunderPaths: [
      resolve(assets + '/thunder-distant-a.pcm'),
      resolve(assets + '/thunder-distant-b.pcm'),
      resolve(assets + '/thunder-distant-c.pcm'),
      resolve(assets + '/thunder-distant-d.pcm'),
    ],
    rainVolume: rainVolume(),
    sunnyAssetPath: resolve(process.env.SUNNY_ASSET_PATH || assets + '/sunny-birds-loop.pcm'),
    controllerRoleIds: new Set((process.env.CONTROLLER_ROLE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
    minReconnectMs,
    maxReconnectMs,
  };
}
