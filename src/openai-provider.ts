import { ChatGPTProvider } from './provider.js';
import { UserError } from './errors.js';
import type { ReasoningEffort } from './config.js';
import { botInstructions } from './personality.js';

export function apiError(status: number, code?: string): UserError {
  if (status === 401 || status === 403 || code === 'invalid_api_key') return new UserError('The API key was not authorized. Check the key and project permissions in Settings.');
  if (status === 429 || code === 'insufficient_quota') return new UserError('API usage is limited. Check the API project quota and billing before trying again.');
  if (status === 400 || status === 404) return new UserError('The API model or options are unavailable. Check the model, reasoning, and web search settings.');
  return new UserError('The API request could not complete. Check connectivity and model access. No provider fallback or automatic retry was used.');
}

export async function apiModels(key: string, request: typeof fetch = fetch): Promise<string[]> {
  if (!key) throw new UserError('Add your API key in Settings first.');
  const response = await request('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect:'error',
  });
  if (!response.ok) throw apiError(response.status);
  const body = await response.json() as { data?: Array<{id?:unknown}> };
  if (!Array.isArray(body.data)) throw new UserError('The API returned an unexpected model catalog.');
  return body.data.flatMap(model => typeof model.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model.id) ? [model.id] : []).slice(0, 500).sort();
}

export class OpenAIProvider extends ChatGPTProvider {
  constructor(model: string, key: string, effort?: ReasoningEffort, webSearch = false, request: typeof fetch = fetch, instructions = botInstructions) {
    if (!key || !model) throw new UserError('Add an API key and model in Settings first.');
    super(model, async () => key, request, effort, instructions, { webSearch, errorFor: apiError });
  }
}
