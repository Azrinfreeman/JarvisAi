import { Conversations } from './storage.js';
import { RequestQueue } from './queue.js';
import type { Provider, ProviderMessage, GenerationOptions } from './provider.js';
import { downloadImage, type ImageAttachment } from './images.js';
import { UserError } from './errors.js';
import { promptWithReference, type ReferencedInput } from './replies.js';

export type ChatIdentity = { guildId: string; channelId: string; userId: string; visibility?: 'private' | 'public' };
export const conversationKey = (identity: ChatIdentity) => `${identity.guildId}:${identity.channelId}:${identity.userId}${identity.visibility ? `:${identity.visibility}` : ''}`;

export class ChatService {
  private controllers = new Set<AbortController>();
  constructor(private provider: Provider, private store: Conversations, private queue = new RequestQueue(), private loadImage = downloadImage) {}
  reset(identity: ChatIdentity) {
    const scopes: ChatIdentity['visibility'][] = [undefined, 'private', 'public'];
    // Clear legacy owner-only history too, without reusing it for public replies.
    const keys = scopes.map(visibility => conversationKey({ ...identity, visibility }));
    if (keys.some(key => this.queue.isBusy(key))) throw new UserError('Wait for your current request to finish before resetting.');
    for (const key of keys) this.store.reset(key);
  }
  ask(identity: ChatIdentity, prompt: string, deliver: (answer: string, imageData?: string) => Promise<void>, options: {
    signal?: AbortSignal; image?: ImageAttachment; reference?: (signal: AbortSignal) => Promise<string | ReferencedInput>;
    nickname?: GenerationOptions['nickname'];
  } = {}) {
    prompt = prompt.trim();
    if (!prompt || prompt.length > 4000) return Promise.reject(new UserError('Enter a question between 1 and 4000 characters.'));
    const key = conversationKey(identity);
    return this.queue.run(key, async () => {
      const controller = new AbortController(); this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 120000);
      const combined = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try {
        combined.throwIfAborted();
        const reference = options.reference ? await options.reference(combined) : undefined;
        const referenceText = typeof reference === 'string' ? reference : reference?.text;
        let requestText = referenceText !== undefined ? promptWithReference(prompt, referenceText) : prompt;
        const image = options.image ?? (typeof reference === 'object' ? reference.image : undefined);
        if (options.image && typeof reference === 'object' && reference.image) {
          requestText += '\n[The image analyzed in this request is the requesting member\'s own attachment; the selected message\'s image is not supplied.]';
        }
        combined.throwIfAborted();
        const imageData = image ? await this.loadImage(image, combined) : undefined;
        const content: ProviderMessage['content'] = imageData ? [
          { type: 'input_text', text: requestText },
          { type: 'input_image', image_url: imageData, detail: 'auto' },
        ] : requestText;
        combined.throwIfAborted();
        const answer = await this.provider.generate([...this.store.get(key), { role: 'user', content }], combined,{nickname:options.nickname});
        combined.throwIfAborted();
        // Do not repost another member's referenced attachment; the reply already links to its original message.
        await deliver(answer, options.image ? imageData : undefined);
        this.store.append(key, image ? `${requestText}\n[Image attached; image bytes are not retained. Reattach for visual follow-ups, or reply to the original image.]` : requestText, answer);
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }, `${identity.guildId}:${identity.userId}`);
  }
  close() { for (const controller of this.controllers) controller.abort(); }
}
