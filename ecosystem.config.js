module.exports = {
  apps: [
    {
      name: 'cbt-sman3-buru',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      max_memory_restart: '750M',
      restart_delay: 2000
    }
  ]
};
