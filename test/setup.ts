import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ensure tests always run against an isolated, empty temporary agent directory
// so that local user configuration or adapters in ~/.config/pi/agent or ~/.pi/agent are never loaded.
if (!process.env.PI_CODING_AGENT_DIR || !process.env.PI_CODING_AGENT_DIR.includes("pi-search-test")) {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-search-test-agent-"));
}
