/**
 * AWS Static Deployment Service
 *
 * Handles automatic provisioning and deployment of static sites to:
 *   - AWS S3 (static website hosting)
 *   - AWS CloudFront (CDN)
 *   - AWS Route 53 (automatic subdomain creation)
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	CloudFrontClient,
	CreateDistributionCommand,
	CreateInvalidationCommand,
	GetDistributionCommand,
	type DistributionConfig,
} from "@aws-sdk/client-cloudfront";
import {
	ChangeResourceRecordSetsCommand,
	ListHostedZonesCommand,
	Route53Client,
} from "@aws-sdk/client-route-53";
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
	PutBucketPolicyCommand,
	PutBucketWebsiteCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { db } from "@dokploy/server/db";
import { awsDeployments } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import mime from "mime-types";
import type { AwsDeployment } from "../db/schema/aws-deployment";

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
		throw new TRPCError({ code: "NOT_FOUND", message: "AWS deployment not found" });
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
		// CloudFront is a global service but SDK must be pointed to us-east-1
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
// S3 provisioning
// ---------------------------------------------------------------------------

/**
 * Create an S3 bucket configured for static website hosting.
 * If the bucket already exists and is owned by this account, it is reused.
 * Returns the bucket name (which may have been auto-generated).
 */
export const provisionS3Bucket = async (
	config: AwsDeployment,
	appName: string,
): Promise<string> => {
	const s3 = makeS3(config);
	// Derive a bucket name if not provided: dokploy-<appName>-<short-id>
	const bucketName =
		config.s3BucketName ||
		`dokploy-${appName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${config.awsDeploymentId.slice(-6)}`;

	// Create the bucket (will fail if it already exists in another account)
	try {
		if (config.awsRegion === "us-east-1") {
			await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
		} else {
			await s3.send(
				new CreateBucketCommand({
					Bucket: bucketName,
					CreateBucketConfiguration: { LocationConstraint: config.awsRegion as any },
				}),
			);
		}
	} catch (err: any) {
		// BucketAlreadyOwnedByYou is fine — bucket exists and belongs to this account
		if (err?.name !== "BucketAlreadyOwnedByYou") {
			throw err;
		}
	}

	// Enable static website hosting
	await s3.send(
		new PutBucketWebsiteCommand({
			Bucket: bucketName,
			WebsiteConfiguration: {
				IndexDocument: { Suffix: "index.html" },
				ErrorDocument: { Key: "index.html" }, // SPA fallback
			},
		}),
	);

	// Set a public-read bucket policy
	const publicPolicy = JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "PublicReadGetObject",
				Effect: "Allow",
				Principal: "*",
				Action: "s3:GetObject",
				Resource: `arn:aws:s3:::${bucketName}/*`,
			},
		],
	});
	await s3.send(
		new PutBucketPolicyCommand({ Bucket: bucketName, Policy: publicPolicy }),
	);

	return bucketName;
};

// ---------------------------------------------------------------------------
// CloudFront provisioning
// ---------------------------------------------------------------------------

/**
 * Create a CloudFront distribution pointing to an S3 website endpoint.
 * Returns `{ distributionId, domainName }`.
 */
export const provisionCloudFront = async (
	config: AwsDeployment,
	bucketName: string,
	customDomain?: string,
): Promise<{ distributionId: string; domainName: string }> => {
	const cf = makeCF(config);

	const s3WebsiteOrigin = `${bucketName}.s3-website-${config.awsRegion}.amazonaws.com`;

	const aliases = customDomain ? [customDomain] : undefined;

	const distributionConfig: DistributionConfig = {
		CallerReference: `dokploy-${config.awsDeploymentId}-${Date.now()}`,
		Comment: `Dokploy static site – ${bucketName}`,
		DefaultRootObject: "index.html",
		Origins: {
			Quantity: 1,
			Items: [
				{
					Id: "S3Origin",
					DomainName: s3WebsiteOrigin,
					CustomOriginConfig: {
						HTTPPort: 80,
						HTTPSPort: 443,
						OriginProtocolPolicy: "http-only",
					},
				},
			],
		},
		DefaultCacheBehavior: {
			TargetOriginId: "S3Origin",
			ViewerProtocolPolicy: "redirect-to-https",
			CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // AWS managed: CachingOptimized
			AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
			Compress: true,
		},
		CustomErrorResponses: {
			Quantity: 1,
			Items: [
				{
					ErrorCode: 403,
					ResponseCode: "200",
					ResponsePagePath: "/index.html",
					ErrorCachingMinTTL: 0,
				},
			],
		},
		...(aliases ? { Aliases: { Quantity: aliases.length, Items: aliases } } : {}),
		Enabled: true,
		HttpVersion: "http2",
		PriceClass: "PriceClass_100",
	};

	const response = await cf.send(
		new CreateDistributionCommand({ DistributionConfig: distributionConfig }),
	);

	const distribution = response.Distribution;
	if (!distribution?.Id || !distribution.DomainName) {
		throw new Error("CloudFront distribution creation returned unexpected response");
	}

	return {
		distributionId: distribution.Id,
		domainName: distribution.DomainName,
	};
};

// ---------------------------------------------------------------------------
// Route 53 – automatic subdomain creation
// ---------------------------------------------------------------------------

/**
 * Automatically find the Route 53 hosted zone for a given domain and create
 * an A-alias record pointing to the CloudFront distribution.
 *
 * E.g. subdomain = "myapp.example.com" → finds hosted zone for "example.com"
 *      and creates an A alias record for "myapp.example.com" → CloudFront.
 */
