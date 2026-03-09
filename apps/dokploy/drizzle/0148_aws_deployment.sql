CREATE TYPE "public"."awsDeploymentStatus" AS ENUM('pending', 'provisioning', 'active', 'error');--> statement-breakpoint
CREATE TYPE "public"."deploymentTarget" AS ENUM('server', 'aws_static');--> statement-breakpoint
CREATE TABLE "aws_deployment" (
	"awsDeploymentId" text PRIMARY KEY NOT NULL,
	"applicationId" text NOT NULL,
	"awsAccessKeyId" text NOT NULL,
	"awsSecretAccessKey" text NOT NULL,
	"awsRegion" text DEFAULT 'us-east-1' NOT NULL,
	"s3BucketName" text,
	"cloudfrontDistributionId" text,
	"cloudfrontDomainName" text,
	"cfStackName" text,
	"route53HostedZoneId" text,
	"subdomain" text,
	"parentDomain" text,
	"buildCommand" text DEFAULT 'npm run build',
	"publishDirectory" text DEFAULT 'dist',
	"status" "awsDeploymentStatus" DEFAULT 'pending' NOT NULL,
	"provisioningLog" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "aws_deployment_applicationId_unique" UNIQUE("applicationId")
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "deploymentTarget" "deploymentTarget" DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "aws_deployment" ADD CONSTRAINT "aws_deployment_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
