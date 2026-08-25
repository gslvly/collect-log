import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { env } from '../../config/env.js';
import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { isUserRole, type UserRole } from '../users/types.js';

export interface AuthenticatedUser {
  username: string;
  role: UserRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthenticatedUser;
    user: AuthenticatedUser;
  }
}

function isExpiredTokenError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('code' in error && error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') ||
      ('name' in error && error.name === 'TokenExpiredError'))
  );
}

export async function registerJwt(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      algorithm: 'HS256',
      expiresIn: configuredLimits.auth.tokenTtlSec,
    },
    verify: {
      algorithms: ['HS256'],
    },
  });
}

export async function authenticateRequest(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (error) {
    if (isExpiredTokenError(error)) {
      throw new AppError('TOKEN_EXPIRED', 'Authentication token has expired');
    }
    throw new AppError('UNAUTHORIZED', 'A valid Bearer token is required');
  }

  if (
    typeof request.user.username !== 'string' ||
    request.user.username.length === 0 ||
    !isUserRole(request.user.role)
  ) {
    throw new AppError('UNAUTHORIZED', 'Authentication token contains invalid claims');
  }
}

export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (request) => {
    await authenticateRequest(request);
    if (!roles.includes(request.user.role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions for this operation');
    }
  };
}
