/**
 * AWS Static Deployment Service
 *
 * Handles automatic provisioning and deployment of static sites to:
 *   - AWS S3 + CloudFront  (via CDK synthesis → CloudFormation)
 *   - AWS Route 53          (automatic subdomain creation, direct SDK)
 *
 * Infrastructure lifecycle:
 *   provision  → synthesize CDK stack → deploy CloudFormation → create Route 53 record
 *   deploy     → sync files to S3 (delete stale + upload) → invalidate CloudFront cache
 *   teardown   → delete CloudFormation stack (preserves S3 bucket per RemovalPolicy.RETAIN)
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
	CloudFormationClient,
	CreateStackCommand,
	DeleteStackCommand,
	DescribeStacksCommand,
	type Output,
	UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
	ChangeResourceRecordSetsCommand,
	ListHostedZonesCommand,
	Route53Client,
} from "@aws-sdk/client-route-53";
import {
	DeleteObjectsCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { db } from "@dokploy/server/db";
import { awsDeployments } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import mime from "mime-types";
import type { AwsDeployment } from "../db/schema/aws-deployment";
import { synthesizeStaticSiteTemplate } from "./aws-cdk-stack";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export const createAwsDeployment = async (
	input: Omit<
		typeof awsDeployments.$inferInsert,
		"awsDeploymentId" | "createdAt" | "updatedAt"
	>,
) => {
	const [record] = await db.insert(awsDeployments).values(input).returning();
	if (!record) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating AWS deployment configuration",
		});
	}
	return record;
};

export const findAwsDeploymentByApplicationId = async (
	applicationId: string,
) => {
	return db.query.awsDeployments.findFirst({
		where: eq(awsDeployments.applicationId, applicationId),
	});
};

export const findAwsDeploymentById = async (awsDeploymentId: string) => {
	const record = await db.query.awsDeployments.findFirst({
		where: eq(awsDeployments.awsDeploymentId, awsDeploymentId),
	});
	if (!record) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AWS deployment not found",
		});
	}
	return record;
};

export const updateAwsDeployment = async (
	awsDeploymentId: string,
	data: Partial<typeof awsDeployments.$inferInsert>,
) => {
	const [updated] = await db
		.update(awsDeployments)
		.set({ ...data, updatedAt: new Date() })
		.where(eq(awsDeployments.awsDeploymentId, awsDeploymentId))
		.returning();
	return updated;
};

export const removeAwsDeployment = async (awsDeploymentId: string) => {
	const [removed] = await db
		.delete(awsDeployments)
		.where(eq(awsDeployments.awsDeploymentId, awsDeploymentId))
		.returning();
	return removed;
};

// ---------------------------------------------------------------------------
// AWS client factories
// ---------------------------------------------------------------------------

const makeCFn = (config: AwsDeployment) =>
	new CloudFormationClient({
		region: config.awsRegion,
		credentials: {
			accessKeyId: config.awsAccessKeyId,
			secretAccessKey: config.awsSecretAccessKey,
		},
	});

const makeS3 = (config: AwsDeployment) =>
	new S3Client({
		region: config.awsRegion,
		credentials: {
			accessKeyId: config.awsAccessKeyId,
			secretAccessKey: config.awsSecretAccessKey,
		},
	});

const makeCF = (config: AwsDeployment) =>
	new CloudFrontClient({
		region: "us-east-1",
		credentials: {
			accessKeyId: config.awsAccessKeyId,
			secretAccessKey: config.awsSecretAccessKey,
		},
	});

const makeR53 = (config: AwsDeployment) =>
	new Route53Client({
		region: "us-east-1",
		credentials: {
			accessKeyId: config.awsAccessKeyId,
			secretAccessKey: config.awsSecretAccessKey,
		},
	});

// ---------------------------------------------------------------------------
// CloudFormation stack deploy / teardown
// ---------------------------------------------------------------------------

/** Terminal stack statuses that end polling. */
const CF_TERMINAL = new Set([
	"CREATE_COMPLETE",
	"UPDATE_COMPLETE",
	"DELETE_COMPLETE",
	"CREATE_FAILED",
	"DELETE_FAILED",
	"ROLLBACK_COMPLETE",
	"ROLLBACK_FAILED",
	"UPDATE_ROLLBACK_COMPLETE",
	"UPDATE_ROLLBACK_FAILED",
]);

