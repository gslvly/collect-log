import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../errors.js';
import { requireRole } from '../auth/jwt.js';
import type { TableRepository } from './repository.js';
import { assertValidFieldKey } from './schema.js';
import { FIELD_TYPES, TABLE_STATUSES, toPublicTable, type TableRecord } from './types.js';

const projectIdPattern = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

const fieldSchema = z.object({
  key: z.string(),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  description: z.string().default(''),
});

const createTableSchema = z.object({
  displayName: z.string().min(1),
  description: z.string().default(''),
  fields: z.array(fieldSchema),
});

const statusSchema = z.object({
  status: z.enum(TABLE_STATUSES),
});

const updateFieldSchema = z
  .object({
    label: z.string().min(1).optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .refine(
    (input) =>
      input.label !== undefined || input.required !== undefined || input.description !== undefined,
  );

const renameFieldSchema = z.object({
  key: z.string(),
});

const confirmationSchema = z
  .object({
    confirm: z.unknown().optional(),
  })
  .default({});

const projectIdParamsSchema = z.object({
  projectId: z.string(),
});

const fieldParamsSchema = z.object({
  projectId: z.string(),
  fieldKey: z.string(),
});

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_JSON', 'Request input does not match the expected shape');
  }
  return result.data;
}

function parseProjectId(input: unknown): string {
  const { projectId } = parseInput(projectIdParamsSchema, input);
  if (!projectIdPattern.test(projectId)) {
    throw new AppError('INVALID_PROJECT_ID', `Project ID "${projectId}" is invalid`);
  }
  return projectId;
}

function parseFieldParams(input: unknown): { projectId: string; fieldKey: string } {
  const projectId = parseProjectId(input);
  const { fieldKey } = parseInput(fieldParamsSchema, input);
  return { projectId, fieldKey: assertValidFieldKey(fieldKey) };
}

function logTableChange(request: FastifyRequest, operation: string, table: TableRecord): void {
  request.log.info(
    {
      requestId: request.id,
      operator: request.user.username,
      projectId: table.projectId,
      operation,
      schemaVersion: table.schemaVersion,
    },
    'table metadata changed',
  );
}

function logTableDeletion(request: FastifyRequest, table: TableRecord): void {
  request.log.info(
    {
      requestId: request.id,
      operator: request.user.username,
      projectId: table.projectId,
      physicalName: table.physicalName,
      displayName: table.displayName,
      operation: 'delete_table',
    },
    'collection table permanently deleted',
  );
}

function secretResponse(table: TableRecord): {
  projectId: string;
  ingestSecret: string;
} {
  return {
    projectId: table.projectId,
    ingestSecret: table.ingestSecret,
  };
}

export function registerTableRoutes(app: FastifyInstance, repository: TableRepository): void {
  app.get(
    '/api/admin/tables',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    async () => ({ tables: (await repository.list()).map(toPublicTable) }),
  );

  app.post(
    '/api/admin/tables',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const body = parseInput(createTableSchema, request.body);
      const created = await repository.create(body, request.user.username);
      logTableChange(request, 'create_table', created.table);
      return secretResponse(created.table);
    },
  );

  app.get(
    '/api/admin/tables/templates',
    { preHandler: requireRole('admin', 'super_admin') },
    async () => ({ templates: await repository.listTemplates() }),
  );

  app.get(
    '/api/admin/tables/:projectId',
    { preHandler: requireRole('user', 'admin', 'super_admin') },
    async (request) => {
      const projectId = parseProjectId(request.params);
      const definition = await repository.getDefinition(projectId);
      if (definition === null) {
        throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
      }
      return { table: toPublicTable(definition), fields: definition.fields };
    },
  );

  app.get(
    '/api/admin/tables/:projectId/template',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const projectId = parseProjectId(request.params);
      const template = await repository.getTemplate(projectId);
      if (template === null) {
        throw new AppError('TABLE_NOT_FOUND', `Table "${projectId}" was not found`);
      }
      return template;
    },
  );

  app.delete(
    '/api/admin/tables/:projectId',
    { preHandler: requireRole('super_admin') },
    async (request) => {
      const projectId = parseProjectId(request.params);
      const body = parseInput(confirmationSchema, request.body);
      const deleted = await repository.deleteTable(projectId, body.confirm);
      logTableDeletion(request, deleted);
      return { projectId, deleted: true };
    },
  );

  app.post(
    '/api/admin/tables/:projectId/retry',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const table = await repository.retry(parseProjectId(request.params));
      logTableChange(request, 'retry_table', table);
      return { table: toPublicTable(table) };
    },
  );

  app.post(
    '/api/admin/tables/:projectId/status',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const projectId = parseProjectId(request.params);
      const body = parseInput(statusSchema, request.body);
      const table = await repository.setStatus(projectId, body.status);
      logTableChange(request, 'set_table_status', table);
      return { table: toPublicTable(table) };
    },
  );

  app.get(
    '/api/admin/tables/:projectId/secret',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => secretResponse(await repository.getSecret(parseProjectId(request.params))),
  );

  app.post(
    '/api/admin/tables/:projectId/secret/rotate',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const table = await repository.rotateSecret(parseProjectId(request.params));
      logTableChange(request, 'rotate_table_secret', table);
      return secretResponse(table);
    },
  );

  app.post(
    '/api/admin/tables/:projectId/fields',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const projectId = parseProjectId(request.params);
      const field = parseInput(fieldSchema, request.body);
      const changed = await repository.addField(projectId, field);
      logTableChange(request, 'add_field', changed.table);
      return { table: toPublicTable(changed.table), field: changed.field };
    },
  );

  app.patch(
    '/api/admin/tables/:projectId/fields/:fieldKey',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { projectId, fieldKey } = parseFieldParams(request.params);
      const changed = await repository.updateField(
        projectId,
        fieldKey,
        parseInput(updateFieldSchema, request.body),
      );
      logTableChange(request, 'update_field', changed.table);
      return { table: toPublicTable(changed.table), field: changed.field };
    },
  );

  app.post(
    '/api/admin/tables/:projectId/fields/:fieldKey/rename',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { projectId, fieldKey } = parseFieldParams(request.params);
      const body = parseInput(renameFieldSchema, request.body);
      const changed = await repository.renameField(projectId, fieldKey, body.key);
      logTableChange(request, 'rename_field', changed.table);
      return {
        table: toPublicTable(changed.table),
        field: changed.field,
        message: '前端上报代码需同步改用新 Key，否则旧 Key 的上报会被拒绝',
      };
    },
  );

  app.post(
    '/api/admin/tables/:projectId/fields/:fieldKey/deprecate',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { projectId, fieldKey } = parseFieldParams(request.params);
      const changed = await repository.deprecateField(projectId, fieldKey);
      logTableChange(request, 'deprecate_field', changed.table);
      return { table: toPublicTable(changed.table), field: changed.field };
    },
  );

  app.delete(
    '/api/admin/tables/:projectId/fields/:fieldKey',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { projectId, fieldKey } = parseFieldParams(request.params);
      const body = parseInput(confirmationSchema, request.body);
      const changed = await repository.dropField(projectId, fieldKey, body.confirm);
      logTableChange(request, 'drop_field', changed.table);
      return { table: toPublicTable(changed.table), field: changed.field };
    },
  );

  app.get(
    '/api/admin/tables/:projectId/fields/:fieldKey/usage',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { projectId, fieldKey } = parseFieldParams(request.params);
      return { count: await repository.fieldUsage(projectId, fieldKey) };
    },
  );
}
