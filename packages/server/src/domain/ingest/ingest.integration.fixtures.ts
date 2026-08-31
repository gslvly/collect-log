import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapSchema } from '../../bootstrap/schema.js';
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
  channel: string | null;
  is_success: boolean | null;
  note: string | null;
  retry_count: number | null;
  score: number | null;
  registered_at: string | null;
}

interface SignedRequest {
  body: string;
  envelope: IngestEnvelope;
}

const testDataDir = mkdtempSync(join(tmpdir(), 'collect-log-ingest-'));
const testDatabase = openSqliteDatabase(testDataDir);
const tables = new TableRepository(testDatabase, new TableMetadataCache());

export let app: FastifyInstance;
export let projectId: string;
let physicalName: string;
export let ingestSecret: string;
export let schemaVersion: number;

export function signedRequest(
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

export async function post(
  request: SignedRequest,
  origin?: string,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
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

export function overwriteStatus(status: TableStatus): void {
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

export function overwriteSecrets(
  current: string,
  previous: string,
  expiresAt: string | null,
): void {
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

export async function storedRows(recordId: string): Promise<StoredRow[]> {
  return parameterizedQuery<StoredRow>({
    client: readonlyClient,
    query: `SELECT
  toString(_record_id) AS record_id,
  _schema_version AS schema_version,
  toString(toUnixTimestamp64Milli(_occurred_at)) AS occurred_at,
  toString(_received_at) AS received_at,
  event_name,
  channel,
  is_success,
  note,
  retry_count,
  score,
  toString(toUnixTimestamp64Milli(registered_at)) AS registered_at
FROM data.${assertIdentifier(physicalName)}
WHERE _record_id = {recordId:UUID}`,
    params: { recordId },
  });
}

export async function restartApp(): Promise<void> {
  await app.close();
  app = await buildApp({ tableRepository: tables });
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
          key: 'channel',
          label: 'Channel',
          type: 'enum',
          required: false,
          description: '',
          options: [
            { value: 'sms', label: 'SMS', status: 'active' },
            { value: 'password', label: 'Password', status: 'active' },
            { value: 'legacy', label: 'Legacy', status: 'disabled' },
          ],
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
          key: 'retry_count',
          label: 'Retry count',
          type: 'integer',
          required: false,
          description: '',
        },
        {
          key: 'score',
          label: 'Score',
          type: 'float',
          required: false,
          description: '',
        },
        {
          key: 'registered_at',
          label: 'Registered at',
          type: 'datetime',
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
