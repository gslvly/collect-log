import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../errors.js';
import { requireRole } from '../auth/jwt.js';
import { assertCanCreateUser } from './permissions.js';
import type { UserRepository } from './repository.js';
import { toPublicUser, USER_ROLES, USER_STATUSES } from './types.js';

const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(USER_ROLES),
});

const resetPasswordSchema = z.object({
  password: z.string().min(1),
});

const statusSchema = z.object({
  status: z.enum(USER_STATUSES),
});

const usernameParamsSchema = z.object({
  username: z.string().min(1),
});

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_JSON', 'Request input does not match the expected shape');
  }
  return result.data;
}

function logAccountChange(
  request: FastifyRequest,
  operation: string,
  targetUsername: string,
): void {
  request.log.info(
    {
      requestId: request.id,
      operator: request.user.username,
      operation,
      targetUsername,
    },
    'account metadata changed',
  );
}

export function registerUserRoutes(app: FastifyInstance, userRepository: UserRepository): void {
  app.get('/api/admin/users', { preHandler: requireRole('admin', 'super_admin') }, async () => ({
    users: (await userRepository.list()).map(toPublicUser),
  }));

  app.post(
    '/api/admin/users',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const body = parseInput(createUserSchema, request.body);
      assertCanCreateUser(request.user.role, body.role);
      const user = await userRepository.create(body);
      logAccountChange(request, 'create_user', user.username);
      return { user: toPublicUser(user) };
    },
  );

  app.post(
    '/api/admin/users/:username/reset-password',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { username } = parseInput(usernameParamsSchema, request.params);
      const body = parseInput(resetPasswordSchema, request.body);
      await userRepository.resetPassword(username, body.password, request.user.role);
      logAccountChange(request, 'reset_user_password', username);
      return { success: true };
    },
  );

  app.post(
    '/api/admin/users/:username/status',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { username } = parseInput(usernameParamsSchema, request.params);
      const body = parseInput(statusSchema, request.body);
      const user = await userRepository.setStatus(username, body.status, request.user.role);
      logAccountChange(request, 'set_user_status', username);
      return { user: toPublicUser(user) };
    },
  );

  app.delete(
    '/api/admin/users/:username',
    { preHandler: requireRole('admin', 'super_admin') },
    async (request) => {
      const { username } = parseInput(usernameParamsSchema, request.params);
      await userRepository.delete(username, request.user.role);
      logAccountChange(request, 'delete_user', username);
      return { success: true };
    },
  );
}
