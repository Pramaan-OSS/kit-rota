import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AccountError } from "../accounts";
import { emailDoor, type Mailer } from "../email";
import { database } from "../runtime";
import { manager, owner, self, type Viewer } from "./access";
import { createInvite, unclaimed } from "./invites";
import { csvCell, id, text } from "./words";

const fail = (message: string): never => {
  throw new AccountError(409, message);
};
export function date(value: unknown) {
  const s = String(value ?? "");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(s) ||
    Number.isNaN(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    throw new AccountError(400, "Choose a valid date.");
  return s;
}
function monday(value: unknown) {
  const s = date(value);
  if (new Date(s).getUTCDay() !== 1) throw new AccountError(400, "Choose a Monday for the week.");
  return s;
}
function local(value: unknown) {
  const s = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(s))
    throw new AccountError(400, "Choose a date and time.");
  date(s.slice(0, 10));
  if (s.slice(11, 13) > "23" || s.slice(14) > "59")
    throw new AccountError(400, "Choose a valid time.");
  return s;
}
export async function transaction<T>(v: Viewer, work: (c: PoolClient) => Promise<T>) {
  const c = await database().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [v.workspaceId]);
    const r = await work(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    if (
      ["23P01", "23505", "23503", "23514", "22008", "22007", "22023"].includes(
        (e as { code: string }).code,
      )
    )
      throw new AccountError(
        409,
        "This conflicts with a shift or a value in use. Check the dates and team records.",
      );
    throw e;
  } finally {
    c.release();
  }
}
async function week(c: PoolClient, v: Viewer, w: unknown, draft = false) {
  const row = (
    await c.query(
      "SELECT *,starts_on::text AS starts_on FROM rota_weeks WHERE id=$1 AND workspace_id=$2",
      [id(w), v.workspaceId],
    )
  ).rows[0];
  if (!row || (v.role === "staff" && row.state !== "published"))
    throw new AccountError(404, "That week could not be found.");
  if (draft && row.state !== "draft") fail("Published weeks are locked. Use a swap for changes.");
  return row;
}
async function shift(c: PoolClient, v: Viewer, s: unknown) {
  const row = (
    await c.query("SELECT * FROM shifts WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [
      id(s),
      v.workspaceId,
    ])
  ).rows[0];
  if (!row) throw new AccountError(404, "That shift could not be found.");
  await week(c, v, row.week_id);
  return row;
}
export async function snapshot(v: Viewer, selected?: string) {
  const db = database(),
    w = v.workspaceId;
  const weeks = (
    await db.query(
      "SELECT id,starts_on::text,state FROM rota_weeks WHERE workspace_id=$1 AND ($2 OR state='published') ORDER BY starts_on DESC",
      [w, v.role !== "staff"],
    )
  ).rows;
  const chosen = selected ? weeks.find((x) => x.id === selected) : weeks[0];
  if (selected && !chosen) throw new AccountError(404, "That week could not be found.");
  const staff = (
    await db.query("SELECT id,name,user_id FROM staff WHERE workspace_id=$1 ORDER BY name", [w])
  ).rows;
  const own = staff.find((s) => s.user_id === v.user.id)?.id;
  const shifts = chosen
    ? (
        await db.query(
          `SELECT s.*,l.name location,l.timezone,p.name position,t.name type,a.name assignee,
 to_char(s.starts_at AT TIME ZONE l.timezone,'YYYY-MM-DD HH24:MI') starts_local,to_char(s.ends_at AT TIME ZONE l.timezone,'YYYY-MM-DD HH24:MI') ends_local,
 extract(epoch FROM(s.ends_at-s.starts_at))/3600 hours
 FROM shifts s JOIN locations l ON l.id=s.location_id JOIN positions p ON p.id=s.position_id JOIN shift_types t ON t.id=s.type_id LEFT JOIN staff a ON a.id=s.assignee_id WHERE s.workspace_id=$1 AND week_id=$2 ORDER BY s.starts_at,s.id`,
          [w, chosen.id],
        )
      ).rows
    : [];
  const availability = (
    await db.query(
      "SELECT a.*,a.unavailable_on::text AS unavailable_on,s.name FROM availability a JOIN staff s ON s.id=a.staff_id WHERE a.workspace_id=$1 AND ($2 OR staff_id=$3) ORDER BY a.weekday,a.unavailable_on",
      [w, v.role !== "staff", own ?? null],
    )
  ).rows;
  const leave = (
    await db.query(
      "SELECT t.*,t.starts_on::text start_date,t.ends_on::text end_date,s.name FROM time_off t JOIN staff s ON s.id=t.staff_id WHERE t.workspace_id=$1 AND ($2 OR staff_id=$3) ORDER BY starts_on",
      [w, v.role !== "staff", own ?? null],
    )
  ).rows;
  const swaps = (
    await db.query(
      `SELECT x.*,a.name offered_by,b.name taken_by FROM swaps x JOIN shifts s ON s.id=x.shift_id JOIN rota_weeks w ON w.id=s.week_id JOIN staff a ON a.id=x.from_staff LEFT JOIN staff b ON b.id=x.to_staff WHERE x.workspace_id=$1 AND ($2 OR w.state='published') AND s.week_id=$3 ORDER BY x.id`,
      [w, v.role !== "staff", chosen?.id ?? null],
    )
  ).rows;
  const tables: Record<string, unknown[]> = {};
  for (const t of ["locations", "positions", "shift_types"])
    tables[t] = (
      await db.query(`SELECT * FROM ${t} WHERE workspace_id=$1 ORDER BY name`, [w])
    ).rows;
  const hours = staff.map((s) => ({
    id: s.id,
    name: s.name,
    hours: shifts.filter((x) => x.assignee_id === s.id).reduce((n, x) => n + Number(x.hours), 0),
  }));
  const warnings: vWarning[] = [];
  if (v.role !== "staff")
    for (const s of shifts) {
      if (!s.assignee_id) continue;
      const r = await db.query(
        `SELECT
 EXISTS(SELECT 1 FROM time_off WHERE staff_id=$1 AND state='approved' AND starts_on<=($2::timestamptz AT TIME ZONE $4)::date AND ends_on>=($3::timestamptz AT TIME ZONE $4)::date) AS leave,
 EXISTS(SELECT 1 FROM availability WHERE staff_id=$1 AND unavailable_on BETWEEN ($3::timestamptz AT TIME ZONE $4)::date AND ($2::timestamptz AT TIME ZONE $4)::date) AS unavailable,
 EXISTS(SELECT 1 FROM availability WHERE staff_id=$1 AND weekday IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM availability WHERE staff_id=$1 AND weekday=extract(isodow FROM $3::timestamptz AT TIME ZONE $4) AND starts_at<=($3::timestamptz AT TIME ZONE $4)::time AND ends_at>=($2::timestamptz AT TIME ZONE $4)::time AND ($3::timestamptz AT TIME ZONE $4)::date=($2::timestamptz AT TIME ZONE $4)::date) AS outside`,
        [s.assignee_id, s.ends_at, s.starts_at, s.timezone],
      );
      if (r.rows[0].leave || r.rows[0].unavailable || r.rows[0].outside)
        warnings.push({
          shiftId: s.id,
          message: `${s.assignee}: ${r.rows[0].leave ? "approved time off" : r.rows[0].unavailable ? "unavailable date" : "outside weekly availability"}`,
        });
    }
  return {
    role: v.role,
    ownStaff: own ?? null,
    weeks,
    chosen,
    staff,
    shifts,
    availability,
    leave,
    swaps,
    hours,
    warnings,
    locations: tables.locations ?? [],
    positions: tables.positions ?? [],
    shift_types: tables.shift_types ?? [],
  };
}
type vWarning = { shiftId: string; message: string };
export async function invite(
  v: Viewer,
  b: Record<string, unknown>,
  origin: string,
  mailer: Mailer = emailDoor,
) {
  if (b.role === "manager") owner(v);
  else manager(v);
  if (b.role !== "manager" && b.role !== "staff")
    throw new AccountError(400, "Choose manager or staff.");
  const address = await unclaimed(b.email),
    name = text(b.name, "a name", 120);
  await transaction(v, async (c) => {
    await c.query(
      "INSERT INTO staff(workspace_id,email,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,email) DO UPDATE SET name=excluded.name",
      [v.workspaceId, address, name],
    );
  });
  return createInvite(
    mailer,
    { email: address, role: b.role, workspaceId: v.workspaceId, invitedBy: v.user.id },
    origin,
    "Staff rota",
  );
}
export async function change(v: Viewer, b: Record<string, unknown>, mailer: Mailer = emailDoor) {
  const action = b.action;
  const notifications: { to: string; subject: string; text: string }[] = [];
  const result = await transaction(v, async (c) => {
    const wid = v.workspaceId;
    // A staff id mails that person; "managers" mails the owner and managers, who review; none mails all staff.
    const notify = async (subject: string, staffId?: string) => {
      const people =
        staffId === "managers"
          ? await c.query(
              "SELECT u.email FROM workspace_members m JOIN app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.role IN ('owner','manager')",
              [wid],
            )
          : await c.query(
              `SELECT email FROM staff WHERE workspace_id=$1 ${staffId ? "AND id=$2" : ""}`,
              [wid, ...(staffId ? [staffId] : [])],
            );
      for (const p of people.rows)
        notifications.push({
          to: p.email,
          subject,
          text: `${subject}. Sign in to Staff rota to see the details.`,
        });
    };
    if (action === "week") {
      manager(v);
      const r = await c.query(
        "INSERT INTO rota_weeks(workspace_id,starts_on) VALUES($1,$2) RETURNING id",
        [wid, monday(b.startsOn)],
      );
      return { id: r.rows[0].id };
    }
    if (action === "copy") {
      manager(v);
      const target = await week(c, v, b.weekId, true),
        source = await week(c, v, b.sourceId);
      if (target.id === source.id) fail("Choose a different source week.");
      if ((await c.query("SELECT 1 FROM shifts WHERE week_id=$1", [target.id])).rowCount)
        fail("Copy into an empty draft week.");
      await c.query(
        `INSERT INTO shifts(workspace_id,week_id,location_id,position_id,type_id,assignee_id,starts_at,ends_at)
 SELECT s.workspace_id,$1,s.location_id,s.position_id,s.type_id,s.assignee_id,
 ((s.starts_at AT TIME ZONE l.timezone)+($3::date-$4::date)*interval '1 day') AT TIME ZONE l.timezone,
 ((s.ends_at AT TIME ZONE l.timezone)+($3::date-$4::date)*interval '1 day') AT TIME ZONE l.timezone
 FROM shifts s JOIN locations l ON l.id=s.location_id WHERE s.week_id=$2`,
        [target.id, source.id, target.starts_on, source.starts_on],
      );
      return {};
    }
    if (action === "publish") {
      manager(v);
      const w = await week(c, v, b.weekId, true);
      await c.query("UPDATE rota_weeks SET state='published' WHERE id=$1", [w.id]);
      const people = (await c.query("SELECT id,email FROM staff WHERE workspace_id=$1", [wid]))
        .rows;
      for (const person of people) {
        const shifts = (
          await c.query(
            `SELECT l.name location,l.timezone,p.name position,
        to_char(s.starts_at AT TIME ZONE l.timezone,'YYYY-MM-DD HH24:MI') start,
        to_char(s.ends_at AT TIME ZONE l.timezone,'YYYY-MM-DD HH24:MI') finish,
        extract(epoch FROM(s.ends_at-s.starts_at))/3600 hours
        FROM shifts s JOIN locations l ON l.id=s.location_id JOIN positions p ON p.id=s.position_id
        WHERE s.week_id=$1 AND s.assignee_id=$2 ORDER BY s.starts_at`,
            [w.id, person.id],
          )
        ).rows;
        notifications.push({
          to: person.email,
          subject: "Your rota week has been published",
          text: `Week beginning ${w.starts_on}\n\n${shifts.length ? shifts.map((s) => `${s.start} – ${s.finish} (${s.timezone}): ${s.position} at ${s.location}`).join("\n") : "No assigned shifts."}\n\nWeekly hours: ${shifts.reduce((total, s) => total + Number(s.hours), 0).toFixed(2)}\nSign in to Staff rota to see the whole week and open shifts.`,
        });
      }
      return {};
    }
    if (action === "shift") {
      manager(v);
      const w = await week(c, v, b.weekId, true);
      const l = (
        await c.query("SELECT * FROM locations WHERE id=$1 AND workspace_id=$2", [
          id(b.locationId),
          wid,
        ])
      ).rows[0];
      if (!l) throw new AccountError(404, "Location not found.");
      const start = local(b.start),
        end = local(b.end);
      if (
        start.slice(0, 10) < new Date(w.starts_on).toISOString().slice(0, 10) ||
        new Date(start.slice(0, 10)).getTime() >= new Date(w.starts_on).getTime() + 7 * 86400000
      )
        throw new AccountError(400, "The shift must start in the selected week.");
      // Reject missing or ambiguous local clock times around a clock change. An explicit shift in an ordinary local time is required.
      for (const t of [start, end]) {
        const check = await c.query(
          `SELECT to_char($1::timestamp AT TIME ZONE $2 AT TIME ZONE $2,'YYYY-MM-DD"T"HH24:MI') local, EXISTS(SELECT 1 FROM generate_series(-120,120,30) m WHERE m<>0 AND to_char((($1::timestamp AT TIME ZONE $2)+m*interval '1 minute') AT TIME ZONE $2,'YYYY-MM-DD"T"HH24:MI')=$3::text) ambiguous`,
          [t, l.timezone, t],
        );
        if (check.rows[0].local !== t || check.rows[0].ambiguous)
          throw new AccountError(
            400,
            "That local time is missing or repeated during a clock change. Choose an unambiguous time.",
          );
      }
      const values = [
        wid,
        w.id,
        l.id,
        id(b.positionId),
        id(b.typeId),
        b.assigneeId ? id(b.assigneeId) : null,
        start,
        end,
        l.timezone,
      ];
      if (b.id) {
        await shift(c, v, b.id);
        const r = await c.query(
          "UPDATE shifts SET location_id=$3,position_id=$4,type_id=$5,assignee_id=$6,starts_at=$7::timestamp AT TIME ZONE $9,ends_at=$8::timestamp AT TIME ZONE $9 WHERE id=$10 AND workspace_id=$1 AND week_id=$2 RETURNING id",
          [...values, id(b.id)],
        );
        if (!r.rowCount) fail("Shift does not belong to this week.");
        return { id: b.id };
      }
      const r = await c.query(
        "INSERT INTO shifts(workspace_id,week_id,location_id,position_id,type_id,assignee_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamp AT TIME ZONE $9,$8::timestamp AT TIME ZONE $9) RETURNING id",
        values,
      );
      return { id: r.rows[0].id };
    }
    if (action === "delete-shift") {
      manager(v);
      const s = await shift(c, v, b.id);
      await week(c, v, s.week_id, true);
      await c.query("DELETE FROM shifts WHERE id=$1", [s.id]);
      return {};
    }
    if (action === "claim") {
      const me = await self(v),
        s = await shift(c, v, b.id);
      const w = await week(c, v, s.week_id);
      if (w.state !== "published" || s.assignee_id) fail("This shift is no longer open.");
      await c.query("UPDATE shifts SET assignee_id=$1 WHERE id=$2 AND assignee_id IS NULL", [
        me,
        s.id,
      ]);
      return {};
    }
    if (action === "offer") {
      const me = await self(v),
        s = await shift(c, v, b.id);
      const w = await week(c, v, s.week_id);
      if (s.assignee_id !== me || w.state !== "published")
        throw new AccountError(403, "Offer only your own published shift.");
      await c.query("INSERT INTO swaps(workspace_id,shift_id,from_staff) VALUES($1,$2,$3)", [
        wid,
        s.id,
        me,
      ]);
      await notify("A shift is available to swap");
      return {};
    }
    if (action === "take" || action === "swap-decision") {
      const x = (
        await c.query("SELECT * FROM swaps WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [
          id(b.id),
          wid,
        ])
      ).rows[0];
      if (!x) throw new AccountError(404, "Swap not found.");
      const s = await shift(c, v, x.shift_id);
      const w = await week(c, v, s.week_id);
      if (w.state !== "published" || s.assignee_id !== x.from_staff)
        fail("This swap is no longer available.");
      if (action === "take") {
        const me = await self(v);
        if (x.state !== "offered" || x.from_staff === me) fail("This swap cannot be taken.");
        await c.query("UPDATE swaps SET to_staff=$1,state='taken' WHERE id=$2", [me, x.id]);
        await notify("A swap needs approval", "managers");
      } else {
        manager(v);
        if (x.state !== "taken") fail("Only a taken swap can be reviewed.");
        if (b.approve === true) {
          await c.query("UPDATE shifts SET assignee_id=$1 WHERE id=$2", [x.to_staff, s.id]);
        }
        await c.query("UPDATE swaps SET state=$1 WHERE id=$2", [
          b.approve === true ? "approved" : "declined",
          x.id,
        ]);
        await notify("Your swap request has been reviewed", x.from_staff);
        await notify("Your swap request has been reviewed", x.to_staff);
      }
      return {};
    }
    if (action === "availability") {
      const me = await self(v);
      if (b.id) {
        const r = await c.query(
          "DELETE FROM availability WHERE id=$1 AND workspace_id=$2 AND staff_id=$3 RETURNING id",
          [id(b.id), wid, me],
        );
        if (!r.rowCount) throw new AccountError(404, "Availability not found.");
      } else if (b.unavailableOn) {
        await c.query(
          "INSERT INTO availability(workspace_id,staff_id,unavailable_on) VALUES($1,$2,$3)",
          [wid, me, date(b.unavailableOn)],
        );
      } else {
        const day = Number(b.weekday),
          start = String(b.start),
          end = String(b.end);
        if (
          !Number.isInteger(day) ||
          day < 1 ||
          day > 7 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/u.test(start) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/u.test(end) ||
          end <= start
        )
          throw new AccountError(400, "Choose a weekday and a valid time range.");
        await c.query(
          "INSERT INTO availability(workspace_id,staff_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)",
          [wid, me, day, start, end],
        );
      }
      return {};
    }
    if (action === "leave") {
      const me = await self(v);
      await c.query(
        "INSERT INTO time_off(workspace_id,staff_id,starts_on,ends_on,reason) VALUES($1,$2,$3,$4,$5)",
        [
          wid,
          me,
          date(b.start),
          date(b.end),
          typeof b.reason === "string" ? b.reason.slice(0, 1000) : "",
        ],
      );
      await notify("A time-off request needs approval", "managers");
      return {};
    }
    if (action === "leave-decision") {
      manager(v);
      const r = await c.query(
        "UPDATE time_off SET state=$1 WHERE id=$2 AND workspace_id=$3 AND state='pending' RETURNING staff_id",
        [b.approve === true ? "approved" : "declined", id(b.id), wid],
      );
      if (!r.rowCount) fail("This request has already been reviewed.");
      await notify("Your time-off request has been reviewed", r.rows[0].staff_id);
      return {};
    }
    if (action === "setting") {
      owner(v);
      const table = String(b.table);
      if (!["positions", "shift_types", "locations"].includes(table))
        throw new AccountError(400, "Choose positions, shift types or locations.");
      if (b.remove) {
        const r = await c.query(
          `DELETE FROM ${table} WHERE id=$1 AND workspace_id=$2 RETURNING id`,
          [id(b.id), wid],
        );
        if (!r.rowCount) throw new AccountError(404, "Setting not found.");
        return {};
      }
      const name = text(b.name, "a name", 80),
        zone = String(b.timezone ?? "Europe/London");
      if (table === "locations") {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
        } catch {
          throw new AccountError(400, "Choose a valid location time zone.");
        }
      }
      if (b.id) {
        const r = await c.query(
          `UPDATE ${table} SET name=$1 ${table === "locations" ? ",timezone=$4" : ""} WHERE id=$2 AND workspace_id=$3 RETURNING id`,
          table === "locations" ? [name, id(b.id), wid, zone] : [name, id(b.id), wid],
        );
        if (!r.rowCount) throw new AccountError(404, "Setting not found.");
      } else
        await c.query(
          `INSERT INTO ${table}(workspace_id,name${table === "locations" ? ",timezone" : ""}) VALUES($1,$2${table === "locations" ? ",$3" : ""})`,
          table === "locations" ? [wid, name, zone] : [wid, name],
        );
      return {};
    }
    throw new AccountError(400, "Choose an action.");
  });
  let sent = 0;
  for (const [i, n] of notifications.entries()) {
    if ((await mailer.send(n, `rota-${randomUUID()}-${i}`)).status === "sent") sent++;
  }
  return {
    ...result,
    notice: notifications.length
      ? sent === notifications.length
        ? "Saved. Email notices sent."
        : "Saved. Email is unavailable or delivery is uncertain; check the rota here."
      : "Saved.",
  };
}
export async function exportWeek(v: Viewer, w: string) {
  const s = await snapshot(v, w);
  const rows = [
    ["Location", "Position", "Shift type", "Start", "End", "Time zone", "Assignee", "Hours"],
    ...s.shifts.map((x) => [
      x.location,
      x.position,
      x.type,
      x.starts_local,
      x.ends_local,
      x.timezone,
      x.assignee ?? "Open",
      String(x.hours),
    ]),
    [],
    ["Person", "Weekly hours"],
    ...s.hours.map((x) => [x.name, String(x.hours)]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
