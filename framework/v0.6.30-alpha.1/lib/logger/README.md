# Logger

Gina's multi-stream, multi-group structured logger (RFC 5424 severity levels). Bundle
code binds it to `console` (`var console = require('gina').lib.logger`) and calls
`console.info(...)`, `console.err(...)`, etc.; the logger filters by level and fans
each line out to its transport "containers" — `default` → `process.stdout`,
`mq` → port 8125 (`gina tail`), and an opt-in `file` container.

## Output modes

The `default` container has two render modes, resolved once at logger init. Select the
mode with an environment variable on the bundle process (precedence
`GINA_LOG_FORMAT` → `GINA_LOG_STDOUT` → `text`):

- **text** (default) — a coloured, human-readable line (`[%d] [%s][%a] %m`), ideal for
  a terminal or `docker logs`.
- **json** — one machine-parseable JSON object per line, for log aggregation:

  ```json
  {"ts":"…","level":"info","bundle":"frontend@myproject","message":"…","group":"frontend@myproject","msg":"…"}
  ```

  `bundle`/`message` are canonical; `group`/`msg` are back-compat aliases.

Two env vars select JSON:

- `GINA_LOG_FORMAT=json` — emit JSON instead of the coloured text, in any environment.
- `GINA_LOG_STDOUT=true` — container preset: implies JSON **and** skips the MQ
  transport (no MQ listener runs inside a container).

Both the level methods (`console.info`, `console.debug`, …) and plain `console.log`
honour the mode, so the stream stays uniformly parseable.

Full reference: the [Logging guide](https://gina.io/docs/guides/logging) and the
[Logger API reference](https://gina.io/docs/api/logger).

## Tests

From the repository root:

```bash
node --test test/lib/logger-render.test.js
node --test test/integration/logger-log-integrity.test.js
```
