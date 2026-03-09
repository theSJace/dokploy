import { relations } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";

export const awsDeploymentStatus = pgEnum("awsDeploymentStatus", [
	"pending",
	"provisioning",
	"active",
	"error",
]);

export const awsDeployments = pgTable("aws_deployment", {
	awsDeploymentId: text("awsDeploymentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	applicationId: text("applicationId")
		.notNull()
		.unique()
		.references(() => applications.applicationId, { onDelete: "cascade" }),
	// AWS credentials
	awsAccessKeyId: text("awsAccessKeyId").notNull(),
	awsSecretAccessKey: text("awsSecretAccessKey").notNull(),
	awsRegion: text("awsRegion").notNull().default("us-east-1"),
	// S3
	s3BucketName: text("s3BucketName"), // auto-generated if not provided
	// CloudFront
	cloudfrontDistributionId: text("cloudfrontDistributionId"),
	cloudfrontDomainName: text("cloudfrontDomainName"), // e.g. d123abc.cloudfront.net
	// CloudFormation (CDK-managed infrastructure)
	cfStackName: text("cfStackName"), // CloudFormation stack name, e.g. dokploy-myapp-abc123
	// Route 53 – auto subdomain creation
	route53HostedZoneId: text("route53HostedZoneId"), // optional; auto-looked-up from subdomain
	subdomain: text("subdomain"), // e.g. myapp.example.com — created automatically
	parentDomain: text("parentDomain"), // e.g. example.com — used to auto-generate subdomain when subdomain is not set
	// Build configuration
	buildCommand: text("buildCommand").default("npm run build"),
	publishDirectory: text("publishDirectory").default("dist"),
	// Status
	status: awsDeploymentStatus("status").notNull().default("pending"),
	provisioningLog: text("provisioningLog"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
	updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const awsDeploymentsRelations = relations(awsDeployments, ({ one }) => ({
	application: one(applications, {
		fields: [awsDeployments.applicationId],
		references: [applications.applicationId],
	}),
}));

const createSchema = createInsertSchema(awsDeployments, {
	awsDeploymentId: z.string().optional(),
	applicationId: z.string(),
	awsAccessKeyId: z.string().min(1),
	awsSecretAccessKey: z.string().min(1),
	awsRegion: z.string().min(1),
	s3BucketName: z.string().optional(),
	subdomain: z.string().optional(),
	parentDomain: z.string().optional(),
	buildCommand: z.string().optional(),
	publishDirectory: z.string().optional(),
});

export const apiCreateAwsDeployment = createSchema
	.pick({
		applicationId: true,
		awsAccessKeyId: true,
		awsSecretAccessKey: true,
		awsRegion: true,
		subdomain: true,
		parentDomain: true,
		buildCommand: true,
		publishDirectory: true,
	})
	.extend({
		s3BucketName: z.string().optional(),
	});

export const apiUpdateAwsDeployment = createSchema
	.pick({
		awsDeploymentId: true,
		awsAccessKeyId: true,
		awsSecretAccessKey: true,
		awsRegion: true,
		subdomain: true,
		parentDomain: true,
		buildCommand: true,
		publishDirectory: true,
	})
	.extend({
		awsDeploymentId: z.string().min(1),
		s3BucketName: z.string().optional(),
	});

export const apiFindAwsDeployment = z.object({
	applicationId: z.string().min(1),
});

export const apiRemoveAwsDeployment = z.object({
	awsDeploymentId: z.string().min(1),
});

export type AwsDeployment = typeof awsDeployments.$inferSelect;
