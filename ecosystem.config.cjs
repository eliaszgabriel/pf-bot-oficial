module.exports = {
  apps: [{
    name: "pf-bot",
    script: "server.js",
    cwd: "/home/ubuntu/pf-bot",
    env: { NODE_ENV: "production" },
    watch: false,
    max_restarts: 10,
    restart_delay: 2000
  }]
};
