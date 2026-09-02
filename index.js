const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

const STORAGE_FILE = path.join(__dirname, "last-squeue.json");
const MOST_API_STORAGE_FILE = path.join(__dirname, "last-most-api.json");
const ENV_FILE = path.join(__dirname, ".env");
const DEFAULT_STILL_ALIVE_MINUTES = 180;
const MOST_API_ENV_KEYS = ["MOST_API_URL_1", "MOST_API_URL_2", "MOST_API_URL_3"];

function sameExperimentReference(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left.experiment || "") === String(right.experiment || "")
    && String(left.iteration || "") === String(right.iteration || "")
    && String(left.url || "") === String(right.url || "");
}

function normalizeMostApiUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (["http:", "https:"].includes(parsed.protocol) && parsed.hostname) {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Ignore invalid values and treat them as unavailable.
  }

  return null;
}

function getConfiguredMostApiUrls() {
  const values = [];

  for (const key of MOST_API_ENV_KEYS) {
    const configured = process.env[key];
    if (typeof configured === "string") {
      const normalized = normalizeMostApiUrl(configured);
      if (normalized) {
        values.push(normalized);
      }
    }
  }

  if (values.length === 0 && process.env.MOST_API_URL) {
    const legacy = normalizeMostApiUrl(process.env.MOST_API_URL);
    if (legacy) {
      values.push(legacy);
    }
  }

  return [...new Set(values)];
}

function readMostApiState() {
  try {
    const raw = fs.readFileSync(MOST_API_STORAGE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeMostApiState(state) {
  fs.writeFileSync(MOST_API_STORAGE_FILE, JSON.stringify(state, null, 2));
}

function deepFindPropertyValue(value, keys) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = deepFindPropertyValue(item, keys);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (typeof value === "object") {
    const lowered = keys.map((key) => key.toLowerCase());

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (keys.includes(entryKey) || lowered.includes(entryKey.toLowerCase())) {
        return entryValue;
      }
    }

    for (const nested of Object.values(value)) {
      const found = deepFindPropertyValue(nested, keys);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}

function scalarFromValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const text = String(value).trim();
  return text || null;
}

function extractExperimentSummary(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const keys = [
    "MODEL_USED",
    "model_used",
    "modelUsed",
    "MIN_INPUT_TOKENS",
    "min_input_tokens",
    "minInputTokens",
    "MAX_INPUT_TOKENS",
    "max_input_tokens",
    "maxInputTokens",
    "MIN_OUTPUT_TOKENS",
    "min_output_tokens",
    "minOutputTokens",
    "MAX_OUTPUT_TOKENS",
    "max_output_tokens",
    "maxOutputTokens",
    "URL",
    "url",
    "LARGEST_TRUE",
    "largest_true",
    "largestTrue",
  ];

  const summary = {};
  for (const key of keys) {
    const found = deepFindPropertyValue(payload, [key]);
    if (found !== undefined && found !== null && String(found).trim() !== "") {
      summary[key] = scalarFromValue(found);
    }
  }

  return summary;
}

function hasFinishedFlag(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const finishedValue = deepFindPropertyValue(payload, ["FINISHED", "finished"]);
  if (finishedValue === undefined || finishedValue === null) {
    return false;
  }

  if (typeof finishedValue === "boolean") {
    return finishedValue;
  }

  const normalized = String(finishedValue).trim().toLowerCase();
  return ["finished", "done", "complete", "completed", "success", "true", "1", "pass", "passed"].includes(normalized);
}

function httpRequestJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;

    const request = transport.get(
      target,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "most-watchdog/1.0",
        },
      },
      (response) => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode >= 400) {
          response.resume();
          resolve(null);
          return;
        }

        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if (!raw.trim()) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Request timed out"));
    });

    request.on("error", reject);
  });
}

async function isApiAvailable(apiUrl) {
  if (!normalizeMostApiUrl(apiUrl)) {
    return false;
  }

  try {
    const healthUrl = new URL("/health", apiUrl).toString();
    const payload = await httpRequestJson(healthUrl, 5000);
    return Boolean(payload && payload.ok === true);
  } catch {
    return false;
  }
}

async function fetchMostApiJson(apiUrl, relativePath) {
  const targetUrl = new URL(relativePath, apiUrl).toString();
  try {
    return await httpRequestJson(targetUrl, 15000);
  } catch {
    return null;
  }
}

