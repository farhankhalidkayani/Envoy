import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { catchError, tap, throwError, type Observable } from "rxjs";
import { PrismaService } from "../../prisma/prisma.service.js";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Every change made through an API token is written to the audit log, with which token did it, what it called and
 * how it ended — the answer to "what did that AI agent do?". Reads aren't logged (they would drown the changes).
 * Never records bodies or query strings: those can hold visitor data.
 */
@Injectable()
export class ApiTokenAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ApiTokenAuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<AuthenticatedRequest & { originalUrl: string }>();
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    const record = (status: number) => {
      if (!req.apiToken || req.method === "GET" || req.method === "HEAD") return;
      void this.prisma.client.auditLog
        .create({
          data: {
            adminUserId: req.user.sub,
            tenantId: req.user.tenantId,
            action: req.apiToken.operator ? "operator_token.request" : "api_token.request",
            meta: { tokenId: req.apiToken.id, token: req.apiToken.name, method: req.method, path: req.originalUrl.split("?")[0], status },
          },
        })
        .catch((err: Error) => this.logger.warn(`audit write failed: ${err.message}`));
    };
    return next.handle().pipe(
      tap(() => record(res.statusCode)),
      catchError((err: unknown) => {
        record(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
    );
  }
}
