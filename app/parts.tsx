"use client";
// Small pieces every project screen shares: sending a change, the signed-out notice and money.
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "../lib/pramaan/client";

/** A same-origin JSON POST, answering the route's reply or throwing its message. */
export function send<T = unknown>(url: string, body: unknown) {
  return api<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What to show while a list loads, or when it can't be read (signed out, or not this person's to see). */
export function Loading({
  error,
  loading,
  children,
}: {
  error?: Error;
  loading: boolean;
  children: ReactNode;
}) {
  if (error)
    return (
      <section>
        <p role="alert">{error.message}</p>
        <p>
          <Link href="/">Go to sign in</Link>
        </p>
      </section>
    );
  if (loading) return <p>Loading…</p>;
  return <>{children}</>;
}

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );

export const day = (iso: string) => new Date(iso).toLocaleDateString("en", { dateStyle: "medium" });

/** What happened to an invite, in plain words, with the link to pass on when it wasn't emailed. */
export function InviteNotice({
  invite,
}: {
  invite: { email: string; delivery: string; link?: string };
}) {
  if (invite.delivery === "sent") return <p role="status">Invite sent to {invite.email}.</p>;
  return (
    <div role="status">
      <p>
        Invite ready for {invite.email}.{" "}
        {invite.delivery === "unknown"
          ? "The invite email may not have gone."
          : "Email isn't switched on for this app yet, so no invite email was sent."}{" "}
        Send them this one-time link yourself. It works once, for 7 days.
      </p>
      {invite.link && (
        <p>
          <a href={invite.link}>Open the invite link</a>
        </p>
      )}
    </div>
  );
}
