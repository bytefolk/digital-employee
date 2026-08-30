# @fullstack-ai-infra/digital-employee-core

Dependency-free package, Agent Host, and compatibility primitives for
[Digital Employee](https://github.com/fullstack-ai-infra/digital-employee).

```bash
npm install @fullstack-ai-infra/digital-employee-core
```

```js
import * as digitalEmployeeCore from "@fullstack-ai-infra/digital-employee-core";
```

This package exposes the framework's public core API without the CLI or
runtime dependencies. It requires Node.js 20 or later and is distributed
under the Apache License 2.0. See `LICENSE` and `NOTICE`.

The public API includes the strict `MemoryPort` and the revision-pinned mem
HTTP adapter. The current public `0.6.0` engine preview can consume a
caller-supplied port through explicit `EngineMemoryOptions` /
`TurnExecutorOptions.memory`; recall runs only when `enabled` is exactly
`true` and remains disabled by default. See the
[MemoryPort integration boundary](https://github.com/fullstack-ai-infra/digital-employee/blob/main/docs/memory-port.md)
before provisioning a position-scoped credential. The adapter contains no
grant or admin path, and this opt-in seam is not a complete durable-memory
product loop.
