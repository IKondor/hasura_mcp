# Advanced Hasura GraphQL MCP Server

**Версия:** 2.0.0

MCP-сервер для работы с Hasura из AI-агентов (Claude Code, Cursor, Claude Desktop). Умеет исследовать схему, выполнять GraphQL-запросы и мутации, гонять **прямой SQL** через служебный эндпоинт Hasura и проверять доступность инстансов.

Ключевое отличие версии 2.0: **один процесс обслуживает все Hasura-инстансы сразу**. Раньше на каждое окружение поднимался отдельный MCP-сервер со своим URL и секретом в аргументах; теперь список берётся из `server-list.json`, а нужный инстанс выбирается параметром `server` в каждом инструменте.

## Конфигурация: `server-list.json`

Файл — JSON-объект `{ "ключ": описание сервера }`. Ключ становится значением параметра `server` у инструментов.

```json
{
  "example-without-secret": {
    "url": "https://hasura.example.org"
  },
  "example-with-secret": {
    "url": "https://hasura.example.org",
    "adminSecret": "мой-admin-secret"
  },
  "example-with-jwt": {
    "url": "http://localhost:32855",
    "authorization": "Bearer eyJhbGciOi..."
  },
  "example-with-custom-headers": {
    "url": "https://hasura.example.org/v1/graphql",
    "headers": {
      "x-hasura-role": "admin",
      "x-custom-gateway-key": "..."
    }
  }
}
```

Форматы записи:

| Форма | Что делает |
|---|---|
| `"host"` или `"https://host"` | Сервер **без авторизации** — заголовки не отправляются |
| `{ "url": "...", "adminSecret": "..." }` | Отправляет `x-hasura-admin-secret` |
| `{ "url": "...", "authorization": "Bearer ..." }` | Отправляет `Authorization` |
| `{ "url": "...", "headers": { ... } }` | Произвольные заголовки, перекрывают всё выше |

Детали:

* URL нормализуется: голый хост дополняется до `https://`, а хвосты `/v1/graphql`, `/v2/query`, `/v1/metadata` отрезаются — от базы сервер сам собирает `/v1/graphql`, `/v2/query`, `/v1/metadata`, `/healthz`. То есть `hasura.example.org` и `https://hasura.example.org/v1/graphql` дают одинаковый результат.
* Если в `adminSecret` положить значение, начинающееся с `Bearer `, оно уедет в заголовок `Authorization` (с предупреждением в лог) — JWT в `x-hasura-admin-secret` Hasura не примет.
* Пустая строка в секрете = секрета нет.
* Путь к файлу ищется по порядку: аргумент `--config=/path/to/file.json` (или первый позиционный аргумент) → переменная окружения `HASURA_SERVER_LIST` → `server-list.json` в корне пакета → `server-list.json` в текущей директории.
* **`server-list.json` в `.gitignore`** — в нём лежат секреты. Шаблон для копирования: `server-list.example.json`.

## SQL-эндпоинт Hasura (`/v2/query`)

У Hasura помимо GraphQL есть недокументированный в UI эндпоинт для прямого SQL — им пользуется инструмент `run_sql`:

```
POST {base}/v2/query
{"type": "run_sql", "args": {"source": "default", "sql": "select 1", "read_only": true}}
```

Что важно знать:

* **Авторизация та же, что у GraphQL.** Если инстанс в `server-list.json` указан без секрета — SQL-эндпоинт у него тоже открыт без секрета, отдельного токена не нужно. Если секрет есть, он уходит в тот же заголовок, что и для GraphQL.
* **Тяжёлые запросы лучше гонять через SQL, а не через GraphQL.** JOIN-ы, `GROUP BY`, оконные функции, выборки на тысячи строк, разовые сверки между таблицами — всё это в SQL пишется короче, выполняется одним запросом и возвращает на порядок меньше «воды», чем эквивалентный GraphQL-ответ. GraphQL оставляйте для точечных выборок по связям и для мутаций через бизнес-логику Hasura.
* **Массовые/точные данные — только SQL.** Большие значения (например, jsonb с SVG на сотни килобайт) через GraphQL-мутацию не пролезут без искажений: генерируйте SQL программно и отправляйте `run_sql`.
* **`run_sql` уже транзакционный** — `BEGIN`/`COMMIT` слать не надо, при ошибке всё откатывается целиком.
* **`read_only`** по умолчанию `true`: read-only транзакция, любые `INSERT`/`UPDATE`/`DELETE`/DDL упадут с `SQLSTATE 25006`. Для записи явно передайте `readOnly: false`.
* **`source`** — имя источника данных Hasura, по умолчанию `default`. У инстансов бывает несколько источников (например, `default` и `keycloak`); список смотрите в `POST {base}/v1/metadata` с `{"type":"export_metadata","args":{}}`.
* Ответ приходит в виде массива массивов (первая строка — заголовки); сервер сам разворачивает его в `{ columns, rowCount, rows: [{колонка: значение}] }`. Значения приходят строками — так их отдаёт Postgres в этом протоколе.

