import { defineStore } from 'pinia';

import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  type LoginInput,
  type UserInfo,
} from '../api/auth.js';

export const AUTH_TOKEN_STORAGE_KEY = 'collect-log.authToken';

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistToken(token: string): void {
  try {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    // The in-memory session remains usable when storage is unavailable.
  }
}

function removeStoredToken(): void {
  try {
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // There is no persistent session to remove when storage is unavailable.
  }
}

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  initialized: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: readStoredToken(),
    user: null,
    initialized: false,
  }),
  getters: {
    isAuthenticated: (state): boolean => state.token !== null && state.user !== null,
  },
  actions: {
    setSession(token: string, user: UserInfo): void {
      this.token = token;
      this.user = user;
      this.initialized = true;
      persistToken(token);
    },
    clearSession(): void {
      this.token = null;
      this.user = null;
      this.initialized = true;
      removeStoredToken();
    },
    async restoreSession(): Promise<void> {
      if (this.initialized) {
        return;
      }
      if (this.token === null) {
        this.clearSession();
        return;
      }

      try {
        const response = await getCurrentUser();
        this.user = response.user;
        this.initialized = true;
      } catch (error) {
        this.clearSession();
        throw error;
      }
    },
    async login(input: LoginInput): Promise<void> {
      const response = await loginRequest(input);
      this.setSession(response.token, response.user);
    },
    async logout(): Promise<void> {
      try {
        if (this.token !== null) {
          await logoutRequest();
        }
      } finally {
        this.clearSession();
      }
    },
  },
});
