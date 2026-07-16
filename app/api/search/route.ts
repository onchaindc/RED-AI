import { runResearch } from "@/lib/research";
import type { EntityCandidate, SearchEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function encode(event: SearchEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  let body: { query?: unknown; entity?: unknown };
  try {
    body = (await request.json()) as { query?: unknown; entity?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const candidate =
    body.entity && typeof body.entity === "object"
      ? (body.entity as Partial<EntityCandidate>)
      : undefined;
  const entity =
    candidate &&
    typeof candidate.name === "string" &&
    typeof candidate.website === "string" &&
    typeof candidate.domain === "string"
      ? {
          id: candidate.id || candidate.domain,
          name: candidate.name.slice(0, 120),
          description:
            typeof candidate.description === "string"
              ? candidate.description.slice(0, 240)
              : "",
          website: candidate.website,
          domain: candidate.domain,
        }
      : undefined;
  if (query.length < 2) {
    return Response.json(
      { error: "Enter at least two characters to run a search." },
      { status: 400 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const outcome = await runResearch(query, (stage) => {
          controller.enqueue(encode({ type: "stage", stage }));
        }, entity);
        if (outcome.type === "ambiguity") {
          controller.enqueue(
            encode({
              type: "ambiguity",
              query: outcome.query,
              candidates: outcome.candidates,
            }),
          );
        } else {
          controller.enqueue(encode({ type: "result", result: outcome.result }));
        }
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
