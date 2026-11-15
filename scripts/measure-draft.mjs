import { execFileSync, spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";

const start = Date.now();
let peakMiB = 0;
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--disable-source-maps",
    "-p",
    "3521",
    "-H",
    "127.0.0.1",
  ],
  { env: process.env, stdio: ["ignore", openSync(".scratch/draft.log", "w"), "inherit"] },
);
const sampler = setInterval(() => {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((x) => x.trim().split(/\s+/u).map(Number));
    const tree = new Set([child.pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [pid, ppid] of rows)
        if (tree.has(ppid) && !tree.has(pid)) {
          tree.add(pid);
          grew = true;
        }
    }
    peakMiB = Math.max(
      peakMiB,
      Math.ceil(rows.filter(([pid]) => tree.has(pid)).reduce((n, [, , rss]) => n + rss, 0) / 1024),
    );
  } catch {
    /* stopped */
  }
}, 100);
try {
  let firstAnswerSeconds;
  for (let n = 0; n < 120; n++) {
    try {
      if ((await fetch("http://127.0.0.1:3521/")).ok) {
        firstAnswerSeconds = (Date.now() - start) / 1000;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!firstAnswerSeconds) throw Error("Draft did not answer.");
  for (const route of [
    "/rota",
    "/availability",
    "/team",
    "/settings",
    "/owner",
    "/invite",
    "/password-reset",
    "/reset-password",
    "/api/health",
  ]) {
    const r = await fetch(`http://127.0.0.1:3521${route}`);
    if (!r.ok) throw Error(`${route}: ${r.status}`);
  }
  const record = {
    peakMiB,
    firstAnswerSeconds,
    method: "sampled summed RSS of development server and descendants",
  };
  writeFileSync(".evidence/draft.json", JSON.stringify(record, null, 2));
  console.log(record);
} finally {
  clearInterval(sampler);
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}
