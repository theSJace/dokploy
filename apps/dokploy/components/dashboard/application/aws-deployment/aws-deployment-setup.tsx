"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cloud, Globe, Server } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const AWS_REGIONS = [
	{ value: "us-east-1", label: "US East (N. Virginia)" },
	{ value: "us-east-2", label: "US East (Ohio)" },
	{ value: "us-west-1", label: "US West (N. California)" },
	{ value: "us-west-2", label: "US West (Oregon)" },
	{ value: "eu-west-1", label: "Europe (Ireland)" },
	{ value: "eu-west-2", label: "Europe (London)" },
	{ value: "eu-central-1", label: "Europe (Frankfurt)" },
	{ value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
	{ value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
	{ value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
	{ value: "sa-east-1", label: "South America (São Paulo)" },
];

const schema = z.object({
	awsAccessKeyId: z.string().min(1, "AWS Access Key ID is required"),
	awsSecretAccessKey: z.string().min(1, "AWS Secret Access Key is required"),
	awsRegion: z.string().min(1, "Region is required"),
	parentDomain: z
		.string()
		.optional()
		.refine(
			(val) => !val || /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(val),
			"Enter a valid domain (e.g. example.com)",
		),
	subdomain: z
		.string()
		.optional()
		.refine(
			(val) => !val || /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(val),
			"Enter a valid fully-qualified domain (e.g. myapp.example.com)",
		),
	buildCommand: z.string().optional(),
	publishDirectory: z.string().optional(),
	s3BucketName: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
	applicationId: string;
}

export const AwsDeploymentSetup = ({ applicationId }: Props) => {
	const utils = api.useUtils();

	const { data: existing } = api.awsDeployment.getByApplicationId.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);

	const { mutateAsync: configure, isPending } =
		api.awsDeployment.configure.useMutation();
	const { mutateAsync: provision, isPending: isProvisioning } =
		api.awsDeployment.provision.useMutation();

	const form = useForm<FormValues>({
		resolver: zodResolver(schema),
		defaultValues: {
			awsAccessKeyId: "",
			awsSecretAccessKey: "",
			awsRegion: "us-east-1",
			parentDomain: "",
			subdomain: "",
			buildCommand: "npm run build",
			publishDirectory: "dist",
			s3BucketName: "",
		},
	});

	// Populate form if config already exists
	useEffect(() => {
		if (existing) {
			form.reset({
				awsAccessKeyId: existing.awsAccessKeyId,
				awsSecretAccessKey: existing.awsSecretAccessKey,
				awsRegion: existing.awsRegion,
				parentDomain: existing.parentDomain ?? "",
				subdomain: existing.subdomain ?? "",
				buildCommand: existing.buildCommand ?? "npm run build",
				publishDirectory: existing.publishDirectory ?? "dist",
				s3BucketName: existing.s3BucketName ?? "",
			});
		}
	}, [existing, form]);

	const onSubmit = async (values: FormValues) => {
		await configure({
			applicationId,
			awsAccessKeyId: values.awsAccessKeyId,
			awsSecretAccessKey: values.awsSecretAccessKey,
			awsRegion: values.awsRegion,
			parentDomain: values.parentDomain || undefined,
			subdomain: values.subdomain || undefined,
			buildCommand: values.buildCommand || "npm run build",
			publishDirectory: values.publishDirectory || "dist",
			s3BucketName: values.s3BucketName || undefined,
		})
			.then(() => {
				toast.success("AWS deployment configuration saved");
				utils.awsDeployment.getByApplicationId.invalidate({ applicationId });
			})
			.catch(() => {
				toast.error("Error saving AWS deployment configuration");
			});
	};

	const handleProvision = async () => {
		await provision({ applicationId })
			.then(() => {
				toast.success(
					"Provisioning started — S3, CloudFront, and Route 53 are being set up",
				);
				utils.awsDeployment.getByApplicationId.invalidate({ applicationId });
			})
			.catch(() => {
				toast.error("Error starting provisioning");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Cloud className="h-5 w-5 text-orange-500" />
					AWS Static Hosting
				</CardTitle>
				<CardDescription>
					Automatically provision S3, CloudFront, and Route 53 to serve this
					application as a static site. The subdomain is created automatically
					in your Route 53 hosted zone.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
						{/* AWS Credentials */}
						<div className="space-y-4">
							<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
								AWS Credentials
							</h3>
							<FormField
								control={form.control}
								name="awsAccessKeyId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Access Key ID</FormLabel>
										<FormControl>
											<Input placeholder="AKIAIOSFODNN7EXAMPLE" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="awsSecretAccessKey"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Secret Access Key</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="awsRegion"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Region</FormLabel>
										<Select onValueChange={field.onChange} value={field.value}>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select region" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{AWS_REGIONS.map((r) => (
													<SelectItem key={r.value} value={r.value}>
														{r.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						{/* Domain */}
						<div className="space-y-4">
							<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
								Domain (Optional)
							</h3>
							<FormField
								control={form.control}
								name="parentDomain"
								render={({ field }) => (
									<FormItem>
										<FormLabel className="flex items-center gap-1">
											<Globe className="h-3.5 w-3.5" />
											Parent Domain
										</FormLabel>
										<FormControl>
											<Input placeholder="example.com" {...field} />
										</FormControl>
										<FormDescription>
											Your root domain hosted in Route 53 (e.g.{" "}
											<code>example.com</code>). When provided without a custom
											subdomain, the system automatically creates{" "}
											<code>&lt;app-name&gt;.example.com</code> in Route 53.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="subdomain"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Custom Subdomain (Optional Override)</FormLabel>
										<FormControl>
											<Input placeholder="myapp.example.com" {...field} />
										</FormControl>
										<FormDescription>
											Override the auto-generated subdomain with a specific
											fully-qualified domain. Leave blank to auto-generate from
											the Parent Domain above, or to use only the CloudFront URL
											if no Parent Domain is set.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="s3BucketName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>S3 Bucket Name (Optional)</FormLabel>
										<FormControl>
											<Input
												placeholder="Auto-generated if left blank"
												{...field}
											/>
										</FormControl>
										<FormDescription>
											Leave blank to auto-generate: dokploy-{"{appname}"}-
											{"{id}"}
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						{/* Build */}
						<div className="space-y-4">
							<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
								Build Configuration
							</h3>
							<FormField
								control={form.control}
								name="buildCommand"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Build Command</FormLabel>
										<FormControl>
											<Input placeholder="npm run build" {...field} />
										</FormControl>
										<FormDescription>
											Leave blank if the repository already contains pre-built
											files.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="publishDirectory"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Publish Directory</FormLabel>
										<FormControl>
											<Input placeholder="dist" {...field} />
										</FormControl>
										<FormDescription>
											Directory containing the static files to upload (e.g.
											dist, build, out, public).
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<div className="flex gap-3 flex-wrap">
							<Button type="submit" disabled={isPending}>
								{isPending ? "Saving…" : "Save Configuration"}
							</Button>
							{existing && existing.status !== "active" && (
								<Button
									type="button"
									variant="outline"
									onClick={handleProvision}
									disabled={isProvisioning}
								>
									<Server className="h-4 w-4 mr-2" />
									{isProvisioning
										? "Provisioning…"
										: "Provision AWS Infrastructure"}
								</Button>
							)}
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
