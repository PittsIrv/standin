import type { FinishReport } from "@standin/knowledge";
import type { Route, ReviewServerOptions } from "./server.ts";

/** The review page's JSON API, beyond status and finish. */
export function registerRoutes(_o: ReviewServerOptions, _route: Route, _finish: () => Promise<FinishReport>): void {}
