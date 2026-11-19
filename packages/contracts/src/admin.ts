import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const DlqItem = z
  .object({
    jobId: z.string(),
    queue: z.string(),
    failedAt: IsoDateTime,
    attemptsMade: z.int(),
    errorChain: z.array(z.object({ name: z.string(), message: z.string() })),
    replayedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "DlqItem" });

export const ReplayResponse = z
  .object({ jobId: z.string(), newJobId: z.string(), queue: z.string() })
  .meta({ id: "ReplayResponse" });
