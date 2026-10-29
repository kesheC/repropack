/** Minimal structured progress reporting; keeps stdout free for machine output. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  quiet?: boolean;
  verbose?: boolean;
  /** Sink for human-facing lines; defaults to stderr so stdout stays parseable. */
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
  return {
    info(message) {
      if (!quiet) sink(message);
    },
    warn(message) {
      sink("warning: " + message);
    },
    error(message) {
      sink("error: " + message);
    },
    debug(message) {
      if (verbose && !quiet) sink("debug: " + message);
    },
  };
}

/** A logger that discards everything; used by the library API by default. */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