function formatExperimentSummaryFields(summary, includeLargestTrue) {
  const orderedKeys = [
    "MODEL_USED",
    "MIN_INPUT_TOKENS",
    "MAX_INPUT_TOKENS",
    "MIN_OUTPUT_TOKENS",
    "MAX_OUTPUT_TOKENS",
    "URL",
  ];

  if (includeLargestTrue) {
    orderedKeys.push("LARGEST_TRUE");
  }

  const lines = [];
  for (const key of orderedKeys) {
    const value = summary[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return lines;
}

function buildExperimentNotificationBody(apiUrl, record, includeLargestTrue) {
  const lines = [
    `API: ${apiUrl}`,
    `Experiment: ${record.experiment}`,
    `Iteration: ${record.iteration}`,
    ...formatExperimentSummaryFields(record.summary || {}, includeLargestTrue),
  ];

  return lines.join("\n");
}

async function detectLatestFinishedExperiment(apiUrl) {
  const experimentsPayload = await fetchMostApiJson(apiUrl, "/api/experiments");
  const experiments = Array.isArray(experimentsPayload && experimentsPayload.experiments)
    ? experimentsPayload.experiments.slice()
    : [];

  const sortedExperiments = experiments
    .map((experiment) => String(experiment))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));

  for (const experiment of sortedExperiments) {
    const iterationsPayload = await fetchMostApiJson(apiUrl, `/api/experiments/${encodeURIComponent(experiment)}/iterations`);
    const iterations = Array.isArray(iterationsPayload && iterationsPayload.iterations)
      ? iterationsPayload.iterations.slice()
      : [];

    const sortedIterations = iterations
      .map((iteration) => String(iteration))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));

    for (const iteration of sortedIterations) {
      const resultPayload = await fetchMostApiJson(
        apiUrl,
        `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iteration)}/download/results.json`,
      );

      if (!resultPayload || !hasFinishedFlag(resultPayload)) {
        continue;
      }

      const summary = extractExperimentSummary(resultPayload);
      if (!summary.URL) {
        continue;
      }

      return {
        experiment,
        iteration,
        url: summary.URL,
        summary,
      };
    }
  }

  return null;
}

async function detectCurrentExperiment(apiUrl) {
  const currentPayload = await fetchMostApiJson(apiUrl, "/api/current-experiment");
  if (!currentPayload || !currentPayload.experiment || !currentPayload.iteration) {
    return null;
  }

  const experiment = String(currentPayload.experiment);
  const iteration = String(currentPayload.iteration);
  const resultPayload = await fetchMostApiJson(
    apiUrl,
    `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iteration)}/download/results.json`,
  );

  if (!resultPayload) {
    return null;
  }

  const summary = extractExperimentSummary(resultPayload);
  if (!summary.URL) {
    return null;
  }

  return {
    experiment,
    iteration,
    url: summary.URL,
    summary,
  };
}

function updateMostApiState(state, apiUrl, kind, record) {
  const target = state && typeof state === "object" ? state : {};
  const current = target[apiUrl] && typeof target[apiUrl] === "object" ? target[apiUrl] : {};

  current[kind] = {
    experiment: record.experiment,
    iteration: record.iteration,
    url: record.url,
    summary: record.summary || {},
    observedAt: new Date().toISOString(),
  };

  target[apiUrl] = current;
  return target;
}

async function pollMostApiChecks() {
  const configuredUrls = getConfiguredMostApiUrls();
  if (configuredUrls.length === 0) {
    return;
  }

  const state = readMostApiState();

  for (const apiUrl of configuredUrls) {
    const normalizedUrl = normalizeMostApiUrl(apiUrl);
    if (!normalizedUrl) {
      continue;
    }

    const available = await isApiAvailable(normalizedUrl);
    if (!available) {
      console.log(`[WATCHDOG] MoST API unavailable: ${normalizedUrl}`);
      continue;
    }

    const latestFinished = await detectLatestFinishedExperiment(normalizedUrl);
    if (latestFinished) {
      const previousLatest = state[normalizedUrl] && state[normalizedUrl].latestFinished;
      if (!sameExperimentReference(previousLatest, latestFinished)) {
        const body = buildExperimentNotificationBody(normalizedUrl, latestFinished, true);
        sendPushbulletNote("MoST finished experiment", body);
        updateMostApiState(state, normalizedUrl, "latestFinished", latestFinished);
      }
    }

    const current = await detectCurrentExperiment(normalizedUrl);
    if (current) {
      const previousCurrent = state[normalizedUrl] && state[normalizedUrl].current;
      if (!sameExperimentReference(previousCurrent, current)) {
        const body = buildExperimentNotificationBody(normalizedUrl, current, false);
        sendPushbulletNote("MoST current experiment changed", body);
        updateMostApiState(state, normalizedUrl, "current", current);
      }
    }
  }

  writeMostApiState(state);
}

