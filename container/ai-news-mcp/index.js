import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AI_NEWS_DB_PATH || join(__dirname, "ai-news.db");

// ---------------------------------------------------------------------------
// Feed definitions — focused on AI enablement, use cases, and adoption
// ---------------------------------------------------------------------------

const FEEDS = [
  // ── AI Enablement & Use Cases (PRIMARY) ─────────────────────────
  { url: "https://www.oneusefulthing.org/feed", source: "oneusefulthing", label: "One Useful Thing (Ethan Mollick)", category: "enablement" },
  { url: "https://www.lennysnewsletter.com/feed", source: "lennys", label: "Lenny's Newsletter", category: "enablement" },
  { url: "https://www.latent.space/feed", source: "latentspace", label: "Latent Space", category: "enablement" },
  { url: "https://every.to/chain-of-thought/feed", source: "every-cot", label: "Every (Chain of Thought)", category: "enablement" },
  { url: "https://every.to/napkin-math/feed", source: "every-napkin", label: "Every (Napkin Math)", category: "enablement" },
  { url: "https://www.superhuman.ai/feed", source: "superhuman-ai", label: "The Rundown AI", category: "enablement" },

  // ── SMB / Solopreneur AI ──────────────────────────────────────
  { url: "https://zapier.com/blog/feeds/latest/", source: "zapier", label: "Zapier Blog", category: "smb" },
  { url: "https://kylepoyar.substack.com/feed", source: "growthunhinged", label: "Growth Unhinged", category: "smb" },

  // ── Enterprise AI / Adoption ──────────────────────────────────
  { url: "https://blogs.microsoft.com/ai/feed/", source: "microsoft-ai", label: "Microsoft AI Blog", category: "enterprise" },
  { url: "https://venturebeat.com/category/ai/feed/", source: "venturebeat", label: "VentureBeat AI", category: "enterprise" },
  { url: "http://feeds.harvardbusiness.org/harvardbusiness?format=xml", source: "hbr", label: "Harvard Business Review", category: "enterprise" },
  { url: "https://www.salesforce.com/blog/feed/", source: "salesforce", label: "Salesforce Blog", category: "enterprise" },
  { url: "https://workspace.google.com/blog/feed/", source: "google-workspace", label: "Google Workspace Blog", category: "enterprise" },

  // ── Anthropic / Claude (David's stack) ────────────────────────
  { url: "https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml", source: "anthropic-blog", label: "Anthropic Blog", category: "product" },
  { url: "https://simonwillison.net/atom/entries/", source: "simonwillison", label: "Simon Willison", category: "coding" },

  // ── MCP Ecosystem ─────────────────────────────────────────────
  { url: "https://github.com/modelcontextprotocol/servers/releases.atom", source: "mcp-servers", label: "MCP Servers Releases", category: "coding" },
  { url: "https://github.com/modelcontextprotocol/specification/releases.atom", source: "mcp-spec", label: "MCP Spec Releases", category: "coding" },

  // ── General AI / Tech News (broad coverage) ────────────────────
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", source: "techcrunch", label: "TechCrunch AI", category: "product" },
  { url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", source: "verge", label: "The Verge AI", category: "product" },
  { url: "https://arstechnica.com/ai/feed/", source: "arstechnica", label: "Ars Technica AI", category: "product" },
  { url: "https://www.cnbc.com/id/100727362/device/rss/rss.html", source: "cnbc-tech", label: "CNBC Technology", category: "enterprise" },
  { url: "https://fortune.com/feed/fortune-feeds/?id=3230629", source: "fortune", label: "Fortune", category: "enterprise" },
  { url: "https://gizmodo.com/feed", source: "gizmodo", label: "Gizmodo", category: "product" },
  { url: "https://www.wired.com/feed/tag/ai/latest/rss", source: "wired", label: "Wired AI", category: "product" },
  { url: "https://www.technologyreview.com/feed/", source: "mit-tech-review", label: "MIT Tech Review", category: "research" },
  { url: "https://the-decoder.com/feed/", source: "decoder", label: "The Decoder", category: "product" },

  // ── Competitor Intel ──────────────────────────────────────────
  { url: "https://openai.com/blog/rss.xml", source: "openai", label: "OpenAI Blog", category: "product" },
  { url: "https://deepmind.google/blog/rss.xml", source: "deepmind", label: "Google DeepMind", category: "research" },

  // ── Opinion / Analysis ────────────────────────────────────────
  { url: "https://www.a16z.news/feed", source: "a16z", label: "Andreessen Horowitz", category: "opinion" },
  { url: "https://www.aisnakeoil.com/feed", source: "aisnakeoil", label: "AI Snake Oil", category: "opinion" },

  // ── Developer / Coding ────────────────────────────────────────
  { url: "https://github.blog/feed/", source: "github", label: "GitHub Blog", category: "coding" },

  // ── Practitioner Use Cases ("I built this with AI") ───────────
  { url: "https://hnrss.org/show?q=AI+OR+LLM+OR+Claude+OR+GPT&points=30", source: "hn-show", label: "Show HN (AI/LLM)", category: "use-case" },
  { url: "https://hnrss.org/frontpage?q=AI+OR+LLM+OR+Claude+OR+GPT&points=100", source: "hn-front", label: "Hacker News AI (100+ pts)", category: "use-case" },
  { url: "https://www.reddit.com/r/ClaudeAI/top/.rss?t=week", source: "r-claudeai", label: "r/ClaudeAI", category: "use-case" },
  { url: "https://www.reddit.com/r/ChatGPTCoding/top/.rss?t=week", source: "r-chatgptcoding", label: "r/ChatGPTCoding", category: "use-case" },
  { url: "https://www.reddit.com/r/LocalLLaMA/top/.rss?t=week", source: "r-localllama", label: "r/LocalLLaMA", category: "use-case" },
  { url: "https://www.reddit.com/r/aicoding/top/.rss?t=week", source: "r-aicoding", label: "r/aicoding", category: "use-case" },
  { url: "https://www.reddit.com/r/cursor/top/.rss?t=week", source: "r-cursor", label: "r/cursor", category: "use-case" },
  { url: "https://dev.to/feed/tag/ai", source: "devto-ai", label: "Dev.to AI", category: "use-case" },
  { url: "https://dev.to/feed/tag/llm", source: "devto-llm", label: "Dev.to LLM", category: "use-case" },
  { url: "https://lobste.rs/t/ai.rss", source: "lobsters", label: "Lobsters AI", category: "use-case" },
  { url: "https://www.bensbites.com/feed", source: "bensbites", label: "Ben's Bites", category: "use-case" },
  { url: "https://huggingface.co/blog/feed.xml", source: "huggingface", label: "Hugging Face Blog", category: "use-case" },
  { url: "https://towardsdatascience.com/feed", source: "tds", label: "Towards Data Science", category: "use-case" },

  // ── AI Practitioner Newsletters ───────────────────────────────
  { url: "https://magazine.sebastianraschka.com/feed", source: "ahead-of-ai", label: "Ahead of AI (Raschka)", category: "research" },
  { url: "https://www.interconnects.ai/feed", source: "interconnects", label: "Interconnects (Nathan Lambert)", category: "research" },
  { url: "https://lastweekin.ai/feed", source: "lastweekinai", label: "Last Week in AI", category: "product" },
  { url: "https://newsletter.pragmaticengineer.com/feed", source: "pragmatic-eng", label: "The Pragmatic Engineer", category: "coding" },

  // ── Cloud Provider AI (enterprise depth) ──────────────────────
  { url: "https://aws.amazon.com/blogs/machine-learning/feed/", source: "aws-ml", label: "AWS Machine Learning Blog", category: "enterprise" },
  { url: "https://cloud.google.com/blog/products/ai-machine-learning/rss", source: "gcloud-ai", label: "Google Cloud AI Blog", category: "enterprise" },

  // ── AI in Specific Industries ─────────────────────────────────
  { url: "https://www.reddit.com/r/artificial/top/.rss?t=week", source: "r-artificial", label: "r/artificial", category: "enablement" },
  { url: "https://www.reddit.com/r/singularity/top/.rss?t=week", source: "r-singularity", label: "r/singularity", category: "opinion" },

  // ── AI Deployment Case Studies ("Company X deployed AI") ──────
  // These feeds are primarily case studies — default to deployment category
  { url: "https://news.microsoft.com/source/topics/ai/feed/", source: "ms-source-ai", label: "Microsoft Source (AI)", category: "deployment" },
  { url: "https://aibusiness.com/rss.xml", source: "aibusiness", label: "AI Business", category: "enterprise" },
  { url: "https://emerj.com/feed/", source: "emerj", label: "Emerj (AI Case Studies)", category: "deployment" },
  { url: "https://www.databricks.com/blog/feed.xml", source: "databricks", label: "Databricks Blog", category: "deployment" },
  { url: "https://medium.com/feed/palantir", source: "palantir", label: "Palantir Blog", category: "deployment" },
  { url: "https://feed.infoq.com/ai-ml-data-eng/", source: "infoq-ai", label: "InfoQ AI/ML", category: "use-case" },
  { url: "https://importai.substack.com/feed", source: "importai", label: "Import AI", category: "product" },

  // ── Business Press AI (general — autoCategory promotes to deployment when relevant)
  { url: "https://www.forbes.com/innovation/ai/feed/", source: "forbes-ai", label: "Forbes AI", category: "enterprise" },
  { url: "https://www.fastcompany.com/section/artificial-intelligence/rss", source: "fastcompany-ai", label: "Fast Company AI", category: "enterprise" },
  { url: "https://www.zdnet.com/topic/artificial-intelligence/rss.xml", source: "zdnet-ai", label: "ZDNet AI", category: "enterprise" },
  { url: "https://blog.google/technology/ai/rss/", source: "google-ai", label: "Google AI Blog", category: "product" },

  // ── Engineering Blogs (real AI in production) ─────────────────
  { url: "https://medium.com/feed/airbnb-engineering", source: "airbnb-eng", label: "Airbnb Engineering", category: "use-case" },

  // ── Startup / VC AI launches ──────────────────────────────────
  { url: "https://www.ycombinator.com/blog/rss", source: "yc-blog", label: "Y Combinator Blog", category: "product" },
  { url: "https://www.sequoiacap.com/feed/", source: "sequoia", label: "Sequoia Capital", category: "opinion" },
];

// ---------------------------------------------------------------------------
// Category ENUM values
// ---------------------------------------------------------------------------

const CATEGORY_VALUES = ["deployment", "use-case", "enablement", "smb", "enterprise", "product", "research", "coding", "opinion", "policy", "fundraising"];

// ---------------------------------------------------------------------------
// SQLite setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL UNIQUE,
    source        TEXT NOT NULL,
    source_label  TEXT NOT NULL,
    published_at  TEXT,
    fetched_at    TEXT NOT NULL,
    summary       TEXT,
    content_snippet TEXT,
    tags          TEXT,
    category      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
  CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
  CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title,
    summary,
    tags,
    content='articles',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, summary, tags)
    VALUES (new.id, new.title, new.summary, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, summary, tags)
    VALUES ('delete', old.id, old.title, old.summary, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, summary, tags)
    VALUES ('delete', old.id, old.title, old.summary, old.tags);
    INSERT INTO articles_fts(rowid, title, summary, tags)
    VALUES (new.id, new.title, new.summary, new.tags);
  END;
