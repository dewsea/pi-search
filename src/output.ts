import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const OUTPUT_TEMP_PREFIX = "pisearch-output-";

export interface LimitedToolOutput {
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export async function limitToolOutput(
	content: string,
	signal?: AbortSignal,
	fileContent = content,
): Promise<LimitedToolOutput> {
	signal?.throwIfAborted();
	const truncation = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: content };

	const dir = await mkdtemp(join(tmpdir(), OUTPUT_TEMP_PREFIX));
	const fullOutputPath = join(dir, "content.txt");
	await withFileMutationQueue(fullOutputPath, async () => {
		signal?.throwIfAborted();
		try {
			await writeFile(fullOutputPath, fileContent, { encoding: "utf8", mode: 0o600, signal });
		} catch (error) {
			signal?.throwIfAborted();
			throw error;
		}
	});
	signal?.throwIfAborted();
	const footer =
		`\n\n[Truncated: ${truncation.totalLines} total lines (${formatSize(truncation.totalBytes)}).` +
		` Full output: ${fullOutputPath}]`;
	// The notice and its complete file path must fit inside the same output budget.
	const preview = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES - (footer.split("\n").length - 1),
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(footer, "utf8"),
	});
	return { text: preview.content + footer, truncation: preview, fullOutputPath };
}
