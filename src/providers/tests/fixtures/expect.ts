// providers/tests/fixtures/expect.ts
//
// Assertions about typed errors.
//
// `assert.rejects(fn, /message/)` is the tempting shorthand and it is the wrong
// one: it asserts the wording, so a reworded message breaks a test that was
// meant to be about behaviour, and a message that happens to contain the right
// word passes a test that should fail. These assert the `kind`, which is the
// part callers branch on and therefore the part that is a contract.

import assert from 'node:assert/strict';

import { isProviderError, type ProviderError } from '../../errors';

export const expectProviderError = async (
  fn: () => Promise<unknown>,
  kind: ProviderError['kind'],
): Promise<ProviderError> => {
  try {
    await fn();
  } catch (error) {
    if (!isProviderError(error)) throw error;
    assert.equal(error.kind, kind, `expected ProviderError kind '${kind}', got '${error.kind}'`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ProviderError of kind '${kind}'` });
};

export const expectProviderErrorSync = (fn: () => unknown, kind: ProviderError['kind']): ProviderError => {
  try {
    fn();
  } catch (error) {
    if (!isProviderError(error)) throw error;
    assert.equal(error.kind, kind, `expected ProviderError kind '${kind}', got '${error.kind}'`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ProviderError of kind '${kind}'` });
};
