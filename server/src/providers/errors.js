export class ProviderError extends Error {
  /**
   * @param {string} provider
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(provider, message, { status, cause } = {}) {
    super(`${provider}: ${message}`, { cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}
