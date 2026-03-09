import path from "node:path";
import {
	createAwsDeployment,
	findApplicationById,
	findAwsDeploymentByApplicationId,
	findAwsDeploymentById,
	getBuildAppDirectory,
	provisionAWSInfrastructure,
	removeAwsDeployment,
	scanRepository,
	updateAwsDeployment,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import {
	apiCreateAwsDeployment,
	apiFindAwsDeployment,
	apiRemoveAwsDeployment,
} from "@/server/db/schema";

export const awsDeploymentRouter = createTRPCRouter({
	/**
	 * Configure AWS deployment for an application.
	 * Creates (or replaces) the aws_deployment record and optionally
	 * kicks off infrastructure provisioning.
	 */
	configure: adminProcedure
		.input(apiCreateAwsDeployment)
		.mutation(async ({ input, ctx }) => {
			// Verify the application belongs to this organisation
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorised to configure this application",
				});
			}

			// Upsert: if a config already exists, update it; otherwise create
			const existing = await findAwsDeploymentByApplicationId(
				input.applicationId,
			);
			if (existing) {
				return await updateAwsDeployment(existing.awsDeploymentId, {
					awsAccessKeyId: input.awsAccessKeyId,
					awsSecretAccessKey: input.awsSecretAccessKey,
					awsRegion: input.awsRegion,
					parentDomain: input.parentDomain ?? null,
					subdomain: input.subdomain ?? null,
					buildCommand: input.buildCommand,
					publishDirectory: input.publishDirectory,
					s3BucketName: input.s3BucketName,
					// Reset provisioning state so re-provisioning picks up changes
					status: "pending",
					cfStackName: null,
					cloudfrontDistributionId: null,
					cloudfrontDomainName: null,
					route53HostedZoneId: null,
				});
			}

			return await createAwsDeployment({
				applicationId: input.applicationId,
				awsAccessKeyId: input.awsAccessKeyId,
				awsSecretAccessKey: input.awsSecretAccessKey,
				awsRegion: input.awsRegion,
				parentDomain: input.parentDomain ?? null,
				subdomain: input.subdomain ?? null,
				buildCommand: input.buildCommand ?? "npm run build",
				publishDirectory: input.publishDirectory ?? "dist",
				s3BucketName: input.s3BucketName ?? null,
				status: "pending",
			});
		}),

	/**
	 * Get the AWS deployment config for an application.
	 */
	getByApplicationId: protectedProcedure
		.input(apiFindAwsDeployment)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorised" });
			}
			return await findAwsDeploymentByApplicationId(input.applicationId);
		}),

	/**
	 * Manually trigger AWS infrastructure provisioning (S3 + CloudFront + Route 53).
	 * Useful for re-provisioning after changing the subdomain or credentials.
	 */
	provision: adminProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorised" });
			}

			const config = await findAwsDeploymentByApplicationId(
				input.applicationId,
			);
			if (!config) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "AWS deployment not configured for this application",
				});
			}

			// Provision in the background — status updates happen via DB
			provisionAWSInfrastructure(
				config.awsDeploymentId,
				application.appName,
			).catch(console.error);

			return { message: "Provisioning started" };
		}),

	/**
	 * Remove AWS deployment configuration.
	 * Note: this does NOT delete AWS resources (S3, CloudFront, Route 53).
	 * Provide a teardown endpoint separately if needed.
	 */
	remove: adminProcedure
		.input(apiRemoveAwsDeployment)
		.mutation(async ({ input, ctx }) => {
			const config = await findAwsDeploymentById(input.awsDeploymentId);
			const application = await findApplicationById(config.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorised" });
			}
			return await removeAwsDeployment(input.awsDeploymentId);
		}),

	/**
	 * Scan a repository and return deployment recommendations.
	 * Requires the application to have been configured with a git source
	 * and have at least one successful clone on disk.
	 */
	scanRepository: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorised" });
			}

			// getBuildAppDirectory returns the path where the repo code lives
			const codeDir = getBuildAppDirectory(application);
			// For non-dockerfile build types, the code dir IS the repo root
			// For dockerfile, strip the Dockerfile filename
			const repoRoot =
				application.buildType === "dockerfile"
					? path.dirname(codeDir)
					: codeDir;

			try {
				const result = await scanRepository(repoRoot);
				return result;
			} catch (err: any) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: err?.message || "Error scanning repository",
				});
			}
		}),
});
