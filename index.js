const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

const STORAGE_FILE = path.join(__dirname, "last-squeue.json");
const MOST_API_STORAGE_FILE = path.join(__dirname, "last-most-api.json");
const LOG_FILE = path.join(__dirname, "watchdog.log");
const ENV_FILE = path.join(__dirname, ".env");
const DEFAULT_STILL_ALIVE_MINUTES = 180;
const MOST_API_ENV_KEYS = ["MOST_API_URL_1", "MOST_API_URL_2", "MOST_API_URL_3"];
const FINISHED_RESULT_FIELDS = [
  "FINISHED",
  "MODEL_USED",
  "URL",
  "MIN_INPUT_TOKENS",
  "MAX_INPUT_TOKENS",
  "MIN_OUTPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "LARGEST_TRUE",
];
const CURRENT_RESULT_FIELDS = [
  "MODEL_USED",
  "URL",
  "MIN_INPUT_TOKENS",
  "MAX_INPUT_TOKENS",
  "MIN_OUTPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
];
const FOUR_FAILED_RESULT_FIELDS = [
  "MODEL_USED",
  "URL",
  "MIN_INPUT_TOKENS",
  "MAX_INPUT_TOKENS",
  "MIN_OUTPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "LARGEST_TRUE",
  "SMALLEST_FALSE",
];

function log(message, details) {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  const line = `[${timestamp}] ${message}${suffix}`;

  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch (error) {
    console.error(`[WATCHDOG] Failed to write log: ${error.message}`);
  }
}

function summarizeResponse(payload) {
  if (payload === null || payload === undefined) {
    return null;
  }

  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  const maximumLength = 2000;
  return serialized.length > maximumLength
    ? `${serialized.slice(0, maximumLength)}... [truncated]`
    : serialized;
}

function sameExperimentReference(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left.experiment || "") === String(right.experiment || "")
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

  let candidate = trimmed;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }

    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
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
  log("MoST API state stored", { file: MOST_API_STORAGE_FILE });
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
    "SMALLEST_FALSE",
    "smallest_false",
    "smallestFalse",
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

function extractFirstResultSummary(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  if (Array.isArray(payload.rows) && payload.rows.length > 0) {
    return extractExperimentSummary(payload.rows[0]);
  }

  return extractExperimentSummary(payload);
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
    log("HTTP endpoint called", { method: "GET", endpoint: target.toString() });

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
          log("HTTP endpoint returned", { method: "GET", endpoint: target.toString(), statusCode, response: null });
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
            log("HTTP endpoint returned", { method: "GET", endpoint: target.toString(), statusCode, response: null });
            resolve(null);
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            log("HTTP endpoint returned", {
              method: "GET",
              endpoint: target.toString(),
              statusCode,
              response: summarizeResponse(parsed),
            });
            resolve(parsed);
          } catch {
            log("HTTP endpoint returned invalid JSON", {
              method: "GET",
              endpoint: target.toString(),
              statusCode,
              response: summarizeResponse(raw),
            });
            resolve(null);
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      log("HTTP endpoint timed out", { method: "GET", endpoint: target.toString(), timeoutMs });
      request.destroy(new Error("Request timed out"));
    });

    request.on("error", (error) => {
      log("HTTP endpoint failed", { method: "GET", endpoint: target.toString(), error: error.message });
      reject(error);
    });
  });
}

