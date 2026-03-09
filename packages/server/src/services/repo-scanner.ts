/**
 * Repository Scanner
 *
 * Scans a cloned repository directory and recommends:
 *   - Build type (nixpacks, dockerfile, static, railpack, etc.)
 *   - Deployment target (server vs AWS static hosting)
 *   - Publish directory (dist, build, out, public, etc.)
 *   - Build command (e.g. "npm run build")
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type DetectedProjectType =
	| "static_html" // Pure HTML/CSS/JS, no build needed
	| "vite" // Vite-based (React, Vue, Svelte, vanilla)
	| "create_react_app" // CRA
	| "nextjs_static" // Next.js with output: export
	| "nextjs_ssr" // Next.js SSR (requires Node server)
	| "nuxtjs" // Nuxt.js
	| "gatsby" // Gatsby static site
	| "hugo" // Hugo static site
	| "jekyll" // Jekyll static site
	| "astro" // Astro
	| "svelte" // SvelteKit
	| "angular" // Angular (ng build)
	| "vue" // Vue CLI
	| "node_app" // Generic Node.js server app
	| "python"
	| "go"
	| "ruby"
	| "java"
	| "php"
	| "docker"
	| "compose"
	| "unknown";

export type RecommendedBuildType =
	| "static"
	| "nixpacks"
	| "dockerfile"
	| "railpack"
	| "paketo_buildpacks";

export type RecommendedDeploymentTarget = "server" | "aws_static";

export interface ScanResult {
	detectedType: DetectedProjectType;
	recommendedBuildType: RecommendedBuildType;
	recommendedDeploymentTarget: RecommendedDeploymentTarget;
	/** Shell command to build the project before deploying (null = no build needed) */
	recommendedBuildCommand: string | null;
	/** Directory that contains the final static output (relative to repo root) */
	recommendedPublishDirectory: string | null;
	confidence: "high" | "medium" | "low";
	/** Human-readable explanation of why we made this recommendation */
	signals: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** List files/dirs at the root of the repo (one level deep). */
async function listRootEntries(
	repoPath: string,
): Promise<{ name: string; isDir: boolean }[]> {
	try {
		const entries = await readdir(repoPath, { withFileTypes: true });
		return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
	} catch {
		return [];
	}
}

