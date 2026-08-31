import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { configuredLimits } from '../config/limits.js';
import type { UserRole } from './users/types.js';
import { fieldTypesResponse, measuresForFieldType, operatorsForFieldType } from './field-types.js';

const apps: FastifyInstance[] = [];

function authorization(app: FastifyInstance, role: UserRole): { authorization: string } {
  const token = app.jwt.sign({ username: `field-types-${role}`, role });
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('field type capability matrix', () => {
  it('derives operators and field-bound measures from the single capability matrix', () => {
    expect(operatorsForFieldType('float')).toEqual([
      'gt',
      'gte',
      'lt',
      'lte',
      'is_null',
      'is_not_null',
    ]);
    expect(operatorsForFieldType('boolean')).toEqual(['eq', 'neq', 'is_null', 'is_not_null']);
    expect(operatorsForFieldType('string')).toContain('is_empty');
    expect(operatorsForFieldType('enum')).not.toContain('contains');

    expect(measuresForFieldType('integer')).toEqual([
      'unique',
      'min',
      'max',
      'sum',
      'avg',
      'p50',
      'p90',
      'p99',
    ]);
    expect(measuresForFieldType('datetime')).toEqual(['min', 'max']);
    for (const type of fieldTypesResponse.types) {
      expect(type.measures).not.toContain('count');
    }
  });

  it('serves the derived matrix and configured limits to every authenticated role', async () => {
    const app = await buildApp();
    apps.push(app);

    for (const role of ['user', 'admin', 'super_admin'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/field-types',
        headers: authorization(app, role),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, max-age=86400');
      expect(response.json()).toEqual(fieldTypesResponse);
      expect(response.json()).toMatchObject({
        limits: {
          maxStringLength: configuredLimits.ingest.maxStringLength,
          // 附录 A 的 query 组：前端的条件构造器与统计页不得把这几项写死。
          maxConditions: configuredLimits.query.maxConditions,
          maxNestingDepth: configuredLimits.query.maxNestingDepth,
          maxRangeDays: configuredLimits.query.maxRangeDays,
          defaultGroupLimit: configuredLimits.query.defaultGroupLimit,
          maxGroupLimit: configuredLimits.query.maxGroupLimit,
        },
      });
    }

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/admin/field-types',
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});
