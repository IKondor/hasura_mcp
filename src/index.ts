#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  IntrospectionEnumType,
  IntrospectionField,
  IntrospectionInputObjectType,
  IntrospectionInputValue,
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionUnionType,
} from "graphql";
import { z } from "zod";
import { ClientRegistry, HasuraClient } from "./client.js";
import { loadServers } from "./config.js";

const SERVER_NAME = "mcp-servers/hasura-advanced";
const SERVER_VERSION = "2.0.0";
const SCHEMA_MIME_TYPE = "application/json";
/** Потолок на размер текстового ответа инструмента, чтобы не забивать контекст. */
const MAX_RESULT_CHARS = Number(process.env.HASURA_MAX_RESULT_CHARS ?? 120_000);

const cliArgs = process.argv.slice(2);
const configArg = cliArgs.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
const positionalConfig = cliArgs.find((arg) => !arg.startsWith("-"));

let registry: ClientRegistry;
let configPath: string;
try {
  const loaded = loadServers(configArg ?? positionalConfig);
  configPath = loaded.configPath;
  registry = new ClientRegistry(loaded.servers);
} catch (error) {
  console.error(`[FATAL] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const serverKeys = registry.keys as [string, ...string[]];
console.error(`[INFO] Конфигурация: ${configPath}`);
for (const config of registry.list()) {
  console.error(
    `[INFO]   ${config.key} → ${config.baseUrl} (${config.authenticated ? "с авторизацией" : "без секрета"})`
  );
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { resources: {}, tools: {} } }
);

/** Параметр `server` у всех инструментов; если сервер один — можно не указывать. */
const serverParam = (
  serverKeys.length === 1 ? z.enum(serverKeys).default(serverKeys[0]) : z.enum(serverKeys)
).describe(
  `Ключ Hasura-сервера из server-list.json. Доступны: ${serverKeys.join(", ")}.`
) as unknown as z.ZodEnum<[string, ...string[]]>;

function clientFor(key: string): HasuraClient {
  return registry.get(key);
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[...ответ обрезан на ${MAX_RESULT_CHARS} символах. Сузьте выборку — LIMIT, меньше колонок, агрегаты.]`;
  }
  return { content: [{ type: "text", text }] };
}

server.resource(
  "Hasura GraphQL Schema (via Introspection)",
  new ResourceTemplate("hasura://{server}/schema", {
    list: async () => ({
      resources: registry.list().map((config) => ({
        uri: `hasura://${config.key}/schema`,
        name: `Схема GraphQL: ${config.key}`,
        description: `Интроспекция ${config.graphqlUrl}`,
        mimeType: SCHEMA_MIME_TYPE,
      })),
    }),
  }),
  { mimeType: SCHEMA_MIME_TYPE },
  async (uri, variables) => {
    const key = String(variables.server);
    const schema = await clientFor(key).introspect();
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(schema, null, 2), mimeType: SCHEMA_MIME_TYPE }],
    };
  }
);

server.tool(
  "list_servers",
  "Показывает Hasura-серверы из server-list.json: ключ, базовый URL, эндпоинты GraphQL/SQL и наличие авторизации. Начните с него, если не знаете, какой ключ передать в параметр 'server'.",
  {},
  async () => {
    const servers = registry.list().map((config) => ({
      server: config.key,
      baseUrl: config.baseUrl,
      graphqlUrl: config.graphqlUrl,
      sqlUrl: config.sqlUrl,
      auth: config.authenticated ? "secret/token" : "none",
    }));
    return textResult({ configPath, servers });
  }
);

server.tool(
  "run_sql",
  "Выполняет SQL напрямую через эндпоинт Hasura /v2/query (run_sql). Предпочтительный способ для тяжёлых выборок, JOIN-ов, оконных функций и группировок: он дешевле GraphQL по трафику и не упирается в ограничения API. По умолчанию read-only и source='default'.",
  {
    server: serverParam,
    sql: z.string().describe("SQL-запрос. Запрос уже выполняется в транзакции — BEGIN/COMMIT не нужны."),
    source: z
      .string()
      .optional()
      .default("default")
      .describe("Имя источника данных в Hasura (обычно 'default')."),
    readOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("true — read-only транзакция. Поставьте false только для осознанных INSERT/UPDATE/DELETE/DDL."),
  },
  async ({ server: serverKey, sql, source, readOnly }) => {
    console.error(`[INFO] run_sql на '${serverKey}' (source=${source}, readOnly=${readOnly})`);
    const result = await clientFor(serverKey).runSql(sql, source, readOnly);
    return textResult(result);
  }
);

