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

async function notionGet({ token, url }) {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': notionVersion,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${JSON.stringify(json).slice(0, 1200)}`);
  return json;
}

async function main() {
  loadEnv();
  const token = process.env.NOTION_TOKEN;
  const pageId = process.env.NOTION_PAGE_ID;
  if (!token) throw new Error('Missing NOTION_TOKEN');
  if (!pageId) throw new Error('Missing NOTION_PAGE_ID');

  const children = await notionGet({ token, url: `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` });
  const db = children.results.find(b => b.type === 'child_database');
  if (!db) throw new Error('No child_database found under page');

  const dbId = db.id;
  const dbObj = await notionGet({ token, url: `https://api.notion.com/v1/databases/${dbId}` });

  console.log(`Database id: ${dbId}`);
  console.log(`Database title: ${dbObj.title?.map(t=>t.plain_text).join('')}`);

  const props = dbObj.properties || {};
  console.log('Properties:');
  for (const [name, def] of Object.entries(props)) {
    console.log(`- ${name}: ${def.type}`);
  }

  const titleProp = Object.entries(props).find(([,def]) => def.type === 'title')?.[0];
  console.log(`Title property: ${titleProp}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
