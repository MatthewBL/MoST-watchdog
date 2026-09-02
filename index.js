const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const STORAGE_FILE = path.join(__dirname, "last-squeue.json");

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
  console.log("[WATCHDOG] Job change detected");
  console.log(JSON.stringify(changeSet, null, 2));
}

function pollOnce() {
  const previousSnapshot = readLastSnapshot();
  const currentLines = runSqueue();
  const currentJobs = normalizeJobs(currentLines);

  const changeSet = previousSnapshot
    ? diffJobs(previousSnapshot.jobs || [], currentJobs)
    : { added: [], removed: [], changed: [], initialSnapshot: true };

  const hasChanges =
    Boolean(changeSet.initialSnapshot) ||
    changeSet.added.length > 0 ||
    changeSet.removed.length > 0 ||
    changeSet.changed.length > 0;

  if (previousSnapshot && hasChanges) {
    sendNotification(changeSet);
  } else if (!previousSnapshot) {
    console.log("[WATCHDOG] No previous snapshot found. Storing initial baseline.");
  }

  const nextSnapshot = {
    capturedAt: new Date().toISOString(),
    jobs: currentJobs,
  };

  writeSnapshot(nextSnapshot);

  console.log(JSON.stringify({
    capturedAt: nextSnapshot.capturedAt,
    jobCount: currentJobs.length,
  }, null, 2));
}

function main() {
  const { loop, interval } = parseArgs();

  const run = () => {
    try {
      pollOnce();
    } catch (error) {
      console.error("[WATCHDOG] Error:", error.message);
    }
  };

  if (loop) {
    run();
    setInterval(run, interval);
    return;
  }

  run();
}

main();
