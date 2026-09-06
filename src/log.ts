import pino from "pino";

/**
 * The logging surface the service codes against.
 *
 * Deliberately narrower than pino's, and stated here rather than imported, so
 * that call sites depend on this interface instead of on pino. A fake in a test
 * is four methods, and swapping the backend later touches only this file.
 *
 * Fields go in a bag rather than being interpolated into the message: the same
 * line then reads well on a console and survives being shipped somewhere that
 * wants structure.
 */
export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  /** A logger that tags every line with a subsystem, e.g. `[publish]`. */
  child: (scope: string) => Logger;
}

/**
 * Verbose turns on debug; otherwise info and above.
 *
 * Named and exported because it is the whole of the VERBOSE_LOGGING contract,
 * and it is the one part worth asserting in a test without a live transport.
 */
export function logLevelFor(verbose: boolean): "debug" | "info" {
  return verbose ? "debug" : "info";
}

/** Turns an error of unknown type into something worth printing. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function wrap(logger: pino.Logger, scope: string | undefined): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: Record<string, unknown>) => {
      if (fields) logger[level](fields, message);
      else logger[level](message);
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (childScope) =>
      wrap(logger.child({ scope: scope ? `${scope}:${childScope}` : childScope }), childScope),
  };
}

/**
 * Console logger for the service.
 *
 * pino with pino-pretty, matching signum-chain-walker, which logs through the
 * same pair: our lines and the walker's then interleave as one stream instead
 * of two formats arguing in the same terminal.
 *
 * Colour follows the TTY. Under pm2 the output is a file, and escape codes
 * there make the log harder to read, not easier.
 */
export function createLogger(verbose: boolean): Logger {
  const logger = pino({
    level: logLevelFor(verbose),
    base: undefined, // no pid/hostname: one process, one machine
    transport: {
      target: "pino-pretty",
      options: {
        colorize: Boolean(process.stdout.isTTY),
        translateTime: "SYS:HH:MM:ss",
        // Fields on the message line: these are short operational lines, and a
        // four-line block per log entry buries the sequence of events.
        singleLine: true,
        // Our `error` field is already a string from describeError, so pino-pretty
        // must not treat it as an Error object and hoist it onto its own block.
        errorLikeObjectKeys: [],
        ignore: "pid,hostname,scope",
        messageFormat: "{if scope}[{scope}] {end}{msg}",
      },
    },
  });

  return wrap(logger, undefined);
}

/** Discards everything. For tests, and for code paths that must not require a logger. */
export function silentLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop, info: noop, warn: noop, error: noop,
    child: () => logger,
  };
  return logger;
}