## Инструменты

Во всех инструментах, кроме `list_servers`, есть параметр `server` — ключ из `server-list.json`. Он обязателен, если серверов больше одного (и подставляется автоматически, если сервер ровно один). Список допустимых значений передаётся модели прямо в схеме инструмента.

* **`list_servers`** — какие серверы доступны: ключ, базовый URL, эндпоинты GraphQL/SQL, есть ли авторизация. Вход: `{}`.
* **`run_sql`** — прямой SQL через `/v2/query`. Вход: `{ server, sql, source?='default', readOnly?=true }`.
* **`run_graphql_query`** — GraphQL-запрос на чтение. Вход: `{ server, query, variables? }`.
* **`run_graphql_mutation`** — GraphQL-мутация (insert/update/delete). Вход: `{ server, mutation, variables? }`.
* **`list_tables`** — таблицы (корневые поля `query_root`) с описаниями, сгруппированные по схеме. Вход: `{ server, schemaName? }`.
* **`describe_table`** — колонки таблицы с типами и описаниями. Вход: `{ server, tableName, schemaName?='public' }`.
* **`list_root_fields`** — корневые поля query/mutation/subscription. Вход: `{ server, fieldType?: 'QUERY'|'MUTATION'|'SUBSCRIPTION' }`.
* **`describe_graphql_type`** — детали GraphQL-типа по интроспекции. Вход: `{ server, typeName }`.
* **`preview_table_data`** — несколько строк таблицы, скалярные поля выбираются автоматически. Вход: `{ server, tableName, limit?=5 }`.
* **`aggregate_data`** — `count`/`sum`/`avg`/`min`/`max` с опциональным `where`. Вход: `{ server, tableName, aggregateFunction, field?, filter? }`.
* **`health_check`** — `GET /healthz` плюс GraphQL `{ __typename }`. Вход: `{ server, healthEndpointUrl? }`.

### Ресурсы

* **`hasura://{server}/schema`** — полная интроспекция схемы в JSON. `resources/list` перечисляет по одному ресурсу на каждый сервер из конфига.

Схема тянется лениво (при первом обращении к конкретному серверу) и кешируется на 10 минут — на dev метаданные меняются часто, поэтому кеш протухающий.

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HASURA_SERVER_LIST` | — | Путь к `server-list.json` |
| `HASURA_TIMEOUT_MS` | `60000` | Таймаут HTTP-запросов |
| `HASURA_SCHEMA_TTL_MS` | `600000` | Время жизни кеша интроспекции |
| `HASURA_MAX_RESULT_CHARS` | `120000` | Потолок размера ответа инструмента (сверху обрезается) |

## Требования

* Node.js 26+
* `pnpm` (или `npm`/`yarn`)
* Доступ до Hasura-инстансов из `server-list.json`

## Установка и сборка

```bash
pnpm install
cp server-list.example.json server-list.json   # и вписать свои инстансы
pnpm run build
```

## Запуск

```bash
pnpm start                              # конфиг ищется автоматически
node dist/index.js --config=/path/to/server-list.json
HASURA_SERVER_LIST=/path/to/list.json node dist/index.js
```

Сервер логирует статус в `stderr` (в `stdout` идёт только JSON-RPC), слушает MCP-запросы на `stdin`.

## Подключение к MCP-клиенту

Раньше на каждое окружение заводилась своя запись в конфиге. Теперь достаточно одной:

```json
{
  "mcpServers": {
    "hasura": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/hasura_mcp/dist/index.js"]
    }
  }
}
```

Для Claude Code то же самое делается командой:

```bash
claude mcp add hasura -- /absolute/path/to/node /absolute/path/to/hasura_mcp/dist/index.js
```

Если конфиг лежит не рядом с пакетом, допишите `--config=/absolute/path/to/server-list.json` в `args`.

После подключения нужный инстанс выбирается прямо в запросе: «покажи таблицы на `pcht-dev`», «посчитай через SQL на `vlg-dev`».

## Разработка

* `pnpm run dev` — сборка + запуск.
* `pnpm run typecheck` — проверка типов без сборки.
* Ручной тест: запустить `node dist/index.js` и слать JSON-RPC в `stdin` (`initialize` → `notifications/initialized` → `tools/call`).

Структура:

* `src/config.ts` — чтение и нормализация `server-list.json`.
* `src/client.ts` — HTTP-клиент одного инстанса (GraphQL, `run_sql`, интроспекция с кешем) и реестр клиентов.
* `src/index.ts` — регистрация MCP-инструментов и ресурсов.
