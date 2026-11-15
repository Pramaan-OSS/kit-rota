import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The kit carries the starter's package.json, which has no browser tools: point WALK_BROWSER_MODULE at an installed
// @playwright/test (its index.mjs) to run this walk.
const browserModule = process.env.WALK_BROWSER_MODULE;
const { chromium, expect } = await import(
  browserModule ? pathToFileURL(browserModule).href : "@playwright/test"
);

import { Pool } from "pg";
import { startFakeDoor } from "./fake-door.mjs";

const origin = "http://127.0.0.1:3520",
  secret = randomBytes(32).toString("hex"),
  project = "rota-walk";
if (!process.env.DATABASE_URL) throw Error("Use a disposable migrated DATABASE_URL.");
mkdirSync(".evidence", { recursive: true });
mkdirSync(".scratch", { recursive: true });
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
// This is a disposable-database walk. Refuse a previous owner rather than deleting unrelated records.
if ((await db.query("SELECT 1 FROM app_users WHERE role='owner'")).rowCount)
  throw Error("Use a fresh disposable database for the walk.");
const door = await startFakeDoor({ dir: path.resolve(".evidence/door") });
door.emailOn = false;
const manifest = JSON.parse(readFileSync("pramaan.kit.json", "utf8"));
const results = [],
  checks = [],
  errors = [];
let peakMiB = 0,
  browser;