server.tool(
  "run_graphql_query",
  "Выполняет read-only GraphQL-запрос. Для больших/сложных выборок используйте run_sql.",
  {
    server: serverParam,
    query: z.string().describe("Строка GraphQL-запроса (только чтение)."),
    variables: z.record(z.unknown()).optional().describe("Опционально: переменные запроса."),
  },
  async ({ server: serverKey, query, variables }) => {
    console.error(`[INFO] run_graphql_query на '${serverKey}'`);
    if (query.trim().toLowerCase().startsWith("mutation")) {
      throw new Error("Инструмент поддерживает только запросы на чтение. Используйте run_graphql_mutation.");
    }
    return textResult(await clientFor(serverKey).graphql(query, variables));
  }
);

server.tool(
  "run_graphql_mutation",
  "Выполняет GraphQL-мутацию (insert/update/delete). Используйте осознанно.",
  {
    server: serverParam,
    mutation: z.string().describe("Строка GraphQL-мутации."),
    variables: z.record(z.unknown()).optional().describe("Опционально: переменные мутации."),
  },
  async ({ server: serverKey, mutation, variables }) => {
    console.error(`[INFO] run_graphql_mutation на '${serverKey}'`);
    if (!mutation.trim().toLowerCase().startsWith("mutation")) {
      throw new Error("Переданная строка не похожа на мутацию.");
    }
    return textResult(await clientFor(serverKey).graphql(mutation, variables));
  }
);

