import sharp from 'sharp';
import { UserError } from './errors.js';
import type { APIEmbed } from 'discord.js';

export type ReplyPayload = {
  content: string;
  embeds?: APIEmbed[];
  files?: Array<{ attachment: Buffer; name: string; description: string }>;
};

function preview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const suffix = '\n[Full text in response.txt]';
  let cut = limit - suffix.length;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return text.slice(0, cut) + suffix;
}

export async function responseMessages(question: string, answer: string, imageData?: string, sourceUrl?: string,
  attachmentLimit = 8 * 1024 * 1024, useImageEmbeds = true): Promise<[ReplyPayload]> {
  const source = sourceUrl ? `**In reply to:** ${sourceUrl}\n\n` : '';
  const fullText = `${source}**Question**\n${question}\n\n**Answer**\n${answer}`;
  const textFile = { attachment: Buffer.from(fullText, 'utf8'), name: 'response.txt', description: 'Complete question and answer' };
  const textReply = (): ReplyPayload => {
    if (fullText.length <= 1900) return { content: fullText };
    const header = `${source}**Question**\n${preview(question, 400)}\n\n**Answer**\n`;
    return { content: header + preview(answer, 1900 - header.length), files: [textFile] };
  };
  if (!imageData) return [textReply()];

  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(imageData);
  if (!match) throw new UserError('Could not prepare the image preview. Upload the image again.');
  let bytes = Buffer.from(match[2]!, 'base64');
  let name = match[1] === 'png' ? 'question.png' : 'question.jpg';
  const limit = Math.min(attachmentLimit, 8 * 1024 * 1024);
  if (bytes.length > limit) {
    bytes = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).timeout({ seconds: 10 }).toBuffer();
    name = 'question.jpg';
  }
  if (bytes.length > limit) throw new UserError('The image preview exceeds Discord’s upload limit. Try a smaller screenshot.');
  const image = { attachment: bytes, name, description: 'Uploaded image for this question' };
  if (!useImageEmbeds) {
    const payload = textReply();
    payload.files = [image, ...(payload.files ?? [])];
    return [payload];
  }
  // Ordered embeds keep the question/image above the answer inside one Discord message.
  const questionText = `${source}${question}`;
  const overflow = questionText.length > 2700 || answer.length > 3000;
  return [{ content: '', embeds: [
    { title: 'Question', description: preview(questionText, 2700), image: { url: `attachment://${name}` } },
    { title: 'Answer', description: preview(answer, 3000) },
  ], files: [image, ...(overflow ? [textFile] : [])] }];
}
