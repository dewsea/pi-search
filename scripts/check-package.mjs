import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	discoverAndLoadExtensions,
	formatSize,
} from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-search-artifact-"));
const nestedNpmEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"),
);
nestedNpmEnvironment.npm_config_dry_run = "false";

const requiredPiPeers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const customProviderName = "artifact-custom";

const requiredFiles = [
	"package.json",
	"index.ts",
	"src/index.ts",
	"src/web-search.ts",
	"src/web-fetch.ts",
	"src/providers/tavily.ts",
	"src/providers/anysearch.ts",
	"src/providers/jina.ts",
	"src/providers/exa.ts",
	"src/providers/serper.ts",
	"src/providers/firecrawl.ts",
	"src/providers/brave.ts",
	"src/providers/tinyfish.ts",
	"src/providers/serpapi.ts",
	"README.md",
	"README.zh-CN.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"LICENSE",
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertPiPackageManifest(packageJson) {
	if (!packageJson.keywords?.includes("pi-package")) {
		throw new Error('Pi package manifest must include the "pi-package" keyword');
	}
	if (JSON.stringify(packageJson.pi?.extensions) !== JSON.stringify(["./index.ts"])) {
		throw new Error("Pi package manifest has an unexpected extension entry point");
	}
	for (const name of requiredPiPeers) {
		if (packageJson.peerDependencies?.[name] !== "*") {
			throw new Error(`Pi core package ${name} must be declared as a "*" peer dependency`);
		}
		if (packageJson.dependencies?.[name] !== undefined) {
			throw new Error(`Pi core package ${name} must not be bundled as a runtime dependency`);
		}
	}
}

function assertArtifactFiles(files) {
	for (const file of requiredFiles) {
		if (!files.includes(file)) throw new Error(`npm artifact is missing ${file}`);
	}

	const forbiddenPrefixes = [
		"test/",
		"examples/",
		"scripts/",
		"pi-search/",
		"pi-search-kit/",
		"docs/",
		"node_modules/",
	];
	for (const file of files) {
		if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
			throw new Error(`npm artifact contains repository-only path ${file}`);
		}
		if (
			file.includes(".DS_Store") ||
			file.endsWith(".tgz") ||
			file.split("/").some((part) => part.startsWith(".env"))
		) {
			throw new Error(`npm artifact contains local or generated state ${file}`);
		}
	}
}

