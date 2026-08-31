import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import { setSessionInvalidHandler } from '../api/client.js';
import AppShell from '../layouts/AppShell.vue';
import { canAccessRoles, type Role } from '../permissions.js';
import { useAuthStore } from '../stores/auth.js';
import { pinia } from '../stores/index.js';
import ForbiddenView from '../views/ForbiddenView/ForbiddenView.vue';
import LoginView from '../views/LoginView/LoginView.vue';
import PlaceholderView from '../views/PlaceholderView/PlaceholderView.vue';
import QueryView from '../views/QueryView/QueryView.vue';
import TableDetailView from '../views/TableDetailView/TableDetailView.vue';
import TablesView from '../views/TablesView/TablesView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    title?: string;
    requiredRoles?: readonly Role[];
  }
}

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', redirect: { name: 'overview' } },
      {
        path: 'overview',
        name: 'overview',
        component: PlaceholderView,
        meta: { title: '数据概览' },
      },
      {
        path: 'tables',
        name: 'tables',
        component: TablesView,
        meta: { title: '数据采集表' },
      },
      {
        path: 'tables/:projectId',
        name: 'table-detail',
        component: TableDetailView,
        meta: { title: '数据采集表详情' },
      },
      {
        path: 'query',
        name: 'query',
        component: QueryView,
        meta: { title: '数据明细查询' },
      },
      {
        // 统计页把 ECharts 拉进依赖树，单独切一个 chunk，避免其余页面为它买单。
        path: 'statistics',
        name: 'statistics',
        component: () => import('../views/StatisticsView/StatisticsView.vue'),
        meta: { title: '统计分析' },
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: PlaceholderView,
        meta: { title: '账户管理', requiredRoles: ['admin', 'super_admin'] },
      },
      {
        path: 'forbidden',
        name: 'forbidden',
        component: ForbiddenView,
        meta: { title: '无权访问' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'overview' } },
] satisfies RouteRecordRaw[];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore(pinia);
  if (!authStore.initialized) {
    try {
      await authStore.restoreSession();
    } catch {
      // The store has already discarded the invalid local session.
    }
  }

  if (to.meta.public === true) {
    return authStore.isAuthenticated ? { name: 'overview' } : true;
  }

  if (!authStore.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  const role = authStore.user?.role;
  if (role === undefined) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (!canAccessRoles(role, to.meta.requiredRoles)) {
    return { name: 'forbidden' };
  }

  return true;
});

setSessionInvalidHandler(() => {
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name === 'login') {
    return;
  }
  void router.replace({
    name: 'login',
    query: currentRoute.fullPath === '/' ? {} : { redirect: currentRoute.fullPath },
  });
});
