import { registerRoutes } from "./routes.ts";
import { startReviewServer as start, type ReviewServer, type ReviewServerOptions } from "./server.ts";

export type { ReviewServer, ReviewServerOptions } from "./server.ts";

/** Starts the review page's server with every route. */
export function startReviewServer(o: ReviewServerOptions): Promise<ReviewServer> {
  return start(o, (route, finish) => registerRoutes(o, route, finish));
}
