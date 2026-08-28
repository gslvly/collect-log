import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
import { configuredLimits } from '../../config/limits.js';
import {
  assertIdentifier,
  metaClient,
  parameterizedQuery,
  readonlyClient,
} from '../../infra/clickhouse.js';
import { serial } from '../../infra/serial.js';
import { openSqliteDatabase } from '../../infra/sqlite.js';
import { TableMetadataCache } from '../tables/cache.js';
import { TableRepository } from '../tables/repository.js';
import type { TableStatus } from '../tables/types.js';
import type { IngestEnvelope } from './envelope.js';
import { signatureFor } from './signature.js';

interface StoredRow {
  record_id: string;
  schema_version: number;
  occurred_at: string;
  received_at: string;
  event_name: string;
  is_success: boolean | null;
  note: string | null;
}

interface SignedRequest {
  body: string;
  envelope: IngestEnvelope;
}

const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-ingest-'));
const testDatabase = openSqliteDatabase(testDataDir);
const tables = new TableRepository(testDatabase, new TableMetadataCache());

let app: FastifyInstance;
let projectId: string;
let physicalName: string;
let ingestSecret: string;
let schemaVersion: number;

function signedRequest(
  payload: Record<string, unknown>,
  options: {
    p?: string;
    t?: number;
    n?: string;
    secret?: string;
    signature?: string;
  } = {},
): SignedRequest {
  const unsigned = {
    p: options.p ?? projectId,
    t: options.t ?? Date.now(),
    n: options.n ?? randomBytes(8).toString('hex'),
    d: JSON.stringify(payload),
  };
  const envelope = {
    ...unsigned,
    s: options.signature ?? signatureFor(options.secret ?? ingestSecret, unsigned),
  };
  return { body: JSON.stringify(envelope), envelope };
}

