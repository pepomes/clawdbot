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
  // Format date in Asia/Dubai without pulling in heavy deps.
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
  // The site renders repeating blocks like:
  // #### 30/01/2026
  // #### Vogue Fitness | JLT
  // #### CrossFit
  // <workout>
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

    // Capture body until next #### <date>
    i += 4;
    const body = [];
    while (i < lines.length) {
      const maybeNextDate = lines[i]?.trim();
      if (/^####\s+\d{2}\/\d{2}\/\d{4}\s*$/.test(maybeNextDate)) break;
      body.push(lines[i]);
      i++;
    }

    if (date === targetDDMMYYYY) {
      entries.push({ date, loc, program, body: stripAnnoyingLines(body.join('\n')) });
    }
  }

  return entries;
}

function buildMarkdown(isoDate, entries) {
  const byLoc = new Map();
  for (const e of entries) {
    const key = e.loc || 'Unknown location';
    if (!byLoc.has(key)) byLoc.set(key, []);
    byLoc.get(key).push(e);
  }

  let out = `## ${isoDate}\n\n`;
  for (const [loc, items] of byLoc) {
    out += `### ${loc}\n\n`;
    for (const it of items) {
      out += `#### ${it.program || 'WOD'}\n\n`;
      out += `${it.body}\n\n`;
    }
  }
  return out.trim() + '\n';
}

function mdToNotionBlocks(md) {
  // Minimal conversion: headings + paragraphs.
  const blocks = [];
  const lines = md.split(/\r?\n/);
  let paragraph = [];

  function flushParagraph() {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
    });
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);
    const h4 = line.match(/^####\s+(.+)$/);

    if (h2 || h3 || h4) {
      flushParagraph();
      const content = (h2 || h3 || h4)[1].trim();
      const type = h2 ? 'heading_2' : h3 ? 'heading_3' : 'heading_4';
      blocks.push({
        object: 'block',
        type,
        [type]: { rich_text: [{ type: 'text', text: { content } }] },
      });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

async function notionAppendBlocks({ token, pageId, blocks }) {
  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children: blocks }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Notion API error ${res.status}: ${txt.slice(0, 500)}`);
  }

  return res.json();
}

async function fetchWodMarkdown() {
  const res = await fetch('https://vfuae.com/wod/', {
    headers: { 'User-Agent': 'clawdbot/1.0 (+https://github.com/pepomes/clawdbot)' },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  // Cheap extraction: fall back to readability-like approach isn’t available here.
  // We rely on OpenClaw's web_fetch in interactive runs normally, but for cron we need standalone.
  // So: request the page and strip tags very roughly.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h4>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '');

  // The html-stripped output won't have the #### markers.
  // So we can’t reliably parse it like this. This script is primarily used when run by the agent
  // (which will use web_fetch). If you run it standalone, it'll just push a raw dump.
  return text;
}

async function main() {
  loadEnv();

  throw new Error('This script is deprecated. Use scripts/daily_wod_to_notion_db.mjs (the Notion page contains a database).');
}

main().catch((err) => {
  process.stderr.write((err && err.stack) ? err.stack + '\n' : String(err) + '\n');
  process.exit(1);
});
