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

function dubaiTodayISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function ddmmyyyyFromISO(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function stripAnnoyingLines(text) {
  return text
    .split(/\r?\n/)
    .filter(line => !/NO RESERVATION, NO CLASS\./i.test(line))
    .filter(line => !/MORE THAN\s+5\s+MIN/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseWodPage(markdown, targetDDMMYYYY) {
  const lines = markdown.split(/\r?\n/);
  const entries = [];

  let i = 0;
  while (i < lines.length) {
    const dateLine = lines[i]?.trim();
    const mDate = dateLine?.match(/^####\s+(\d{2}\/\d{2}\/\d{4})\s*$/);
    if (!mDate) {
      i++;
      continue;
    }

    const date = mDate[1];
    const locLine = (lines[i + 2] ?? lines[i + 1] ?? '').trim();
    const progLine = (lines[i + 3] ?? lines[i + 2] ?? '').trim();

    const loc = locLine.replace(/^####\s+/, '').trim();
    const program = progLine.replace(/^####\s+/, '').trim();

    i += 4;
    const body = [];
    while (i < lines.length) {
      const maybeNextDate = lines[i]?.trim();
      if (/^####\s+\d{2}\/\d{2}\/\d{4}\s*$/.test(maybeNextDate)) break;
      body.push(lines[i]);
      i++;
    }

    if (date === targetDDMMYYYY) {
      entries.push({
        date,
        loc,
        program,
        body: stripAnnoyingLines(body.join('\n')),
      });
    }
  }

  return entries;
}

function notionRichText(content) {
  const s = (content ?? '').toString();
  if (!s.trim()) return [];
  // Notion limit ~2000 chars per rich_text item; chunk conservatively.
  const chunks = [];
  const max = 1800;
  for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
  return chunks.map(c => ({ type: 'text', text: { content: c } }));
}

async function notionReq({ token, method, url, body }) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': notionVersion,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${JSON.stringify(json).slice(0, 1200)}`);
  return json;
}

async function getChildDatabaseId({ token, pageId }) {
  const data = await notionReq({ token, method: 'GET', url: `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` });
  const db = data.results?.find(b => b.type === 'child_database');
  if (!db) throw new Error('No child_database found under target page.');
  return db.id;
}

async function queryExistingForDate({ token, databaseId, isoDate }) {
  const res = await notionReq({
    token,
    method: 'POST',
    url: `https://api.notion.com/v1/databases/${databaseId}/query`,
    body: {
      page_size: 100,
      filter: {
        property: 'Date',
        date: { equals: isoDate },
      },
    },
  });

  const existing = new Set();
  for (const p of res.results ?? []) {
    const props = p.properties || {};
    const loc = props.Location?.rich_text?.map(x => x.plain_text).join('') ?? '';
    const type = props.Type?.select?.name ?? '';
    const key = `${loc}__${type}`;
    existing.add(key);
  }
  return existing;
}

async function createWodRow({ token, databaseId, isoDate, entry }) {
  const name = `${isoDate} — ${entry.loc} — ${entry.program}`.slice(0, 180);

  return notionReq({
    token,
    method: 'POST',
    url: 'https://api.notion.com/v1/pages',
    body: {
      parent: { database_id: databaseId },
      properties: {
        Name: { title: notionRichText(name) },
        Date: { date: { start: isoDate } },
        Location: { rich_text: notionRichText(entry.loc) },
        Type: { select: { name: entry.program || 'WOD' } },
        Source: { url: 'https://vfuae.com/wod/' },
        WOD: { rich_text: notionRichText(entry.body) },
      },
    },
  });
}

async function main() {
  loadEnv();
  const token = process.env.NOTION_TOKEN;
  const pageId = process.env.NOTION_PAGE_ID;
  if (!token) throw new Error('Missing NOTION_TOKEN in environment/.env');
  if (!pageId) throw new Error('Missing NOTION_PAGE_ID in environment/.env');

  const isoDate = dubaiTodayISO();
  const ddmmyyyy = ddmmyyyyFromISO(isoDate);

  const sourceMd = process.env.WOD_MARKDOWN;
  if (!sourceMd) throw new Error('Missing WOD_MARKDOWN (expected vfuae.com/wod/ markdown).');

  const entries = parseWodPage(sourceMd, ddmmyyyy);
  if (!entries.length) throw new Error(`No entries found for ${ddmmyyyy}.`);

  const databaseId = await getChildDatabaseId({ token, pageId });
  const existingKeys = await queryExistingForDate({ token, databaseId, isoDate });

  let created = 0;
  let skipped = 0;

  for (const e of entries) {
    const key = `${e.loc}__${e.program}`;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    await createWodRow({ token, databaseId, isoDate, entry: e });
    created++;
  }

  process.stdout.write(`Notion DB updated (${isoDate}): created=${created} skipped=${skipped} (total entries today=${entries.length}).\n`);
}

main().catch(err => {
  process.stderr.write(err?.stack || String(err));
  process.stderr.write('\n');
  process.exit(1);
});
