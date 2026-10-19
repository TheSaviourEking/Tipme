import { defineConfig } from 'drizzle-kit';

// Generation only reads the schema; it never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
