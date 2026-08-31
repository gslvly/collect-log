<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getCaptcha } from '../../api/auth.js';
import { getApiErrorMessage } from '../../api/errors.js';
import { useAuthStore } from '../../stores/auth.js';

interface LoginForm {
  username: string;
  password: string;
  captchaCode: string;
}

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const formRef = ref<FormInstance>();
const form = reactive<LoginForm>({ username: '', password: '', captchaCode: '' });
const captchaId = ref('');
const captchaImage = ref('');
const captchaLoading = ref(false);
const submitting = ref(false);
const errorMessage = ref('');

const rules: FormRules<LoginForm> = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captchaCode: [{ required: true, message: '请输入验证码', trigger: 'blur' }],
};

async function refreshCaptcha(showError = true): Promise<void> {
  captchaLoading.value = true;
  captchaId.value = '';
  captchaImage.value = '';
  form.captchaCode = '';
  try {
    const captcha = await getCaptcha();
    captchaId.value = captcha.captchaId;
    captchaImage.value = captcha.image;
  } catch (error) {
    if (showError) {
      errorMessage.value = getApiErrorMessage(error);
    }
  } finally {
    captchaLoading.value = false;
  }
}

function getSafeRedirect(): string {
  const redirect = route.query.redirect;
  return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : '/overview';
}

async function submit(): Promise<void> {
  if (formRef.value === undefined || captchaId.value === '') {
    return;
  }
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) {
    return;
  }

  submitting.value = true;
  errorMessage.value = '';
  try {
    await authStore.login({
      username: form.username,
      password: form.password,
      captchaId: captchaId.value,
      captchaCode: form.captchaCode,
    });
    await router.replace(getSafeRedirect());
  } catch (error) {
    errorMessage.value = getApiErrorMessage(error);
    await refreshCaptcha(false);
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void refreshCaptcha();
});
</script>

<template>
  <main class="login-page">
    <section class="login-intro">
      <div class="brand-mark">CL</div>
      <p class="eyebrow">COLLECT LOG</p>
      <h1>让每一次上报<br />都清晰可见</h1>
      <p class="intro-copy">统一管理数据采集表、查询明细并洞察业务趋势。</p>
    </section>

    <section class="login-panel">
      <el-card class="login-card" shadow="never">
        <div class="card-heading">
          <h2>登录管理后台</h2>
          <p>请输入账户信息与图形验证码</p>
        </div>

        <el-alert
          v-if="errorMessage"
          class="login-error"
          :title="errorMessage"
          type="error"
          :closable="false"
          show-icon
        />

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          @submit.prevent="submit"
        >
          <el-form-item label="用户名" prop="username">
            <el-input
              v-model="form.username"
              size="large"
              autocomplete="username"
              placeholder="请输入用户名"
            />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              autocomplete="current-password"
              placeholder="请输入密码"
              show-password
              @keyup.enter="submit"
            />
          </el-form-item>
          <el-form-item label="图形验证码" prop="captchaCode">
            <div class="captcha-row">
              <el-input
                v-model="form.captchaCode"
                size="large"
                autocomplete="off"
                placeholder="请输入验证码"
                @keyup.enter="submit"
              />
              <button
                class="captcha-button"
                type="button"
                :disabled="captchaLoading"
                aria-label="刷新验证码"
                title="点击刷新验证码"
                @click="refreshCaptcha()"
              >
                <img v-if="captchaImage" :src="captchaImage" alt="图形验证码，点击刷新" />
                <span v-else>{{ captchaLoading ? '加载中…' : '点击刷新' }}</span>
              </button>
            </div>
          </el-form-item>
          <el-button
            class="submit-button"
            type="primary"
            size="large"
            native-type="submit"
            :loading="submitting"
            :disabled="captchaId === ''"
          >
            登录
          </el-button>
        </el-form>
      </el-card>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  grid-template-columns: minmax(380px, 1.05fr) minmax(440px, 0.95fr);
  background: #f7f9fc;
}

.login-intro {
  position: relative;
  display: flex;
  overflow: hidden;
  flex-direction: column;
  justify-content: center;
  padding: 11vw;
  color: #fff;
  background:
    radial-gradient(circle at 20% 15%, rgb(83 144 255 / 55%), transparent 34%),
    linear-gradient(145deg, #122c58 0%, #0d1f40 54%, #071329 100%);
}

.login-intro::after {
  position: absolute;
  right: -130px;
  bottom: -170px;
  width: 420px;
  height: 420px;
  content: '';
  border: 1px solid rgb(255 255 255 / 13%);
  border-radius: 50%;
  box-shadow: 0 0 0 70px rgb(255 255 255 / 3%);
}

.brand-mark {
  display: grid;
  width: 52px;
  height: 52px;
  margin-bottom: 60px;
  place-items: center;
  font-weight: 800;
  letter-spacing: -1px;
  color: #122c58;
  background: #fff;
  border-radius: 14px;
}

.eyebrow {
  margin: 0 0 16px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.28em;
  color: #87b3ff;
}

.login-intro h1 {
  margin: 0;
  font-size: clamp(38px, 4.6vw, 66px);
  line-height: 1.14;
  letter-spacing: -0.04em;
}

.intro-copy {
  max-width: 450px;
  margin: 26px 0 0;
  line-height: 1.8;
  color: rgb(255 255 255 / 70%);
}

.login-panel {
  display: grid;
  padding: 48px;
  place-items: center;
}

.login-card {
  width: min(100%, 440px);
  border: 0;
  border-radius: 18px;
  box-shadow: 0 24px 70px rgb(26 43 74 / 12%);
}

.login-card :deep(.el-card__body) {
  padding: 42px;
}

.card-heading {
  margin-bottom: 28px;
}

.card-heading h2 {
  margin: 0 0 8px;
  font-size: 26px;
}

.card-heading p {
  margin: 0;
  color: #8a94a6;
}

.login-error {
  margin-bottom: 20px;
}

.captcha-row {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr 138px;
  gap: 12px;
}

.captcha-button {
  display: grid;
  height: 40px;
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  place-items: center;
  color: #64748b;
  background: #f8fafc;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
}

.captcha-button:disabled {
  cursor: wait;
}

.captcha-button img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.submit-button {
  width: 100%;
  margin-top: 8px;
}

@media (max-width: 840px) {
  .login-page {
    grid-template-columns: 1fr;
  }

  .login-intro {
    display: none;
  }

  .login-panel {
    padding: 24px;
  }

  .login-card :deep(.el-card__body) {
    padding: 30px 24px;
  }
}
</style>
