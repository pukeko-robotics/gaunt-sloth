# @gaunt-sloth/tools

> ⚠️ **Deprecated.** This package is part of the `gaunt-sloth-assistant` 1.x line, which has been
> renamed to [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth). In v2 its tools and
> middleware are consolidated into [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent);
> this package will receive no further updates.
>
> **Migrating imports** — the same modules live under `@gaunt-sloth/agent`:
>
> ```js
> // v1 (@gaunt-sloth/tools)                                   → v2 (@gaunt-sloth/agent)
> import { resolveMiddleware } from '@gaunt-sloth/tools/middleware/registry.js';
> import { resolveMiddleware } from '@gaunt-sloth/agent';
>
> import GthFileSystemToolkit from '@gaunt-sloth/tools/tools/GthFileSystemToolkit.js';
> import GthFileSystemToolkit from '@gaunt-sloth/agent/tools/GthFileSystemToolkit.js';
> ```
>
> Some APIs were reorganised in v2 (e.g. `builtInToolsConfig` → `AVAILABLE_BUILT_IN_TOOLS` /
> `getDefaultTools`) — see <https://gauntsloth.app/docs/>.
> Site & docs: <https://gauntsloth.app> · Source: <https://github.com/pukeko-robotics/gaunt-sloth>

Tools and middleware for Gaunt Sloth.

## Contents

- Built-in tools configuration (`builtInToolsConfig`)
- Filesystem toolkit (`GthFileSystemToolkit`) — provides read/write/glob/grep tools controlled by `.aiignore`
- Custom tools (`GthCustomToolkit`) — executes user-defined shell commands from config
- Dev tools (`GthDevToolkit`) — tools for development and coding sessions
- Status update tool
- Web fetch tool
- Binary content injection middleware
- Middleware registry (`resolveMiddleware`) and types

## Dependencies

- `@gaunt-sloth/core`

## Exports

```js
import { builtInToolsConfig } from '@gaunt-sloth/tools/builtInToolsConfig.js';
import { resolveMiddleware } from '@gaunt-sloth/tools/middleware/registry.js';
```

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure
- [`@gaunt-sloth/tools`](../tools) — Built-in tools, filesystem toolkit, and middleware registry (this package)
- [`@gaunt-sloth/api`](../api) — API server, AG-UI, MCP, and A2A integration
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth-assistant`](../assistant) — Main CLI application
