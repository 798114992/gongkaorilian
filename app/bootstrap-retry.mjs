// A signed-in bootstrap can legitimately need two lightweight preparation
// invocations before the read-heavy response: one for identity/session setup
// and one for an eligible invite reward. Keep the browser bounded to those two
// retries so a server regression can never create a request loop.
export const BOOTSTRAP_MAX_REQUESTS = 3;

export function bootstrapRetryDecision(requestNumber, responseOk, retryBootstrap) {
  if (!responseOk || !retryBootstrap) return "stop";
  return requestNumber < BOOTSTRAP_MAX_REQUESTS ? "retry" : "exhausted";
}