server.tool(
  "list_tables",
  "Перечисляет таблицы (корневые поля query_root) с описаниями, сгруппированные по схеме.",
  {
    server: serverParam,
    schemaName: z
      .string()
      .optional()
      .describe("Опционально: фильтр по имени схемы БД. Без него — все схемы."),
  },
  async ({ server: serverKey, schemaName }) => {
    console.error(`[INFO] list_tables на '${serverKey}' (схема: ${schemaName ?? "ALL"})`);
    const result = await clientFor(serverKey).graphql(`
      query GetTablesWithDescriptions {
        __type(name: "query_root") {
          fields { name description type { name kind } }
        }
      }
    `);

    const tablesData: Record<string, Array<{ name: string; description: string | null }>> = {};
    for (const field of result?.__type?.fields ?? []) {
      if (
        field.name.includes("_aggregate") ||
        field.name.includes("_by_pk") ||
        field.name.includes("_stream") ||
        field.name.includes("_mutation") ||
        field.name.startsWith("__")
      ) {
        continue;
      }

      let currentSchema = "public";
      const schemaMatch = field.description?.match(/schema:\s*([^\s,]+)/i);
      if (schemaMatch?.[1]) {
        currentSchema = schemaMatch[1];
      }
      if (schemaName && currentSchema !== schemaName) {
        continue;
      }
      (tablesData[currentSchema] ??= []).push({ name: field.name, description: field.description });
    }

    const formatted = Object.entries(tablesData)
      .map(([schema, tables]) => ({
        schema,
        tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.schema.localeCompare(b.schema));
    return textResult(formatted);
  }
);

server.tool(
  "list_root_fields",
  "Перечисляет корневые поля query/mutation/subscription из схемы.",
  {
    server: serverParam,
    fieldType: z
      .enum(["QUERY", "MUTATION", "SUBSCRIPTION"])
      .optional()
      .describe("Опционально: фильтр по типу корневых полей."),
  },
  async ({ server: serverKey, fieldType }) => {
    console.error(`[INFO] list_root_fields на '${serverKey}' (${fieldType ?? "ALL"})`);
    const schema = await clientFor(serverKey).introspect();
    const rootFieldsOf = (typeName?: string): readonly IntrospectionField[] => {
      const root = schema.types.find((t) => t.name === typeName) as IntrospectionObjectType | undefined;
      return root?.fields ?? [];
    };

    let fields: IntrospectionField[] = [];
    if (!fieldType || fieldType === "QUERY") fields = fields.concat(rootFieldsOf(schema.queryType?.name));
    if (!fieldType || fieldType === "MUTATION") fields = fields.concat(rootFieldsOf(schema.mutationType?.name));
    if (!fieldType || fieldType === "SUBSCRIPTION")
      fields = fields.concat(rootFieldsOf(schema.subscriptionType?.name));

    const fieldInfo = fields
      .map((f) => ({ name: f.name, description: f.description || "No description." }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return textResult(fieldInfo);
  }
);

server.tool(
  "describe_graphql_type",
  "Показывает детали GraphQL-типа (Object, Input, Scalar, Enum, Interface, Union) по интроспекции.",
  {
    server: serverParam,
    typeName: z.string().describe("Точное имя типа с учётом регистра."),
  },
  async ({ server: serverKey, typeName }) => {
    console.error(`[INFO] describe_graphql_type '${typeName}' на '${serverKey}'`);
    const schema = await clientFor(serverKey).introspect();
    const typeInfo = schema.types.find((t) => t.name === typeName);
    if (!typeInfo) {
      throw new Error(`Тип '${typeName}' не найден в схеме сервера '${serverKey}'.`);
    }

    const formattedInfo = {
      kind: typeInfo.kind,
      name: typeInfo.name,
      description: typeInfo.description || null,
      ...(typeInfo.kind === "OBJECT" || typeInfo.kind === "INTERFACE"
        ? {
            fields:
              (typeInfo as IntrospectionObjectType | IntrospectionInterfaceType).fields?.map(
                (f: IntrospectionField) => ({
                  name: f.name,
                  description: f.description || null,
                  type: JSON.stringify(f.type),
                  args:
                    f.args?.map((a: IntrospectionInputValue) => ({
                      name: a.name,
                      type: JSON.stringify(a.type),
                    })) || [],
                })
              ) || [],
          }
        : {}),
      ...(typeInfo.kind === "INPUT_OBJECT"
        ? {
            inputFields:
              (typeInfo as IntrospectionInputObjectType).inputFields?.map(
                (f: IntrospectionInputValue) => ({
                  name: f.name,
                  description: f.description || null,
                  type: JSON.stringify(f.type),
                })
              ) || [],
          }
        : {}),
      ...(typeInfo.kind === "ENUM"
        ? {
            enumValues:
              (typeInfo as IntrospectionEnumType).enumValues?.map((ev) => ({
                name: ev.name,
                description: ev.description || null,
              })) || [],
          }
        : {}),
      ...(typeInfo.kind === "UNION" || typeInfo.kind === "INTERFACE"
        ? {
            possibleTypes:
              (typeInfo as IntrospectionUnionType | IntrospectionInterfaceType).possibleTypes?.map(
                (pt) => pt.name
              ) || [],
          }
        : {}),
    };
    return textResult(formattedInfo);
  }
);

server.tool(
  "describe_table",
  "Показывает структуру таблицы: колонки, типы и описания.",
  {
    server: serverParam,
    tableName: z.string().describe("Точное имя таблицы."),
    schemaName: z.string().optional().default("public").describe("Опционально: имя схемы БД."),
  },
  async ({ server: serverKey, tableName, schemaName }) => {
    console.error(`[INFO] describe_table '${tableName}' на '${serverKey}'`);
    const client = clientFor(serverKey);
    const tableTypeQuery = `
      query GetTableType($typeName: String!) {
        __type(name: $typeName) {
          name kind description
          fields {
            name description
            type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
            args { name description type { kind name ofType { kind name } } }
          }
        }
      }
    `;

    let typeResult = await client.graphql(tableTypeQuery, { typeName: tableName });
    if (!typeResult?.__type) {
      const pascalCaseName = tableName.charAt(0).toUpperCase() + tableName.slice(1);
      typeResult = await client.graphql(tableTypeQuery, { typeName: pascalCaseName });
      if (!typeResult?.__type) {
        throw new Error(`Таблица '${tableName}' не найдена в схеме сервера '${serverKey}'.`);
      }
    }

    const columnsInfo = (typeResult.__type.fields ?? []).map((field: any) => {
      let typeInfo = field.type;
      let typeString = "";
      let isNonNull = false;
      let isList = false;

      while (typeInfo) {
        if (typeInfo.kind === "NON_NULL") {
          isNonNull = true;
          typeInfo = typeInfo.ofType;
        } else if (typeInfo.kind === "LIST") {
          isList = true;
          typeInfo = typeInfo.ofType;
        } else {
          typeString = typeInfo.name || "unknown";
          break;
        }
      }

      const fullTypeString = `${isList ? `[${typeString}]` : typeString}${isNonNull ? "!" : ""}`;
      return {
        name: field.name,
        type: fullTypeString,
        description: field.description || null,
        args: field.args?.length ? field.args : null,
      };
    });

    return textResult({
      table: {
        name: tableName,
        schema: schemaName,
        description: typeResult.__type.description || null,
        columns: columnsInfo.sort((a: any, b: any) => a.name.localeCompare(b.name)),
      },
    });
  }
);

server.tool(
  "preview_table_data",
  "Возвращает несколько строк таблицы (по умолчанию 5), выбирая скалярные и enum-поля автоматически.",
  {
    server: serverParam,
    tableName: z.string().describe("Точное имя таблицы."),
    limit: z.number().int().positive().optional().default(5).describe("Максимум строк."),
  },
  async ({ server: serverKey, tableName, limit }) => {
    console.error(`[INFO] preview_table_data '${tableName}' на '${serverKey}' (limit=${limit})`);
    const client = clientFor(serverKey);
    const schema = await client.introspect();
    const tableType = schema.types.find((t) => t.name === tableName && t.kind === "OBJECT") as
      | IntrospectionObjectType
      | undefined;
    if (!tableType) {
      throw new Error(`Тип таблицы '${tableName}' не найден в схеме сервера '${serverKey}'.`);
    }

    const scalarFields =
      tableType.fields
        ?.filter((f) => {
          let currentType: any = f.type;
          while (currentType.kind === "NON_NULL" || currentType.kind === "LIST") {
            currentType = currentType.ofType;
          }
          return currentType.kind === "SCALAR" || currentType.kind === "ENUM";
        })
        .map((f) => f.name) ?? [];
    if (scalarFields.length === 0) {
      console.error(`[WARN] У таблицы ${tableName} нет скалярных полей, беру __typename.`);
      scalarFields.push("__typename");
    }

    const query = `query PreviewData($limit: Int!) { ${tableName}(limit: $limit) { ${scalarFields.join(" ")} } }`;
    return textResult(await client.graphql(query, { limit }));
  }
);

server.tool(
  "aggregate_data",
  "Простая агрегация (count, sum, avg, min, max) по таблице с опциональным where-фильтром.",
  {
    server: serverParam,
    tableName: z.string().describe("Точное имя таблицы (без суффикса _aggregate)."),
    aggregateFunction: z.enum(["count", "sum", "avg", "min", "max"]).describe("Функция агрегации."),
    field: z.string().optional().describe("Обязательно для sum/avg/min/max."),
    filter: z.record(z.unknown()).optional().describe("Опционально: объект where-фильтра Hasura."),
  },
  async ({ server: serverKey, tableName, aggregateFunction, field, filter }) => {
    console.error(`[INFO] aggregate_data ${aggregateFunction}(${tableName}) на '${serverKey}'`);
    if (aggregateFunction !== "count" && !field) {
      throw new Error(`Параметр 'field' обязателен для агрегации '${aggregateFunction}'.`);
    }

    const aggregateTableName = `${tableName}_aggregate`;
    const aggregateSelection =
      aggregateFunction === "count" ? `{ count }` : `{ ${aggregateFunction} { ${field} } }`;
    // Пустые скобки — невалидный GraphQL, поэтому без фильтра их вообще не пишем.
    const filterVariableDefinition = filter ? `($filter: ${tableName}_bool_exp!)` : "";
    const whereClause = filter ? "(where: $filter)" : "";

    const query = `
      query AggregateData ${filterVariableDefinition} {
        ${aggregateTableName}${whereClause} { aggregate ${aggregateSelection} }
      }
    `;
    const rawResult = await clientFor(serverKey).graphql(query, filter ? { filter } : undefined);
    return textResult(rawResult?.[aggregateTableName]?.aggregate ?? rawResult);
  }
);

server.tool(
  "health_check",
  "Проверяет доступность сервера: HTTP /healthz и GraphQL-запрос { __typename }.",
  {
    server: serverParam,
    healthEndpointUrl: z.string().url().optional().describe("Опционально: свой URL health-проверки."),
  },
  async ({ server: serverKey, healthEndpointUrl }) => {
    console.error(`[INFO] health_check '${serverKey}'`);
    const client = clientFor(serverKey);
    try {
      if (healthEndpointUrl) {
        const response = await fetch(healthEndpointUrl, { method: "GET" });
        const text = `${healthEndpointUrl} → HTTP ${response.status} ${response.statusText}`;
        if (!response.ok) throw new Error(text);
        return textResult(`Health check OK. ${text}`);
      }
      const [health, graphql] = await Promise.all([
        client.healthCheck().catch((error: Error) => `недоступен: ${error.message}`),
        client.graphql(`query HealthCheck { __typename }`),
      ]);
      return textResult(
        `Health check OK для '${serverKey}'.\nHTTP: ${health}\nGraphQL: ${client.config.graphqlUrl} отвечает, ${JSON.stringify(graphql)}`
      );
    } catch (error: any) {
      return textResult(`Health check не прошёл для '${serverKey}': ${error.message}`);
    }
  }
);

async function main() {
  console.error(`[INFO] Запуск ${SERVER_NAME} v${SERVER_VERSION} (${serverKeys.length} сервер(ов))...`);
  // Схемы тянем лениво, по первому обращению к конкретному серверу.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[INFO] ${SERVER_NAME} v${SERVER_VERSION} работает через STDIO.`);
}

main().catch((error) => {
  console.error("[FATAL] Сервер упал при старте:", error);
  process.exit(1);
});
