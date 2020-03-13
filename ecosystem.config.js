module.exports = {
  apps: {
    name: "minimars-server",
    // script: "./node_modules/.bin/ts-node",
    // args: "src/index.ts",
    script: "./dist/index.js",
    log_date_format: "YYYY-MM-DD HH:mm:ss.SSS (ZZ)",
    log: true,
    env: {
      TZ: "Asia/Shanghai"
    }
  },
  deploy: {
    production: {
      user: "www-data",
      host: ["mini-mars.com"],
      ref: "origin/master",
      repo: "https://github.com/uicestone/minimars-server",
      path: "/var/www/minimars-server",
      "post-deploy": "yarn && pm2 startOrRestart ecosystem.config.js"
    },
    testing: {
      user: "www-data",
      host: ["stirad.com"],
      ref: "origin/testing",
      repo: "https://github.com/uicestone/minimars-server",
      path: "/var/www/minimars-server",
      "post-deploy": "yarn && pm2 startOrRestart ecosystem.config.js"
    }
  }
};
