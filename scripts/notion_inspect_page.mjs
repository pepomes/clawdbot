#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const notionVersion = '2022-06-28';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2] ?? '';
      val = val.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

function blockPlainText(block) {
  const t = block.type;
  const obj = block[t];
  const rt = obj?.rich_text;
  if (!Array.isArray(rt)) return '';
  return rt.map(r => r.plain_text ?? '').join('');
}

async function listChildren({ token, blockId, cursor }) {
  const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
  url.searchParams.set('page_size', '100');
  if (cursor) url.searchParams.set('start_cursor', cursor);

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': notionVersion,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
  return json;
}

async function main() {
  loadEnv();
  const token = process.env.NOTION_TOKEN;
  const pageId = process.env.NOTION_PAGE_ID;
  if (!token) throw new Error('Missing NOTION_TOKEN');
  if (!pageId) throw new Error('Missing NOTION_PAGE_ID');

  let cursor;
  let n = 0;
  const types = new Map();
  const sample = [];

  while (true) {
    const { results, has_more, next_cursor } = await listChildren({ token, blockId: pageId, cursor });
    for (const b of results) {
      n++;
      types.set(b.type, (types.get(b.type) ?? 0) + 1);
      if (sample.length < 40) {
        sample.push({
          id: b.id,
          type: b.type,
          text: blockPlainText(b).slice(0, 120),
        });
      }
    }
    if (!has_more) break;
    cursor = next_cursor;
  }

  console.log(`Total child blocks: ${n}`);
  console.log('Types:');
  for (const [k, v] of [...types.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`- ${k}: ${v}`);
  }

  console.log('\nFirst blocks sample:');
  for (const s of sample) {
    console.log(`- ${s.type} (${s.id}): ${JSON.stringify(s.text)}`);
  }

  // Heuristic: detect date heading pattern among samples
  const dateRe = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/;
  const dateBlock = sample.find(s => (s.type.startsWith('heading_') || s.type === 'paragraph') && dateRe.test(s.text));
  if (dateBlock) {
    console.log(`\nDetected date-like block type=${dateBlock.type} text=${JSON.stringify(dateBlock.text)}`);
  } else {
    console.log('\nNo date-like heading found in first 40 blocks.');
  }
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
