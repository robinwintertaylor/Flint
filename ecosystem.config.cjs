module.exports = {
  apps: [
    {
      name: 'flint-dashboard',
      script: 'dashboard/server.js',
      cwd: 'C:/Users/Robin/Applications Dev/Flint',
      watch: false,
      max_memory_restart: '500M',
      env: { PORT: '3000', NODE_ENV: 'production' },
    },
    {
      name: 'flint-router',
      script: 'router/server.js',
      cwd: 'C:/Users/Robin/Applications Dev/Flint',
      watch: false,
      max_memory_restart: '300M',
      env: { PORT: '3001', NODE_ENV: 'production' },
    },
  ],
};
