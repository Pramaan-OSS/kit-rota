import { handle } from "../../../../lib/roles/http";
import { viewer } from "../../../../lib/rota/access";
import { exportWeek } from "../../../../lib/rota/data";
import { id } from "../../../../lib/rota/words";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  return handle(
    async () =>
      new Response(await exportWeek(await viewer(r), id(new URL(r.url).searchParams.get("week"))), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="rota-week.csv"',
          "cache-control": "no-store",
        },
      }),
  );
}
