import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, queryFingerprint } from './cursor.js';
import { definition } from './query.fixtures.js';
import { expectInvalidQuery } from './query.test-helpers.js';

describe('keyset cursor', () => {
  const fingerprint = queryFingerprint({
    projectId: definition.projectId,
    range: { start: 1, end: 2 },
    includeFields: [],
    order: 'desc',
    schemaVersion: definition.schemaVersion,
  });

  it('round-trips a valid opaque base64url cursor', () => {
    const payload = { at: 1_777_777_777_123, id: randomUUID(), fp: fingerprint };
    expect(decodeCursor(encodeCursor(payload), fingerprint)).toEqual(payload);
  });

  it('rejects fingerprint mismatch and damaged base64', () => {
    const cursor = encodeCursor({ at: 1, id: randomUUID(), fp: fingerprint });
    expectInvalidQuery(() => decodeCursor(cursor, '0'.repeat(16)));
    expectInvalidQuery(() => decodeCursor('not+base64!', fingerprint));
    expectInvalidQuery(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ at: 'invalid', id: randomUUID(), fp: fingerprint })).toString(
          'base64url',
        ),
        fingerprint,
      ),
    );
  });
});
