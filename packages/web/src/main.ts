import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router/index.js';
import { pinia } from './stores/index.js';

createApp(App).use(pinia).use(router).use(ElementPlus).mount('#app');