function pass(extra = {}) {
  const now = Math.floor(Date.now() / 1000),
    body = Buffer.from(
      JSON.stringify({
        v: 1,
        role: "owner",
        project,
        iat: now,
        exp: now + 60,
        nonce: randomBytes(18).toString("base64url"),
        ...extra,
      }),
    ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-p", "3520", "-H", "127.0.0.1"],
  {
    env: {
      ...process.env,
      SESSION_SECRET: secret,
      PRAMAAN_PROJECT_ID: project,
      APP_ORIGIN: origin,
      APP_COOKIE_SECURE: "false",
      PRAMAAN_MODULES_DIR: path.resolve(".evidence/door"),
    },
    stdio: ["ignore", openSync(".scratch/walk-server.log", "w"), "inherit"],
  },
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
    /* process exited */
  }
}, 100);
async function context() {
  const c = await browser.newContext({ baseURL: origin });
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { c, p };
}
async function post(c, body, url = "/api/rota") {
  return c.request.post(url, { headers: { origin }, data: body });
}
function note(s) {
  checks.push(s);
  console.log(`passed: ${s}`);
}
async function signin(email) {
  const { c, p } = await context();
  await p.goto("/");
  await p.getByLabel("Email", { exact: true }).fill(email);
  await p.getByLabel("Password", { exact: true }).fill("Rota browser pass!");
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(p.getByText(`Signed in as ${email}`, { exact: false })).toBeVisible();
  return { c, p };
}
async function invite(p, name, email, role = "staff") {
  await p.goto("/team");
  await p.getByLabel("Name", { exact: true }).fill(name);
  await p.getByLabel("Email", { exact: true }).fill(email);
  await p.getByLabel("Role", { exact: true }).selectOption(role);
  await p.getByRole("button", { name: "Invite person", exact: true }).click();
  await expect(p.getByText("Invitation emailed.", { exact: true })).toBeVisible();
  const mail = door.mail.findLast((m) => m.to === email);
  expect(mail).toBeTruthy();
  const link = mail.text.match(/http\S+\/invite#[a-f0-9]{64}/u)[0];
  const { c, p: join } = await context();
  await join.goto(link);
  await expect(join.getByText(email, { exact: false })).toBeVisible();
  expect(new URL(join.url()).hash).toBe("");
  await join.getByLabel("Choose a password", { exact: true }).fill("Rota browser pass!");
  await join.getByLabel("Type it again", { exact: true }).fill("Rota browser pass!");
  await join.getByRole("button", { name: "Accept invite", exact: true }).click();
  await expect(join.getByText(`Signed in as ${email}`, { exact: false })).toBeVisible();
  return { c, p: join, link };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Server did not start.");
  browser = await chromium.launch({ headless: true });
  for (const j of manifest.journeys.filter((j) => j.status === "ships-working")) {
    let { c, p } = await context();
    try {
      for (const item of JSON.parse(readFileSync(j.checklist, "utf8")).items)
        for (const step of item.steps) {
          if (step.enterAs) {
            await c.close();
            ({ c, p } = await context());
            if (step.enterAs === "owner") await p.goto(`/api/account/owner-pass?token=${pass()}`);
            else if (step.enterAs !== "visitor") throw Error(`Unsupported role ${step.enterAs}`);
          } else if (step.goto) await p.goto(step.goto);
          else if (step.fill) await p.getByLabel(step.fill, { exact: true }).fill(step.value);
          else if (step.select)
            await p.getByLabel(step.select, { exact: true }).selectOption({ label: step.option });
          else if (step.click)
            await p
              .getByRole("button", { name: step.click, exact: true })
              .or(p.getByRole("link", { name: step.click, exact: true }))
              .click();
          else if (step.expectText)
            await expect(p.getByText(step.expectText, { exact: false }).first()).toBeVisible();
          else if (step.expectHeading)
            await expect(
              p.getByRole("heading", { name: step.expectHeading, exact: true }),
            ).toBeVisible();
          else if (step.expectAbsent)
            await expect(p.getByText(step.expectAbsent, { exact: false })).toHaveCount(0);
          else throw Error("Unsupported checklist step");
        }
      results.push(j.id);
      console.log(`journey passed: ${j.id}`);
    } catch (e) {
      await p.screenshot({ path: `.evidence/failed-${j.id}.png`, fullPage: true });
      throw e;
    } finally {
      await c.close();
    }
  }
  door.emailOn = true;
  const { p: op } = await context();
  const ownerToken = pass();
  await op.goto(`/api/account/owner-pass?token=${ownerToken}`);
  await expect(op.getByRole("heading", { name: "Owner area", exact: true })).toBeVisible();
  for (const token of [
    ownerToken,
    pass({ project: "foreign-project" }),
    pass({ exp: 1 }),
    `${pass()}broken`,
  ]) {
    const { c, p } = await context();
    const response = await p.goto(`/api/account/owner-pass?token=${token}`);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    await c.close();
  }
  note("owner pass works once; replay, foreign, expired and forged passes fail");
  const manager = await invite(op, "Walk manager", "manager@walk.test", "manager");
  const a = await invite(op, "Walk Alice", "alice@walk.test");
  const b = await invite(op, "Walk Bea", "bea@walk.test");
  await manager.c.close();
  const mgr = await signin("manager@walk.test");
  note(
    "manager and both staff accept emailed invitations and sign in; manager saved-password sign-in works",
  );
  await mgr.p.goto("/rota");
  await mgr.p.getByLabel("Week beginning (Monday)", { exact: true }).fill("2099-07-06");
  await mgr.p.getByRole("button", { name: "Create draft week", exact: true }).click();
  await expect(mgr.p.getByRole("heading", { name: "Draft week", exact: true })).toBeVisible();
  let state = await (await mgr.c.request.get("/api/rota")).json();
  const wid = state.chosen.id;
  const sh = {
    action: "shift",
    weekId: wid,
    locationId: state.locations[0].id,
    positionId: state.positions[0].id,
    typeId: state.shift_types[0].id,
    start: "2099-07-06T09:00",
    end: "2099-07-06T17:00",
    assigneeId: state.staff.find((s) => s.name === "Walk Alice").id,
  };
  await mgr.p.getByLabel("Assign to", { exact: true }).selectOption({ label: "Walk Alice" });
  await mgr.p.getByLabel("Start (location time)", { exact: true }).fill(sh.start);
  await mgr.p.getByLabel("End (location time)", { exact: true }).fill(sh.end);
  await mgr.p.getByRole("button", { name: "Add shift", exact: true }).click();
  await expect(mgr.p.getByText("2099-07-06 09:00 – 2099-07-06 17:00")).toBeVisible();
  await mgr.p.getByRole("button", { name: "Edit shift", exact: true }).click();
  await expect(mgr.p.getByLabel("Assign to", { exact: true })).toHaveValue(sh.assigneeId);
  await mgr.p.getByRole("button", { name: "Save shift", exact: true }).click();
  await expect(mgr.p.getByText("Saved.", { exact: true })).toBeVisible();
  expect((await a.c.request.get(`/api/rota?week=${wid}`)).status()).toBe(404);
  expect((await post(a.c, sh)).status()).toBe(403);
  expect(
    (
      await post(mgr.c, {
        action: "invite",
        name: "Denied",
        email: "denied@walk.test",
        role: "manager",
      })
    ).status(),
  ).toBe(403);
  expect(
    (await post(mgr.c, { ...sh, start: "2099-07-06T10:00", end: "2099-07-06T11:00" })).status(),
  ).toBe(409);
  note(
    "drafts hidden from staff; staff cannot edit shifts, managers cannot add managers, overlap refused",
  );
  const open = (
    await (
      await post(mgr.c, {
        ...sh,
        assigneeId: null,
        start: "2099-07-07T09:00",
        end: "2099-07-07T17:00",
      })
    ).json()
  ).id;
  await mgr.p.reload();
  await mgr.p.getByRole("button", { name: "Publish week", exact: true }).click();
  await expect(mgr.p.getByRole("heading", { name: "Published rota", exact: true })).toBeVisible();
  expect(
    door.mail.some(
      (m) => m.to === "alice@walk.test" && m.subject === "Your rota week has been published",
    ),
  ).toBe(true);
  await a.p.goto("/rota");
  await a.p.getByRole("button", { name: "Offer swap", exact: true }).click();
  await expect(a.p.getByText("Awaiting a colleague", { exact: false })).toBeVisible();
  await b.p.goto("/rota");
  await b.p.getByRole("button", { name: "Take swap", exact: true }).click();
  await expect(b.p.getByText("Walk Alice → Walk Bea · taken", { exact: true })).toBeVisible();
  await mgr.p.reload();
  await mgr.p.getByRole("button", { name: "Approve swap", exact: true }).click();
  await expect(mgr.p.getByText("Walk Alice → Walk Bea · approved", { exact: true })).toBeVisible();
  state = await (await mgr.c.request.get(`/api/rota?week=${wid}`)).json();
  expect(state.shifts.find((s) => s.starts_local === "2099-07-06 09:00").assignee).toBe("Walk Bea");
  note("manager publishes, staff offer and take, manager approves, and assignment persists");
  const claims = await Promise.all([
    post(a.c, { action: "claim", id: open }),
    post(b.c, { action: "claim", id: open }),
  ]);
  expect(claims.map((r) => r.status()).sort()).toEqual([200, 409]);
  note("two concurrent staff claims have exactly one winner");
  await a.p.goto("/availability");
  await a.p.getByLabel("Available from", { exact: true }).fill("09:00");
  await a.p.getByLabel("Available until", { exact: true }).fill("17:00");
  await a.p.getByRole("button", { name: "Add weekly availability", exact: true }).click();
  await expect(a.p.getByText("Walk Alice: Monday 09:00:00–17:00:00")).toBeVisible();
  await a.p.getByLabel("First day", { exact: true }).fill("2099-07-10");
  await a.p.getByLabel("Last day", { exact: true }).fill("2099-07-11");
  await a.p.getByRole("button", { name: "Request time off", exact: true }).click();
  await expect(a.p.getByText("pending", { exact: false })).toBeVisible();
  await mgr.p.goto("/availability");
  await mgr.p.getByRole("button", { name: "Decline time off", exact: true }).click();
  await expect(mgr.p.getByText("declined", { exact: false })).toBeVisible();
  await b.p.goto("/availability");
  await expect(b.p.getByText("Walk Alice: Monday", { exact: false })).toHaveCount(0);
  note("staff availability and leave are private; manager declines leave and email notices arrive");
  await mgr.p.goto("/team");
  await mgr.p.getByLabel("Staff CSV", { exact: true }).setInputFiles({
    name: "staff.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,Email\nImported person,imported@walk.test"),
  });
  await expect(mgr.p.getByText("Imported 1 staff.", { exact: false })).toBeVisible();
  await mgr.p.goto("/rota");
  const download = mgr.p.waitForEvent("download");
  await mgr.p.getByRole("link", { name: "Export shifts and hours", exact: true }).click();
  const csv = readFileSync(await (await download).path(), "utf8");
  expect(csv).toContain("Weekly hours");
  expect(csv).toContain("Walk Bea");
  expect(csv).toContain("2099-07-06 09:00");
  note("staff CSV import and downloaded week shifts/hours are verified");
  const sid = state.shifts.find((s) => s.assignee === "Walk Bea").id;
  expect((await post(a.c, { action: "offer", id: sid })).status()).toBe(403);
  const foreignId = randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/u, "$1-$2-$3-$4-$5");
  expect((await a.c.request.get(`/api/rota?week=${foreignId}`)).status()).toBe(404);
  const { c: visitor } = await context();
  expect((await visitor.request.get("/api/rota")).status()).toBe(401);
  expect((await visitor.request.get(`/api/rota/export?week=${wid}`)).status()).toBe(401);
  await visitor.close();
  note(
    "signed-out data and exports refused; staff cannot offer others shifts or read foreign weeks",
  );
  await mgr.p.goto("/rota");
  await mgr.p.screenshot({ path: ".evidence/rota-desktop.png", fullPage: true });
  await mgr.p.setViewportSize({ width: 390, height: 844 });
  await mgr.p.screenshot({ path: ".evidence/rota-mobile.png", fullPage: true });
  expect(await mgr.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  note("desktop and 390px mobile layout fit the viewport");
  expect(errors).toEqual([]);
  console.log(`App peak summed RSS: ${peakMiB} MiB`);
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify(
      {
        journeys: results,
        checks,
        errors,
        appPeakMiB: peakMiB,
        method: "sampled summed RSS of production server and descendants",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  clearInterval(sampler);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  await door.close();
  await db.end();
}