`);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "new",
  "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put",
  "say", "she", "too", "use", "with", "that", "this", "have", "from", "they",
  "will", "been", "said", "each", "which", "their", "time", "what", "about",
  "into", "than", "more", "very", "just", "also", "over", "such", "your",
  "when", "make", "like", "some", "could", "them", "then", "these", "would",
  "there", "other", "after", "first", "well", "were", "many", "most", "only",
]);

function extractTags(text) {
  if (!text) return "";
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const unique = [...new Set(words)].slice(0, 15);
  return unique.join(",");
}

function autoCategory(title, summary, feedCategory) {
  const text = ((title || "") + " " + (summary || "")).toLowerCase();

  // Deployment / case study signals (check first — highest priority)
  if (/\b(case study|deploy|deployed|rolled out|rolling out|implementation|in production|went live|customer stor|how .+ uses? ai|how .+ built|powered by ai|ai.powered)\b/.test(text)) return "deployment";

  // Enablement / use-case signals
  if (/\b(use case|workflow|automat|implement|adopt|roi|transform|productiv|efficien|streamlin|onboard|integrat)\b/.test(text)) return "enablement";
  if (/\b(small business|smb|solopreneur|freelanc|solo founder|one.person|independent|side hustle|bootstrap)\b/.test(text)) return "smb";

  if (/\b(research|paper|study|findings|arxiv|benchmark|eval)\b/.test(text)) return "research";
  if (/\b(regulation|policy|law|congress|government|senator|legislation)\b/.test(text)) return "policy";
  if (/\b(funding|raise|raised|valuation|acquire|acquisition|seed|series [a-e])\b/.test(text)) return "fundraising";
  if (/\b(enterprise|workforce|b2b|fortune 500|corporate)\b/.test(text)) return "enterprise";
  if (/\b(code|coding|developer|engineer|vibe coding|agent|github|cursor|ide)\b/.test(text)) return "coding";
  if (/\b(launch|release|announce|announced|update|ship|shipped|introducing|new model)\b/.test(text)) return "product";

  return feedCategory || "product";
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl.trim());
    const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return rawUrl.trim().replace(/\/$/, "");
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePubDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function cutoffDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// RSS parsing
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  parseTagValue: true,
  trimValues: true,
  processEntities: false,
});

function extractItemsFromParsed(parsed) {
  const items = [];

  try {
    // RSS 2.0
    const channel = parsed?.rss?.channel;
    if (channel) {
      const rawItems = channel.item;
      if (!rawItems) return items;
      const arr = Array.isArray(rawItems) ? rawItems : [rawItems];
      for (const item of arr) {
        items.push({
          title: extractText(item.title),
          link: extractText(item.link) || extractText(item.guid),
          pubDate: extractText(item.pubDate),
          summary: extractText(item.description),
          content: extractText(item["content:encoded"]),
        });
      }
      return items;
    }

    // Atom
    const feed = parsed?.feed;
    if (feed) {
      const rawEntries = feed.entry;
      if (!rawEntries) return items;
      const arr = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
      for (const entry of arr) {
        let link = "";
        if (entry.link) {
          if (typeof entry.link === "string") link = entry.link;
          else if (Array.isArray(entry.link)) {
            const alt = entry.link.find((l) => l["@_rel"] === "alternate" || !l["@_rel"]);
            link = alt?.["@_href"] || entry.link[0]?.["@_href"] || "";
          } else {
            link = entry.link["@_href"] || extractText(entry.link) || "";
          }
        }
        const summaryRaw = entry.summary || entry["media:description"] || "";
        const contentRaw = entry.content || entry["content:encoded"] || "";
        items.push({
          title: extractText(entry.title),
          link,
          pubDate: extractText(entry.published) || extractText(entry.updated),
          summary: extractText(summaryRaw),
          content: extractText(contentRaw),
        });
      }
      return items;
    }
  } catch (err) {
    console.error("[RSS] Error extracting items:", err.message);
  }

  return items;
}

function extractText(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (val.__cdata) return val.__cdata;
  if (val["#text"]) return val["#text"];
  if (val["@_type"] && val["#text"]) return val["#text"];
  if (typeof val === "object") {
    const keys = Object.keys(val);
    if (keys.includes("#text")) return val["#text"];
    if (keys.includes("__cdata")) return val.__cdata;
  }
  return String(val);
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AI-News-MCP/1.0; +https://savvysales.ai)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.error(`[RSS] ${feed.source}: HTTP ${response.status} for ${feed.url}`);
      return [];
    }

    const xml = await response.text();
    if (!xml || xml.trim().length === 0) {
      console.error(`[RSS] ${feed.source}: Empty response`);
      return [];
    }

    const parsed = xmlParser.parse(xml);
    const rawItems = extractItemsFromParsed(parsed);

    const articles = [];
    for (const item of rawItems) {
      const url = normalizeUrl(item.link);
      if (!url) continue;

      const title = stripHtml(item.title) || "(no title)";
      const rawSummary = stripHtml(item.summary || item.content || "");
      const summary = rawSummary.slice(0, 500);

      const rawContent = item.content || item.summary || "";
      const contentSnippet = stripHtml(rawContent).slice(0, 500);

      const publishedAt = parsePubDate(item.pubDate);
      const tags = extractTags(title + " " + summary);
      const category = autoCategory(title, summary, feed.category);

      articles.push({
        title,
        url,
        source: feed.source,
        source_label: feed.label,
        published_at: publishedAt,
        fetched_at: new Date().toISOString(),
        summary,
        content_snippet: contentSnippet,
        tags,
        category,
      });
    }

    return articles;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      console.error(`[RSS] ${feed.source}: Timeout fetching ${feed.url}`);
    } else {
      console.error(`[RSS] ${feed.source}: Error fetching ${feed.url}: ${err.message}`);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

const insertArticle = db.prepare(`
  INSERT OR IGNORE INTO articles
    (title, url, source, source_label, published_at, fetched_at, summary, content_snippet, tags, category)
  VALUES
    (@title, @url, @source, @source_label, @published_at, @fetched_at, @summary, @content_snippet, @tags, @category)