function loadDotEnv() {
  try {
    const envText = fs.readFileSync(ENV_FILE, "utf8");
    const lines = envText.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, "");
      if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing .env file.
  }
}

loadDotEnv();

function getStillAliveIntervalMinutes() {
  const rawValue = process.env.WATCHDOG_STILL_ALIVE_MINUTES || process.env.STILL_ALIVE_INTERVAL_MINUTES;
  const parsed = Number(rawValue !== undefined && rawValue !== null ? rawValue : DEFAULT_STILL_ALIVE_MINUTES);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STILL_ALIVE_MINUTES;
  }

  return parsed;
}

function readLastSnapshot() {
  try {
    const raw = fs.readFileSync(STORAGE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSnapshot(snapshot) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(snapshot, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let loop = false;
  let interval = 300000;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--loop") {
      loop = true;
    } else if (arg === "--interval") {
      const value = Number(args[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        interval = value;
      }
      i += 1;
    }
  }

  return { loop, interval };
}

function runSqueue() {
  try {
    const output = execSync(
      "squeue --noheader --Format=jobid,name,state,nodelist",
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const stdout = error && error.stdout ? String(error.stdout).trim() : "";
    const message = stderr || stdout || error.message;
    throw new Error(`squeue failed: ${message}`);
  }
}

function parseSqueueLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) {
    return null;
  }

  const [jobId, name, state, ...nodeParts] = parts;
  return {
    jobId,
    name,
    state,
    node: nodeParts.join(" ") || "unknown",
  };
}

function normalizeJobs(rawLines) {
  return rawLines
    .map(parseSqueueLine)
    .filter(Boolean)
    .map((job) => ({
      jobId: String(job.jobId),
      name: String(job.name),
      state: String(job.state),
      node: String(job.node),
    }));
}

function diffJobs(previousJobs, currentJobs) {
  const prevMap = new Map(previousJobs.map((job) => [job.jobId, job]));
  const currentMap = new Map(currentJobs.map((job) => [job.jobId, job]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [jobId, currentJob] of currentMap.entries()) {
    const previousJob = prevMap.get(jobId);
    if (!previousJob) {
      added.push({
        jobId,
        job: currentJob,
      });
      continue;
    }

    const fields = [];
    if (previousJob.state !== currentJob.state) fields.push(`state: ${previousJob.state} -> ${currentJob.state}`);
    if (previousJob.name !== currentJob.name) fields.push(`name: ${previousJob.name} -> ${currentJob.name}`);
    if (previousJob.node !== currentJob.node) fields.push(`node: ${previousJob.node} -> ${currentJob.node}`);

    if (fields.length > 0) {
      changed.push({
        jobId,
        before: previousJob,
        after: currentJob,
        fields,
      });
    }
  }

  for (const [jobId, previousJob] of prevMap.entries()) {
    if (!currentMap.has(jobId)) {
      removed.push({
        jobId,
        job: previousJob,
      });
    }
  }

  return { added, removed, changed };
}

function sendNotification(changeSet) {
  const added = changeSet.added || [];
  const removed = changeSet.removed || [];
  const changed = changeSet.changed || [];

  const lines = [];

  if (added.length > 0) {
    for (const entry of added) {
      const job = entry.job || {};
      lines.push(`Added job: ${job.jobId || "unknown"} | ${job.name || "unknown"} | ${job.state || "unknown"} | ${job.node || "unknown"}`);
    }
  }

  if (removed.length > 0) {
    for (const entry of removed) {
      const job = entry.job || {};
      lines.push(`Removed job: ${job.jobId || "unknown"} | ${job.name || "unknown"} | ${job.state || "unknown"} | ${job.node || "unknown"}`);
    }
  }

  if (changed.length > 0) {
    for (const entry of changed) {
      const fields = (entry.fields || []).join("; ");
      lines.push(`Changed job: ${entry.jobId || "unknown"} | ${fields}`);
    }
  }

  const summary = lines.join("\n");

  console.log("[WATCHDOG] Job change detected");
  console.log(JSON.stringify(changeSet, null, 2));

  if (summary) {
    sendPushbulletNote("Watchdog job change", summary);
  }
}

function sendPushbulletNote(title, body) {
  const token = process.env.PUSHBULLET_API;
  if (!token) {
    console.warn("[WATCHDOG] PUSHBULLET_API not configured. Skipping push notification.");
    return;
  }

  const payload = {
    type: "note",
    title,
    body,
  };

  const deviceId = process.env.PUSHBULLET_DEVICE_ID;
  if (deviceId) {
    payload.device_iden = deviceId;
  }

  try {
    const response = execSync(
      `curl -sS -X POST https://api.pushbullet.com/v2/pushes -u "${token}:" -H "Content-Type: application/json" -d '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const parsed = JSON.parse(response);
    if (parsed && parsed.error) {
      console.error("[WATCHDOG] Pushbullet error:", parsed.error.message || parsed.error);
      return;
    }

    console.log("[WATCHDOG] Pushbullet notification sent");
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout).trim() : "";
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const text = stdout || stderr || error.message;
    console.error("[WATCHDOG] Failed to send Pushbullet notification:", text);
  }
}

function sendStillAliveNotification(intervalMinutes) {
  const timestamp = new Date().toISOString();
  const body = `Watchdog is still alive.\nInterval: ${intervalMinutes} minutes\nTimestamp: ${timestamp}`;

  console.log("[WATCHDOG] Still alive");
  console.log(JSON.stringify({
    type: "still_alive",
    intervalMinutes,
    timestamp,
  }, null, 2));

  sendPushbulletNote("Watchdog still alive", body);
}

async function pollOnce() {
  const previousSnapshot = readLastSnapshot();
  const currentLines = runSqueue();
  const currentJobs = normalizeJobs(currentLines);
  const now = new Date();
  const intervalMinutes = getStillAliveIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  const changeSet = previousSnapshot
    ? diffJobs(previousSnapshot.jobs || [], currentJobs)
    : { added: [], removed: [], changed: [], initialSnapshot: true };

  const hasChanges =
    Boolean(changeSet.initialSnapshot) ||
    changeSet.added.length > 0 ||
    changeSet.removed.length > 0 ||
    changeSet.changed.length > 0;

  const lastHeartbeatAt = previousSnapshot && previousSnapshot.lastHeartbeatAt
    ? new Date(previousSnapshot.lastHeartbeatAt).getTime()
    : null;

  const heartbeatDue = !lastHeartbeatAt || now.getTime() - lastHeartbeatAt >= intervalMs;

  if (previousSnapshot && hasChanges) {
    sendNotification(changeSet);
  } else if (!previousSnapshot) {
    console.log("[WATCHDOG] No previous snapshot found. Storing initial baseline.");
  }

  if (previousSnapshot && heartbeatDue) {
    sendStillAliveNotification(intervalMinutes);
  }

  const nextSnapshot = {
    capturedAt: now.toISOString(),
    lastHeartbeatAt: heartbeatDue ? now.toISOString() : previousSnapshot && previousSnapshot.lastHeartbeatAt ? previousSnapshot.lastHeartbeatAt : null,
    jobs: currentJobs,
  };

  writeSnapshot(nextSnapshot);

  try {
    await pollMostApiChecks();
  } catch (error) {
    console.error("[WATCHDOG] Error checking MoST API state:", error && error.message ? error.message : error);
  }

  console.log(JSON.stringify({
    capturedAt: nextSnapshot.capturedAt,
    jobCount: currentJobs.length,
    intervalMinutes,
  }, null, 2));
}

function main() {
  const { loop, interval } = parseArgs();

  const run = async () => {
    try {
      await pollOnce();
    } catch (error) {
      console.error("[WATCHDOG] Error:", error.message);
    }
  };

  if (loop) {
    run();
    setInterval(() => {
      run();
    }, interval);
    return;
  }

  run();
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeMostApiUrl,
  getConfiguredMostApiUrls,
  extractExperimentSummary,
  hasFinishedFlag,
  detectLatestFinishedExperiment,
  detectCurrentExperiment,
  pollMostApiChecks,
};
