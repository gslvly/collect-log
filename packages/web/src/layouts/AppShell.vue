<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';

import { changePassword } from '../api/auth.js';
import { getApiErrorMessage } from '../api/errors.js';
import { can, type Permission, type Role } from '../permissions.js';
import { useAuthStore } from '../stores/auth.js';
import { useFieldTypesStore } from '../stores/field-types.js';

interface NavigationItem {
  label: string;
  path: string;
  marker: string;
  permission?: Permission;
}

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const navigationItems: readonly NavigationItem[] = [
  { label: '数据概览', path: '/overview', marker: '览' },
  { label: '数据采集表', path: '/tables', marker: '表', permission: 'viewTables' },
  { label: '数据明细查询', path: '/query', marker: '查', permission: 'queryData' },
  { label: '统计分析', path: '/statistics', marker: '析', permission: 'queryData' },
  { label: '账户管理', path: '/accounts', marker: '户', permission: 'createUser' },
];

const roleLabels: Record<Role, string> = {
  user: '只读用户',
  admin: '管理员',
  super_admin: '超级管理员',
};

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const fieldTypesStore = useFieldTypesStore();
const passwordDialogVisible = ref(false);
const passwordSubmitting = ref(false);
const passwordFormRef = ref<FormInstance>();
const passwordForm = reactive<PasswordForm>({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});

const visibleNavigationItems = computed(() => {
  const role = authStore.user?.role;
  if (role === undefined) {
    return [];
  }
  return navigationItems.filter(
    (item) => item.permission === undefined || can(role, item.permission),
  );
});
const activeNavigationPath = computed(() =>
  route.path.startsWith('/tables/') ? '/tables' : route.path,
);

const passwordRules: FormRules<PasswordForm> = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 1, message: '请输入新密码', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value !== passwordForm.newPassword) {
          callback(new Error('两次输入的新密码不一致'));
          return;
        }
        callback();
      },
      trigger: 'blur',
    },
  ],
};

function resetPasswordForm(): void {
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirmPassword = '';
  passwordFormRef.value?.clearValidate();
}

async function submitPasswordChange(): Promise<void> {
  if (passwordFormRef.value === undefined) {
    return;
  }
  const valid = await passwordFormRef.value.validate().catch(() => false);
  if (!valid) {
    return;
  }

  passwordSubmitting.value = true;
  try {
    await changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });
    ElMessage.success('密码修改成功');
    passwordDialogVisible.value = false;
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    passwordSubmitting.value = false;
  }
}

async function handleLogout(): Promise<void> {
  try {
    await authStore.logout();
  } catch {
    ElMessage.warning('服务端登出失败，本地登录状态已清除');
  } finally {
    await router.replace({ name: 'login' });
  }
}

onMounted(() => {
  void fieldTypesStore.load().catch(() => {
    // Pages that need the matrix expose their own retry state.
  });
});
</script>

<template>
  <el-container class="app-shell">
    <el-aside class="app-sidebar" width="224px">
      <div class="sidebar-brand">
        <span class="sidebar-logo">CL</span>
        <span>Collect Log</span>
      </div>
      <el-menu class="sidebar-menu" router :default-active="activeNavigationPath">
        <el-menu-item v-for="item in visibleNavigationItems" :key="item.path" :index="item.path">
          <span class="nav-marker">{{ item.marker }}</span>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footnote">数据采集管理后台</div>
    </el-aside>

    <el-container class="shell-main">
      <el-header class="topbar" height="68px">
        <div>
          <p class="page-eyebrow">管理后台</p>
          <h1>{{ route.meta.title ?? 'Collect Log' }}</h1>
        </div>

        <div class="topbar-actions">
          <el-dropdown trigger="click">
            <button class="user-menu-button" type="button">
              <span class="avatar">{{ authStore.user?.username.slice(0, 1).toUpperCase() }}</span>
              <span class="user-copy">
                <strong>{{ authStore.user?.username }}</strong>
                <small>{{ authStore.user ? roleLabels[authStore.user.role] : '' }}</small>
              </span>
              <span class="chevron">⌄</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="passwordDialogVisible = true">修改密码</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="content-area">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog
    v-model="passwordDialogVisible"
    title="修改密码"
    width="440px"
    destroy-on-close
    @closed="resetPasswordForm"
  >
    <el-form
      ref="passwordFormRef"
      :model="passwordForm"
      :rules="passwordRules"
      label-position="top"
    >
      <el-form-item label="当前密码" prop="currentPassword">
        <el-input
          v-model="passwordForm.currentPassword"
          type="password"
          autocomplete="current-password"
          show-password
        />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="passwordForm.newPassword"
          type="password"
          autocomplete="new-password"
          show-password
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="passwordForm.confirmPassword"
          type="password"
          autocomplete="new-password"
          show-password
          @keyup.enter="submitPasswordChange"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="passwordDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="passwordSubmitting" @click="submitPasswordChange"
        >确认修改</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.app-sidebar {
  position: fixed;
  z-index: 10;
  top: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  color: #dce7f7;
  background: #102544;
  box-shadow: 8px 0 30px rgb(17 38 69 / 10%);
}

