declare module "@runtime-env" {
  export const env: typeof import("cloudflare:workers").env;
}
