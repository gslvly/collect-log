import type { Role } from '../permissions.js';
import { requestJson } from './client.js';

export interface UserInfo {
  username: string;
  role: Role;
}

export interface CaptchaResponse {
  captchaId: string;
  image: string;
}

export interface LoginInput {
  username: string;
  password: string;
  captchaId: string;
  captchaCode: string;
}

export interface LoginResponse {
  token: string;
  expiresIn: number;
  user: UserInfo;
}

export interface MeResponse {
  user: UserInfo;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface SuccessResponse {
  success: true;
}

export function getCaptcha(): Promise<CaptchaResponse> {
  return requestJson<CaptchaResponse>('/api/auth/captcha');
}

export function login(input: LoginInput): Promise<LoginResponse> {
  return requestJson<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: input,
    skipAuthFailureHandling: true,
  });
}

export function logout(): Promise<SuccessResponse> {
  return requestJson<SuccessResponse>('/api/auth/logout', { method: 'POST' });
}

export function getCurrentUser(): Promise<MeResponse> {
  return requestJson<MeResponse>('/api/auth/me');
}

export function changePassword(input: ChangePasswordInput): Promise<SuccessResponse> {
  return requestJson<SuccessResponse>('/api/auth/change-password', {
    method: 'POST',
    body: input,
  });
}
