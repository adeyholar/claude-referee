// A local stand-in for the Jev API: records requests and answers with canned probabilities.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Record<string, { type: string; criteria?: unknown; instructions?: unknown }>;
  readonly assets?: Record<string, unknown>;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly fileSizes?: Record<string, number>;
}

export type Answerer = (request: FakeRequest) => Record<string, unknown>;

export interface Behaviour {
  readonly status?: number;
  readonly retryAfter?: string;
  readonly hang?: boolean;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export interface FakeJev {
  readonly url: string;
  readonly requests: FakeRequest[];
  readonly authorizations: string[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function defaultAnswer(request: FakeRequest): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
    else if (q.type === "choice") {
      const labels = Object.keys(q.criteria as object);
      const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.9 : 0.1 / Math.max(labels.length - 1, 1)]));
      answers[id] = { type: "choice", choice: labels[0], confidence: 0.9, probabilities };
    } else {
      const levels = (q.criteria as unknown[]).length;
      answers[id] = { type: "score", score: levels - 1, confidence: 0.9, legend: {}, probabilities: {} };
    }
  }
  return answers;
}

export async function fakeJev(
  answer: Answerer = defaultAnswer,
  options: { hang?: boolean; status?: number; retryAfter?: string; delayMs?: number; behave?: (request: FakeRequest) => Behaviour | undefined } = {},
): Promise<FakeJev> {
  const requests: FakeRequest[] = [];
  const authorizations: string[] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(options.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "jev-latest", description: "fake", release_date: "2026-09-01" }] }));
      return;
    }
    const raw = await readBody(req);
    const boundary = /^multipart\/form-data;\s*boundary=(.+)$/.exec(String(req.headers["content-type"] ?? ""))?.[1];
    let body: FakeRequest;
    if (boundary) {
      const parts = raw.split(`--${boundary}`).filter((p) => /name="/.test(p));
      const named = (p: string): string => /name="([^"]*)"/.exec(p)?.[1] ?? "";
      const content = (p: string): string => p.slice(p.indexOf("\r\n\r\n") + 4, p.lastIndexOf("\r\n"));
      const json = parts.find((p) => named(p) === "request");
      body = JSON.parse(json ? content(json) : "{}") as FakeRequest;
      body = { ...body, headers: req.headers, fileSizes: Object.fromEntries(parts.filter((p) => named(p) !== "request").map((p) => [named(p), content(p).length])) };
    } else body = JSON.parse(raw) as FakeRequest;
    requests.push(body);
    authorizations.push(String(req.headers.authorization ?? ""));
    const behaviour = options.behave?.(body) ?? options;
    if (behaviour.hang) return;
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
    if (behaviour.status) {
      res.writeHead(behaviour.status, { "content-type": "application/json", ...(behaviour.retryAfter ? { "retry-after": behaviour.retryAfter } : {}) });
      res.end(JSON.stringify("body" in behaviour ? behaviour.body : { error: "fake" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-typesafe-request-id": `req_${requests.length}` });
    res.end(JSON.stringify({ model: body.model, answers: answer(body), usage: { input_tokens: 100, output_tokens: 10 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
