import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const voiceDir = join(__dirname, "voice");

function readVoiceFile(name) {
  return readFileSync(join(voiceDir, `${name}.md`), "utf-8");
}

const server = new McpServer({
  name: "davids-voice",
  version: "1.0.0",
});

server.tool(
  "get_voice",
  "Get David Sonshine's writing voice rules. CALL THIS BEFORE drafting any email, message, text, post, cover letter, proposal, or written content on David's behalf. Returns core voice identity, mechanical rules, cadence, reasoning style, and anti-patterns.",
  {},
  async () => {
    const content = readVoiceFile("core");
    return { content: [{ type: "text", text: content }] };
  }
);

const FORMAT_OPTIONS = ["email", "text", "social", "cover-letter"];

server.tool(
  "get_format_guide",
  `Get format-specific writing rules for a given medium. Call this AFTER get_voice when you know what format you're writing in. Available formats: ${FORMAT_OPTIONS.join(", ")}. Each format has different structure, formatting, and tone rules -- e.g., text messages use dense paragraphs with no bullets, emails use structured sections with bullets, social posts need a hook in line one.`,
  { format: z.enum(FORMAT_OPTIONS).describe("The writing format/medium") },
  async ({ format }) => {
    const content = readVoiceFile(format);
    return { content: [{ type: "text", text: content }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
