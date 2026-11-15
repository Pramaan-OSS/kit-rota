import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

const secret = randomBytes(32).toString("hex"),
  origin = "http://127.0.0.1:3520";
process.env.SESSION_SECRET = secret;
process.env.APP_ORIGIN = origin;
process.env.APP_COOKIE_SECURE = "false";
process.env.PRAMAAN_PROJECT_ID = "rota-tests";

import { POST as accountPost } from "../../app/api/account/[action]/route";
import { GET as exportCsv } from "../../app/api/rota/export/route";
import { GET, POST } from "../../app/api/rota/route";
import { hashPassword } from "../accounts";
import { database } from "../runtime";
import { type Viewer, workspaceFor } from "./access";
import { parseCsv } from "./csv";
import { change, invite, snapshot } from "./data";
import { acceptInvite, checkInvite } from "./invites";

type Actor = { v: Viewer; cookie: string; staffId: string };
let owner: Actor,
  manager: Actor,
  a: Actor,
  b: Actor,
  foreign: Actor,
  week: string,
  shiftId: string,
  open: string,
  position: string,
  type: string,
  location: string,
  hash: string;
const mail: { to: string; subject: string; text: string }[] = [];
const fake = {
  send: async (m: { to: string; subject: string; text: string }) => {
    mail.push(m);
    return { status: "sent" as const };
  },
};
const noMail = { send: async () => ({ status: "not-sent" as const }) };
async function actor(role: "owner" | "manager" | "staff", workspaceId?: string): Promise<Actor> {
  const uid = randomUUID(),
    address = `${uid}@example.test`;
  await database().query("INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,$4)", [
    uid,
    address,
    hash,
    role,
  ]);
  if (!workspaceId && role !== "owner") {
    workspaceId = randomUUID();
    await database().query("INSERT INTO workspaces VALUES($1,$2)", [workspaceId, uid]);
  }
  if (workspaceId)
    await database().query("INSERT INTO workspace_members VALUES($1,$2,$3)", [
      workspaceId,
      uid,
      role,
    ]);
  const v = await workspaceFor({ id: uid, email: address, role });
  const staff = await database().query(
    "INSERT INTO staff(workspace_id,name,email,user_id) VALUES($1,$2,$3,$4) RETURNING id",
    [v.workspaceId, role === "staff" ? `Staff ${uid.slice(0, 5)}` : role, address, uid],
  );
  const token = randomBytes(32).toString("hex");
  await database().query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '1 hour')", [
    createHmac("sha256", secret).update(token).digest("hex"),
    uid,
  ]);
  return { v, staffId: staff.rows[0].id, cookie: `app_session=${token}` };
}
function req(
  actor: Actor | undefined,
  body?: unknown,
  path = "/api/rota",
  extra: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(actor ? { cookie: actor.cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function post(who: Actor, body: unknown) {
  return POST(req(who, body));
}
function shift(extra: Record<string, unknown> = {}) {
  return {
    action: "shift",
    weekId: week,
    locationId: location,
    positionId: position,
    typeId: type,
    start: "2099-06-01T09:00",
    end: "2099-06-01T17:00",
    assigneeId: a.staffId,
    ...extra,
  };
}
beforeAll(async () => {
  hash = await hashPassword("a-long-test-password");
  owner = await actor("owner");
  manager = await actor("manager", owner.v.workspaceId);
  a = await actor("staff", owner.v.workspaceId);
  b = await actor("staff", owner.v.workspaceId);
  foreign = await actor("manager");
  const s = await snapshot(owner.v);
  position = (s.positions as { id: string }[])[0]?.id as string;
  type = (s.shift_types as { id: string }[])[0]?.id as string;
  location = (s.locations as { id: string }[])[0]?.id as string;
  week = (await change(manager.v, { action: "week", startsOn: "2099-06-01" }, fake)).id as string;
  shiftId = (await change(manager.v, shift(), fake)).id as string;
  open = (
    await change(
      manager.v,
      shift({ assigneeId: null, start: "2099-06-02T09:00", end: "2099-06-02T17:00" }),
      fake,
    )
  ).id as string;
});
afterAll(async () => {
  const ids = [owner?.v.workspaceId, foreign?.v.workspaceId].filter(Boolean);
  const users = (
    await database().query(
      "SELECT user_id id FROM workspace_members WHERE workspace_id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  for (const table of [
    "swaps",
    "availability",
    "time_off",
    "shifts",
    "rota_weeks",
    "rota_invites",
    "staff",
    "positions",
    "shift_types",
    "locations",
    "workspace_members",
    "workspaces",
  ]) {
    await database().query(
      `DELETE FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"}=ANY($1::uuid[])`,
      [ids],
    );
  }
  await database().query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [
    users.map((x) => x.id),
  ]);
  await database().end();
});
it("requires sign-in and rejects signup", async () => {
  expect((await GET(req(undefined))).status).toBe(401);
  expect(
    (
      await accountPost(
        req(
          undefined,
          { email: "no@example.test", password: "a-long-test-password" },
          "/api/account/signup",
        ),
        { params: Promise.resolve({ action: "signup" }) },
      )
    ).status,
  ).toBe(404);
});
it("staff cannot see draft weeks or export them", async () => {
  expect((await snapshot(a.v)).weeks).toEqual([]);
  expect((await GET(req(a, undefined, `/api/rota?week=${week}`))).status).toBe(404);
  expect((await exportCsv(req(a, undefined, `/api/rota/export?week=${week}`))).status).toBe(404);
});
it("staff cannot edit shifts, publish, create weeks or settings", async () => {
  for (const body of [
    shift(),
    { action: "publish", weekId: week },
    { action: "week", startsOn: "2099-06-08" },
    { action: "setting", table: "positions", name: "Denied" },
  ])
    expect((await post(a, body)).status).toBe(403);
  expect((await post(a, { action: "claim", id: open })).status).toBe(404);
});
it("blocks cross-workspace reads and writes", async () => {
  expect((await GET(req(foreign, undefined, `/api/rota?week=${week}`))).status).toBe(404);
  expect((await post(foreign, shift())).status).toBe(404);
});
it("rejects cross-origin changes", async () => {
  expect(
    (
      await POST(
        req(owner, { action: "week", startsOn: "2099-06-08" }, "/api/rota", {
          origin: "https://elsewhere.test",
        }),
      )
    ).status,
  ).toBe(403);
});
it("database prevents double-booking even without the app", async () => {
  await expect(
    database().query(
      "INSERT INTO shifts(workspace_id,week_id,location_id,position_id,type_id,assignee_id,starts_at,ends_at) SELECT workspace_id,week_id,location_id,position_id,type_id,assignee_id,starts_at,ends_at FROM shifts WHERE id=$1",
      [shiftId],
    ),
  ).rejects.toMatchObject({ code: "23P01" });
});
it("refuses overlaps while allowing touching shift boundaries", async () => {
  expect(
    (await post(manager, shift({ start: "2099-06-01T16:00", end: "2099-06-01T18:00" }))).status,
  ).toBe(409);
  expect(
    (await post(manager, shift({ start: "2099-06-01T17:00", end: "2099-06-01T18:00" }))).status,
  ).toBe(200);
});
it("rejects impossible dates and dates outside the week", async () => {
  for (const start of ["2099-06-08T09:00", "2099-02-31T09:00"])
    expect((await post(manager, shift({ start }))).status).toBe(400);
});
it("warns about recurring availability, unavailable dates and approved leave", async () => {
  await change(a.v, { action: "availability", weekday: 1, start: "10:00", end: "16:00" }, fake);
  await change(a.v, { action: "availability", unavailableOn: "2099-06-01" }, fake);
  let s = await snapshot(manager.v);
  expect(s.warnings.some((w) => w.shiftId === shiftId)).toBe(true);
  expect(s.availability.some((x) => x.unavailable_on === "2099-06-01")).toBe(true);
  await change(
    a.v,
    { action: "leave", start: "2099-06-01", end: "2099-06-01", reason: "Holiday" },
    fake,
  );
  s = await snapshot(manager.v);
  await change(manager.v, { action: "leave-decision", id: s.leave[0].id, approve: true }, fake);
  expect(
    (await snapshot(manager.v)).warnings.some((w) => w.message.includes("approved time off")),
  ).toBe(true);
});
it("staff cannot read or remove another person availability or approve leave", async () => {
  const s = await snapshot(manager.v);
  expect((await snapshot(b.v)).availability).toHaveLength(0);
  expect((await post(b, { action: "availability", id: s.availability[0].id })).status).toBe(404);
  expect(
    (await post(a, { action: "leave-decision", id: s.leave[0].id, approve: true })).status,
  ).toBe(403);
});
it("copy last week preserves local clock times and rolls back conflicts", async () => {
  const next = (await change(manager.v, { action: "week", startsOn: "2099-06-08" }, fake)).id;
  await change(manager.v, { action: "copy", weekId: next, sourceId: week }, fake);
  const s = await snapshot(manager.v, String(next));
  expect(s.shifts[0].starts_local).toBe("2099-06-08 09:00");
  await expect(
    change(manager.v, { action: "copy", weekId: next, sourceId: week }, fake),
  ).rejects.toMatchObject({ status: 409 });
});
it("manager publishes a week and platform email receives notices", async () => {
  mail.length = 0;
  await change(manager.v, { action: "publish", weekId: week }, fake);
  expect((await snapshot(a.v)).weeks.map((x) => x.id)).toEqual([week]);
  expect(
    mail.some((m) => m.subject === "Your rota week has been published" && m.to === a.v.user.email),
  ).toBe(true);
  expect((await post(manager, shift({ id: shiftId }))).status).toBe(409);
});
it("concurrent claims yield exactly one winner", async () => {
  const r = await Promise.all([
    post(a, { action: "claim", id: open }),
    post(b, { action: "claim", id: open }),
  ]);
  expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
  const row = (await database().query("SELECT assignee_id FROM shifts WHERE id=$1", [open]))
    .rows[0];
  expect([a.staffId, b.staffId]).toContain(row.assignee_id);
});
it("staff cannot offer another person shift", async () => {
  expect((await post(b, { action: "offer", id: shiftId })).status).toBe(403);
});
it("swap changes assignee only after manager approval", async () => {
  await change(a.v, { action: "offer", id: shiftId }, fake);
  const x = (await snapshot(a.v, week)).swaps.find((x) => x.shift_id === shiftId);
  await change(b.v, { action: "take", id: x.id }, fake);
  expect(
    (await database().query("SELECT assignee_id FROM shifts WHERE id=$1", [shiftId])).rows[0]
      .assignee_id,
  ).toBe(a.staffId);
  expect((await post(b, { action: "swap-decision", id: x.id, approve: true })).status).toBe(403);
  await change(manager.v, { action: "swap-decision", id: x.id, approve: true }, fake);
  expect(
    (await database().query("SELECT assignee_id FROM shifts WHERE id=$1", [shiftId])).rows[0]
      .assignee_id,
  ).toBe(b.staffId);
  expect((await post(manager, { action: "swap-decision", id: x.id, approve: true })).status).toBe(
    409,
  );
});
it("approval refuses a swap that would double-book the taker", async () => {
  const w = (await change(manager.v, { action: "week", startsOn: "2099-06-15" }, fake)).id;
  const one = (
    await change(
      manager.v,
      shift({ weekId: w, start: "2099-06-15T09:00", end: "2099-06-15T17:00" }),
      fake,
    )
  ).id;
  await change(
    manager.v,
    shift({ weekId: w, assigneeId: b.staffId, start: "2099-06-15T10:00", end: "2099-06-15T12:00" }),
    fake,
  );
  await change(manager.v, { action: "publish", weekId: w }, fake);
  await change(a.v, { action: "offer", id: one }, fake);
  const x = (await snapshot(a.v, String(w))).swaps.find((x) => x.shift_id === one);
  await change(b.v, { action: "take", id: x.id }, fake);
  expect((await post(manager, { action: "swap-decision", id: x.id, approve: true })).status).toBe(
    409,
  );
  expect(
    (await database().query("SELECT state FROM swaps WHERE id=$1", [x.id])).rows[0].state,
  ).toBe("taken");
});
it("settings in use cannot be deleted; unused values can be renamed and deleted", async () => {
  expect(
    (await post(owner, { action: "setting", table: "positions", id: position, remove: true }))
      .status,
  ).toBe(409);
  await change(owner.v, { action: "setting", table: "positions", name: "Unused" }, fake);
  const row = ((await snapshot(owner.v)).positions as { id: string; name: string }[]).find(
    (x) => x.name === "Unused",
  );
  await change(
    owner.v,
    { action: "setting", table: "positions", id: row?.id, name: "Renamed" },
    fake,
  );
  expect(
    (await post(owner, { action: "setting", table: "positions", id: row?.id, remove: true }))
      .status,
  ).toBe(200);
  expect(
    (await post(manager, { action: "setting", table: "positions", name: "Denied" })).status,
  ).toBe(403);
});
it("CSV supports quotes and rejects malformed input", () => {
  expect(parseCsv('Name,Email\n"A, B",a@example.test')).toEqual([
    ["Name", "Email"],
    ["A, B", "a@example.test"],
  ]);
  expect(() => parseCsv('"open')).toThrow();
});
it("staff import is atomic and export includes hours", async () => {
  const before = (await snapshot(manager.v)).staff.length;
  expect(
    (
      await post(manager, {
        action: "import",
        csv: "Name,Email\nGood,good@example.test\nBad,not-email",
      })
    ).status,
  ).toBe(400);
  expect((await snapshot(manager.v)).staff.length).toBe(before);
  expect(
    (await post(manager, { action: "import", csv: "Name,Email\n=Formula,formula@example.test" }))
      .status,
  ).toBe(200);
  const r = await exportCsv(req(manager, undefined, `/api/rota/export?week=${week}`));
  expect(r.status).toBe(200);
  const csv = await r.text();
  expect(csv).toContain("Weekly hours");
  expect(csv).toContain("'=Formula");
  expect((await post(a, { action: "import", csv: "Name,Email\nNo,no@example.test" })).status).toBe(
    403,
  );
});
it("only the owner can invite managers", async () => {
  expect(
    (
      await post(manager, {
        action: "invite",
        name: "No",
        email: "no@example.test",
        role: "manager",
      })
    ).status,
  ).toBe(403);
});
it("one-time invites grant server-selected role and cannot be replayed", async () => {
  const address = `join-${randomUUID()}@example.test`;
  const result = await invite(
    owner.v,
    { role: "staff", name: "Joiner", email: address },
    origin,
    noMail,
  );
  expect(result.delivery).toBe("not-sent");
  const token = result.link?.split("#")[1];
  await acceptInvite(token, "a-long-test-password", 12);
  await expect(acceptInvite(token, "a-long-test-password", 12)).rejects.toMatchObject({
    status: 410,
  });
  const row = (
    await database().query(
      "SELECT s.user_id,u.role FROM staff s JOIN app_users u ON u.id=s.user_id WHERE s.email=$1",
      [address],
    )
  ).rows[0];
  expect(row.role).toBe("staff");
  const response = await accountPost(
    req(undefined, { email: address, password: "a-long-test-password" }, "/api/account/signin"),
    { params: Promise.resolve({ action: "signin" }) },
  );
  expect(response.status).toBe(200);
});
it("reissuing invites invalidates the old token; expired links fail", async () => {
  const email = `expire-${randomUUID()}@example.test`;
  const first = await invite(owner.v, { role: "manager", name: "Manager", email }, origin, noMail);
  const second = await invite(owner.v, { role: "manager", name: "Manager", email }, origin, noMail);
  await expect(checkInvite(first.link?.split("#")[1])).rejects.toMatchObject({ status: 410 });
  await database().query(
    "UPDATE rota_invites SET expires_at=now()-interval '1 second' WHERE email=$1",
    [email],
  );
  await expect(checkInvite(second.link?.split("#")[1])).rejects.toMatchObject({ status: 410 });
});
it("approval notices go to the owner and managers, not to other staff", async () => {
  const from = mail.length;
  await change(a.v, { action: "leave", start: "2099-08-10", end: "2099-08-10" }, fake);
  const to = mail
    .slice(from)
    .filter((m) => m.subject === "A time-off request needs approval")
    .map((m) => m.to);
  expect(to.sort()).toEqual([manager.v.user.email, owner.v.user.email].sort());
});
it("email-off response is honest and does not undo the saved request", async () => {
  const r = await change(b.v, { action: "leave", start: "2099-08-01", end: "2099-08-02" }, noMail);
  expect(r.notice).toContain("Email is unavailable");
  expect((await snapshot(b.v)).leave.some((x) => x.start_date === "2099-08-01")).toBe(true);
});
it("refuses missing and repeated local times at clock changes", async () => {
  for (const [startsOn, start, end] of [
    ["2099-03-23", "2099-03-29T01:30", "2099-03-29T03:30"],
    ["2099-10-19", "2099-10-25T01:30", "2099-10-25T03:30"],
  ]) {
    const w = (await change(manager.v, { action: "week", startsOn }, fake)).id;
    expect((await post(manager, shift({ weekId: w, start, end, assigneeId: null }))).status).toBe(
      400,
    );
  }
});
it("copy across a clock change keeps local start times and elapsed hours", async () => {
  const db = database(),
    wid = owner.v.workspaceId;
  const source = (
    await db.query("SELECT id FROM rota_weeks WHERE workspace_id=$1 AND starts_on='2099-03-23'", [
      wid,
    ])
  ).rows[0].id;
  await change(
    manager.v,
    shift({ weekId: source, start: "2099-03-27T09:00", end: "2099-03-27T17:00", assigneeId: null }),
    fake,
  );
  const next = (await change(manager.v, { action: "week", startsOn: "2099-03-30" }, fake)).id;
  await change(manager.v, { action: "copy", weekId: next, sourceId: source }, fake);
  const s = await snapshot(manager.v, String(next));
  expect(s.shifts[0].starts_local).toBe("2099-04-03 09:00");
  expect(Number(s.shifts[0].hours)).toBe(8);
  const row = (await db.query("SELECT starts_at FROM shifts WHERE week_id=$1", [next])).rows[0];
  expect(row.starts_at.toISOString()).toBe("2099-04-03T08:00:00.000Z");
});
it("a claim cannot assign a staff member who already works that time", async () => {
  const w = (await change(manager.v, { action: "week", startsOn: "2099-09-07" }, fake)).id;
  await change(
    manager.v,
    shift({ weekId: w, start: "2099-09-07T09:00", end: "2099-09-07T17:00" }),
    fake,
  );
  const open = (
    await change(
      manager.v,
      shift({ weekId: w, start: "2099-09-07T10:00", end: "2099-09-07T14:00", assigneeId: null }),
      fake,
    )
  ).id;
  await change(manager.v, { action: "publish", weekId: w }, fake);
  expect((await post(a, { action: "claim", id: open, assigneeId: b.staffId })).status).toBe(409);
  expect(
    (await database().query("SELECT assignee_id FROM shifts WHERE id=$1", [open])).rows[0]
      .assignee_id,
  ).toBeNull();
});

it("published week emails include local shift details and hours", async () => {
  const notice = mail.find(
    (m) =>
      m.to === a.v.user.email &&
      m.subject === "Your rota week has been published" &&
      m.text.includes("2099-06-01"),
  );
  expect(notice?.text).toContain("2099-06-01 09:00");
  expect(notice?.text).toContain("Weekly hours: 9.00");
  expect(notice?.text).toContain("Europe/London");
});

it("a refused invitation leaves an existing person unchanged", async () => {
  const before = (await database().query("SELECT name FROM staff WHERE id=$1", [a.staffId])).rows[0]
    .name;
  expect(
    (
      await post(manager, {
        action: "invite",
        role: "staff",
        name: "Changed without success",
        email: a.v.user.email,
      })
    ).status,
  ).toBe(409);
  expect(
    (await database().query("SELECT name FROM staff WHERE id=$1", [a.staffId])).rows[0].name,
  ).toBe(before);
});