/** Statuses that indicate a failure. */
const CF_FAILED = new Set([
	"CREATE_FAILED",
	"DELETE_FAILED",
	"ROLLBACK_COMPLETE",
	"ROLLBACK_FAILED",
	"UPDATE_ROLLBACK_COMPLETE",
	"UPDATE_ROLLBACK_FAILED",
]);

/**
 * Poll a CloudFormation stack until it reaches a terminal state.
 * Throws on failure states.
 */
async function waitForStack(
	cfn: CloudFormationClient,
	stackName: string,
	logFn: (msg: string) => void,
): Promise<void> {
	for (;;) {
		await new Promise((r) => setTimeout(r, 6000)); // poll every 6 s
		const { Stacks } = await cfn.send(
			new DescribeStacksCommand({ StackName: stackName }),
		);
		const status = Stacks?.[0]?.StackStatus ?? "UNKNOWN";
		logFn(`[AWS] Stack status: ${status}`);
		if (CF_TERMINAL.has(status)) {
			if (CF_FAILED.has(status)) {
				const reason = Stacks?.[0]?.StackStatusReason ?? "";
				throw new Error(
					`CloudFormation stack "${stackName}" failed (${status})${reason ? `: ${reason}` : ""}`,
				);
			}
			return;
		}
	}
}

/**
 * Create or update a CloudFormation stack from a synthesized CDK template.
 * Waits for the operation to complete and returns the stack outputs.
 */
async function deployCloudFormationStack(
	config: AwsDeployment,
	stackName: string,
	templateBody: string,
	logFn: (msg: string) => void,
): Promise<Output[]> {
	const cfn = makeCFn(config);

	// Check whether the stack already exists
	let stackExists = false;
	try {
		const { Stacks } = await cfn.send(
			new DescribeStacksCommand({ StackName: stackName }),
		);
		stackExists = !!Stacks?.length;
	} catch {
		// DescribeStacks throws when the stack does not exist
	}

	if (stackExists) {
		logFn("[AWS] Updating existing CloudFormation stack…");
		try {
			await cfn.send(
				new UpdateStackCommand({
					StackName: stackName,
					TemplateBody: templateBody,
					Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
				}),
			);
		} catch (err: any) {
			// CloudFormation throws ValidationError when there are no changes —
			// treat this as success so we can still read the current outputs.
			if (
				err?.name === "ValidationError" &&
				err?.message?.includes("No updates are to be performed")
			) {
				logFn("[AWS] No infrastructure changes detected — skipping update");
			} else {
				throw err;
			}
		}
	} else {
		logFn("[AWS] Creating new CloudFormation stack…");
		await cfn.send(
			new CreateStackCommand({
				StackName: stackName,
				TemplateBody: templateBody,
				Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
				OnFailure: "ROLLBACK",
			}),
		);
	}

	await waitForStack(cfn, stackName, logFn);

	const { Stacks } = await cfn.send(
		new DescribeStacksCommand({ StackName: stackName }),
	);
	return Stacks?.[0]?.Outputs ?? [];
}

/**
 * Delete a CloudFormation stack.
 * The S3 bucket is NOT deleted because it has RemovalPolicy.RETAIN in the
 * CDK stack — user data is preserved.
 */
