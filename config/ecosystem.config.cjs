module.exports = {
  apps: [
    {
      name: "signum-testnet-rewards",
      script: "src/main.ts",
      // Absolute: pm2's PATH is not your login shell's.
      interpreter: "/home/pi/.bun/bin/bun",
      cwd: "/home/pi/signum-testnet-rewards",

      // LOAD-BEARING, not a tuning knob. Two instances would mean two SQLite
      // writers and two payout batches in flight, breaking the single-batch
      // invariant that crash reconciliation depends on. Do not raise this.
      instances: 1,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      max_memory_restart: "400M",
      time: true,
    },
  ],
};
