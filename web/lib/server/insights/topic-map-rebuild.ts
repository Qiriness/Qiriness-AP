/**
 * Rebuild the topic map from the dashboard — the same `cluster:tickets:save`
 * a person runs in a terminal, started by a button.
 *
 * WHY THIS WAS A COMMAND, AND WHAT CHANGED. The panel used to hand over the
 * command instead, for two reasons: a long all-pairs job inside a request, and
 * a hand-tuned threshold that a one-click rebuild invites re-running until the
 * map looks nice. Measured on 2026-09-11 the whole run takes ~9 seconds over
 * the live corpus, so the first reason no longer holds at this size; and the
 * button takes NO arguments — it always runs at the script's own tuned
 * defaults — so the second is designed out rather than trusted to discipline.
 *
 * ONE RUN AT A TIME. A second click while a rebuild is running joins it rather
 * than starting another; two concurrent saves would each prune the other's run.
 *
 * Server-only. Spawns the script rather than importing it so the job's own
 * config loading, logging and exit code stay exactly what the terminal sees.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const TIMEOUT_MS = 3 * 60_000;

export interface RebuildResult {
  runId: string | null;
  topics: number | null;
  seconds: number;
}

let running: Promise<RebuildResult> | null = null;

export function rebuildTopicMap(): Promise<RebuildResult> {
  if (!running) {
    running = run().finally(() => {
      running = null;
    });
  }
  return running;
}

function scriptPath(): string {
  // `next dev` / `next start` run from web/; the scripts live one level up.
  const candidates = [
    path.join(process.cwd(), "..", "scripts", "cluster-ticket-messages.mjs"),
    path.join(process.cwd(), "scripts", "cluster-ticket-messages.mjs"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("scripts/cluster-ticket-messages.mjs was not found next to the dashboard.");
  return found;
}

function run(): Promise<RebuildResult> {
  const script = scriptPath();
  const started = Date.now();

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, "--save"],
      { cwd: path.dirname(path.dirname(script)), timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          // The script prints its own error message to stderr and exits 1; that
          // line is the useful part, not the Node stack around the spawn.
          const detail = String(stderr || error.message).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`The rebuild failed: ${detail}`));
          return;
        }
        const saved = String(stdout).match(/Saved run (\S+) — (\d+) topic/);
        resolve({
          runId: saved?.[1] ?? null,
          topics: saved ? Number(saved[2]) : null,
          seconds: Math.round((Date.now() - started) / 1000),
        });
      }
    );
  });
}
