import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const GENERATED_PATH = resolve(__dirname, '..', 'src', 'api', 'generated.ts');

describe('openapi-typescript codegen snapshot', () => {
  it('src/api/generated.ts exists on disk', () => {
    expect(existsSync(GENERATED_PATH)).toBe(true);
  });

  it('contains type definitions for all known endpoint paths', () => {
    const source = readFileSync(GENERATED_PATH, 'utf8');
    const requiredPaths = [
      '/auth/login',
      '/auth/me',
      '/api/v1/preferences',
      '/api/v1/schedules',
      '/api/v1/rates',
      '/api/v1/appliances',
    ];
    for (const p of requiredPaths) {
      expect(source.includes(`"${p}"`)).toBe(true);
    }
  });
});