async function readJsonFile(
	filePath: string,
): Promise<Record<string, any> | null> {
	try {
		const content = await readFile(filePath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function hasFile(
	entries: { name: string }[],
	...names: string[]
): string | null {
	for (const name of names) {
		if (entries.some((e) => e.name === name)) return name;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export const scanRepository = async (repoPath: string): Promise<ScanResult> => {
	const entries = await listRootEntries(repoPath);
	const fileNames = entries.map((e) => e.name);
	const signals: string[] = [];

	// -------------------------------------------------------------------------
	// Docker-first checks
	// -------------------------------------------------------------------------
	if (
		fileNames.includes("docker-compose.yml") ||
		fileNames.includes("compose.yml")
	) {
		signals.push("Found docker-compose.yml");
		return {
			detectedType: "compose",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	if (fileNames.includes("Dockerfile") || fileNames.includes("dockerfile")) {
		signals.push("Found Dockerfile");
		return {
			detectedType: "docker",
			recommendedBuildType: "dockerfile",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	// -------------------------------------------------------------------------
	// Non-Node language checks (no static output → server deployment)
	// -------------------------------------------------------------------------
	if (
		fileNames.includes("requirements.txt") ||
		fileNames.includes("pyproject.toml") ||
		fileNames.includes("setup.py")
	) {
		signals.push("Found Python project files");
		return {
			detectedType: "python",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	if (fileNames.includes("go.mod")) {
		signals.push("Found go.mod");
		return {
			detectedType: "go",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	if (fileNames.includes("Gemfile")) {
		signals.push("Found Gemfile (Ruby)");
		return {
			detectedType: "ruby",
			recommendedBuildType: "railpack",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	if (
		fileNames.includes("pom.xml") ||
		fileNames.includes("build.gradle") ||
		fileNames.includes("build.gradle.kts")
	) {
		signals.push("Found Java/JVM build file");
		return {
			detectedType: "java",
			recommendedBuildType: "paketo_buildpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	if (fileNames.includes("composer.json")) {
		signals.push("Found composer.json (PHP)");
		return {
			detectedType: "php",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	// -------------------------------------------------------------------------
	// Static site generators (no package.json)
	// -------------------------------------------------------------------------
	if (
		fileNames.includes("config.toml") ||
		fileNames.includes("hugo.toml") ||
		fileNames.includes("config.yaml")
	) {
		if (
			fileNames.includes("content") ||
			fileNames.includes("themes") ||
			fileNames.includes("layouts")
		) {
			signals.push(
				"Found Hugo project structure (config.toml + content/themes/layouts)",
			);
			return {
				detectedType: "hugo",
				recommendedBuildType: "nixpacks",
				recommendedDeploymentTarget: "aws_static",
				recommendedBuildCommand: "hugo --minify",
				recommendedPublishDirectory: "public",
				confidence: "high",
				signals,
			};
		}
	}

	if (fileNames.includes("_config.yml") || fileNames.includes("_config.yaml")) {
		signals.push("Found _config.yml (Jekyll)");
		return {
			detectedType: "jekyll",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "bundle exec jekyll build",
			recommendedPublishDirectory: "_site",
			confidence: "high",
			signals,
		};
	}

	// Pure static HTML (no package.json, has index.html)
	if (!fileNames.includes("package.json") && fileNames.includes("index.html")) {
		signals.push("Found index.html without package.json — pure static HTML");
		return {
			detectedType: "static_html",
			recommendedBuildType: "static",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: ".",
			confidence: "high",
			signals,
		};
	}

	// -------------------------------------------------------------------------
	// Node.js / JavaScript projects — analyse package.json
	// -------------------------------------------------------------------------
	if (!fileNames.includes("package.json")) {
		signals.push("No recognisable project files found");
		return {
			detectedType: "unknown",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "low",
			signals,
		};
	}

	signals.push("Found package.json");
	const pkg = await readJsonFile(path.join(repoPath, "package.json"));
	const deps: Record<string, string> = {
		...(pkg?.dependencies || {}),
		...(pkg?.devDependencies || {}),
	};
	const scripts: Record<string, string> = pkg?.scripts || {};
	const hasBuildScript = "build" in scripts;

	// -------------------------------------------------------------------------
	// Framework-specific detection
	// -------------------------------------------------------------------------

	// Next.js
	if (deps.next) {
		signals.push("Found 'next' dependency");
		// Check if next.config has output: 'export'
		const nextConfigFiles = [
			"next.config.js",
			"next.config.mjs",
			"next.config.ts",
		];
		let isStaticExport = false;
		for (const cfgFile of nextConfigFiles) {
			if (fileNames.includes(cfgFile)) {
				try {
					const cfgContent = await readFile(
						path.join(repoPath, cfgFile),
						"utf-8",
					);
					if (cfgContent.includes("output") && cfgContent.includes("export")) {
						isStaticExport = true;
						signals.push(`${cfgFile} has output: 'export'`);
					}
				} catch {
					/* ignore */
				}
			}
		}
		if (isStaticExport) {
			return {
				detectedType: "nextjs_static",
				recommendedBuildType: "nixpacks",
				recommendedDeploymentTarget: "aws_static",
				recommendedBuildCommand: "npm run build",
				recommendedPublishDirectory: "out",
				confidence: "high",
				signals,
			};
		}
		// SSR Next.js
		return {
			detectedType: "nextjs_ssr",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "high",
			signals,
		};
	}

	// Vite (React/Vue/Svelte/vanilla via Vite)
	if (deps.vite || deps["@vitejs/plugin-react"] || deps["@vitejs/plugin-vue"]) {
		signals.push("Found Vite");
		return {
			detectedType: "vite",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: "dist",
			confidence: "high",
			signals,
		};
	}

	// Create React App
	if (deps["react-scripts"]) {
		signals.push("Found react-scripts (Create React App)");
		return {
			detectedType: "create_react_app",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: "build",
			confidence: "high",
			signals,
		};
	}

	// Gatsby
	if (deps.gatsby) {
		signals.push("Found Gatsby");
		return {
			detectedType: "gatsby",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: "public",
			confidence: "high",
			signals,
		};
	}

	// Astro
	if (deps.astro) {
		signals.push("Found Astro");
		// Astro can be static or SSR — check astro.config
		const astroConfigFiles = [
			"astro.config.mjs",
			"astro.config.ts",
			"astro.config.js",
		];
		let isStaticAstro = true; // default to static if no adapter
		for (const cfgFile of astroConfigFiles) {
			if (fileNames.includes(cfgFile)) {
				try {
					const cfgContent = await readFile(
						path.join(repoPath, cfgFile),
						"utf-8",
					);
					if (
						cfgContent.includes("@astrojs/node") ||
						cfgContent.includes("@astrojs/vercel") ||
						cfgContent.includes("@astrojs/netlify")
					) {
						isStaticAstro = false;
						signals.push(`${cfgFile} uses a server adapter`);
					}
				} catch {
					/* ignore */
				}
			}
		}
		return {
			detectedType: "astro",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: isStaticAstro ? "aws_static" : "server",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: isStaticAstro ? "dist" : null,
			confidence: "high",
			signals,
		};
	}

	// SvelteKit
	if (deps["@sveltejs/kit"]) {
		signals.push("Found SvelteKit");
		// Static adapter → static, otherwise server
		const isStatic = !!deps["@sveltejs/adapter-static"];
		if (isStatic) signals.push("Found @sveltejs/adapter-static");
		return {
			detectedType: "svelte",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: isStatic ? "aws_static" : "server",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: isStatic ? "build" : null,
			confidence: isStatic ? "high" : "medium",
			signals,
		};
	}

	// Nuxt
	if (deps.nuxt || deps.nuxt3) {
		signals.push("Found Nuxt.js");
		return {
			detectedType: "nuxtjs",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "server",
			recommendedBuildCommand: null,
			recommendedPublishDirectory: null,
			confidence: "medium",
			signals,
		};
	}

	// Angular
	if (deps["@angular/core"]) {
		signals.push("Found Angular");
		const projectName = pkg?.name || "app";
		return {
			detectedType: "angular",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "npm run build -- --configuration production",
			recommendedPublishDirectory: `dist/${projectName}`,
			confidence: "medium",
			signals,
		};
	}

	// Vue CLI (not Vite)
	if (deps.vue && deps["@vue/cli-service"]) {
		signals.push("Found Vue CLI");
		return {
			detectedType: "vue",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: "aws_static",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: "dist",
			confidence: "high",
			signals,
		};
	}

	// -------------------------------------------------------------------------
	// Generic Node.js: has a build script but unknown framework
	// -------------------------------------------------------------------------
	if (hasBuildScript) {
		signals.push("Found generic package.json with build script");
		// Heuristic: if it outputs to dist/build/out it might be static
		const outDirHint = scripts.build?.match(
			/(?:--outDir|--out-dir|--output|--dest)\s+(\S+)/,
		)?.[1];
		const likelyStatic = !!(
			deps.express === undefined &&
			!deps.fastify &&
			!deps.koa &&
			!deps.hapi
		);
		return {
			detectedType: "node_app",
			recommendedBuildType: "nixpacks",
			recommendedDeploymentTarget: likelyStatic ? "aws_static" : "server",
			recommendedBuildCommand: "npm run build",
			recommendedPublishDirectory: outDirHint || "dist",
			confidence: "low",
			signals,
		};
	}

	// Plain Node.js app (server-side)
	signals.push(
		"Found package.json without recognisable framework or build script",
	);
	return {
		detectedType: "node_app",
		recommendedBuildType: "nixpacks",
		recommendedDeploymentTarget: "server",
		recommendedBuildCommand: null,
		recommendedPublishDirectory: null,
		confidence: "low",
		signals,
	};
};