.sidebar-brand {
  display: flex;
  height: 68px;
  align-items: center;
  gap: 12px;
  padding: 0 22px;
  font-size: 17px;
  font-weight: 700;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.sidebar-logo {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  font-size: 12px;
  color: #102544;
  background: #fff;
  border-radius: 9px;
}

.sidebar-menu {
  flex: 1;
  padding: 18px 12px;
  background: transparent;
  border-right: 0;
}

.sidebar-menu :deep(.el-menu-item) {
  height: 46px;
  margin-bottom: 6px;
  color: #adbed3;
  border-radius: 9px;
}

.sidebar-menu :deep(.el-menu-item:hover) {
  color: #fff;
  background: rgb(255 255 255 / 7%);
}

.sidebar-menu :deep(.el-menu-item.is-active) {
  color: #fff;
  background: #2d70d6;
}

.nav-marker {
  display: inline-flex;
  width: 25px;
  height: 25px;
  margin-right: 11px;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid currentcolor;
  border-radius: 7px;
}

.sidebar-footnote {
  padding: 20px 24px;
  font-size: 12px;
  color: #6f86a4;
  border-top: 1px solid rgb(255 255 255 / 7%);
}

.shell-main {
  min-width: 0;
  margin-left: 224px;
}

.topbar {
  position: sticky;
  z-index: 5;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  background: rgb(255 255 255 / 94%);
  border-bottom: 1px solid #e8edf5;
  backdrop-filter: blur(14px);
}

.page-eyebrow {
  margin: 0 0 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: #91a0b5;
}

.topbar h1 {
  margin: 0;
  font-size: 19px;
}

.topbar-actions,
.user-menu-button {
  display: flex;
  align-items: center;
}

.topbar-actions {
  gap: 24px;
}

.user-menu-button {
  gap: 10px;
  padding: 5px 7px;
  cursor: pointer;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 9px;
}

.user-menu-button:hover {
  background: #f4f7fb;
}

.avatar {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  font-weight: 700;
  color: #2d70d6;
  background: #eaf2ff;
  border-radius: 50%;
}

.user-copy {
  display: grid;
  gap: 1px;
}

.user-copy strong {
  font-size: 13px;
}

.user-copy small {
  color: #8b97a8;
}

.chevron {
  color: #9aa5b5;
}

.content-area {
  padding: 28px;
  background: #f4f7fb;
}

@media (max-width: 900px) {
  .app-sidebar {
    width: 76px !important;
  }

  .sidebar-brand {
    justify-content: center;
    padding: 0;
  }

  .sidebar-brand > span:last-child,
  .sidebar-menu :deep(.el-menu-item > span:last-child),
  .sidebar-footnote {
    display: none;
  }

  .sidebar-menu {
    padding: 18px 10px;
  }

  .sidebar-menu :deep(.el-menu-item) {
    justify-content: center;
    padding: 0 !important;
  }

  .nav-marker {
    margin-right: 0;
  }

  .shell-main {
    margin-left: 76px;
  }

  .user-copy,
  .chevron {
    display: none;
  }
}

@media (max-width: 620px) {
  .topbar {
    padding: 0 16px;
  }
  .content-area {
    padding: 16px;
  }
}
</style>
