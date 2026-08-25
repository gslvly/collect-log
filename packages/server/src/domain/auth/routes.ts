import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configuredLimits } from '../../config/limits.js';
import { AppError } from '../../errors.js';
import { verifyPassword } from '../users/password.js';
import type { UserRepository } from '../users/repository.js';
import { authenticateRequest } from './jwt.js';
import type { CaptchaService } from './captcha.js';
import type { CaptchaRateLimiter, LoginRateLimiter } from './rate-limit.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  captchaId: z.string().min(1),
  captchaCode: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('INVALID_JSON', 'Request body does not match the expected shape');
  }
  return result.data;
}

export interface AuthRouteDependencies {
  captchaService: CaptchaService;
  captchaRateLimiter: CaptchaRateLimiter;
  loginRateLimiter: LoginRateLimiter;
  userRepository: UserRepository;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { captchaService, captchaRateLimiter, loginRateLimiter, userRepository } = dependencies;

  app.get('/api/auth/captcha', async (request) => {
    if (!captchaRateLimiter.consume(request.ip)) {
      throw new AppError('RATE_LIMITED', 'Too many captcha requests from this IP address');
    }
    return captchaService.create();
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!loginRateLimiter.consume(request.ip)) {
      throw new AppError('RATE_LIMITED', 'Too many login attempts from this IP address');
    }

    const body = parseBody(loginSchema, request.body);
    if (!captchaService.consume(body.captchaId, body.captchaCode)) {
      throw new AppError('INVALID_CAPTCHA', 'Captcha is invalid or expired');
    }

    const user = await userRepository.findActiveByUsername(body.username);
    if (user === null || !(await verifyPassword(user.passwordHash, body.password))) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password');
    }

    const token = await reply.jwtSign({ username: user.username, role: user.role });
    return {
      token,
      expiresIn: configuredLimits.auth.tokenTtlSec,
      user: { username: user.username, role: user.role },
    };
  });

  app.post('/api/auth/logout', { preHandler: authenticateRequest }, async () => ({
    success: true,
  }));

  app.get('/api/auth/me', { preHandler: authenticateRequest }, async (request) => ({
    user: { username: request.user.username, role: request.user.role },
  }));

  app.post('/api/auth/change-password', { preHandler: authenticateRequest }, async (request) => {
    const body = parseBody(changePasswordSchema, request.body);
    await userRepository.changeOwnPassword(
      request.user.username,
      body.currentPassword,
      body.newPassword,
    );
    request.log.info(
      {
        requestId: request.id,
        operator: request.user.username,
        operation: 'change_own_password',
      },
      'account metadata changed',
    );
    return { success: true };
  });
}
