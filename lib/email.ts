export type Outgoing = { to: string; subject: string; text: string };
export type Sent = { status: "sent" | "not-sent" | "unknown" };
export type Mailer = { send(message: Outgoing, key: string): Promise<Sent> };
export { emailDoor } from "./modules";
