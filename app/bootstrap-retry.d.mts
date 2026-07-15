export const BOOTSTRAP_MAX_REQUESTS: 3;
export type BootstrapRetryDecision = "stop" | "retry" | "exhausted";
export function bootstrapRetryDecision(
  requestNumber: number,
  responseOk: boolean,
  retryBootstrap: boolean,
): BootstrapRetryDecision;
