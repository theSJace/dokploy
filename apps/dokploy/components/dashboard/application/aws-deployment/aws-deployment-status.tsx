"use client";

import {
	AlertCircle,
	CheckCircle2,
	Cloud,
	Copy,
	ExternalLink,
	Globe,
	Loader2,
	RefreshCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

const statusConfig = {
	pending: {
		label: "Pending",
		icon: <Cloud className="h-4 w-4" />,
		variant: "secondary" as const,
	},
	provisioning: {
		label: "Provisioning",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		variant: "default" as const,
	},
	active: {
		label: "Active",
		icon: <CheckCircle2 className="h-4 w-4 text-green-500" />,
		variant: "default" as const,
	},
	error: {
		label: "Error",
		icon: <AlertCircle className="h-4 w-4 text-destructive" />,
		variant: "destructive" as const,
	},
};

export const AwsDeploymentStatus = ({ applicationId }: Props) => {
	const utils = api.useUtils();

	const { data: config, isLoading } =
		api.awsDeployment.getByApplicationId.useQuery(
			{ applicationId },
			{ enabled: !!applicationId, refetchInterval: 5000 },
		);

	const { mutateAsync: provision, isPending: isProvisioning } =
		api.awsDeployment.provision.useMutation();

	if (isLoading) {
		return (
			<Card className="bg-background">
				<CardContent className="py-8 flex justify-center">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</CardContent>
			</Card>
		);
	}

	if (!config) return null;

	const status = statusConfig[config.status as keyof typeof statusConfig] || statusConfig.pending;
	const liveUrl = config.subdomain
		? `https://${config.subdomain}`
		: config.cloudfrontDomainName
			? `https://${config.cloudfrontDomainName}`
			: null;

	const copyToClipboard = (text: string, label: string) => {
		navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	};

	const handleReprovision = async () => {
		await provision({ applicationId })
			.then(() => {
				toast.success("Re-provisioning started");
				utils.awsDeployment.getByApplicationId.invalidate({ applicationId });
			})
			.catch(() => toast.error("Error starting re-provisioning"));
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center justify-between text-xl">
					<span className="flex items-center gap-2">
						<Cloud className="h-5 w-5 text-orange-500" />
						AWS Deployment Status
					</span>
					<Badge variant={status.variant} className="flex items-center gap-1.5">
						{status.icon}
						{status.label}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Live URL */}
				{liveUrl && (
					<div className="flex items-center justify-between p-3 bg-muted rounded-lg">
						<div className="flex items-center gap-2">
							<Globe className="h-4 w-4 text-muted-foreground shrink-0" />
							<span className="text-sm font-mono break-all">{liveUrl}</span>
						</div>
						<div className="flex gap-1 shrink-0">
							<Button
								size="icon"
								variant="ghost"
								onClick={() => copyToClipboard(liveUrl, "URL")}
							>
								<Copy className="h-3.5 w-3.5" />
							</Button>
							<Button size="icon" variant="ghost" asChild>
								<a href={liveUrl} target="_blank" rel="noopener noreferrer">
									<ExternalLink className="h-3.5 w-3.5" />
								</a>
							</Button>
						</div>
					</div>
				)}

				{/* Resource details */}
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
					{config.s3BucketName && (
						<ResourceRow label="S3 Bucket" value={config.s3BucketName} />
					)}
					{config.cloudfrontDistributionId && (
						<ResourceRow
							label="CloudFront ID"
							value={config.cloudfrontDistributionId}
						/>
					)}
					{config.cloudfrontDomainName && (
						<ResourceRow
							label="CloudFront Domain"
							value={config.cloudfrontDomainName}
						/>
					)}
					{config.subdomain && (
						<ResourceRow
							label="Route 53 Subdomain"
							value={config.subdomain}
							highlight
						/>
					)}
					{config.awsRegion && (
						<ResourceRow label="Region" value={config.awsRegion} />
					)}
				</div>

				{/* Error log */}
				{config.status === "error" && config.provisioningLog && (
					<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
						<p className="text-xs text-destructive font-mono whitespace-pre-wrap">
							{config.provisioningLog}
						</p>
					</div>
				)}

				{/* Note about CloudFront propagation */}
				{config.status === "active" && config.subdomain && (
					<p className="text-xs text-muted-foreground">
						DNS changes may take up to 60 seconds to propagate.
						CloudFront distributions can take 5–15 minutes to fully deploy.
					</p>
				)}

				{/* Re-provision button */}
				{(config.status === "pending" || config.status === "error") && (
					<Button
						variant="outline"
						size="sm"
						onClick={handleReprovision}
						disabled={isProvisioning}
					>
						<RefreshCcw className="h-3.5 w-3.5 mr-2" />
						{isProvisioning ? "Provisioning…" : "Retry Provisioning"}
					</Button>
				)}
			</CardContent>
		</Card>
	);
};

const ResourceRow = ({
	label,
	value,
	highlight = false,
}: {
	label: string;
	value: string;
	highlight?: boolean;
}) => (
	<div className="p-2 bg-muted/50 rounded space-y-0.5">
		<p className="text-xs text-muted-foreground">{label}</p>
		<p
			className={`text-xs font-mono truncate ${highlight ? "text-primary font-semibold" : ""}`}
		>
			{value}
		</p>
	</div>
);
