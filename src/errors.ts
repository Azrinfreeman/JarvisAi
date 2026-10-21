export class UserError extends Error {}

export function safeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return 'The request timed out or was cancelled. Please try again.';
  }
  return 'The operation failed. Check connectivity and your local configuration. Credentials and provider responses were not logged.';
}

export function providerError(status: number, code?: string): UserError {
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) {
    return new UserError('ChatGPT plan usage is currently limited. Review Settings > Usage in ChatGPT and try again later. No paid API fallback was used.');
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return new UserError('ChatGPT plan usage is unavailable for this connection. Review app access and plan eligibility in ChatGPT.');
  }
  if (status === 401 || status === 403) {
    return new UserError('ChatGPT did not authorize this request. Stop the bot and run npm run auth -- login to reconnect or check integration eligibility.');
  }
  return new UserError('ChatGPT could not complete the request. Check connectivity, model availability, and integration eligibility. No paid API fallback was used.');
}
