# MoST Watchdog

A simple console watchdog for monitoring Slurm jobs via `squeue`.

## Usage

```bash
node index.js
node index.js --loop --interval 300000
```

## Environment

Set at least one of the following URLs in `.env`:

```env
PUSHBULLET_API=TOKEN
PUSHBULLET_DEVICE_ID=DEVICE_ID
WATCHDOG_STILL_ALIVE_MINUTES=180
MOST_API_URL_1=https://api1.example.com
MOST_API_URL_2=https://api2.example.com
MOST_API_URL_3=https://api3.example.com
```

Each configured MoST API is checked with `/health` first. If it is healthy, the watchdog compares the latest finished experiment and the current experiment against the previous stored values and sends a Pushbullet notification when those change.

Experiment checks use the parsed `results.csv` endpoint with a `fields` query parameter, so the watchdog does not download the large `results.json` file.

The watchdog stores the last `squeue` snapshot in `last-squeue.json` and compares it with the next poll. If a job is added, removed, or changes state, it prints a notification payload to the console.

Detailed operational logs are appended to `watchdog.log`. The log includes poll starts, `squeue` commands and results, every MoST API endpoint called, HTTP status and response summaries, notification decisions, Pushbullet outcomes, and state-file writes. Long HTTP responses are truncated to keep the log manageable, and the Pushbullet API token is never logged.

This is a first implementation intended to be extended with real notifications and experiment monitoring.
