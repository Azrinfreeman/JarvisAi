import { accessToken } from './auth.js';
import { UserError, providerError } from './errors.js';
import type { Message } from './storage.js';
import type { ReasoningEffort } from './config.js';
import { botInstructions } from './personality.js';
import { renderWebCitations, webSearchInstructions } from './web-search.js';
import { nicknameGuidance, nicknameTool, validNicknameRequest, type NicknameRequest } from './nickname-request.js';

export type ProviderMessage = Omit<Message, 'content'> & { content: string | Array<
  { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }
> };
export interface Provider {
  generate(messages: ProviderMessage[], signal: AbortSignal, options?: GenerationOptions): Promise<string>;
}
export type GenerationOptions={nickname?:{request:NicknameRequest;execute:(request:NicknameRequest,signal:AbortSignal)=>Promise<string>}};
export type Model = { slug: string; display_name: string };

export async function listModels(): Promise<Model[]> {
  const token = await accessToken();
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!response.ok) throw providerError(response.status);
  const result = await response.json() as { models?: Array<Model & { visibility: string }> };
  if (!Array.isArray(result.models)) throw new UserError('ChatGPT returned an unexpected model catalog. Check the current integration contract.');
  const models = result.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string');
  if (!models.length) throw new UserError('No visible models are available for this ChatGPT connection.');
  return models;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let frameSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Normalize CRLF only after a complete line is available, including split chunks.
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        frameSize += line.length;
        if (frameSize > 1_000_000) throw new UserError('ChatGPT returned an oversized stream event.');
        if (!line) {
          const payload = data.join('\n'); data = []; frameSize = 0;
          if (payload && payload !== '[DONE]') {
            try { yield JSON.parse(payload) as Record<string, unknown>; }
            catch (error) {
              if (error instanceof UserError) throw error;
              throw new UserError('ChatGPT returned an invalid stream event.');
            }
          }
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (buffer.length > 1_000_000) throw new UserError('ChatGPT returned an oversized stream event.');
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function consumeResponse(body: ReadableStream<Uint8Array>, maxChars = 12000,
  execute?: (calls: Array<{name?:unknown;arguments?:unknown}>)=>Promise<string>): Promise<string> {
  let answer = '';
  const annotations: unknown[] = [];
  const streamedCalls=new Map<string,{name:unknown;arguments:unknown}>();
  const checkLimit = (text: string) => {
    if (text.length > maxChars) throw new UserError('The answer exceeded the bot output limit and was cancelled. Ask for a shorter answer. No conversation turn was saved.');
  };
  for await (const event of sseEvents(body)) {
    if (event.type==='response.output_item.done') {
      const item=event.item as Record<string,unknown>|undefined;
      if (item?.type==='function_call') {
        if (typeof item.call_id!=='string' || item.call_id.length>100 || item.status!=='completed'
          || typeof item.name!=='string' || item.name.length>80 || typeof item.arguments!=='string' || item.arguments.length>1000) {
          throw new UserError('Invalid completed action in the AI stream. No nickname was changed.');
        }
        const previous=streamedCalls.get(item.call_id);
        if (previous && (previous.name!==item.name || previous.arguments!==item.arguments)) throw new UserError('Conflicting AI action results. No nickname was changed.');
        streamedCalls.set(item.call_id,{name:item.name,arguments:item.arguments});
        if (streamedCalls.size>1) throw new UserError('More than one AI action was requested. No nickname was changed.');
      }
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      answer += event.delta;
      checkLimit(answer);
    }
    if (event.type === 'response.output_text.annotation.added') annotations.push(event.annotation);
    if (event.type === 'response.content_part.done') {
      const part = event.part as { annotations?: unknown[] } | undefined;
      if (Array.isArray(part?.annotations)) annotations.push(...part.annotations);
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const response = event.response as { error?: { code?: string } } | undefined;
      const error = event.error as { code?: string } | undefined;
      throw providerError(0, response?.error?.code ?? error?.code ?? String(event.code ?? ''));
    }
    if (event.type === 'response.incomplete') throw new UserError('ChatGPT returned an incomplete answer. Try a shorter request. No conversation turn was saved.');
    if (event.type === 'response.completed') {
      const response = event.response as { output?: Array<{ type?: string; name?:unknown; arguments?:unknown; content?: Array<{ type?: string; text?: string; annotations?: unknown[] }> }> } | undefined;
      const canonical=response?.output?.filter(item=>item.type==='function_call') ?? [];
      // Subscription streams may finish with output:[]; completed item events
      // contain the canonical call. Never execute on deltas or item.done alone.
      const calls=canonical.length?canonical:[...streamedCalls.values()];
      if (calls.length) {
        if (!execute) throw new UserError('An unapproved action was requested; no nickname was changed.');
        const result=await execute(calls); checkLimit(result); return result;
      }
      const parts = response?.output?.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'output_text');
      if (parts?.length) {
        answer = parts.map(part => part.text ?? '').join('\n');
        for (const part of parts) if (Array.isArray(part.annotations)) annotations.push(...part.annotations);
      }
      if (!answer.trim()) throw new UserError('ChatGPT completed without a text answer. Try another prompt or model.');
      checkLimit(answer);
      const rendered = renderWebCitations(answer, annotations);
      checkLimit(rendered);
      return rendered;
    }
  }
  throw new UserError('The ChatGPT stream ended before completion. No conversation turn was saved.');
}

export class ChatGPTProvider implements Provider {
  constructor(readonly model: string, private getToken = accessToken, private request: typeof fetch = fetch,
    private reasoningEffort?: ReasoningEffort, private getInstructions = botInstructions) {}
  async generate(messages: ProviderMessage[], signal: AbortSignal, options:GenerationOptions={}): Promise<string> {
    const action=options.nickname;
    const instructions = `${this.getInstructions()}\n\n${nicknameGuidance}${action?'\nThe current direct request has one exact nickname capability. Call change_server_nickname once to perform it; do not answer that it is done yourself.':''}\n\n${webSearchInstructions}`;
    const token = await this.getToken();
    const response = await this.request('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: messages, store: false, stream: true,
        tools: [{ type: 'web_search' },...(action?[nicknameTool(action.request)]:[])],
        tool_choice: action?{type:'function',name:'change_server_nickname'}:'auto',
        ...(action?{parallel_tool_calls:false}:{}),
        ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
        instructions }),
    });
    if (!response.ok) throw providerError(response.status);
    if (!response.body) throw new UserError('ChatGPT returned no response stream.');
    return consumeResponse(response.body,12000,action?async calls=>{
      if (calls.length!==1 || calls[0]!.name!=='change_server_nickname' || typeof calls[0]!.arguments!=='string' || calls[0]!.arguments.length>1000) {
        throw new UserError('The AI requested an unexpected action. No nickname was changed.');
      }
      let request:unknown; try { request=JSON.parse(calls[0]!.arguments); } catch { throw new UserError('Invalid nickname action. No nickname was changed.'); }
      if (!validNicknameRequest(request) || request.targetId!==action.request.targetId || request.nickname!==action.request.nickname) {
        throw new UserError('The AI action did not match your exact member and nickname. No nickname was changed.');
      }
      signal.throwIfAborted();
      return action.execute(request,signal);
    }:undefined);
  }
}

export class StubProvider implements Provider {
  async generate(messages: ProviderMessage[]): Promise<string> {
    const content = messages.at(-1)?.content ?? '';
    const text = typeof content === 'string' ? content : content.map(part => part.type === 'input_text' ? part.text : '[Image received]').join('\n');
    return `[Offline stub — no AI request made]\n${text}`;
  }
}
