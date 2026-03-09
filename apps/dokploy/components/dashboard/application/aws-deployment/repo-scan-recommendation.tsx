"use client";

import type { ScanResult } from "@dokploy/server";
import {
	AlertCircle,
	CheckCircle2,
	ChevronRight,
	Cloud,
	Code2,
	Loader2,
	RefreshCcw,
	Scan,
	Server,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
	/** Called when user clicks "Apply Recommendations" with the scan result */
	onApply?: (result: ScanResult) => void;
}

const confidenceColor = {
	high: "text-green-600",
	medium: "text-yellow-600",
	low: "text-muted-foreground",
} as const;

const deploymentTargetLabel = {
	aws_static: "AWS Static (S3 + CloudFront)",
	server: "Docker Server",
} as const;

const deploymentTargetIcon = {
	aws_static: <Cloud className="h-4 w-4 text-orange-500" />,
	server: <Server className="h-4 w-4 text-blue-500" />,
} as const;

export const RepoScanRecommendation = ({ applicationId, onApply }: Props) => {
	const [scanResult, setScanResult] = useState<ScanResult | null>(null);
	const [dismissed, setDismissed] = useState(false);

	const { mutateAsync: scan, isPending: isScanning } =
		api.awsDeployment.scanRepository.useMutation();

	const handleScan = async () => {
		setScanResult(null);
		await scan({ applicationId })
			.then((result) => {
				setScanResult(result);
			})
			.catch((err) => {
				const message =
					err?.message?.includes("ENOENT") || err?.message?.includes("no such")
						? "Repository not yet cloned. Trigger an initial deployment to clone the repository before scanning."
						: "Error scanning repository";
				toast.error(message);
			});
	};

	if (dismissed) return null;

	return (
		<Card className="bg-background border-dashed">
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between">
					<CardTitle className="flex items-center gap-2 text-base">
						<Scan className="h-4 w-4 text-primary" />
						Repository Auto-Scan
					</CardTitle>
					<Button
						size="icon"
						variant="ghost"
						className="h-6 w-6 -mt-1"
						onClick={() => setDismissed(true)}
					>
						<X className="h-3 w-3" />
					</Button>
				</div>
				<CardDescription>
					Scan your repository to automatically detect the framework and get
					recommended deployment settings.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<Button
					variant="outline"
					size="sm"
					onClick={handleScan}
					disabled={isScanning}
				>
					{isScanning ? (
						<Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
					) : (
						<RefreshCcw className="h-3.5 w-3.5 mr-2" />
					)}
					{isScanning ? "Scanning…" : "Scan Repository"}
				</Button>

				{scanResult && (
					<div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
						{/* Summary */}
						<div className="flex items-center gap-2 flex-wrap">
							<Badge variant="secondary" className="font-mono text-xs">
								{scanResult.detectedType}
							</Badge>
							<span
								className={`text-xs ${confidenceColor[scanResult.confidence]}`}
							>
								{scanResult.confidence} confidence
							</span>
						</div>

						{/* Recommendations */}
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
							<RecommendationItem
								label="Deployment Target"
								icon={
									deploymentTargetIcon[scanResult.recommendedDeploymentTarget]
								}
								value={
									deploymentTargetLabel[scanResult.recommendedDeploymentTarget]
								}
							/>
							<RecommendationItem
								label="Build Type"
								icon={<Code2 className="h-4 w-4 text-primary" />}
								value={scanResult.recommendedBuildType}
							/>
							{scanResult.recommendedBuildCommand && (
								<RecommendationItem
									label="Build Command"
									icon={
										<ChevronRight className="h-4 w-4 text-muted-foreground" />
									}
									value={scanResult.recommendedBuildCommand}
									mono
								/>
							)}
							{scanResult.recommendedPublishDirectory && (
								<RecommendationItem
									label="Publish Directory"
									icon={
										<ChevronRight className="h-4 w-4 text-muted-foreground" />
									}
									value={scanResult.recommendedPublishDirectory}
									mono
								/>
							)}
						</div>

						{/* Detection signals */}
						<details className="text-xs text-muted-foreground cursor-pointer">
							<summary className="flex items-center gap-1 hover:text-foreground transition-colors">
								<AlertCircle className="h-3 w-3" />
								Why this recommendation?
							</summary>
							<ul className="mt-2 space-y-1 pl-4">
								{scanResult.signals.map((s, i) => (
									<li key={i} className="flex items-start gap-1">
										<CheckCircle2 className="h-3 w-3 mt-0.5 text-green-500 shrink-0" />
										{s}
									</li>
								))}
							</ul>
						</details>

						{onApply && (
							<Button
								size="sm"
								onClick={() => onApply(scanResult)}
								className="gap-2"
							>
								<CheckCircle2 className="h-3.5 w-3.5" />
								Apply Recommendations
							</Button>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
};

const RecommendationItem = ({
	label,
	icon,
	value,
	mono = false,
}: {
	label: string;
	icon: React.ReactNode;
	value: string;
	mono?: boolean;
}) => (
	<div className="flex items-start gap-2 p-2 bg-muted/50 rounded-lg">
		<span className="mt-0.5 shrink-0">{icon}</span>
		<div>
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-xs font-medium ${mono ? "font-mono" : ""}`}>
				{value}
			</p>
		</div>
	</div>
);
