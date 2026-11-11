// Trim an OpenAPI document to the routes this package uses, then write
// openapi.snapshot.json. Usage: node scripts/trim-openapi.mjs <full-openapi.json>
import { readFileSync, writeFileSync } from 'node:fs';

const KEEP = [
  '/health',
  '/auth/',
  '/api/v1/appliances',
  '/api/v1/calibration',
  '/api/v1/feedback',
  '/api/v1/integration',
  '/api/v1/preferences',
  '/api/v1/rates',
  '/api/v1/readings',
  '/api/v1/schedule',
  '/api/v1/weather',
];

const doc = JSON.parse(readFileSync(process.argv[2] ?? 'openapi.snapshot.json', 'utf8'));

doc.paths = Object.fromEntries(
  Object.entries(doc.paths).filter(([p]) => KEEP.some((k) => p === k || p.startsWith(k))),
);

// Keep summaries, drop long-form descriptions: the types are what the
// contract check needs.
const strip = (node) => {
  if (Array.isArray(node)) return node.forEach(strip);
  if (node && typeof node === 'object') {
    if (typeof node.description === 'string' && !('schema' in node) && !('content' in node)) {
      delete node.description;
    }
    Object.values(node).forEach(strip);
  }
};
strip(doc.paths);
strip(doc.components?.schemas ?? {});

// Drop component schemas nothing references any more.
const schemas = doc.components?.schemas ?? {};
const refs = (node, out) => {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.add(v.split('/').pop());
      else refs(v, out);
    }
  }
  return out;
};
const used = refs(doc.paths, new Set());
for (const queue = [...used]; queue.length; ) {
  const name = queue.pop();
  for (const r of refs(schemas[name], new Set())) {
    if (!used.has(r)) {
      used.add(r);
      queue.push(r);
    }
  }
}
for (const name of Object.keys(schemas)) if (!used.has(name)) delete schemas[name];

writeFileSync('openapi.snapshot.json', JSON.stringify(doc, null, 2) + '\n');
console.log(`${Object.keys(doc.paths).length} paths, ${Object.keys(schemas).length} schemas`);
