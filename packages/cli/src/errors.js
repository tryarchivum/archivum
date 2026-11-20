export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = code;
  }
}

/** Bad command line or missing configuration: exit code 2. */
export class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = "UsageError";
  }
}
