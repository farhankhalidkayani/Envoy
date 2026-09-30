import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../core/prisma/prisma.service.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Auto-deletes old conversations/form submissions once RETENTION_DAYS is
 * set — unset (the default) disables this entirely, since indefinite
 * retention is the safer default until an operator opts in. Never touches
 * in_progress conversations regardless of age — only a conversation that's
 * actually finished (or been abandoned) is eligible.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sweep(): Promise<{ conversations: number; submissions: number } | { skipped: true }> {
    const days = Number(process.env.RETENTION_DAYS);
    if (!days || days <= 0) return { skipped: true };
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);

    const [conversations, submissions] = await Promise.all([
      this.prisma.client.conversation.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ["completed", "abandoned"] } },
      }),
      this.prisma.client.formSubmission.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ]);
    this.logger.log(
      `retention sweep: deleted ${conversations.count} conversation(s) and ${submissions.count} form submission(s) older than ${days}d`,
    );
    return { conversations: conversations.count, submissions: submissions.count };
  }
}
