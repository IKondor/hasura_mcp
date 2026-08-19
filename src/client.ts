import { getIntrospectionQuery, IntrospectionQuery, IntrospectionSchema } from "graphql";
import type { ServerConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = Number(process.env.HASURA_TIMEOUT_MS ?? 60_000);
/** Схема кешируется на процесс, но протухает — на dev метаданные меняются часто. */
const SCHEMA_TTL_MS = Number(process.env.HASURA_SCHEMA_TTL_MS ?? 10 * 60_000);

/** Hasura прячет текст ошибки Postgres в internal.error — вытаскиваем его наружу. */
function describeError(payload: any): string {
  if (!payload) return "пустой ответ";
  const parts: string[] = [];
  if (payload.error) parts.push(String(payload.error));
  if (payload.errors?.length) {
    parts.push(payload.errors.map((e: any) => e.message ?? JSON.stringify(e)).join(", "));
  }
  const internal = payload.internal?.error;
  if (internal) {
    const detail = [internal.message, internal.description, internal.hint]
      .filter(Boolean)
      .join(" | ");
    if (detail) parts.push(detail);
    if (internal.status_code) parts.push(`(SQLSTATE ${internal.status_code})`);
  }
  return parts.length ? parts.join(": ") : JSON.stringify(payload).slice(0, 500);
}

export interface SqlResult {
  resultType: string;
  columns: string[];
  rowCount: number;
  rows: Array<Record<string, string | null>>;
}

/** Клиент одного инстанса Hasura: GraphQL + SQL + интроспекция с кешем. */
export class HasuraClient {
  private schema: IntrospectionSchema | null = null;
  private schemaFetchedAt = 0;
  private schemaInFlight: Promise<IntrospectionSchema> | null = null;

  constructor(public readonly config: ServerConfig) {}

  private async post(url: string, body: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.config.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`[${this.config.key}] запрос к ${url} не выполнен: ${reason}`);
    }

    const text = await response.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `[${this.config.key}] ${url} вернул не-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`
      );
    }
    if (!response.ok) {
      throw new Error(
        `[${this.config.key}] HTTP ${response.status} от ${url}: ${describeError(payload)}`
      );
    }
    return payload;
  }

  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const payload = await this.post(this.config.graphqlUrl, { query, variables: variables ?? {} });
    if (payload?.errors?.length) {
      const message = payload.errors.map((e: any) => e.message).join(", ");
      throw new Error(`[${this.config.key}] GraphQL-ошибка: ${message}`);
    }
    return payload?.data as T;
  }

  /**
   * Прямой SQL через скрытый эндпоинт `/v2/query`. Транзакционен сам по себе —
   * BEGIN/COMMIT слать не надо. Секрет тот же, что и у GraphQL (если он есть).
   */
  async runSql(sql: string, source = "default", readOnly = true): Promise<SqlResult> {
    const payload = await this.post(this.config.sqlUrl, {
      type: "run_sql",
      args: { source, sql, cascade: false, read_only: readOnly },
    });

    const resultType: string = payload?.result_type ?? "unknown";
    const raw: string[][] = Array.isArray(payload?.result) ? payload.result : [];
    if (resultType !== "TuplesOk" || raw.length === 0) {
      return { resultType, columns: [], rowCount: 0, rows: [] };
    }
    const [columns, ...dataRows] = raw;
    const rows = dataRows.map((row) => {
      const record: Record<string, string | null> = {};
      columns.forEach((column, index) => {
        record[column] = row[index] ?? null;
      });
      return record;
    });
    return { resultType, columns, rowCount: rows.length, rows };
  }

  async introspect(force = false): Promise<IntrospectionSchema> {
    const fresh = Date.now() - this.schemaFetchedAt < SCHEMA_TTL_MS;
    if (!force && this.schema && fresh) {
      return this.schema;
    }
    if (!force && this.schemaInFlight) {
      return this.schemaInFlight;
    }

    this.schemaInFlight = (async () => {
      console.error(`[INFO] [${this.config.key}] интроспекция схемы...`);
      const result = await this.graphql<IntrospectionQuery>(getIntrospectionQuery());
      if (!result?.__schema) {
        throw new Error(`[${this.config.key}] интроспекция не вернула __schema.`);
      }
      this.schema = result.__schema;
      this.schemaFetchedAt = Date.now();
      console.error(`[INFO] [${this.config.key}] схема закеширована.`);
      return this.schema;
    })();

    try {
      return await this.schemaInFlight;
    } catch (error) {
      this.schema = null;
      this.schemaFetchedAt = 0;
      throw error;
    } finally {
      this.schemaInFlight = null;
    }
  }

  async healthCheck(): Promise<string> {
    const response = await fetch(this.config.healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`${this.config.healthUrl} → HTTP ${response.status} ${body}`);
    }
    return `${this.config.healthUrl} → HTTP ${response.status} ${body}`;
  }
}

/** Реестр клиентов: по одному на сервер из server-list.json. */
export class ClientRegistry {
  private clients = new Map<string, HasuraClient>();

  constructor(private readonly servers: Map<string, ServerConfig>) {}

  get keys(): string[] {
    return [...this.servers.keys()];
  }

  list(): ServerConfig[] {
    return [...this.servers.values()];
  }

  get(key: string): HasuraClient {
    const config = this.servers.get(key);
    if (!config) {
      throw new Error(`Неизвестный сервер '${key}'. Доступны: ${this.keys.join(", ")}.`);
    }
    let client = this.clients.get(key);
    if (!client) {
      client = new HasuraClient(config);
      this.clients.set(key, client);
    }
    return client;
  }
}
