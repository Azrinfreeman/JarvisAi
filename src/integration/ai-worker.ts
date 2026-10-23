import { join } from 'node:path';
import { ChatService } from '../chat.js';
import { Conversations } from '../storage.js';
import { ChatGPTProvider, StubProvider, listModels } from '../provider.js';
import { reasoningEffort } from '../config.js';
import { dataDir, runtimeLock } from '../vault.js';
import { UserError, safeError } from '../errors.js';
import { responseMessages } from '../responses.js';
import { botInstructions } from '../personality.js';
import type { ReferencedInput } from '../replies.js';
import { validToWorker, type FromWorker, type WorkerStatus } from './protocol.js';
import { nicknameIntent } from '../nickname-request.js';
import { OpenAIProvider, apiModels } from '../openai-provider.js';

if (!process.send) throw new Error('AI worker requires local IPC.');
const send = (message: FromWorker) => { if (process.connected) process.send!(message, () => {}); };
const state = (phase: WorkerStatus['phase'], label: string) => send({ type:'status', status:{phase,label} });
let chat: ChatService | undefined;
let store: Conversations | undefined;
let release: (() => void) | undefined;
const controllers = new Map<string, AbortController>();
type Waiter = { kind: 'reference' | 'delivery' | 'nickname'; resolve: (value?: ReferencedInput|string) => void; reject: (error: Error) => void; cleanup: () => void };
const waiting = new Map<string, Waiter>();
function wait(id: string, kind: Waiter['kind'], signal: AbortSignal): Promise<ReferencedInput|string|undefined> {
  return new Promise((resolve,reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); waiting.delete(id); };
    const abort = () => { cleanup(); reject(new UserError('AI request was cancelled before delivery completed.')); };
    const timer = setTimeout(abort, kind === 'reference' ? 20000 : kind === 'nickname' ? 45000 : 30000);
    waiting.set(id,{kind, resolve, reject, cleanup});
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
  });
}
function shutdown() {
  chat?.close(); for (const controller of controllers.values()) controller.abort();
  store?.close(); store = undefined; release?.(); release = undefined;
}
process.once('exit',shutdown);
process.once('disconnect',() => process.exit(0));
process.once('SIGTERM',() => process.exit(0));
process.once('SIGINT',() => process.exit(0));
process.on('message', raw => {
  if (!validToWorker(raw)) return;
  const message = raw;
  if (message.type === 'shutdown') { process.exit(0); return; }
  const id = message.id;
  if (message.type === 'cancel') { controllers.get(id)?.abort(); return; }
  if (message.type === 'reference' || message.type === 'delivered' || message.type === 'nickname_result') {
    const pending = waiting.get(id);
    if (!pending || pending.kind !== (message.type === 'reference' ? 'reference' : message.type === 'nickname_result' ? 'nickname' : 'delivery')) return;
    pending.cleanup();
    if (message.type === 'reference') {
      if (message.error || !message.value) pending.reject(new UserError(message.error || 'Referenced message was not available.'));
      else pending.resolve(message.value);
    } else if (message.type === 'nickname_result') {
      if (message.error) pending.reject(new UserError(message.error)); else pending.resolve(message.result);
    } else if (!message.success) pending.reject(new UserError('Discord delivery failed. No conversation turn was saved.'));
    else pending.resolve();
    return;
  }
  if (!chat || !store) { send({type:'failed',id,error:'AI is unavailable; sleep controls still work.'}); return; }
  if (controllers.has(id)) return;
  if (message.type === 'reset') {
    try { chat.reset(message.identity); send({type:'done',id}); }
    catch(error) { send({type:'failed',id,error:safeError(error)}); }
    return;
  }
  if (!store.claimEvent(message.input.eventKey)) { send({type:'duplicate',id}); return; }
  const controller = new AbortController(); controllers.set(id,controller);
  // This timer includes queue waiting and delivery acknowledgment.
  const deadline = setTimeout(() => controller.abort(), 650000);
  const input = message.input;
  if (input.nickname) {
    let direct; try { direct=nicknameIntent(input.prompt); } catch {}
    if (!direct || direct.targetId!==input.nickname.targetId || direct.nickname!==input.nickname.nickname) {
      clearTimeout(deadline); controllers.delete(id);
      send({type:'failed',id,error:'Nickname capability did not match the current direct request.'}); return;
    }
  }
  void chat.ask(input.identity,input.prompt,async (answer,imageData) => {
    const [payload] = await responseMessages(input.prompt,answer,imageData,input.sourceUrl,input.attachmentLimit,input.useImageEmbeds);
    const delivered = wait(id,'delivery',controller.signal);
    send({type:'result',id,payload}); await delivered;
  }, {
    signal:controller.signal, image:input.image,
    reference:input.hasReference ? async () => {
      const loaded = wait(id,'reference',controller.signal); send({type:'reference',id});
      return (await loaded) as ReferencedInput;
    } : undefined,
    nickname:input.nickname ? {request:input.nickname,execute:async(request,signal)=>{
      const done=wait(id,'nickname',signal); send({type:'nickname',id,request}); return (await done) as string;
    }} : undefined,
  }).then(() => send({type:'done',id})).catch(error => send({type:'failed',id,error:safeError(error)}))
    .finally(() => { clearTimeout(deadline); controllers.delete(id); });
});
try {
  state('starting','Starting AI connection');
  release = runtimeLock();
  store = new Conversations(join(dataDir,'conversations.sqlite'));
  const stub = process.env.AI_PROVIDER === 'stub';
  if (stub) { chat = new ChatService(new StubProvider(),store); state('ready','Offline stub (no AI request)'); }
  else {
    const instructions = () => `${botInstructions()}\n\nYour AI persona is Jarvis. This combined Discord application may be displayed as RainBot; Jarvis and RainBot both refer to you. This Discord bot also provides deterministic /sleep commands. You cannot join, leave, change ambience or control voice. For requested sleep actions, direct the member to the appropriate /sleep command; never claim an action was executed.`;
    if (process.env.AI_PROVIDER === 'openai') {
      const key = process.env.OPENAI_API_KEY ?? '';
      const model = process.env.OPENAI_MODEL?.trim() ?? '';
      const models = await apiModels(key);
      if (!models.includes(model)) throw new UserError('The configured API model is not available to this key. Check Settings.');
      const effort = reasoningEffort({ CHATGPT_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT });
      chat = new ChatService(new OpenAIProvider(model,key,effort,process.env.OPENAI_WEB_SEARCH === 'true',fetch,instructions),store);
      state('ready',`OpenAI API / ${model}`);
    } else {
      const models = await listModels();
      const model = process.env.CHATGPT_MODEL?.trim() || models[0]!.slug;
      if (!models.some(item => item.slug === model)) throw new UserError('Configured AI model is unavailable. Stop the combined bot and check auth models.');
      const effort = reasoningEffort();
      chat = new ChatService(new ChatGPTProvider(model,undefined,undefined,effort,instructions),store);
      state('ready',`ChatGPT plan / ${model}${effort ? ` / reasoning ${effort}` : ''}`);
    }
  }
} catch(error) {
  state('unavailable',safeError(error));
  // Give the parent time to receive the status before the supervised restart.
  setTimeout(() => process.exit(1),100);
}