async function isApiAvailable(apiUrl) {
  if (!normalizeMostApiUrl(apiUrl)) {
    return false;
  }

  try {
    const healthUrl = new URL("/health", apiUrl).toString();
    log("Checking MoST API availability", { endpoint: healthUrl });
    const payload = await httpRequestJson(healthUrl, 5000);
    const available = Boolean(payload && payload.ok === true);
    log("MoST API availability result", { apiUrl, available });
    return available;
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

async function fetchResultCsvFields(apiUrl, experiment, iteration, fields) {
  const query = encodeURIComponent(fields.join(","));
  const relativePath = `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iteration)}/results.csv?fields=${query}`;
  return fetchMostApiJson(apiUrl, relativePath);
}

function formatExperimentSummaryFields(summary, includeLargestTrue, includeSmallestFalse) {
  const orderedKeys = [
    "MODEL_USED",
    "URL",
    "MIN_INPUT_TOKENS",
    "MAX_INPUT_TOKENS",
    "MIN_OUTPUT_TOKENS",
    "MAX_OUTPUT_TOKENS",
  ];

  if (includeLargestTrue) {
    orderedKeys.push("LARGEST_TRUE");
  }

  if (includeSmallestFalse) {
    orderedKeys.push("SMALLEST_FALSE");
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

function buildFourFailedNotificationBody(apiUrl, record) {
  return [
    `API: ${apiUrl}`,
    `Experiment: ${record.experiment}`,
    `Latest iteration: ${record.iteration}`,
    "The last four iterations failed.",
    ...formatExperimentSummaryFields(record.summary || {}, true, true),
  ].join("\n");
}

async function detectLatestFinishedExperiment(apiUrl) {
  const experimentsPayload = await fetchMostApiJson(apiUrl, "/api/experiments");
  const experiments = Array.isArray(experimentsPayload && experimentsPayload.experiments)
    ? experimentsPayload.experiments.slice()
    : [];

  let latestExperiment = null;

  for (const rawExperiment of experiments) {
    const experiment = String(rawExperiment).trim();
    if (!experiment) {
      continue;
    }

    const iterationsPayload = await fetchMostApiJson(apiUrl, `/api/experiments/${encodeURIComponent(experiment)}/iterations`);
    const iterations = Array.isArray(iterationsPayload && iterationsPayload.iterations)
      ? iterationsPayload.iterations.slice()
      : [];

    const sortedIterations = iterations
      .map((iteration) => String(iteration))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));

    const iteration = sortedIterations[0];
    if (!iteration || (latestExperiment && iteration.localeCompare(
      latestExperiment.iteration,
      undefined,
      { numeric: true, sensitivity: "base" },
    ) <= 0)) {
      continue;
    }

    latestExperiment = { experiment, iteration };
  }

  if (!latestExperiment) {
    return null;
  }

  const resultPayload = await fetchResultCsvFields(
    apiUrl,
    latestExperiment.experiment,
    latestExperiment.iteration,
    FINISHED_RESULT_FIELDS,
  );

  if (!resultPayload || !hasFinishedFlag(resultPayload)) {
    return null;
  }

  const summary = extractExperimentSummary(resultPayload);
  if (!summary.URL) {
    return null;
  }

  return {
    experiment: latestExperiment.experiment,
    iteration: latestExperiment.iteration,
    url: summary.URL,
    summary,
  };
}

async function detectCurrentExperiment(apiUrl) {
  const currentPayload = await fetchMostApiJson(apiUrl, "/api/current-experiment");
  if (!currentPayload || !currentPayload.experiment || !currentPayload.iteration) {
    return null;
  }

  const experiment = String(currentPayload.experiment);
  const iteration = String(currentPayload.iteration);
  const resultPayload = await fetchResultCsvFields(
    apiUrl,
    experiment,
    iteration,
    CURRENT_RESULT_FIELDS,
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

async function detectFourFailedIterations(apiUrl) {
  const current = await detectCurrentExperiment(apiUrl);
  if (!current) {
    return null;
  }

  const failureStatus = await fetchMostApiJson(
    apiUrl,
    `/api/experiments/${encodeURIComponent(current.experiment)}/last-four-failed`,
  );

  if (!failureStatus || failureStatus.lastFourFailed !== true || !Array.isArray(failureStatus.checkedIterations)) {
    return null;
  }

  const recentIteration = failureStatus.checkedIterations[0];
  if (!recentIteration) {
    return null;
  }

  const resultPayload = await fetchResultCsvFields(
    apiUrl,
    current.experiment,
    recentIteration,
    FOUR_FAILED_RESULT_FIELDS,
  );
  const summary = extractFirstResultSummary(resultPayload);
  if (!summary.URL) {
    return null;
  }

  return {
    experiment: current.experiment,
    iteration: String(recentIteration),
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
  log("MoST API check started", { configuredApiCount: configuredUrls.length, apiUrls: configuredUrls });
  if (configuredUrls.length === 0) {
    log("MoST API check skipped", { reason: "no valid API URLs configured" });
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
      log("MoST API checks skipped", { apiUrl: normalizedUrl, reason: "health check failed" });
      console.log(`[WATCHDOG] MoST API unavailable: ${normalizedUrl}`);
      continue;
    }

    const latestFinished = await detectLatestFinishedExperiment(normalizedUrl);
    log("Latest finished experiment detected", { apiUrl: normalizedUrl, experiment: latestFinished });
    if (latestFinished) {
      const previousLatest = state[normalizedUrl] && state[normalizedUrl].latestFinished;
      if (!sameExperimentReference(previousLatest, latestFinished)) {
        log("New latest finished experiment found", { apiUrl: normalizedUrl, experiment: latestFinished });
        const body = buildExperimentNotificationBody(normalizedUrl, latestFinished, true);
        sendPushbulletNote("MoST finished experiment", body);
        updateMostApiState(state, normalizedUrl, "latestFinished", latestFinished);
      }
    }

    const current = await detectCurrentExperiment(normalizedUrl);
    log("Current experiment detected", { apiUrl: normalizedUrl, experiment: current });
    if (current) {
      const previousCurrent = state[normalizedUrl] && state[normalizedUrl].current;
      if (!sameExperimentReference(previousCurrent, current)) {
        log("New current experiment found", { apiUrl: normalizedUrl, experiment: current });
        const body = buildExperimentNotificationBody(normalizedUrl, current, false);
        sendPushbulletNote("MoST current experiment changed", body);
        updateMostApiState(state, normalizedUrl, "current", current);
      }
    }

    const fourFailed = await detectFourFailedIterations(normalizedUrl);
    log("Four-failed-iterations result", { apiUrl: normalizedUrl, experiment: fourFailed });
    if (fourFailed) {
      const previousFourFailed = state[normalizedUrl] && state[normalizedUrl].fourFailed;
      if (!sameExperimentReference(previousFourFailed, fourFailed)) {
        log("Four consecutive failed iterations found", { apiUrl: normalizedUrl, experiment: fourFailed });
        const body = buildFourFailedNotificationBody(normalizedUrl, fourFailed);
        sendPushbulletNote("MoST four failed iterations", body);
        updateMostApiState(state, normalizedUrl, "fourFailed", fourFailed);
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
  const command = 'squeue --noheader --format="%i|%j|%T|%N"';
  log("squeue called", { command });
  try {
    const output = execSync(
      command,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    log("squeue returned", { lineCount: lines.length, lines });
    return lines;
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const stdout = error && error.stdout ? String(error.stdout).trim() : "";
    const message = stderr || stdout || error.message;
    log("squeue failed", { error: message });
    throw new Error(`squeue failed: ${message}`);
  }
}

function parseSqueueLine(line) {
  const parts = line.split("|");
  if (parts.length < 4) {
    return null;
  }

  const [jobId, name, state, node] = parts;
  return {
    jobId: jobId.trim(),
    name: name.trim(),
    state: state.trim(),
    node: node.trim() || "unknown",
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
    log("Pushbullet notification skipped", { title, reason: "PUSHBULLET_API not configured" });
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
    log("Pushbullet notification called", {
      title,
      deviceId: deviceId || "all devices",
      body: summarizeResponse(body),
    });
    const response = execSync(
      `curl -sS -X POST https://api.pushbullet.com/v2/pushes -u "${token}:" -H "Content-Type: application/json" -d '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const parsed = JSON.parse(response);
    if (parsed && parsed.error) {
      log("Pushbullet notification failed", { title, response: summarizeResponse(parsed) });
      console.error("[WATCHDOG] Pushbullet error:", parsed.error.message || parsed.error);
      return;
    }

    console.log("[WATCHDOG] Pushbullet notification sent");
    log("Pushbullet notification sent", { title, response: summarizeResponse(parsed) });
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout).trim() : "";
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const text = stdout || stderr || error.message;
    log("Pushbullet notification failed", { title, error: text });
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
  log("Watchdog poll started");
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
  log("squeue snapshot stored", { file: STORAGE_FILE, jobCount: currentJobs.length });

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
  detectFourFailedIterations,
  pollMostApiChecks,
};
