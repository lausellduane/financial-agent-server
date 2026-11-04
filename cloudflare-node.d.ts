declare module "cloudflare:node" {
  export function httpServerHandler(input: { port: number }): {
    fetch(
      request: Request,
      env?: unknown,
      ctx?: unknown,
    ): Promise<Response> | Response;
  };
}