async function run() {
	if (!existsSync(join(repositoryRoot, "node_modules"))) {
		throw new Error("node_modules is missing; run npm ci before checking the package artifact");
	}

	const repositoryPackage = readJson(join(repositoryRoot, "package.json"));
	assertPiPackageManifest(repositoryPackage);
	const testedPiPackage = readJson(
		join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
	);
	if (repositoryPackage.devDependencies?.typebox !== testedPiPackage.dependencies?.typebox) {
		throw new Error(
			`tested typebox ${repositoryPackage.devDependencies?.typebox} does not match Pi ${testedPiPackage.version}'s bundled ${testedPiPackage.dependencies?.typebox}`,
		);
	}
	const output = execFileSync("npm", ["pack", "--pack-destination", temporaryRoot, "--json", "--dry-run=false"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: nestedNpmEnvironment,
	});
	const metadata = JSON.parse(output)[0];
	if (!metadata?.filename || !Array.isArray(metadata.files)) throw new Error("npm pack returned invalid metadata");

	const artifactFiles = metadata.files.map(({ path }) => path);
	assertArtifactFiles(artifactFiles);

	const archivePath = join(temporaryRoot, metadata.filename);
	const consumerRoot = join(temporaryRoot, "consumer");
	mkdirSync(consumerRoot);
	writeFileSync(
		join(consumerRoot, "package.json"),
		`${JSON.stringify({ name: "pi-search-artifact-consumer", private: true, type: "module" })}\n`,
	);

	const peerNames = Object.keys(repositoryPackage.peerDependencies ?? {});
	for (const name of peerNames) {
		const testedVersion = repositoryPackage.devDependencies?.[name];
		const source = join(repositoryRoot, "node_modules", name);
		if (!testedVersion || !existsSync(source)) {
			throw new Error(`tested peer dependency ${name} is missing; run npm ci`);
		}
		if (readJson(join(source, "package.json")).version !== testedVersion) {
			throw new Error(`installed ${name} does not match tested version ${testedVersion}`);
		}
	}

	execFileSync(
		"npm",
		[
			"--prefix",
			consumerRoot,
			"install",
			"--legacy-peer-deps",
			"--ignore-scripts",
			"--no-package-lock",
			"--no-save",
			"--no-fund",
			"--no-audit",
			archivePath,
		],
		{ stdio: "pipe", env: nestedNpmEnvironment },
	);

	for (const name of peerNames) {
		if (name === "typebox") continue;
		const source = join(repositoryRoot, "node_modules", name);
		const target = join(consumerRoot, "node_modules", name);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	}
	if (existsSync(join(consumerRoot, "node_modules", "typebox"))) {
		throw new Error("artifact consumer must not contain a physical typebox package");
	}

	const packageRoot = join(consumerRoot, "node_modules", repositoryPackage.name);
	const installedPackage = readJson(join(packageRoot, "package.json"));
	if (installedPackage.name !== repositoryPackage.name || installedPackage.version !== repositoryPackage.version) {
		throw new Error("installed artifact identity does not match repository metadata");
	}
	if (typeof installedPackage.main !== "string" || !existsSync(join(packageRoot, installedPackage.main))) {
		throw new Error("installed artifact has no existing main entry point");
	}
	if (JSON.stringify(installedPackage.pi?.extensions) !== JSON.stringify(["./index.ts"])) {
		throw new Error("installed artifact has an unexpected Pi extension manifest");
	}

	const agentRoot = join(temporaryRoot, "agent");
	const adapterDirectory = join(agentRoot, "extensions", "pi-search", "providers");
	mkdirSync(adapterDirectory, { recursive: true });
	writeFileSync(
		join(adapterDirectory, `${customProviderName}.ts`),
		`import { defineProvider } from "@hyav/pi-search";

export default defineProvider({
	name: ${JSON.stringify(customProviderName)},
	label: "Artifact Custom",
	envVar: "ARTIFACT_CUSTOM_API_KEY",
	keyless: true,
	searchHint: "Production artifact adapter check",
	async search() { return { results: [] }; },
});
`,
		"utf8",
	);

	const extensionPath = join(packageRoot, "index.ts");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousWarn = console.warn;
	const adapterWarnings = [];
	let result;
	try {
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		console.warn = (...args) => {
			const message = args.map(String).join(" ");
			if (message.includes("[pi-search] failed to load adapter")) adapterWarnings.push(message);
			previousWarn(...args);
		};
		result = await discoverAndLoadExtensions([extensionPath], packageRoot, packageRoot);
	} finally {
		console.warn = previousWarn;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	if (adapterWarnings.length > 0) {
		throw new Error(`published custom adapter failed without a physical typebox peer: ${adapterWarnings.join("; ")}`);
	}
	if (result.errors.length > 0) {
		throw new Error(`published Pi entry point failed to load: ${JSON.stringify(result.errors)}`);
	}
	if (result.extensions.length !== 1)
		throw new Error(`expected one published Pi entry point, loaded ${result.extensions.length}`);

	const extension = result.extensions[0];
	if (!extension.commands?.has("search")) {
		throw new Error("published Pi entry point must register /search command");
	}

	const expectedToolNames = ["fetch", "search"];
	const loadedToolNames = [...extension.tools.keys()].sort();
	if (JSON.stringify(loadedToolNames) !== JSON.stringify(expectedToolNames)) {
		throw new Error(`published Pi entry point registered unexpected tools: ${loadedToolNames.join(", ")}`);
	}
	const expectedLimits = `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}`;
	for (const name of expectedToolNames) {
		const definition = extension.tools.get(name)?.definition;
		if (!definition?.promptSnippet || !definition.description.includes(expectedLimits)) {
			throw new Error(`${name} is missing Pi prompt metadata or output-limit documentation`);
		}
		if (
			!definition.promptGuidelines?.length ||
			!definition.promptGuidelines.every((guideline) => guideline.trim() && guideline.includes(name))
		) {
			throw new Error(`${name} has a promptGuidelines entry that does not name the tool`);
		}
	}
	const searchDefinition = extension.tools.get("search")?.definition;
	const providersSchema = searchDefinition?.parameters.properties.providers;
	if (providersSchema?.type !== "array") {
		throw new Error("search providers must be an array schema");
	}
	const providersItemSchema = providersSchema.items;
	const searchProviderNames = providersItemSchema?.anyOf?.[0]?.enum ?? providersItemSchema?.enum;
	if (!searchProviderNames?.includes(customProviderName)) {
		throw new Error(`published custom adapter was not registered in providers enum: ${customProviderName}`);
	}
	if (searchDefinition?.parameters.properties.max_results.type !== "integer") {
		throw new Error("search max_results must use an integer schema");
	}
	const preparedLegacyArguments = searchDefinition.prepareArguments?.({
		query: "compatibility",
		provider: "artifact-custom",
		max_results: 3.8,
	});
	if (preparedLegacyArguments?.max_results !== 3) {
		throw new Error("search must normalize legacy fractional max_results values");
	}
	if (JSON.stringify(preparedLegacyArguments?.providers) !== JSON.stringify(["artifact-custom"])) {
		throw new Error("search must normalize legacy provider argument to providers array");
	}

	console.log(
		`artifact ok: ${metadata.filename} (${artifactFiles.length} files, 1 Pi entry point, 2 tools, 1 command)`,
	);
}

try {
	await run();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
