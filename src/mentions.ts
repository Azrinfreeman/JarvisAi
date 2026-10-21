export function mentionedPrompt(content: string, botId: string): string | undefined {
  // Only an explicit mention of this bot triggers a response.
  const pattern = new RegExp(`<@!?${botId}>`, 'g');
  if (!pattern.test(content)) return undefined;
  return content.replace(pattern, '').trim();
}
