export const MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT = 10;
export const MAX_API_KEYS_PER_SCOUT = 10;

export class WebhookSubscriptionLimitError extends Error {
  constructor() {
    super(`Webhook subscription limit reached (${MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT} per scout)`);
    this.name = 'WebhookSubscriptionLimitError';
  }
}

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`API key limit reached (${MAX_API_KEYS_PER_SCOUT} per scout)`);
    this.name = 'ApiKeyLimitError';
  }
}