export const teardownCloudFormationStack = async (
	config: AwsDeployment,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	if (!config.cfStackName) return;
	const cfn = makeCFn(config);
	logFn(`[AWS] Deleting CloudFormation stack ${config.cfStackName}…`);
	await cfn.send(new DeleteStackCommand({ StackName: config.cfStackName }));
	await waitForStack(cfn, config.cfStackName, logFn);
	logFn("[AWS] CloudFormation stack deleted");
};

// ---------------------------------------------------------------------------
// Route 53 – automatic subdomain creation (direct SDK)
// ---------------------------------------------------------------------------

/**
 * Auto-discover the Route 53 hosted zone for a given fully-qualified domain
 * and create (or upsert) an A-alias record pointing to a CloudFront domain.
 *
 * Zone discovery walks up the subdomain tree until a matching hosted zone is
 * found in the account (e.g. "app.sub.example.com" → tries "sub.example.com"
 * then "example.com").
 */
export const provisionRoute53Subdomain = async (
	config: AwsDeployment,
	subdomain: string,
	cloudfrontDomainName: string,
): Promise<{ hostedZoneId: string }> => {
	const r53 = makeR53(config);
	const parts = subdomain.split(".");
	let hostedZoneId = config.route53HostedZoneId ?? null;

	if (!hostedZoneId) {
		for (let i = 1; i < parts.length - 1; i++) {
			const candidate = parts.slice(i).join(".");
			const { HostedZones } = await r53.send(
				new ListHostedZonesCommand({ MaxItems: 100 }),
			);
			const match = (HostedZones ?? []).find(
				(z) => z.Name === `${candidate}.` || z.Name === candidate,
			);
			if (match?.Id) {
				hostedZoneId = match.Id.replace("/hostedzone/", "");
				break;
			}
		}
	}

	if (!hostedZoneId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Could not find a Route 53 hosted zone for "${subdomain}". Ensure the parent domain is hosted in Route 53 under the provided AWS account.`,
		});
	}

	await r53.send(
		new ChangeResourceRecordSetsCommand({
			HostedZoneId: hostedZoneId,
			ChangeBatch: {
				Changes: [
					{
						Action: "UPSERT",
						ResourceRecordSet: {
							Name: subdomain,
							Type: "A",
							AliasTarget: {
								// CloudFront's fixed hosted zone ID (globally constant)
								HostedZoneId: "Z2FDTNDATAQYW2",
								DNSName: cloudfrontDomainName,
								EvaluateTargetHealth: false,
							},
						},
					},
				],
			},
		}),
	);

	return { hostedZoneId };
};

// ---------------------------------------------------------------------------
// Full provisioning (orchestrator)
// ---------------------------------------------------------------------------

/**
 * Provision all AWS infrastructure for a static site:
 *   1. Synthesize CDK stack → CloudFormation template (in-process, no CLI)
 *   2. Create / update CloudFormation stack  → S3 bucket + CloudFront distribution
 *   3. Read stack outputs → persist resource IDs to DB
 *   4. Optionally create Route 53 A-alias record (direct SDK)
 *
 * On retry the same stack name and bucket name are reused, so CloudFormation
 * simply performs an idempotent update.
 */
export const provisionAWSInfrastructure = async (
	awsDeploymentId: string,
	appName: string,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	await updateAwsDeployment(awsDeploymentId, { status: "provisioning" });
	const config = await findAwsDeploymentById(awsDeploymentId);

	try {
		// Derive safe, URL-friendly name fragments
		const safeApp = appName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const shortId = config.awsDeploymentId.slice(-6);

		// CloudFormation stack name must start with a letter, max 128 chars
		const stackName = config.cfStackName ?? `dokploy-${safeApp}-${shortId}`;
		// S3 bucket name: globally unique, same derivation
		const bucketName = config.s3BucketName ?? `dokploy-${safeApp}-${shortId}`;

		// Persist derived names immediately so retries are idempotent
		await updateAwsDeployment(awsDeploymentId, {
			cfStackName: stackName,
			s3BucketName: bucketName,
		});

		// Resolve effective subdomain (explicit > auto-generated > none)
		let effectiveSubdomain = config.subdomain ?? null;
		if (!effectiveSubdomain && config.parentDomain) {
			effectiveSubdomain = `${safeApp}.${config.parentDomain}`;
			await updateAwsDeployment(awsDeploymentId, {
				subdomain: effectiveSubdomain,
			});
			logFn(`[AWS] Auto-generated subdomain: ${effectiveSubdomain}`);
		}

		// ── Step 1: CDK synthesis (in-process, no CLI required) ───────────────
		logFn("[AWS] Synthesizing CDK stack → CloudFormation template…");
		const templateBody = synthesizeStaticSiteTemplate({
			stackName,
			bucketName,
		});
		logFn("[AWS] Synthesis complete");

		// ── Step 2: Deploy via CloudFormation ─────────────────────────────────
		logFn("[AWS] Deploying CloudFormation stack (S3 + CloudFront)…");
		const outputs = await deployCloudFormationStack(
			config,
			stackName,
			templateBody,
			logFn,
		);

		// ── Step 3: Read stack outputs ────────────────────────────────────────
		const out = Object.fromEntries(
			outputs
				.filter((o) => o.OutputKey && o.OutputValue)
				.map((o) => [o.OutputKey!, o.OutputValue!]),
		);

		await updateAwsDeployment(awsDeploymentId, {
			s3BucketName: out.BucketName ?? bucketName,
			cloudfrontDistributionId: out.DistributionId ?? null,
			cloudfrontDomainName: out.CloudFrontDomain ?? null,
		});

		const cloudfrontDomain = out.CloudFrontDomain ?? null;
		logFn(
			`[AWS] Stack deployed — CloudFront: ${cloudfrontDomain ?? "(pending)"}`,
		);

		// ── Step 4: Route 53 (direct SDK, needs runtime zone discovery) ───────
		if (effectiveSubdomain && cloudfrontDomain) {
			logFn(`[AWS] Creating Route 53 record for ${effectiveSubdomain}…`);
			const { hostedZoneId } = await provisionRoute53Subdomain(
				config,
				effectiveSubdomain,
				cloudfrontDomain,
			);
			await updateAwsDeployment(awsDeploymentId, {
				route53HostedZoneId: hostedZoneId,
			});
			logFn(
				`[AWS] ${effectiveSubdomain} → ${cloudfrontDomain} (DNS active in ~60s)`,
			);
		}

		await updateAwsDeployment(awsDeploymentId, { status: "active" });
		logFn("[AWS] Infrastructure provisioning complete ✓");
	} catch (err: any) {
		const message = err?.message ?? String(err);
		await updateAwsDeployment(awsDeploymentId, {
			status: "error",
			provisioningLog: message,
		});
		logFn(`[AWS] Provisioning failed: ${message}`);
		throw err;
	}
};

// ---------------------------------------------------------------------------
// File upload to S3
// ---------------------------------------------------------------------------

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const results: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await collectFiles(full)));
		} else {
			results.push(full);
		}
	}
	return results;
}

/**
 * Sync local build output to S3:
 *   1. List all existing S3 keys
 *   2. Delete keys that are no longer in the local build output
 *   3. Upload all local files (adds new, overwrites changed)
 */
export const syncStaticFilesWithS3 = async (
	config: AwsDeployment,
	localDir: string,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	const s3 = makeS3(config);
	const bucketName = config.s3BucketName;
	if (!bucketName) {
		throw new Error("S3 bucket name not configured — run provisioning first");
	}

	// ── Step 1: List all existing S3 keys (paginated) ─────────────────────
	const existingKeys = new Set<string>();
	let continuationToken: string | undefined;
	do {
		const res = await s3.send(
			new ListObjectsV2Command({
				Bucket: bucketName,
				ContinuationToken: continuationToken,
			}),
		);
		for (const obj of res.Contents ?? []) {
			if (obj.Key) existingKeys.add(obj.Key);
		}
		continuationToken = res.NextContinuationToken;
	} while (continuationToken);

	// ── Step 2: Collect local file keys ───────────────────────────────────
	const localFiles = await collectFiles(localDir);
	const localKeys = new Set(
		localFiles.map((f) => path.relative(localDir, f).replace(/\\/g, "/")),
	);

	// ── Step 3: Delete stale keys (in S3 but not in local build) ──────────
	const staleKeys = [...existingKeys].filter((k) => !localKeys.has(k));
	if (staleKeys.length > 0) {
		logFn(
			`[AWS] Removing ${staleKeys.length} stale file(s) from s3://${bucketName}…`,
		);
		// DeleteObjects accepts max 1000 keys per request
		for (let i = 0; i < staleKeys.length; i += 1000) {
			const batch = staleKeys.slice(i, i + 1000);
			await s3.send(
				new DeleteObjectsCommand({
					Bucket: bucketName,
					Delete: {
						Objects: batch.map((Key) => ({ Key })),
						Quiet: true,
					},
				}),
			);
		}
		logFn(`[AWS] Removed ${staleKeys.length} stale file(s)`);
	}

	// ── Step 4: Upload all local files ────────────────────────────────────
	logFn(`[AWS] Uploading ${localFiles.length} files to s3://${bucketName}…`);
	await Promise.all(
		localFiles.map(async (filePath) => {
			const key = path.relative(localDir, filePath).replace(/\\/g, "/");
			const contentType = mime.lookup(filePath) || "application/octet-stream";

			const upload = new Upload({
				client: s3,
				params: {
					Bucket: bucketName,
					Key: key,
					Body: createReadStream(filePath),
					ContentType: contentType,
				},
			});
			await upload.done();
		}),
	);

	logFn(
		`[AWS] Sync complete — ${localFiles.length} uploaded, ${staleKeys.length} removed`,
	);
};

