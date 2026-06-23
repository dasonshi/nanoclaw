#!/usr/bin/env node
/**
 * Standalone daily feed refresh for cron.
 * Reads FEEDS from index.js source, fetches RSS, inserts into SQLite.
 * No MCP dependency — talks directly to the DB.
 */
import Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AI_NEWS_DB_PATH || join(__dirname, "db/ai-news.db");

// Extract FEEDS from index.js source to stay in sync
const src = readFileSync(join(__dirname, "index.js"), "utf-8");
const feedsMatch = src.match(/const FEEDS = \[([\s\S]*?)\];/);
if (!feedsMatch) { console.error("Could not parse FEEDS from index.js"); process.exit(1); }
const FEEDS = eval(`[${feedsMatch[1]}]`);

// DB setup
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL, source_label TEXT NOT NULL,
    published_at TEXT, fetched_at TEXT NOT NULL,
    summary TEXT, content_snippet TEXT, tags TEXT, category TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title, summary, tags, content='articles', content_rowid='id'
  );
`);

const insertArticle = db.prepare(`
  INSERT OR IGNORE INTO articles
    (title, url, source, source_label, published_at, fetched_at, summary, content_snippet, tags, category)
  VALUES (@title, @url, @source, @source_label, @published_at, @fetched_at, @summary, @content_snippet, @tags, @category)
`);
const insertMany = db.transaction((articles) => {
  let n = 0;
  for (const a of articles) { if (insertArticle.run(a).changes > 0) n++; }
  return n;
});

// Minimal helpers
const STOP_WORDS = new Set(["the","and","for","are","but","not","you","all","can","was","one","our","out","get","has","how","its","new","now","see","two","way","who","did","let","put","say","she","too","use","with","that","this","have","from","they","will","been","said","each","which","their","time","what","about","into","than","more","very","just","also","over","such","your","when","make","like","some","could","them","then","these","would","there","other","after","first","well","were","many","most","only"]);
function extractTags(text) {
  if (!text) return "";
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g," ").split(/\s+/).filter(w=>w.length>=3&&!STOP_WORDS.has(w)))].slice(0,15).join(",");
}
function stripHtml(h) {
  if (!h) return "";
  return h.replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
}
function normalizeUrl(u) {
  if (!u) return null;
  try { const x = new URL(u.trim()); ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].forEach(p=>x.searchParams.delete(p)); x.pathname=x.pathname.replace(/\/$/,"")||"/"; return x.toString(); } catch { return u.trim().replace(/\/$/,""); }
}
function parsePubDate(d) { if (!d) return null; try { const x=new Date(d); return isNaN(x.getTime())?null:x.toISOString(); } catch { return null; } }

const xmlParser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"@_", cdataPropName:"__cdata", parseTagValue:true, trimValues:true, processEntities:false });
function extractText(v) { if(!v)return""; if(typeof v==="string")return v; if(typeof v==="number")return String(v); if(v.__cdata)return v.__cdata; if(v["#text"])return v["#text"]; return String(v); }

function extractItems(parsed) {
  const items = [];
  const ch = parsed?.rss?.channel;
  if (ch) {
    const arr = Array.isArray(ch.item)?ch.item:ch.item?[ch.item]:[];
    for (const i of arr) items.push({ title:extractText(i.title), link:extractText(i.link)||extractText(i.guid), pubDate:extractText(i.pubDate), summary:extractText(i.description), content:extractText(i["content:encoded"]) });
    return items;
  }
  const f = parsed?.feed;
  if (f) {
    const arr = Array.isArray(f.entry)?f.entry:f.entry?[f.entry]:[];
    for (const e of arr) {
      let link="";
      if(e.link){if(typeof e.link==="string")link=e.link;else if(Array.isArray(e.link)){const a=e.link.find(l=>l["@_rel"]==="alternate"||!l["@_rel"]);link=a?.["@_href"]||e.link[0]?.["@_href"]||"";}else link=e.link["@_href"]||"";}
      items.push({ title:extractText(e.title), link, pubDate:extractText(e.published)||extractText(e.updated), summary:extractText(e.summary||e["media:description"]||""), content:extractText(e.content||e["content:encoded"]||"") });
    }
  }
  return items;
}

// Main
let totalNew = 0;
for (const feed of FEEDS) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { "User-Agent": "AI-News-MCP/2.0", Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" } });
    clearTimeout(timer);
    if (!res.ok) { console.error(`[${feed.source}] HTTP ${res.status}`); continue; }
    const xml = await res.text();
    if (!xml.trim()) continue;
    const rawItems = extractItems(xmlParser.parse(xml));
    const articles = [];
    for (const item of rawItems) {
      const url = normalizeUrl(item.link);
      if (!url) continue;
      const title = stripHtml(item.title) || "(no title)";
      const summary = stripHtml(item.summary || item.content || "").slice(0, 500);
      articles.push({ title, url, source: feed.source, source_label: feed.label, published_at: parsePubDate(item.pubDate), fetched_at: new Date().toISOString(), summary, content_snippet: stripHtml(item.content || item.summary || "").slice(0, 500), tags: extractTags(title + " " + summary), category: feed.category });
    }
    const n = insertMany(articles);
    totalNew += n;
    if (n > 0) console.log(`${feed.label}: +${n} new`);
  } catch (err) {
    console.error(`[${feed.source}] ${err.message}`);
  }
}

console.log(`Done. ${totalNew} new article(s) total.`);
db.close();
