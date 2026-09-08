// Lightweight browser-compatible Mem0 client for mobile runtime.
// Avoids bundling heavyweight Node database drivers (mongodb, cassandra, redis)
// while supporting telemetry logging.

export interface AddMemoryOptions {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export class Memory {
  private apiKey?: string;
  private userId: string;

  constructor(options?: { apiKey?: string; userId?: string }) {
    this.apiKey = options?.apiKey;
    this.userId = options?.userId || 'pieces-android-mobile-user';
  }

  async add(
    content: string | Record<string, unknown>,
    options?: AddMemoryOptions
  ): Promise<void> {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    if (this.apiKey) {
      try {
        await fetch('https://api.mem0.ai/v1/memories/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Token ${this.apiKey}`,
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: text }],
            user_id: options?.user_id || this.userId,
            metadata: {
              category: options?.category || 'telemetry',
              ...(options?.metadata || {}),
            },
          }),
        });
      } catch (err) {
        console.warn('Mem0 telemetry logging skipped:', err);
      }
    }
  }
}
