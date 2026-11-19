import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import type { Problem } from "@ledgerline/contracts";

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).type("application/problem+json").send(problem);
}

/** Every error leaves the API as RFC 9457 problem+json. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return sendProblem(reply, {
        type: "https://ledgerline.dev/problems/validation",
        title: "Request validation failed",
        status: 400,
        instance: req.url,
        errors: err.validation.map((v) => ({
          path: `${err.validationContext ?? "request"}${v.instancePath || ""}`,
          message: v.message ?? "invalid",
        })),
      });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return sendProblem(reply, {
      type: "about:blank",
      title: status >= 500 ? "Internal Server Error" : err.message,
      status,
      instance: req.url,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, { type: "about:blank", title: "Not Found", status: 404, instance: req.url }),
  );
}
