/**
 * Bridges Cloudflare's request-scoped ExecutionContext into App Router handlers.
 * The opaque id is injected only by worker/index.ts and is removed as soon as
 * the routed request completes. D1 remains the durable source of task state.
 */

export const EXECUTION_CONTEXT_HEADER = "x-gkrl-execution-id";

type RequestExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const requestContexts = new Map<string, RequestExecutionContext>();

export function registerRequestExecutionContext(id: string, context: RequestExecutionContext) {
  requestContexts.set(id, context);
}

export function clearRequestExecutionContext(id: string) {
  requestContexts.delete(id);
}

export function scheduleRequestTask(request: Request, task: () => Promise<unknown>) {
  const id = request.headers.get(EXECUTION_CONTEXT_HEADER) ?? "";
  const context = id ? requestContexts.get(id) : undefined;
  if (!context) return false;
  context.waitUntil(task());
  return true;
}
