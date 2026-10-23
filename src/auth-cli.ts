import './bootstrap.js';
import { login, logout } from './auth.js';
import { listModels, ChatGPTProvider } from './provider.js';
import { readCredential, runtimeLock } from './vault.js';
import { safeError, UserError } from './errors.js';
import { reasoningEffort } from './config.js';

let release: (() => void) | undefined;
try {
  release = runtimeLock();
  process.once('exit', () => release?.());
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  switch (process.argv[2]) {
    case 'login': await login(); break;
    case 'logout': await logout(); break;
    case 'status': {
      const credential = readCredential();
      console.log(credential ? 'Protected ChatGPT connection exists. Connectivity and eligibility have not been checked.' : 'ChatGPT is not connected.');
      break;
    }
    case 'models': {
      const models = await listModels();
      console.log(models.map(m => `${m.slug}\t${m.display_name}`).join('\n')); break;
    }
    case 'test': {
      const models = await listModels();
      const model = process.env.CHATGPT_MODEL?.trim() || models[0]!.slug;
      if (!models.some(m => m.slug === model)) throw new UserError('CHATGPT_MODEL is not in your account model catalog.');
      console.log('Sending one short test request using your ChatGPT plan allowance.');
      const answer = await new ChatGPTProvider(model, undefined, undefined, reasoningEffort()).generate([{ role: 'user', content: 'Say exactly: Hello from my ChatGPT plan.' }], AbortSignal.timeout(120000));
      console.log(answer); break;
    }
    default: console.log('Usage: npm run auth -- login | status | models | test | logout');
  }
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { release?.(); }
