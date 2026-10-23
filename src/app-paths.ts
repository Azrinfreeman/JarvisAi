import { fileURLToPath } from 'node:url';
import { join, resolve, isAbsolute } from 'node:path';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const packaged = import.meta.url.endsWith('.js');
for (const key of ['RAINBOT_STATE_ROOT', 'RAINBOT_RESOURCE_ROOT']) {
  if (process.env[key] && !isAbsolute(process.env[key]!)) throw new Error(`${key} must be absolute.`);
}
export const resourceRoot = process.env.RAINBOT_RESOURCE_ROOT || sourceRoot;
export const stateRoot = process.env.RAINBOT_STATE_ROOT || sourceRoot;
export const runtimeArguments = packaged ? [] : ['--import', 'tsx'];
export function runtimeEntry(root: string, entry: string) {
  return resolve(process.env.RAINBOT_RESOURCE_ROOT || root, packaged ? entry.replace(/\.ts$/, '.js') : entry);
}
export const defaultAssets = join(resourceRoot, 'assets');
export const runtimePathKeys = ['RAINBOT_STATE_ROOT', 'RAINBOT_RESOURCE_ROOT'] as const;
