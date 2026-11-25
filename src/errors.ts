/** Represent an expected local operation failure with a safe message and its HTTP response status. */
export class HttpError extends Error {
  /** Associate a safe user-facing message with its response status. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
