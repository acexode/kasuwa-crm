import { describe, it } from 'vitest';

/**
 * ACCEPTANCE STUB — T-0004, adversarial isolation testing (Agent 12).
 *
 * Unusually, Agent 12 *writes* these rather than consuming them, so this file is
 * a prompt rather than a contract. The `todo` entries are the lead's guesses at
 * where the tenancy model is weakest; they are a starting point and explicitly
 * not a limit.
 *
 * If Agent 12 only converts these seven and finds nothing else, the task has
 * failed its purpose — the value is in the eighth thing, which the lead did not
 * think of. A truthful "I could not break it beyond these" is a better report
 * than seven variations dressed up as new attacks.
 */
describe('acceptance (stub): adversarial tenancy attacks', () => {
  it.todo(
    'interleaved transactions on one pooled connection never observe each other’s ' +
      'session GUCs',
  );

  it.todo(
    'a statement_timeout firing between set_config and the query leaves no usable ' +
      'session context behind on that connection',
  );

  it.todo(
    'constraint violations, foreign-key errors and planner errors never reveal that ' +
      'a row exists in another tenant',
  );

  it.todo('keyset pagination cannot skip or duplicate rows under concurrent inserts');

  it.todo(
    'revoking a user_programme row takes effect on the next request, and an ' +
      'in-flight transaction cannot extend its own scope',
  );

  it.todo('no code path builds SQL for the reserved-word "user" table without quoting it');

  it.todo(
    'response timing does not distinguish "no such record" from "record exists in ' +
      'another tenant"',
  );

  it.todo('property-based: formatProgrammeIds rejects every non-uuid input');

  it.todo('property-based: decodeCursor never yields a position it was not given');
});
