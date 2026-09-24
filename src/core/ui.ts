import * as clack from "@clack/prompts";
import pc from "picocolors";
import { CancelledError, ShipOneError } from "./errors.js";

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Everything the commands need from the terminal. Commands never talk to
 * stdin/stdout directly, so tests can swap in a scripted implementation.
 */
export interface UI {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  note(body: string, title?: string): void;
  text(opts: { message: string; placeholder?: string; defaultValue?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  password(opts: { message: string; validate?: (v: string) => string | undefined }): Promise<string>;
  select<T extends string>(opts: { message: string; choices: SelectChoice<T>[]; initial?: T }): Promise<T>;
  confirm(opts: { message: string; initial?: boolean }): Promise<boolean>;
  spinner(): Spinner;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  fail(message: string): void;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

function needsInput(message: string): never {
  throw new ShipOneError(
    `ShipOne needs an answer to "${message}" but is running non-interactively.`,
    "Run the command in a terminal without --yes, or provide the value via flags/.shipone.yml.",
  );
}

export class TerminalUI implements UI {
  readonly interactive: boolean;

  constructor(opts: { yes?: boolean } = {}) {
    this.interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !opts.yes;
  }

  intro(title: string) {
    clack.intro(pc.inverse(` ${title} `));
  }
  outro(message: string) {
    clack.outro(message);
  }
  info(message: string) {
    clack.log.info(message);
  }
  success(message: string) {
    clack.log.success(message);
  }
  warn(message: string) {
    clack.log.warn(message);
  }
  error(message: string) {
    clack.log.error(message);
  }
  note(body: string, title?: string) {
    clack.note(body, title);
  }

  async text(opts: Parameters<UI["text"]>[0]) {
    if (!this.interactive) {
      if (opts.defaultValue !== undefined) return opts.defaultValue;
      needsInput(opts.message);
    }
    return unwrap(
      await clack.text({
        message: opts.message,
        placeholder: opts.placeholder,
        defaultValue: opts.defaultValue,
        validate: opts.validate ? (v) => opts.validate!(v ?? "") : undefined,
      }),
    );
  }

  async password(opts: Parameters<UI["password"]>[0]) {
    if (!this.interactive) needsInput(opts.message);
    return unwrap(
      await clack.password({
        message: opts.message,
        validate: opts.validate ? (v) => opts.validate!(v ?? "") : undefined,
      }),
    );
  }

  async select<T extends string>(opts: { message: string; choices: SelectChoice<T>[]; initial?: T }): Promise<T> {
    if (opts.choices.length === 1) return opts.choices[0]!.value;
    if (!this.interactive) {
      if (opts.initial !== undefined) return opts.initial;
      needsInput(opts.message);
    }
    const options = opts.choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint }));
    return unwrap(
      await clack.select<T>({
        message: opts.message,
        options: options as Parameters<typeof clack.select<T>>[0]["options"],
        initialValue: opts.initial,
      }),
    );
  }

  async confirm(opts: { message: string; initial?: boolean }) {
    if (!this.interactive) return opts.initial ?? true;
    return unwrap(await clack.confirm({ message: opts.message, initialValue: opts.initial ?? true }));
  }

  spinner(): Spinner {
    if (!process.stdout.isTTY) {
      // Plain line-by-line output for CI logs and pipes.
      return {
        start: (m) => console.log(`… ${m}`),
        message: () => {},
        stop: (m) => console.log(`✔ ${m}`),
        fail: (m) => console.log(`✖ ${m}`),
      };
    }
    const s = clack.spinner();
    return {
      start: (m) => s.start(m),
      message: (m) => s.message(m),
      stop: (m) => s.stop(m),
      fail: (m) => s.error(m),
    };
  }
}
