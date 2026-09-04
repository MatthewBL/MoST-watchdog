# MoST Watchdog

MoST Watchdog is the operational monitoring process for the MoST benchmark. It
does not run experiments or calculate the sustainable request limit. Instead, it
periodically checks whether the experiment infrastructure and result services
are progressing, then reports important changes through the console and,
optionally, Pushbullet.

## Role in MoST

MoST is split into cooperating components:

```text
MoST-experiment-environment
				| runs workloads, evaluates iterations, writes results/
				v
MoST-API
				| exposes results and experiment state over HTTP
				v
MoST Watchdog
				| detects changes and sends operational notifications
				v
Pushbullet / console / watchdog.log
```

- **MoST-experiment-environment** runs the benchmark. It sends requests to the
	model endpoint, evaluates each iteration, and writes `results.csv` and
	`results.json`. Its two-stage search finds the largest sustainable `REQ_MIN`
	for each token interval.
- **MoST-API** serves those files through endpoints such as `/health`,
	`/api/experiments`, `/api/current-experiment`, and the parsed `results.csv`
	route. The Watchdog depends on this API to inspect experiment progress.
- **MoST-dashboard** is the interactive visualization layer. It reads from
	MoST-API and is useful for detailed investigation; the Watchdog is intended
	for unattended status monitoring.
- **MoST-telemetry-addon** collects host or container CPU, memory, and network
	measurements with Prometheus. The Watchdog does not query telemetry directly,
	but telemetry files can be correlated with the events it reports.
- **MoST-Watchdog** monitors Slurm jobs and MoST-API state. It is a consumer of
	experiment results, not part of the benchmark measurement algorithm.

## What it monitors

On every poll, the Watchdog:

1. Runs `squeue --noheader --Format=jobid,name,state,nodelist`.
2. Compares the current Slurm jobs with the previous snapshot.
3. Reports jobs that were added, removed, or changed state, name, or node.
4. Checks every configured MoST API with `GET /health`.
5. Detects newly finished experiments and changes to the current experiment.
6. Checks whether the active experiment has four consecutive failed iterations.

For experiment notifications it requests selected fields from parsed
`results.csv` data, rather than downloading the potentially large
`results.json`. Notifications can include the model, endpoint, token limits,
and, for four-failed-iteration notifications, `LARGEST_TRUE` and
`SMALLEST_FALSE`.

The first poll creates a baseline and does not report it as a job change. Later
polls compare against that baseline. State is stored in:

- `last-squeue.json`: the previous Slurm snapshot and heartbeat timestamp.
- `last-most-api.json`: the last notified experiment state per API.
- `watchdog.log`: detailed operational logs.

## Prerequisites

Run the Watchdog on a machine that has:

- Node.js 18 or newer.
- Access to the Slurm command `squeue` and permission to query the relevant
	jobs.
- Network access to one or more running MoST-API instances.
- Network access to the device to be notified, most likely through the public network.
- `curl`, if Pushbullet notifications are enabled.
- A Pushbullet access token, if remote notifications are required.

The MoST-API instances must be backed by the result directories produced by
`MoST-experiment-environment`. The Watchdog itself does not need the Python
benchmark dependencies.

## Installation

From this directory:

```bash
npm install
```

Create `MoST-Watchdog/.env`:

```env
# One or more API instances. The numbered keys support up to three instances.
MOST_API_URL_1=http://127.0.0.1:4000
# MOST_API_URL_2=http://127.0.0.1:4001
# MOST_API_URL_3=http://127.0.0.1:4002

# Optional Pushbullet delivery.
PUSHBULLET_API=your_pushbullet_access_token
PUSHBULLET_DEVICE_ID=your_device_id

# Optional heartbeat interval. Default: 180 minutes.
WATCHDOG_STILL_ALIVE_MINUTES=180
```

`MOST_API_URL` is also accepted as a legacy single-API configuration. API URLs
may use `http` or `https`; paths are removed and the Watchdog addresses the
MoST-API root.

Keep `.env` private. The token is used for the Pushbullet request but is not
written to the log.

## Run one poll

Start MoST-API first, then test the Watchdog from `MoST-Watchdog`:

```bash
node index.js
```

This performs one poll and exits. Check the console and `watchdog.log`. On the
first successful run, confirm that `last-squeue.json` and, when API URLs are
configured, `last-most-api.json` were created.

## Run continuously

The built-in loop is useful for an interactive session:

```bash
node index.js --loop --interval 300000
```

`--interval` is measured in milliseconds. The equivalent npm script polls every
five minutes:

```bash
npm run watch
```

For unattended operation, use the one-poll command from cron instead of the
built-in loop. This gives cron responsibility for scheduling and prevents a
second long-running process from being started accidentally.

## Launch with crontab

1. Find the absolute paths:

	 ```bash
	 pwd
	 command -v node
	 ```

2. Verify the one-poll command manually using those paths. For example:

	 ```bash
	 cd /opt/most/MoST-Watchdog
	 /usr/bin/node index.js
	 ```

3. Edit the crontab for the user that can run `squeue`:

	 ```bash
	 crontab -e
	 ```

4. Add a five-minute schedule. Replace both paths with the real absolute paths:

	 ```cron
	 */5 * * * * cd /opt/most/MoST-Watchdog && /usr/bin/node index.js >> /opt/most/MoST-Watchdog/cron.log 2>&1
	 ```

Cron starts with a minimal environment, so use absolute paths and rely on the
`.env` file in `MoST-Watchdog` for configuration. The working-directory change
is important because the Watchdog stores its state and log beside `index.js`.

To confirm that cron is running, inspect `cron.log` and `watchdog.log`:

```bash
tail -f /opt/most/MoST-Watchdog/watchdog.log
```

Do not add `--loop` to the cron command: each cron invocation should run one
poll and exit before the next scheduled invocation.

## Troubleshooting

- **`squeue failed`:** run `squeue` as the same user and confirm that Slurm
	environment or authentication is available to cron.
- **API unavailable:** open `MOST_API_URL_1/health` and confirm that MoST-API is
	running and reachable from the Watchdog host.
- **No Pushbullet notification:** confirm `PUSHBULLET_API`, optionally
	`PUSHBULLET_DEVICE_ID`, and `curl`. Notifications are skipped when the token
	is absent; console logging and state tracking still work.
- **Unexpected repeated notifications:** preserve `last-squeue.json` and
	`last-most-api.json` between polls. Do not run multiple Watchdog copies from
	different working directories unless separate state is intended.
