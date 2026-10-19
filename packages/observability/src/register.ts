import { register } from 'node:module';

// ESM loader hook so instrumentations can patch modules imported with `import`.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
