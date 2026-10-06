import type { Env } from "./env";

// Step 1 scaffold: handlers are wired up but the sync logic lands in Steps 4–5,
// and /status in Step 7.
export default {
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("sync not implemented yet");
  },

  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
