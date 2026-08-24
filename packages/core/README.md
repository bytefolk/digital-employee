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

The public API includes the strict, engine-detached `MemoryPort` and the
revision-pinned mem HTTP adapter. See the
[MemoryPort integration boundary](https://github.com/fullstack-ai-infra/digital-employee/blob/main/docs/memory-port.md)
before provisioning a position-scoped credential; the adapter contains no
grant or admin path and is not enabled by constructing the execution engine.
