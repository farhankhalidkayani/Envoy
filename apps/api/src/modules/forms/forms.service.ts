import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@envoy/db";
import {
  EMPTY_FORM_SCHEMA,
  FormSchema,
  renderOptionsUrl,
  toPublicFormSchema,
  validateSubmission,
  type ApiOptionsSource,
  type FormOption,
} from "@envoy/types";
import { PrismaService } from "../core/prisma/prisma.service.js";
import { safeFetch } from "../core/common/safe-fetch.js";
import { CaptureRoutingService } from "../routing/capture-routing.service.js";

const MAX_OPTIONS = 500;
const MAX_OPTIONS_RESPONSE_BYTES = 1_000_000;

function parseSchema(raw: unknown): FormSchema {
  const result = FormSchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      message: "Invalid form schema",
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], obj);
}

@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: CaptureRoutingService,
  ) {}

  list(tenantId: string) {
    return this.prisma.client.form.findMany({
      where: { tenantId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { submissions: true } } },
    });
  }

  async get(tenantId: string, id: string) {
    const form = await this.prisma.client.form.findFirst({ where: { id, tenantId } });
    if (!form) throw new NotFoundException("Form not found");
    return form;
  }

  create(tenantId: string, name: string) {
    return this.prisma.client.form.create({
      data: { tenantId, name, schema: EMPTY_FORM_SCHEMA as unknown as Prisma.InputJsonValue },
    });
  }

  async update(tenantId: string, id: string, input: { name?: string; status?: "draft" | "live"; schema?: unknown }) {
    const form = await this.get(tenantId, id);
    const schema = input.schema !== undefined ? parseSchema(input.schema) : undefined;
    if (input.status === "live") {
      const effective = schema ?? parseSchema(form.schema);
      if (!effective.steps.some((s) => s.fields.length > 0)) {
        throw new BadRequestException("Add at least one field before publishing");
      }
    }
    return this.prisma.client.form.update({
      where: { id },
      data: {
        name: input.name,
        status: input.status,
        schema: schema as unknown as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.get(tenantId, id);
    await this.prisma.client.form.delete({ where: { id } });
  }

  async listSubmissions(tenantId: string, formId: string, opts: { cursor?: string; take?: number } = {}) {
    await this.get(tenantId, formId);
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    const rows = await this.prisma.client.formSubmission.findMany({
      where: { formId, tenantId },
      orderBy: { createdAt: "desc" },
      take: take + 1, // one extra row tells us whether a next page exists
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const nextCursor = rows.length > take ? rows[take - 1]!.id : undefined;
    return { rows: rows.slice(0, take), nextCursor };
  }

  async deleteSubmission(tenantId: string, formId: string, submissionId: string) {
    const { count } = await this.prisma.client.formSubmission.deleteMany({
      where: { id: submissionId, formId, tenantId },
    });
    if (count === 0) throw new NotFoundException("Submission not found");
  }

  /** Every submission, oldest-safe cap so an unbounded form can't OOM the request. */
  async exportSubmissionsCsv(tenantId: string, formId: string): Promise<string> {
    const form = await this.get(tenantId, formId);
    const schema = parseSchema(form.schema);
    const rows = await this.prisma.client.formSubmission.findMany({
      where: { formId, tenantId },
      orderBy: { createdAt: "desc" },
      take: 10_000,
    });

    const schemaKeys = schema.steps.flatMap((s) => s.fields).map((f) => f.key);
    const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data as Record<string, unknown>)))].filter(
      (k) => !schemaKeys.includes(k),
    );
    const columns = [...schemaKeys, ...extraKeys];

    const csvCell = (value: unknown): string => {
      const s = value === undefined || value === null ? "" : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Submitted", ...columns].map(csvCell).join(",");
    const lines = rows.map((r) => {
      const data = r.data as Record<string, unknown>;
      return [r.createdAt.toISOString(), ...columns.map((c) => data[c])].map(csvCell).join(",");
    });
    return [header, ...lines].join("\r\n");
  }

  private async getLive(publicToken: string) {
    const form = await this.prisma.client.form.findUnique({
      where: { publicToken },
      include: { tenant: { select: { subscriptionStatus: true } } },
    });
    // Locked tenants' forms disappear the same way their widget does.
    if (!form || form.status !== "live" || form.tenant.subscriptionStatus === "locked") {
      throw new NotFoundException("Form not found");
    }
    return { form, schema: parseSchema(form.schema) };
  }

  /** Nothing tenant-sensitive: no tenant id, no API-source URLs or headers. */
  async getPublic(publicToken: string) {
    const { form, schema } = await this.getLive(publicToken);
    return { name: form.name, schema: toPublicFormSchema(schema) };
  }

  async submit(publicToken: string, data: Record<string, unknown>) {
    const { form, schema } = await this.getLive(publicToken);
    // Honeypot: "_hp" isn't a declared field (FieldKey can't start with "_"),
    // so it's invisible to validateSubmission either way — only a bot that
    // fills every input would set it. Pretend success; don't store or route.
    if (typeof data._hp === "string" && data._hp.trim()) {
      return { successMessage: schema.successMessage };
    }
    // Re-validated server-side with the same function the renderer used —
    // never trust the browser's view of which fields were visible/valid.
    const result = validateSubmission(schema, data);
    if (!result.valid) throw new BadRequestException({ message: "Please fix the highlighted fields", errors: result.errors });

    const submission = await this.prisma.client.formSubmission.create({
      data: { formId: form.id, tenantId: form.tenantId, data: result.values as Prisma.InputJsonValue },
    });
    await this.routing.route(form.tenantId, { formSubmissionId: submission.id });
    return { successMessage: schema.successMessage };
  }

  /**
   * Server-side proxy for API-sourced dropdowns: keeps the tenant's API URL
   * and auth headers off the browser, and sidesteps CORS on their API.
   * `answers` fills `{{fieldKey}}` placeholders for dependent dropdowns.
   */
  async fetchOptions(publicToken: string, fieldKey: string, answers: Record<string, unknown>): Promise<FormOption[]> {
    const { schema } = await this.getLive(publicToken);
    const source = schema.steps.flatMap((s) => s.fields).find((f) => f.key === fieldKey)?.optionsSource;
    if (!source) throw new NotFoundException("No API options for this field");
    return this.fetchFromSource(source, answers);
  }

  /** Builder "Test" button / preview: same fetch, for a source config that may not be saved yet. */
  async fetchFromSource(source: ApiOptionsSource, answers: Record<string, unknown>): Promise<FormOption[]> {
    let response: Response;
    try {
      response = await safeFetch(renderOptionsUrl(source.url, answers), {
        headers: { Accept: "application/json", ...(source.headers ?? {}) },
      });
    } catch (err) {
      throw new BadRequestException(`Could not load options: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) throw new BadRequestException(`Options API responded ${response.status}`);

    const text = await response.text();
    if (text.length > MAX_OPTIONS_RESPONSE_BYTES) throw new BadRequestException("Options API response too large");
    let items: unknown;
    try {
      items = getPath(JSON.parse(text), source.itemsPath);
    } catch {
      throw new BadRequestException("Options API did not return JSON");
    }
    if (!Array.isArray(items)) throw new BadRequestException(`No array found at "${source.itemsPath || "(root)"}"`);

    return items
      .slice(0, MAX_OPTIONS)
      .map((item) => ({
        label: String(getPath(item, source.labelKey) ?? ""),
        value: String(getPath(item, source.valueKey) ?? ""),
      }))
      .filter((o) => o.label && o.value);
  }
}