export const provisionRoute53Subdomain = async (
	config: AwsDeployment,
	subdomain: string,
	cloudfrontDomainName: string,
): Promise<{ hostedZoneId: string }> => {
	const r53 = makeR53(config);

	// Auto-discover the hosted zone: strip subdomains until we find a match
	const parts = subdomain.split(".");
	let hostedZoneId = config.route53HostedZoneId || null;

	if (!hostedZoneId) {
		// Try each parent domain level (e.g. "myapp.sub.example.com" → "sub.example.com" → "example.com")
		for (let i = 1; i < parts.length - 1; i++) {
			const candidate = parts.slice(i).join(".");
			const { HostedZones } = await r53.send(
				new ListHostedZonesCommand({ MaxItems: "100" }),
			);
			const match = (HostedZones || []).find(
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
			message: `Could not find a Route 53 hosted zone for subdomain "${subdomain}". Please ensure the parent domain is hosted in Route 53 under the provided AWS account.`,
		});
	}

	// Create (or upsert) the A alias record
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
								HostedZoneId: "Z2FDTNDATAQYW2", // CloudFront's hosted zone ID (fixed globally)
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
 *   1. S3 bucket with website hosting
 *   2. CloudFront distribution
 *   3. Route 53 A-alias record (if subdomain is set)
 *
 * Updates the `aws_deployment` record with the provisioned resource IDs.
 */
export const provisionAWSInfrastructure = async (
	awsDeploymentId: string,
	appName: string,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	await updateAwsDeployment(awsDeploymentId, { status: "provisioning" });

	const config = await findAwsDeploymentById(awsDeploymentId);

	try {
		// 1. S3
		logFn("[AWS] Provisioning S3 bucket…");
		const bucketName = await provisionS3Bucket(config, appName);
		await updateAwsDeployment(awsDeploymentId, { s3BucketName: bucketName });
		logFn(`[AWS] S3 bucket ready: ${bucketName}`);

		// Resolve the effective subdomain: use the explicit one or auto-generate
		// from parentDomain when the user did not supply a specific subdomain.
		let effectiveSubdomain = config.subdomain ?? null;
		if (!effectiveSubdomain && config.parentDomain) {
			// Sanitise appName: lowercase, replace non-alphanumeric with hyphens
			const safeAppName = appName
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "");
			effectiveSubdomain = `${safeAppName}.${config.parentDomain}`;
			await updateAwsDeployment(awsDeploymentId, { subdomain: effectiveSubdomain });
			logFn(`[AWS] Auto-generated subdomain: ${effectiveSubdomain}`);
		}

		// 2. CloudFront
		logFn("[AWS] Creating CloudFront distribution…");
		const { distributionId, domainName } = await provisionCloudFront(
			{ ...config, s3BucketName: bucketName },
			bucketName,
			effectiveSubdomain ?? undefined,
		);
		await updateAwsDeployment(awsDeploymentId, {
			cloudfrontDistributionId: distributionId,
			cloudfrontDomainName: domainName,
		});
		logFn(`[AWS] CloudFront distribution created: ${domainName}`);

		// 3. Route 53 (only if a subdomain is configured or was auto-generated)
		if (effectiveSubdomain) {
			logFn(`[AWS] Creating Route 53 record for ${effectiveSubdomain}…`);
			const { hostedZoneId } = await provisionRoute53Subdomain(
				config,
				effectiveSubdomain,
				domainName,
			);
			await updateAwsDeployment(awsDeploymentId, { route53HostedZoneId: hostedZoneId });
			logFn(`[AWS] Subdomain ${effectiveSubdomain} → ${domainName} (active in ~60s)`);
		}

		await updateAwsDeployment(awsDeploymentId, { status: "active" });
		logFn("[AWS] Infrastructure provisioning complete ✓");
	} catch (err: any) {
		const message = err?.message || String(err);
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

/**
 * Recursively collect all files under a directory.
 */
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
 * Upload all files from a local directory to an S3 bucket.
 * Uses streaming uploads for efficiency.
 */
export const uploadStaticFilesToS3 = async (
	config: AwsDeployment,
	localDir: string,
	logFn: (msg: string) => void = console.log,
): Promise<void> => {
	const s3 = makeS3(config);
	const bucketName = config.s3BucketName;
	if (!bucketName) {
		throw new Error("S3 bucket name not configured — run provisioning first");
	}

	const files = await collectFiles(localDir);
	logFn(`[AWS] Uploading ${files.length} files to s3://${bucketName}…`);

	await Promise.all(
		files.map(async (filePath) => {
			const key = path.relative(localDir, filePath).replace(/\\/g, "/");
			const contentType =
				mime.lookup(filePath) || "application/octet-stream";

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

	logFn(`[AWS] Upload complete — ${files.length} files synced`);
};

/**
 * Invalidate the CloudFront cache for all paths ("/*").
 */
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
// Main deploy function (called from application.ts deployApplication)
// ---------------------------------------------------------------------------

/**
 * Full deploy cycle for an AWS static site:
 *   1. Ensure infrastructure is provisioned (S3 + CloudFront + Route 53)
 *   2. Upload static files from `localPublishDir`
 *   3. Invalidate CloudFront cache
 *
 * `localPublishDir` = the directory on the Dokploy host that contains the
 * built static files (e.g. /etc/dokploy/applications/myapp/code/dist).
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

	// Upload files
	await uploadStaticFilesToS3(config, localPublishDir, logFn);

	// Invalidate cache
	await invalidateCloudFrontCache(config, logFn);

	// Log the live URL
	const liveUrl = config.subdomain
		? `https://${config.subdomain}`
		: config.cloudfrontDomainName
			? `https://${config.cloudfrontDomainName}`
			: "(CloudFront domain pending)";
	logFn(`[AWS] Site live at: ${liveUrl}`);
};