/** Invalidate the CloudFront cache for all paths. */
export const invalidateCloudFrontCache = async (
	config: AwsDeployment,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	if (!config.cloudfrontDistributionId) return;

	const cf = makeCF(config);
	await cf.send(
		new CreateInvalidationCommand({
			DistributionId: config.cloudfrontDistributionId,
			InvalidationBatch: {
				CallerReference: `dokploy-deploy-${Date.now()}`,
				Paths: { Quantity: 1, Items: ["/*"] },
			},
		}),
	);
	logFn("[AWS] CloudFront cache invalidated");
};

// ---------------------------------------------------------------------------
// Main deploy function
// ---------------------------------------------------------------------------

/**
 * Full deploy cycle for an AWS static site:
 *   1. Ensure infrastructure is provisioned (CDK → CloudFormation → Route 53)
 *   2. Sync static files: delete stale S3 objects, upload new/changed files
 *   3. Invalidate CloudFront cache
 */
export const deployStaticToAWS = async (
	applicationId: string,
	appName: string,
	localPublishDir: string,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	let config = await findAwsDeploymentByApplicationId(applicationId);
	if (!config) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AWS deployment configuration not found for this application",
		});
	}

	// Auto-provision if not yet done
	if (config.status === "pending" || !config.s3BucketName) {
		await provisionAWSInfrastructure(config.awsDeploymentId, appName, logFn);
		config = await findAwsDeploymentById(config.awsDeploymentId);
	}

	await syncStaticFilesWithS3(config, localPublishDir, logFn);
	await invalidateCloudFrontCache(config, logFn);

	const liveUrl = config.subdomain
		? `https://${config.subdomain}`
		: config.cloudfrontDomainName
			? `https://${config.cloudfrontDomainName}`
			: "(CloudFront domain pending)";
	logFn(`[AWS] Site live at: ${liveUrl}`);
};
