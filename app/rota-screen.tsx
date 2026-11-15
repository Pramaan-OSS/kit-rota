"use client";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";

type Row = { id: string; name: string; [key: string]: string };
type Shift = Row & {
  starts_local: string;
  ends_local: string;
  assignee: string;
  location: string;
  position: string;
  type: string;
  timezone: string;
  assignee_id: string;
};
type Data = {
  role: string;
  ownStaff: string;
  chosen?: Row;
  weeks: Row[];
  staff: Row[];
  shifts: Shift[];
  locations: Row[];
  positions: Row[];
  shift_types: Row[];
  availability: Row[];
  leave: Row[];
  swaps: Row[];
  hours: { id: string; name: string; hours: number }[];
  warnings: { shiftId: string; message: string }[];
};
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function Input({
  label,
  name,
  type = "text",
  value,
}: {
  label: string;
  name: string;
  type?: string;
  value?: string;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value} required />
    </label>
  );
}
function Options({
  label,
  name,
  rows,
  empty,
  value,
}: {
  label: string;
  name: string;
  rows: Row[];
  empty?: string;
  value?: string;
}) {
  return (
    <label>
      {label}
      <select aria-label={label} name={name} required={!empty} defaultValue={value}>
        {empty && <option value="">{empty}</option>}
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name || r.starts_on}
          </option>
        ))}
      </select>
    </label>
  );
}
export default function RotaScreen({ view = "rota" }: { view?: string }) {
  const [data, setData] = useState<Data>(),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(""),
    [mine, setMine] = useState(false),
    [editing, setEditing] = useState<Shift>();
  async function load(week = selected) {
    setData(await api<Data>(`/api/rota${week ? `?week=${week}` : ""}`));
  }
  useEffect(() => {
    api<Data>(`/api/rota${selected ? `?week=${selected}` : ""}`).then(setData, (e) =>
      setMessage(e.message),
    );
  }, [selected]);
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ notice?: string; link?: string; id?: string; delivery?: string }>(
        "/api/rota",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setMessage(
        r.notice ??
          (r.delivery === "sent"
            ? "Invitation emailed."
            : r.link
              ? "Email is unavailable. Pass on this one-time invite link."
              : "Saved."),
      );
      setLink(r.link ?? "");
      if (body.action === "week" && r.id) setSelected(r.id);
      else await load();
      setEditing(undefined);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function form(
    action: string,
    children: ReactNode,
    extra: Record<string, unknown> = {},
    label = "Save",
  ) {
    return (
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void send({ action, ...Object.fromEntries(new FormData(e.currentTarget)), ...extra });
        }}
      >
        {children}
        <button type="submit" disabled={busy}>
          {label}
        </button>
      </form>
    );
  }
  function act(label: string, body: Record<string, unknown>) {
    return (
      <button type="button" disabled={busy} onClick={() => void send(body)}>
        {label}
      </button>
    );
  }
  if (!data)
    return (
      <main className="workspace">
        <h1>Staff rota</h1>
        <p role="status">{message || "Loading your rota…"}</p>
        <a href="/">Sign in</a>
      </main>
    );
  const manage = data.role !== "staff",
    own = data.role === "owner",
    week = data.chosen,
    draft = week?.state === "draft";
  return (
    <main className="workspace">
      <p className="eyebrow">Staff rota · {data.role}</p>
      <h1>
        {view === "team"
          ? "Your team"
          : view === "settings"
            ? "Rota settings"
            : view === "availability"
              ? "Availability and time off"
              : "Plan a good week"}
      </h1>
      <p role="status" className="notice">
        {message}
      </p>
      {link && (
        <p>
          <a href={link}>Open one-time invitation</a>
          <br />
          <input aria-label="One-time invitation link" value={link} readOnly />
        </p>
      )}
      {view === "rota" && (
        <>
          <section>
            <div className="filters">
              <label>
                Week
                <select
                  aria-label="Week"
                  value={week?.id ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a week
                  </option>
                  {data.weeks.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.starts_on} · {w.state}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
                My shifts only
              </label>
              {week && <a href={`/api/rota/export?week=${week.id}`}>Export shifts and hours</a>}
            </div>
            {!week && <p>No {manage ? "rota" : "published"} weeks yet.</p>}
            {manage &&
              form(
                "week",
                <Input label="Week beginning (Monday)" name="startsOn" type="date" />,
                {},
                "Create draft week",
              )}
            {manage && draft && (
              <>
                <h2>Draft week</h2>
                {form(
                  "copy",
                  <Options
                    label="Copy from week"
                    name="sourceId"
                    rows={data.weeks.filter((w) => w.id !== week.id)}
                  />,
                  { weekId: week.id },
                  "Copy week",
                )}
                {act("Publish week", { action: "publish", weekId: week.id })}
                <p>Publishing locks this week and sends email notices when email is enabled.</p>
              </>
            )}
          </section>
          {manage && draft && (
            <section>
              <h2>{editing ? "Edit shift" : "Add a shift"}</h2>
              {form(
                "shift",
                <div className="filters" key={editing?.id ?? "new"}>
                  <Options
                    label="Location"
                    name="locationId"
                    rows={data.locations}
                    value={editing?.location_id}
                  />
                  <Options
                    label="Position"
                    name="positionId"
                    rows={data.positions}
                    value={editing?.position_id}
                  />
                  <Options
                    label="Shift type"
                    name="typeId"
                    rows={data.shift_types}
                    value={editing?.type_id}
                  />
                  <Options
                    label="Assign to"
                    name="assigneeId"
                    rows={data.staff}
                    value={editing?.assignee_id ?? ""}
                    empty="Open shift"
                  />
                  <Input
                    label="Start (location time)"
                    name="start"
                    type="datetime-local"
                    value={editing?.starts_local?.replace(" ", "T")}
                  />
                  <Input
                    label="End (location time)"
                    name="end"
                    type="datetime-local"
                    value={editing?.ends_local?.replace(" ", "T")}
                  />
                </div>,
                { weekId: week.id, ...(editing ? { id: editing.id } : {}) },
                editing ? "Save shift" : "Add shift",
              )}
              {editing && (
                <button type="button" onClick={() => setEditing(undefined)}>
                  Cancel edit
                </button>
              )}
              <p>
                Dates and times use the selected location’s time zone. Overlapping assignments are
                refused.
              </p>
            </section>
          )}
          {!!data.warnings.length && (
            <section aria-label="Warnings">
              <h2>Check before publishing</h2>
              {data.warnings.map((w) => (
                <p key={w.shiftId}>{w.message}</p>
              ))}
            </section>
          )}
          <section>
            <h2>{week?.state === "published" ? "Published rota" : "Weekly shifts"}</h2>
            <div className="shift-grid">
              {data.shifts
                .filter((s) => !mine || s.assignee_id === data.ownStaff)
                .map((s) => (
                  <article className="shift-card" key={s.id}>
                    <p className="eyebrow">
                      {s.position} · {s.type}
                    </p>
                    <h3>
                      {s.starts_local} – {s.ends_local}
                    </h3>
                    <p>
                      {s.location} · {s.timezone}
                    </p>
                    <p>{s.assignee || "Open shift"}</p>
                    <div className="links">
                      {manage && draft && (
                        <>
                          <button type="button" onClick={() => setEditing(s)}>
                            Edit shift
                          </button>
                          {act("Remove shift", { action: "delete-shift", id: s.id })}
                        </>
                      )}
                      {week?.state === "published" &&
                        data.ownStaff &&
                        !s.assignee_id &&
                        act("Claim shift", { action: "claim", id: s.id })}
                      {week?.state === "published" &&
                        data.ownStaff === s.assignee_id &&
                        act("Offer swap", { action: "offer", id: s.id })}
                    </div>
                  </article>
                ))}
            </div>
            {!data.shifts.length && <p>No shifts in this week.</p>}
          </section>
          <section>
            <h2>Hours per person this week</h2>
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Hours</th>
                </tr>
              </thead>
              <tbody>
                {data.hours.map((h) => (
                  <tr key={h.id}>
                    <td>{h.name}</td>
                    <td>{h.hours.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h2>Shift swaps</h2>
            {data.swaps.map((s) => (
              <article className="shift-card" key={s.id}>
                <p>
                  {s.offered_by} → {s.taken_by || "Awaiting a colleague"} · {s.state}
                </p>
                <p>
                  {data.shifts.find((x) => x.id === s.shift_id)?.starts_local ??
                    "Another rota week"}
                </p>
                {s.state === "offered" &&
                  data.ownStaff &&
                  s.from_staff !== data.ownStaff &&
                  act("Take swap", { action: "take", id: s.id })}
                {manage && s.state === "taken" && (
                  <>
                    {act("Approve swap", { action: "swap-decision", id: s.id, approve: true })}
                    {act("Decline swap", { action: "swap-decision", id: s.id, approve: false })}
                  </>
                )}
              </article>
            ))}
          </section>
        </>
      )}
      {view === "availability" && (
        <>
          <section>
            <h2>My availability</h2>
            <p>
              Weekly availability uses the time zone of each shift’s location. With no weekly
              entries, no recurring limit is assumed.
            </p>
            {data.ownStaff ? (
              <>
                {form(
                  "availability",
                  <>
                    <label>
                      Weekday
                      <select aria-label="Weekday" name="weekday">
                        {days.map((d, i) => (
                          <option key={d} value={i + 1}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Input label="Available from" name="start" type="time" />
                    <Input label="Available until" name="end" type="time" />
                  </>,
                  {},
                  "Add weekly availability",
                )}
                {form(
                  "availability",
                  <Input label="Unavailable date" name="unavailableOn" type="date" />,
                  {},
                  "Add unavailable date",
                )}
              </>
            ) : (
              <p>Invite a staff account to set personal availability.</p>
            )}
            {data.availability.map((a) => (
              <article key={a.id}>
                <p>
                  {a.name}:{" "}
                  {a.unavailable_on
                    ? `Unavailable ${String(a.unavailable_on).slice(0, 10)}`
                    : `${days[Number(a.weekday) - 1]} ${a.starts_at}–${a.ends_at}`}
                </p>
                {a.staff_id === data.ownStaff &&
                  act("Remove availability", { action: "availability", id: a.id })}
              </article>
            ))}
          </section>
          <section>
            <h2>Time-off requests</h2>
            {data.ownStaff &&
              form(
                "leave",
                <>
                  <Input label="First day" name="start" type="date" />
                  <Input label="Last day" name="end" type="date" />
                  <label>
                    Reason
                    <input name="reason" maxLength={1000} />
                  </label>
                </>,
                {},
                "Request time off",
              )}
            {data.leave.map((l) => (
              <article className="shift-card" key={l.id}>
                <h3>
                  {l.name}: {l.start_date} – {l.end_date}
                </h3>
                <p>
                  {l.reason} · {l.state}
                </p>
                {manage && l.state === "pending" && (
                  <>
                    {act("Approve time off", { action: "leave-decision", id: l.id, approve: true })}
                    {act("Decline time off", {
                      action: "leave-decision",
                      id: l.id,
                      approve: false,
                    })}
                  </>
                )}
              </article>
            ))}
          </section>
        </>
      )}
      {view === "team" &&
        (manage ? (
          <>
            <section>
              <h2>Invite a person</h2>
              {form(
                "invite",
                <>
                  <Input label="Name" name="name" />
                  <Input label="Email" name="email" type="email" />
                  <label>
                    Role
                    <select aria-label="Role" name="role">
                      <option value="staff">Staff</option>
                      {own && <option value="manager">Manager</option>}
                    </select>
                  </label>
                </>,
                {},
                "Invite person",
              )}
              <p>Email is off by default. If it cannot send, you get a one-time link to pass on.</p>
            </section>
            <section>
              <h2>Import staff</h2>
              <p>CSV columns: Name,Email. Imported people need an invitation to sign in.</p>
              <input
                aria-label="Staff CSV"
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (file.size > 12000) {
                      setMessage("Import at most 12 KB.");
                      return;
                    }
                    void send({ action: "import", csv: await file.text() });
                  }
                }}
              />
            </section>
            <section>
              <h2>Staff</h2>
              {data.staff.map((s) => (
                <p key={s.id}>
                  {s.name} ·{" "}
                  {s.user_id ? "Has sign-in access" : "Not invited or invitation pending"}
                </p>
              ))}
            </section>
          </>
        ) : (
          <p>Only managers can invite people.</p>
        ))}
      {view === "settings" &&
        (own ? (
          <section>
            <h2>Locations, positions and shift types</h2>
            {(["locations", "positions", "shift_types"] as const).map((table) => (
              <div key={table}>
                <h3>{table.replace("_", " ")}</h3>
                {form(
                  "setting",
                  <>
                    <Input
                      label={`New ${table === "positions" ? "position" : table === "shift_types" ? "shift type" : "location"} name`}
                      name="name"
                    />
                    {table === "locations" && (
                      <Input label="Time zone" name="timezone" value="Europe/London" />
                    )}
                  </>,
                  { table },
                  `Add ${table === "positions" ? "position" : table === "shift_types" ? "shift type" : "location"}`,
                )}
                {data[table].map((r) => (
                  <div className="setting-row" key={r.id}>
                    {form(
                      "setting",
                      <>
                        <Input label="Name" name="name" value={r.name} />
                        {table === "locations" && (
                          <Input label="Time zone" name="timezone" value={r.timezone} />
                        )}
                      </>,
                      { table, id: r.id },
                      "Rename",
                    )}
                    {act(`Remove ${r.name}`, { action: "setting", table, id: r.id, remove: true })}
                  </div>
                ))}
              </div>
            ))}
            <p>Values used by shifts cannot be removed.</p>
          </section>
        ) : (
          <p>Only the owner can edit settings.</p>
        ))}
    </main>
  );
}
