import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Резолвнутая конфигурация одного Hasura-инстанса. */
export interface ServerConfig {
  /** Ключ из server-list.json, он же значение параметра `server` у инструментов. */
  key: string;
  /** База без пути, например `https://hasura.example.org`. */
  baseUrl: string;
  graphqlUrl: string;
  /** Эндпоинт SQL (`run_sql`). */
  sqlUrl: string;
  metadataUrl: string;
  healthUrl: string;
  /** Есть ли у сервера авторизация. Если нет — SQL-эндпоинт тоже открыт. */
  authenticated: boolean;
  headers: Record<string, string>;
}

/**
 * Значение записи в server-list.json:
 *   "key": "host.example.org"                          — без секрета
 *   "key": { "url": "...", "adminSecret": "..." }       — x-hasura-admin-secret
 *   "key": { "url": "...", "authorization": "Bearer ..." } — заголовок Authorization
 *   "key": { "url": "...", "headers": { ... } }         — произвольные заголовки
 */
type RawEntry =
  | string
  | {
      url?: string;
      host?: string;
      endpoint?: string;
      adminSecret?: string;
      secret?: string;
      authorization?: string;
      headers?: Record<string, string>;
    };

const KNOWN_SUFFIXES = ["/v1/graphql", "/v1alpha1/graphql", "/v2/query", "/v1/metadata"];

/** `host` → `https://host`; полный URL с путём Hasura → база без пути. */
function normalizeBaseUrl(target: string, key: string): string {
  let value = target.trim();
  if (!value) {
    throw new Error(`Server '${key}': пустой URL.`);
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Server '${key}': не удалось разобрать URL '${target}'.`);
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  for (const suffix of KNOWN_SUFFIXES) {
    if (pathname.toLowerCase().endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function buildHeaders(entry: RawEntry, key: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof entry === "string") {
    return headers;
  }

  const secret = (entry.adminSecret ?? entry.secret ?? "").trim();
  const authorization = (entry.authorization ?? "").trim();

  if (authorization) {
    headers["authorization"] = authorization;
  }
  if (secret) {
    // JWT удобнее передавать как Authorization: пустой пароль admin-secret Hasura отвергнет.
    if (/^bearer\s+/i.test(secret)) {
      if (!headers["authorization"]) {
        headers["authorization"] = secret;
        console.error(
          `[WARN] Server '${key}': adminSecret начинается с 'Bearer ', отправляю его как заголовок Authorization.`
        );
      }
    } else {
      headers["x-hasura-admin-secret"] = secret;
    }
  }
  for (const [name, value] of Object.entries(entry.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function toServerConfig(key: string, entry: RawEntry): ServerConfig {
  const target =
    typeof entry === "string" ? entry : entry.url ?? entry.host ?? entry.endpoint ?? "";
  const baseUrl = normalizeBaseUrl(target, key);
  const headers = buildHeaders(entry, key);
  return {
    key,
    baseUrl,
    graphqlUrl: `${baseUrl}/v1/graphql`,
    sqlUrl: `${baseUrl}/v2/query`,
    metadataUrl: `${baseUrl}/v1/metadata`,
    healthUrl: `${baseUrl}/healthz`,
    authenticated: Boolean(headers["x-hasura-admin-secret"] || headers["authorization"]),
    headers,
  };
}

/** Путь по умолчанию: server-list.json в корне пакета (рядом с dist/ или src/). */
export function defaultConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "server-list.json");
}

export function resolveConfigPath(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.HASURA_SERVER_LIST,
    defaultConfigPath(),
    path.resolve(process.cwd(), "server-list.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    `Не найден server-list.json. Искал: ${candidates.join(", ")}. ` +
      `Укажите путь аргументом или переменной окружения HASURA_SERVER_LIST.`
  );
}

export function loadServers(explicitPath?: string): {
  configPath: string;
  servers: Map<string, ServerConfig>;
} {
  const configPath = resolveConfigPath(explicitPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Не удалось прочитать ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} должен содержать JSON-объект вида { "ключ": "host" | {...} }.`);
  }

  const servers = new Map<string, ServerConfig>();
  for (const [key, entry] of Object.entries(parsed as Record<string, RawEntry>)) {
    servers.set(key, toServerConfig(key, entry as RawEntry));
  }
  if (servers.size === 0) {
    throw new Error(`${configPath} не содержит ни одного сервера.`);
  }
  return { configPath, servers };
}
