import { handle, readBody, reply } from "../../../lib/roles/http";
import { viewer } from "../../../lib/rota/access";
import { importStaff } from "../../../lib/rota/csv";
import { change, invite, snapshot } from "../../../lib/rota/data";
import { appOrigin } from "../../../lib/rota/origin";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  return handle(async () =>
    reply(await snapshot(await viewer(r), new URL(r.url).searchParams.get("week") ?? undefined)),
  );
}
export async function POST(r: Request) {
  return handle(async () => {
    const v = await viewer(r),
      b = await readBody(r);
    return reply(
      b.action === "invite"
        ? await invite(v, b, appOrigin(r))
        : b.action === "import"
          ? await importStaff(v, b.csv)
          : await change(v, b),
    );
  });
}