async function post(request: SignedRequest, origin?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/ingest/v1/projects/${projectId}/rows`,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      ...(origin === undefined ? {} : { origin }),
    },
    payload: request.body,
  });
}

function overwriteStatus(status: TableStatus): void {
  testDatabase.transaction(() => {
    const result = testDatabase
      .prepare('UPDATE collect_tables SET status = ?, updated_at = ? WHERE project_id = ?')
      .run(status, new Date().toISOString(), projectId);
    if (result.changes !== 1) {
      throw new Error(`Fixture table ${projectId} was not found`);
    }
  });
  tables.clearCache();
}

function overwriteSecrets(current: string, previous: string, expiresAt: string | null): void {
  testDatabase.transaction(() => {
    const result = testDatabase
      .prepare(
        `UPDATE collect_tables
SET ingest_secret = ?, ingest_secret_prev = ?, ingest_secret_prev_expires_at = ?, updated_at = ?
WHERE project_id = ?`,
      )
      .run(current, previous, expiresAt, new Date().toISOString(), projectId);
    if (result.changes !== 1) {
      throw new Error(`Fixture table ${projectId} was not found`);
    }
  });
  tables.clearCache();
}

async function storedRows(recordId: string): Promise<StoredRow[]> {
  return parameterizedQuery<StoredRow>({
    client: readonlyClient,
    query: `SELECT
  toString(_record_id) AS record_id,
  _schema_version AS schema_version,
  toString(toUnixTimestamp64Milli(_occurred_at)) AS occurred_at,
  toString(_received_at) AS received_at,
  event_name,
  is_success,
  note
FROM data.${assertIdentifier(physicalName)}
WHERE _record_id = {recordId:UUID}`,
    params: { recordId },
  });
}

beforeAll(async () => {
  await bootstrapSchema(testDatabase);
  const created = await tables.create(
    {
      displayName: `stage-c-${randomUUID()}`,
      description: 'stage C ingest fixture',
      fields: [
        {
          key: 'event_name',
          label: 'Event name',
          type: 'string',
          required: true,
          description: '',
        },
        {
          key: 'is_success',
          label: 'Success',
          type: 'boolean',
          required: false,
          description: '',
        },
        {
          key: 'note',
          label: 'Note',
          type: 'string',
          required: false,
          description: '',
        },
        {
          key: 'legacy_value',
          label: 'Legacy value',
          type: 'string',
          required: false,
          description: '',
        },
      ],
    },
    'stage-c-test',
  );
  projectId = created.table.projectId;
  physicalName = created.table.physicalName;
  ingestSecret = created.ingestSecret;
  const deprecated = await tables.deprecateField(projectId, 'legacy_value');
  schemaVersion = deprecated.table.schemaVersion;
  app = await buildApp({ tableRepository: tables });
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (physicalName !== undefined) {
    await serial(async () => {
      await metaClient.command({
        query: `DROP TABLE IF EXISTS data.${assertIdentifier(physicalName)} SYNC`,
      });
    });
  }
  testDatabase.close();
  rmSync(testDataDir, { recursive: true, force: true });
});

describe('stage C ingest route', () => {
  it('writes a signed cross-origin row with complete columns and rejects its replay', async () => {
    const occurredAt = Date.now();
    const request = signedRequest({
      occurredAt,
      data: { event_name: 'login', is_success: true },
    });
    const accepted = await post(request, 'https://ingest.example.test');

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.headers['access-control-allow-origin']).toBe('https://ingest.example.test');
    expect(accepted.json()).toEqual({
      success: true,
      recordId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      requestId: accepted.headers['x-request-id'],
    });

    const recordId = accepted.json().recordId as string;
    const rows = await storedRows(recordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_id: recordId,
      schema_version: schemaVersion,
      occurred_at: String(occurredAt),
      event_name: 'login',
      is_success: true,
      note: null,
    });
    expect(rows[0]?.received_at).not.toBe('');

    const replayed = await post(request);
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toMatchObject({ error: { code: 'REPLAYED_NONCE' } });
  });

  it('distinguishes invalid and expired signatures', async () => {
    const payload = { recordId: randomUUID(), occurredAt: Date.now(), data: { event_name: 'x' } };
    const invalid = await post(signedRequest(payload, { signature: '0'.repeat(64) }));
    const expired = await post(
      signedRequest(payload, {
        t: Date.now() - configuredLimits.ingest.signatureWindowMs - 1,
      }),
    );

    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'SIGNATURE_EXPIRED' } });
  });

  it('accepts the previous secret in its grace period and rejects the same envelope after expiry', async () => {
    const request = signedRequest(
      { recordId: randomUUID(), occurredAt: Date.now(), data: { event_name: 'rotation' } },
      { secret: ingestSecret },
    );
    overwriteSecrets(
      'rotated-current-secret',
      ingestSecret,
      new Date(Date.now() + 60_000).toISOString(),
    );

    const accepted = await post(request);
    expect(accepted.statusCode, accepted.body).toBe(200);

    overwriteSecrets(
      'rotated-current-secret',
      ingestSecret,
      new Date(Date.now() - 1).toISOString(),
    );
    await app.close();
    app = await buildApp({ tableRepository: tables });

    const rejected = await post(request);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });

    overwriteSecrets(ingestSecret, '', null);
  });

  it('returns schema-aware errors for unknown and deprecated fields', async () => {
    const occurredAt = Date.now();
    const unknown = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt,
        data: { event_name: 'x', mystery: 'value' },
      }),
    );
    const deprecated = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt,
        data: { event_name: 'x', legacy_value: 'value' },
      }),
    );

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: {
        code: 'UNKNOWN_FIELD',
        field: 'mystery',
        schemaVersion,
      },
    });
    expect(unknown.json().error.message).toContain('event_name, is_success, note');
    expect(unknown.json().error).not.toHaveProperty('expected');

    expect(deprecated.statusCode).toBe(400);
    expect(deprecated.json()).toMatchObject({
      error: {
        code: 'DEPRECATED_FIELD',
        field: 'legacy_value',
        expected: {
          key: 'legacy_value',
          label: 'Legacy value',
          type: 'string',
          required: false,
        },
        schemaVersion,
      },
    });
  });

  it('returns schema-aware errors for required, type and UTF-8 length violations', async () => {
    const occurredAt = Date.now();
    const cases = [
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { is_success: true },
        }),
        code: 'REQUIRED_FIELD_MISSING',
      },
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { event_name: false },
        }),
        code: 'INVALID_FIELD_TYPE',
      },
      {
        request: signedRequest({
          recordId: randomUUID(),
          occurredAt,
          data: { event_name: 'x'.repeat(configuredLimits.ingest.maxStringLength + 1) },
        }),
        code: 'FIELD_VALUE_TOO_LONG',
      },
    ];

    for (const testCase of cases) {
      const response = await post(testCase.request);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: testCase.code,
          field: 'event_name',
          expected: {
            key: 'event_name',
            label: 'Event name',
            type: 'string',
            required: true,
          },
          schemaVersion,
        },
      });
    }
  });

  it.each([
    ['too early', () => Date.now() - configuredLimits.ingest.occurredAtPastMs - 1],
    ['too late', () => Date.now() + configuredLimits.ingest.occurredAtFutureMs + 1_000],
  ] as const)('rejects occurredAt that is %s', async (_label, occurredAt) => {
    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: occurredAt(),
        data: { event_name: 'x' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_OCCURRED_AT' } });
  });

  it.each([
    ['disabled', 'TABLE_DISABLED', 403],
    ['archived', 'TABLE_DISABLED', 403],
    ['creating', 'TABLE_NOT_READY', 503],
    ['failed', 'TABLE_NOT_READY', 503],
  ] as const)('maps the %s table state to %s', async (status, code, httpStatus) => {
    overwriteStatus(status);
    try {
      const response = await post(
        signedRequest({
          recordId: randomUUID(),
          occurredAt: Date.now(),
          data: { event_name: 'x' },
        }),
      );

      expect(response.statusCode).toBe(httpStatus);
      expect(response.json()).toMatchObject({ error: { code } });
    } finally {
      overwriteStatus('active');
    }
  });

  it('rejects a non-UUID recordId', async () => {
    const response = await post(
      signedRequest({
        recordId: 'not-a-uuid',
        occurredAt: Date.now(),
        data: { event_name: 'x' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_RECORD_ID' } });
  });

  it('rejects an origin outside the ingest whitelist', async () => {
    const response = await post(
      signedRequest({
        recordId: randomUUID(),
        occurredAt: Date.now(),
        data: { event_name: 'x' },
      }),
      'https://forbidden.example.test',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('rejects an envelope project that differs from the URL project', async () => {
    const response = await post(
      signedRequest(
        {
          recordId: randomUUID(),
          occurredAt: Date.now(),
          data: { event_name: 'x' },
        },
        { p: `prj_${ulid()}` },
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_ENVELOPE' } });
  });

  it('validates the URL project before parsing the envelope body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest/v1/projects/not-a-project/rows',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: '{',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_PROJECT_ID' } });
  });
});
