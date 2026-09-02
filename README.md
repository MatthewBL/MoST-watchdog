# MoST Watchdog

A simple console watchdog for monitoring Slurm jobs via `squeue`.

## Usage

```bash
node index.js
node index.js --loop --interval 300000
```

The watchdog stores the last `squeue` snapshot in `last-squeue.json` and compares it with the next poll. If a job is added, removed, or changes state, it prints a notification payload to the console.

This is a first implementation intended to be extended with real notifications and experiment monitoring.
