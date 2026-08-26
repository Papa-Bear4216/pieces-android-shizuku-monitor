// Surfaces PiecesOS's own workstream summaries ("what got done") instead of
// raw captured telemetry — confirmed live: GET /workstream_summaries lists
// real AI-generated rollups (e.g. "Standup Update (Aug 25)"), each backed by
// a SUMMARY-type annotation (TL;DR text) via GET /workstream_summary/{id}.
//
// Every summary also carries a HIERARCHICAL_PROFILE_SUMMARY annotation — a
// much broader persona/psychological profile (legal, medical, family
// details) that must never reach the phone. Only SUMMARY (falling back to
// DESCRIPTION) is ever read here.

const SUMMARIES_TIMEOUT_MS = 15000;
const MAX_SUMMARIES = 25;

export type WorkstreamSummary = {
  id: string;
  name: string;
  created: string;
  text: string;
};

type AnnotationRef = { id: string; type?: string };

async function fetchJson(piecesBaseUrl: string, path: string): Promise<any> {
  const res = await fetch(`${piecesBaseUrl.replace(/\/$/, "")}${path}`, {
    signal: AbortSignal.timeout(SUMMARIES_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchSummaryText(piecesBaseUrl: string, summaryId: string): Promise<string | null> {
  const detail = await fetchJson(piecesBaseUrl, `/workstream_summary/${summaryId}`);
  const annotationIds: string[] = Object.keys(detail?.annotations?.indices ?? {});
  if (annotationIds.length === 0) return null;

  const annotations = await Promise.all(
    annotationIds.map((id) =>
      fetchJson(piecesBaseUrl, `/annotation/${id}`)
        .then((a): AnnotationRef & { text?: string } => ({ id, type: a?.type, text: a?.text }))
        .catch(() => ({ id, type: undefined, text: undefined })),
    ),
  );

  // SUMMARY (the TL;DR rollup) preferred; DESCRIPTION (shorter paraphrase) as
  // fallback. HIERARCHICAL_PROFILE_SUMMARY and anything else is never used.
  const summary = annotations.find((a) => a.type === "SUMMARY" && a.text);
  const description = annotations.find((a) => a.type === "DESCRIPTION" && a.text);
  return summary?.text ?? description?.text ?? null;
}

export async function listWorkstreamSummaries(piecesBaseUrl: string): Promise<WorkstreamSummary[]> {
  const body = await fetchJson(piecesBaseUrl, "/workstream_summaries");
  const items: any[] = Array.isArray(body?.iterable) ? body.iterable : [];

  const withText = await Promise.all(
    items.slice(0, MAX_SUMMARIES).map(async (item) => {
      const text = await fetchSummaryText(piecesBaseUrl, item.id).catch(() => null);
      if (!text) return null;
      return {
        id: item.id,
        name: item.name ?? "(untitled)",
        created: item.created?.readable ?? item.created?.value ?? "",
        text,
      };
    }),
  );

  return withText.filter((s): s is WorkstreamSummary => s !== null);
}
