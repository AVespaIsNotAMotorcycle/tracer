export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {object} [details]  Extra fields for the JSON body, beside `error`.
   */
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }

  /** The response body: `{ error, ...details }`. */
  body() {
    return { error: this.message, ...this.details };
  }
}
