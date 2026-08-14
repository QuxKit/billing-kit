// A failure the user caused and can fix, as distinct from a crash.
//
// Deliberately not `BillingError`. That union is the library's contract and a
// caller is expected to branch on its codes; nothing branches on a CLI failure
// except the shell, which sees an exit status. Adding `config_not_found` to a
// union that ships to every adopter would make a CLI concern part of the
// library's public API forever.
//
// `detail` is printed under the message, indented. It exists so the fix can be
// spelled out without cramming it into one line.

export class CliError extends Error {
  readonly detail: readonly string[];

  constructor(message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'CliError';
    this.detail = detail;
  }
}
