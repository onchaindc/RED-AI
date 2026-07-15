import { runResearch } from "@/lib/research";
import type { SearchEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function encode(event: SearchEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query.length < 2) {
    return Response.json(
      { error: "Enter at least two characters to run a search." },
      { status: 400 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await runResearch(query, (stage) => {
          controller.enqueue(encode({ type: "stage", stage }));
        });
        controller.enqueue(encode({ type: "result", result }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The research pipeline failed.";
        controller.enqueue(encode({ type: "fatal", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
