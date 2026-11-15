import { AccountError } from "../../../lib/accounts";
import { handle, readBody, reply } from "../../../lib/roles/http";
import { acceptInvite, checkInvite } from "../../../lib/rota/invites";
export const dynamic = "force-dynamic";

/** `check` reads what an invite is for; `accept` makes its account with the chosen password. No sign-in needed. */
export async function POST(request: Request) {
  return handle(async () => {
    const input = await readBody(request);
    if (input.action === "check") return reply(await checkInvite(input.token));
    if (input.action === "accept") {
      const min = Number(process.env.APP_PASSWORD_MIN_LENGTH ?? 12);
      return reply(await acceptInvite(input.token, input.password, min), 201);
    }
    throw new AccountError(400, "Choose what to do with the invite.");
  });
}
