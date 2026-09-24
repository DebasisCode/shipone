/**
 * An error meant for the user: `message` says what went wrong, `hint` says
 * what to do about it. Anything else that escapes is treated as a bug.
 */
export class ShipOneError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ShipOneError";
  }
}

/** The user pressed Ctrl+C / Esc at a prompt. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}
