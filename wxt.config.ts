import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'NextRole',
    description: 'NextRole — AI-powered job monitoring co-pilot. Never miss out.',
    permissions: ['storage', 'notifications', 'alarms', 'tabs', 'activeTab'],
    host_permissions: ['http://localhost:5000/*'],
  },
});
