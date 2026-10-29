import type { ChatIdentity } from '../chat.js';
import type { ImageAttachment } from '../images.js';
import type { ReferencedInput } from '../replies.js';
import type { ReplyPayload } from '../responses.js';
import { validNicknameRequest, type NicknameRequest } from '../nickname-request.js';
import { validVoiceSummaryInput, VOICE_SUMMARY_MAX_CHARS, type VoiceSummaryInput } from '../voice-summary/summary.js';

export type WorkerStatus = { phase: 'starting' | 'ready' | 'unavailable' | 'restarting'; label: string };
export type AskInput = {
  eventKey: string; identity: ChatIdentity; prompt: string; image?: ImageAttachment; hasReference?: boolean;
  sourceUrl?: string; attachmentLimit?: number; useImageEmbeds?: boolean; nickname?:NicknameRequest;
};
export type ToWorker =
  | { type: 'voice_summary'; id: string; input: VoiceSummaryInput }
  | { type: 'ask'; id: string; input: AskInput }
  | { type: 'reset'; id: string; identity: ChatIdentity }
  | { type: 'reference'; id: string; value?: ReferencedInput; error?: string }
  | { type: 'delivered'; id: string; success: boolean }
  | { type: 'nickname_result'; id: string; result?:string; error?:string }
  | { type: 'cancel'; id: string }
  | { type: 'shutdown' };
export type FromWorker =
  | { type: 'voice_summary_result'; id: string; result: string; error?: never }
  | { type: 'voice_summary_result'; id: string; error: string; result?: never }
  | { type: 'status'; status: WorkerStatus }
  | { type: 'reference'; id: string }
  | { type: 'result'; id: string; payload: ReplyPayload }
  | { type: 'nickname'; id:string; request:NicknameRequest }
  | { type: 'done' | 'duplicate'; id: string }
  | { type: 'failed'; id: string; error: string };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const exactKeys = (v: Record<string, unknown>, expected: string[]) =>
  !Array.isArray(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const summaryId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
export function validIdentity(v: unknown): v is ChatIdentity {
  return record(v) && ['guildId','channelId','userId'].every(k => typeof v[k] === 'string' && /^\d{17,20}$/.test(v[k] as string))
    && (v.visibility === undefined || ['private','public'].includes(String(v.visibility)));
}
function validImage(v: unknown): boolean {
  return v === undefined || record(v) && short(v.url, 4000) && Number.isSafeInteger(v.size) && Number(v.size) > 0
    && Number(v.size) <= 14 * 1024 * 1024 && (v.contentType === null || typeof v.contentType === 'string' && v.contentType.length <= 200);
}
export function validToWorker(v: unknown): v is ToWorker {
  if (!record(v) || !short(v.type, 20)) return false;
  if (v.type === 'shutdown') return true;
  if (!short(v.id, 80)) return false;
  switch(v.type) {
    case 'voice_summary': return exactKeys(v, ['type', 'id', 'input']) && summaryId(v.id) && validVoiceSummaryInput(v.input);
    case 'cancel': return true;
    case 'delivered': return typeof v.success === 'boolean';
    case 'nickname_result': return (short(v.result,600)&&v.error===undefined)||(short(v.error,600)&&v.result===undefined);
    case 'reset': return validIdentity(v.identity);
    case 'reference': return (v.error === undefined || short(v.error, 500)) && (v.value === undefined || record(v.value)
      && typeof v.value.text === 'string' && v.value.text.length <= 40000 && validImage(v.value.image));
    case 'ask': {
      const a = v.input;
      return record(a) && validIdentity(a.identity) && short(a.prompt, 4000) && validImage(a.image)
        && typeof a.eventKey === 'string' && /^(message|interaction):\d{17,20}:\d{17,20}$/.test(a.eventKey)
        && (a.hasReference === undefined || typeof a.hasReference === 'boolean')
        && (a.sourceUrl === undefined || typeof a.sourceUrl === 'string' && /^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}$/.test(a.sourceUrl))
        && (a.attachmentLimit === undefined || Number.isSafeInteger(a.attachmentLimit) && Number(a.attachmentLimit) > 0 && Number(a.attachmentLimit) <= 1024 ** 3)
        && (a.useImageEmbeds === undefined || typeof a.useImageEmbeds === 'boolean')
        && (a.nickname === undefined || validNicknameRequest(a.nickname));
    }
    default: return false;
  }
}
export function validFromWorker(v: unknown): v is FromWorker {
  if (!record(v)) return false;
  if (v.type === 'voice_summary_result') return summaryId(v.id) && (
    exactKeys(v, ['type', 'id', 'result']) && short(v.result, VOICE_SUMMARY_MAX_CHARS)
    || exactKeys(v, ['type', 'id', 'error']) && short(v.error, 600));
  if (v.type === 'status') return record(v.status) && ['starting','ready','unavailable','restarting'].includes(String(v.status.phase)) && short(v.status.label, 600);
  if (!short(v.id, 80)) return false;
  if (['reference','done','duplicate'].includes(String(v.type))) return true;
  if (v.type === 'failed') return short(v.error, 600);
  if (v.type === 'nickname') return validNicknameRequest(v.request);
  if (v.type !== 'result' || !record(v.payload)) return false;
  const p = v.payload;
  if (typeof p.content !== 'string' || p.content.length > 2000) return false;
  if (p.embeds !== undefined && (!Array.isArray(p.embeds) || p.embeds.length > 2 || JSON.stringify(p.embeds).length > 10000)) return false;
  if (p.files !== undefined && (!Array.isArray(p.files) || p.files.length > 2 || p.files.some(f => !record(f) || !Buffer.isBuffer(f.attachment)
    || f.attachment.length > 8 * 1024 * 1024 || !short(f.name, 80) || !short(f.description, 200)))) return false;
  return true;
}

export function workerEnvironment(env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
    'AI_DATA_DIR','AI_PROVIDER','CHATGPT_MODEL','CHATGPT_REASONING_EFFORT','BOT_CONFIG_REVISION','RAINBOT_STATE_ROOT','RAINBOT_RESOURCE_ROOT'];
  if ((overrides.AI_PROVIDER ?? env.AI_PROVIDER) === 'openai') allowed.push('OPENAI_API_KEY','OPENAI_MODEL','OPENAI_REASONING_EFFORT','OPENAI_WEB_SEARCH');
  return Object.fromEntries(allowed.flatMap(k => {
    const value = overrides[k] ?? env[k]; return value === undefined ? [] : [[k,value]];
  }));
}
