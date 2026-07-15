/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  clearRequestExecutionContext,
  EXECUTION_CONTEXT_HEADER,
  registerRequestExecutionContext,
} from "./execution-context";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ADMIN_TOKEN?: string;
  INTERNAL_JOB_SECRET?: string;
  SITES_BYPASS_BEARER_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const API_METRIC_EVENT = "api_request_metric";
const API_METRIC_USER = "system";

async function recordApiRequestMetric(
  env: Env,
  request: Request,
  status: number,
  durationMs: number,
) {
  try {
    await env.DB.prepare(`INSERT INTO analytics_events (user_id, event_name, event_data)
      VALUES (?, ?, ?)`)
      .bind(API_METRIC_USER, API_METRIC_EVENT, JSON.stringify({
        method: request.method,
        status,
        durationMs: Math.round(Math.max(0, durationMs) * 100) / 100,
      }))
      .run();
  } catch (error) {
    // Metrics must never change the API response. A missing table during the
    // very first bootstrap request is allowed to self-heal on the next call.
    console.warn("API metric write skipped", error);
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/app") {
      const startedAt = performance.now();
      let responseStatus = 500;
      const executionId = crypto.randomUUID();
      const headers = new Headers(request.headers);
      headers.set(EXECUTION_CONTEXT_HEADER, executionId);
      registerRequestExecutionContext(executionId, ctx);
      try {
        const response = await handler.fetch(new Request(request, { headers }), env, ctx);
        responseStatus = response.status;
        return response;
      } finally {
        clearRequestExecutionContext(executionId);
        const durationMs = performance.now() - startedAt;
        ctx.waitUntil(recordApiRequestMetric(env, request, responseStatus, durationMs));
      }
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
