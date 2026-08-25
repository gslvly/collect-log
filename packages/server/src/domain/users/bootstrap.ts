import { env } from '../../config/env.js';
import { userRepository, type BootstrapUserResult } from './repository.js';

export async function bootstrapInitialSuperAdmin(): Promise<BootstrapUserResult> {
  const result = await userRepository.bootstrapSuperAdmin(
    env.BOOTSTRAP_ADMIN_USERNAME,
    env.BOOTSTRAP_ADMIN_PASSWORD,
  );

  if (result === 'created') {
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  }
  return result;
}
