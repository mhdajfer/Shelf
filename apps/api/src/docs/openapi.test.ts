import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi.js';

const document = buildOpenApiDocument('http://localhost:4000');
const documented = new Set(
  Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item ?? {}).map((method) => `${method.toUpperCase()} ${path}`),
  ),
);

/** Every `router.<method>('<path>'` in the routes directory, as "METHOD /path". */
function implemented(): string[] {
  const directory = fileURLToPath(new URL('../routes', import.meta.url));
  const routes: string[] = [];

  for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(directory, file), 'utf8');
    // The auth router is mounted under /auth; every other router at the root.
    const prefix = file === 'auth.ts' ? '/auth' : '';
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const path = `${prefix}${match[2] ?? ''}`.replace(/:(\w+)/g, '{$1}');
      routes.push(`${(match[1] ?? '').toUpperCase()} ${path}`);
    }
  }
  return routes;
}

describe('the OpenAPI document', () => {
  it('builds from the shared request schemas', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(documented.size).toBeGreaterThan(50);
  });

  it('describes every route the API implements', () => {
    const routes = implemented();
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((route) => !documented.has(route))).toEqual([]);
  });

  it('describes no route that does not exist', () => {
    const routes = new Set(implemented());
    expect([...documented].filter((route) => !routes.has(route))).toEqual([]);
  });

  it('takes the create-prompt body from the schema the route validates with', () => {
    const operation = document.paths?.['/prompts']?.post;
    const schema = operation?.requestBody as
      { content: { 'application/json': { schema: { required?: string[] } } } } | undefined;
    expect(schema?.content['application/json'].schema.required).toEqual(
      expect.arrayContaining(['title', 'category', 'body']),
    );
  });
});