`);

const insertMany = db.transaction((articles) => {
  let inserted = 0;
  for (const a of articles) {
    const result = insertArticle.run(a);
    if (result.changes > 0) inserted++;
  }
  return inserted;
});

async function refreshAllFeeds() {
  let totalNew = 0;
  const results = [];

  for (const feed of FEEDS) {
    try {
      const articles = await fetchFeed(feed);
      const newCount = insertMany(articles);
      totalNew += newCount;
      results.push({ source: feed.source, label: feed.label, fetched: articles.length, new: newCount });
    } catch (err) {
      console.error(`[RSS] Unexpected error for ${feed.source}: ${err.message}`);
      results.push({ source: feed.source, label: feed.label, fetched: 0, new: 0, error: err.message });
    }
  }

  return { totalNew, results };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "ai-news",
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// Tool: refresh_feeds
// ---------------------------------------------------------------------------

server.tool(
  "refresh_feeds",
  "Fetch all configured RSS feeds and insert new articles into the database. Deduplicates by URL. Returns count of new articles found. Call this to refresh the news database before browsing or searching.",
  {},
  async () => {
    const { totalNew, results } = await refreshAllFeeds();

    const lines = [
      `Refresh complete. ${totalNew} new article(s) inserted.`,
      "",
      "Feed results:",
      ...results.map((r) =>
        r.error
          ? `  [ERROR] ${r.label} (${r.source}): ${r.error}`
          : `  ${r.label} (${r.source}): fetched ${r.fetched}, new ${r.new}`
      ),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: search_news
// ---------------------------------------------------------------------------

server.tool(
  "search_news",
  "Full-text search across article titles, summaries, and tags. Filter by recency. Returns matching articles sorted by relevance.",
  {
    query: z.string().describe("Search query — keywords or phrases"),
    days: z.number().default(7).describe("Only return articles from the last N days (default 7)"),
    limit: z.number().default(10).describe("Maximum number of results to return (default 10)"),
  },
  async ({ query, days, limit }) => {
    const cutoff = cutoffDate(days);

    let rows = [];
    try {
      rows = db.prepare(`
        SELECT a.id, a.title, a.url, a.source, a.source_label, a.published_at,
               a.summary, a.category, a.tags,
               bm25(articles_fts) AS score
        FROM articles_fts
        JOIN articles a ON articles_fts.rowid = a.id
        WHERE articles_fts MATCH ?
          AND (a.published_at IS NULL OR a.published_at >= ?)
        ORDER BY score
        LIMIT ?
      `).all(query, cutoff, limit);
    } catch (err) {
      console.error(`[search_news] FTS error: ${err.message}`);
      rows = [];
    }

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No articles found matching "${query}" in the last ${days} day(s).` }] };
    }

    const lines = [
      `Found ${rows.length} article(s) matching "${query}" (last ${days} days):`,
      "",
      ...rows.map((r, i) => formatArticleShort(r, i + 1)),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: browse_recent
// ---------------------------------------------------------------------------

server.tool(
  "browse_recent",
  "Browse recent articles grouped by date. Optionally filter by source or category. Categories: enablement, smb, enterprise, product, research, coding, opinion, policy, fundraising.",
  {
    days: z.number().default(3).describe("Number of days to look back (default 3)"),
    source: z.string().optional().describe("Filter by source key (e.g. 'anthropic-blog', 'oneusefulthing')"),
    category: z
      .enum(["deployment", "use-case", "enablement", "smb", "enterprise", "product", "research", "coding", "opinion", "policy", "fundraising"])
      .optional()
      .describe("Filter by category"),
  },
  async ({ days, source, category }) => {
    const cutoff = cutoffDate(days);

    let query = `
      SELECT id, title, url, source, source_label, published_at, summary, category, tags
      FROM articles
      WHERE (published_at IS NULL OR published_at >= ?)
    `;
    const params = [cutoff];

    if (source) {
      query += " AND source = ?";
      params.push(source);
    }
    if (category) {
      query += " AND category = ?";
      params.push(category);
    }

    query += " ORDER BY published_at DESC, fetched_at DESC LIMIT 200";

    const rows = db.prepare(query).all(...params);

    if (rows.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No articles found in the last ${days} day(s)${source ? ` from source "${source}"` : ""}${category ? ` in category "${category}"` : ""}.`,
        }],
      };
    }

    const byDate = {};
    for (const row of rows) {
      const dateKey = row.published_at ? row.published_at.slice(0, 10) : "unknown";
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(row);
    }

    const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

    const lines = [
      `${rows.length} article(s) from the last ${days} day(s):`,
      "",
    ];

    for (const date of sortedDates) {
      lines.push(`## ${date}`);
      lines.push("");
      for (const [i, row] of byDate[date].entries()) {
        lines.push(formatArticleShort(row, i + 1));
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_sources
// ---------------------------------------------------------------------------

server.tool(
  "get_sources",
  "List all configured RSS feed sources with their labels, categories, and article counts in the database.",
  {},
  async () => {
    const counts = db
      .prepare("SELECT source, COUNT(*) as count FROM articles GROUP BY source")
      .all()
      .reduce((acc, r) => ({ ...acc, [r.source]: r.count }), {});

    const lines = [
      "Configured RSS feed sources:",
      "",
      ...FEEDS.map((f) => {
        const count = counts[f.source] || 0;
        return `  [${f.category}] ${f.label} (${f.source})\n    ${count} article(s) in DB\n    Feed: ${f.url}`;
      }),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_article
// ---------------------------------------------------------------------------

server.tool(
  "get_article",
  "Get full details for a specific article by its numeric ID.",
  {
    id: z.number().describe("Article ID (integer)"),
  },
  async ({ id }) => {
    const row = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);

    if (!row) {
      return { content: [{ type: "text", text: `No article found with id ${id}.` }] };
    }

    const lines = [
      `# ${row.title}`,
      "",
      `**ID:** ${row.id}`,
      `**Source:** ${row.source_label} (${row.source})`,
      `**Category:** ${row.category || "unknown"}`,
      `**Published:** ${row.published_at || "unknown"}`,
      `**Fetched:** ${row.fetched_at}`,
      `**URL:** ${row.url}`,
      `**Tags:** ${row.tags || "none"}`,
      "",
      "**Summary:**",
      row.summary || "(no summary)",
      "",
      "**Content snippet:**",
      row.content_snippet || "(no content snippet)",
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_summary
// ---------------------------------------------------------------------------

server.tool(
  "get_summary",
  "Get a structured digest of recent AI news: article counts by source, top topics, and article list. Use this when generating social posts or briefings.",
  {
    days: z.number().default(7).describe("Number of days to summarize (default 7)"),
    category: z
      .enum(["deployment", "use-case", "enablement", "smb", "enterprise", "product", "research", "coding", "opinion", "policy", "fundraising"])
      .optional()
      .describe("Filter by category"),
  },
  async ({ days, category }) => {
    const cutoff = cutoffDate(days);

    let baseWhere = "WHERE (published_at IS NULL OR published_at >= ?)";
    const params = [cutoff];

    if (category) {
      baseWhere += " AND category = ?";
      params.push(category);
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM articles ${baseWhere}`).get(...params).n;

    if (total === 0) {
      return {
        content: [{
          type: "text",
          text: `No articles found in the last ${days} day(s)${category ? ` for category "${category}"` : ""}.`,
        }],
      };
    }

    const bySrc = db
      .prepare(`SELECT source_label, source, COUNT(*) as n FROM articles ${baseWhere} GROUP BY source ORDER BY n DESC`)
      .all(...params);

    const byCat = db
      .prepare(`SELECT category, COUNT(*) as n FROM articles ${baseWhere} GROUP BY category ORDER BY n DESC`)
      .all(...params);

    const articles = db
      .prepare(
        `SELECT id, title, url, source, source_label, published_at, summary, category, tags
         FROM articles ${baseWhere}
         ORDER BY published_at DESC, fetched_at DESC
         LIMIT 30`
      )
      .all(...params);

    const tagFreq = {};
    for (const a of articles) {
      if (a.tags) {
        for (const t of a.tags.split(",")) {
          const tag = t.trim();
          if (tag) tagFreq[tag] = (tagFreq[tag] || 0) + 1;
        }
      }
    }
    const topTags = Object.entries(tagFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => `${tag} (${count})`);

    const lines = [
      `# AI News Digest — Last ${days} Day(s)${category ? ` | Category: ${category}` : ""}`,
      "",
      `**Total articles:** ${total}`,
      "",
      "## Articles by source",
      ...bySrc.map((r) => `  ${r.source_label}: ${r.n}`),
      "",
      "## Articles by category",
      ...byCat.map((r) => `  ${r.category || "unknown"}: ${r.n}`),
      "",
      "## Top topics / tags",
      topTags.join(", ") || "(none)",
      "",
      `## Articles (most recent ${articles.length})`,
      "",
      ...articles.map((r, i) => formatArticleShort(r, i + 1)),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

function formatArticleShort(row, index) {
  const pub = row.published_at ? row.published_at.slice(0, 10) : "unknown date";
  const summary = row.summary ? row.summary.slice(0, 150) + (row.summary.length > 150 ? "..." : "") : "";
  return [
    `${index}. [${row.id}] ${row.title}`,
    `   Source: ${row.source_label} | Category: ${row.category || "?"} | Date: ${pub}`,
    `   URL: ${row.url}`,
    summary ? `   ${summary}` : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Connect and start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
