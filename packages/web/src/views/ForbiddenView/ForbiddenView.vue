<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <el-result icon="warning" title="无权访问" sub-title="当前账户没有访问此页面的权限。">
    <template #extra>
      <el-button type="primary" @click="router.replace({ name: 'overview' })">返回首页</el-button>
    </template>
  </el-result>
</template>
