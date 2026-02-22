import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { Download, Upload, Clock, CheckCircle, XCircle, Loader2, TrendingUp, LogOut, FileSpreadsheet, Users } from "lucide-react";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { Link } from "wouter";

interface PreviewData {
  fileUrl: string;
  fileKey: string;
  firmCount: number;
  costEstimate: {
    totalCost: number;
    perFirmCost: number;
    estimatedDuration: string;
  };
  preview: Array<{
    companyName: string;
    websiteUrl: string;
    descriptionPreview: string;
  }>;
}

export default function Dashboard() {
  const { user, loading: authLoading, logout } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [tierFilter, setTierFilter] = useState<"tier1" | "tier1-2" | "all">("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: jobs, isLoading: jobsLoading, refetch } = trpc.enrichment.listJobs.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 3000, // Poll every 3 seconds for real-time updates
  });

  const uploadMutation = trpc.enrichment.uploadAndPreview.useMutation({
    onSuccess: (data) => {
      setPreviewData(data);
      setShowPreview(true);
      setUploading(false);
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
      setUploading(false);
    },
  });

  const confirmMutation = trpc.enrichment.confirmAndStart.useMutation({
    onSuccess: (data) => {
      toast.success(`Enrichment started! Processing ${data.firmCount} VC firms.`);
      setShowPreview(false);
      setPreviewData(null);
      refetch();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    onError: (error) => {
      toast.error(`Failed to start enrichment: ${error.message}`);
    },
  });

  const resumeMutation = trpc.enrichment.resumeJob.useMutation({
    onSuccess: (data) => {
      toast.success(`Job resumed! ${data.remainingCount} firms remaining.`);
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to resume job: ${error.message}`);
    },
  });

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");
    const isCsv = file.name.endsWith(".csv");
    
    if (!isExcel && !isCsv) {
      toast.error("Please upload an Excel (.xlsx, .xls) or CSV (.csv) file");
      return;
    }

    setUploading(true);

    try {
      // Read file as base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        const fileData = base64.split(",")[1]; // Remove data:application/... prefix

        if (!fileData) {
          toast.error("Failed to read file");
          setUploading(false);
          return;
        }

        uploadMutation.mutate({
          fileData,
          fileName: file.name,
        });
      };
      reader.readAsDataURL(file);
    } catch (error) {
      toast.error("Failed to read file");
      setUploading(false);
    }
  };

  const handleConfirmEnrichment = () => {
    if (!previewData) return;

    confirmMutation.mutate({
      fileUrl: previewData.fileUrl,
      fileKey: previewData.fileKey,
      firmCount: previewData.firmCount,
      tierFilter,
    });
  };

  const getTierFilterDescription = (filter: string) => {
    switch (filter) {
      case "tier1":
        return "Primary Decision Makers only (Managing Partners, General Partners, Investment Partners)";
      case "tier1-2":
        return "Decision Makers & Influencers (Partners, Principals, Senior Associates)";
      case "all":
        return "All investment team members (excludes operations, marketing, HR, etc.)";
      default:
        return "";
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Authentication Required</CardTitle>
            <CardDescription>Please sign in to access the dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href={getLoginUrl()}>Sign In</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link href="/">
            <div className="flex items-center gap-2 cursor-pointer">
              <TrendingUp className="h-8 w-8 text-primary" />
              <h1 className="text-2xl font-bold">VC Enrichment</h1>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <Button variant="outline" size="sm" onClick={() => logout()}>
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Upload Section */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-6 w-6" />
              Upload VC Firms
            </CardTitle>
            <CardDescription>
              Upload an Excel (.xlsx, .xls) or CSV (.csv) file with columns: Company Name (or Company), Company Website URL (or Corporate Website), and LinkedIn Description (or Description)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                disabled={uploading}
                className="flex-1"
              />
              <Button disabled={uploading}>
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Select File
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Jobs List */}
        <Card>
          <CardHeader>
            <CardTitle>Enrichment Jobs</CardTitle>
            <CardDescription>Track your enrichment jobs and download results</CardDescription>
          </CardHeader>
          <CardContent>
            {jobsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : jobs && jobs.length > 0 ? (
              <div className="space-y-4">
                {jobs.map((job) => {
                  const progress = job.firmCount && job.firmCount > 0 
                    ? Math.round(((job.processedCount || 0) / job.firmCount) * 100) 
                    : 0;
                  const isProcessing = job.status === "processing";
                  
                  return (
                    <Card key={job.id} className="border-2">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              {job.status === "completed" && <CheckCircle className="h-5 w-5 text-green-600" />}
                              {job.status === "failed" && <XCircle className="h-5 w-5 text-red-600" />}
                              {job.status === "processing" && <Loader2 className="h-5 w-5 animate-spin text-blue-600" />}
                              {job.status === "pending" && <Clock className="h-5 w-5 text-gray-600" />}
                              <span className="font-semibold capitalize">{job.status}</span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {job.firmCount} firms • Created {new Date(job.createdAt).toLocaleDateString()}
                            </p>
                            {job.tierFilter && job.tierFilter !== "all" && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Filter: {job.tierFilter === "tier1" ? "Tier 1 Only" : "Tiers 1-2"}
                              </p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {job.status === "completed" && (
                              <DownloadResultsButton jobId={job.id} outputFileUrl={job.outputFileUrl} />
                            )}
                            {job.status === "failed" && (
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={() => resumeMutation.mutate({ jobId: job.id })}
                                disabled={resumeMutation.isPending}
                              >
                                {resumeMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                  <Clock className="h-4 w-4 mr-2" />
                                )}
                                Resume
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Progress Bar for Processing Jobs */}
                        {isProcessing && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">
                                Progress: {job.processedCount || 0} / {job.firmCount} firms
                              </span>
                              <span className="font-semibold">{progress}%</span>
                            </div>
                            <Progress value={progress} className="h-2" />
                            {job.currentFirmName && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                <span>Currently processing: <span className="font-medium">{job.currentFirmName}</span></span>
                                {job.currentTeamMemberCount !== null && job.currentTeamMemberCount > 0 && (
                                  <span className="flex items-center gap-1">
                                    <Users className="h-3 w-3" />
                                    {job.currentTeamMemberCount} members found
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {job.status === "failed" && job.errorMessage && (
                          <p className="text-sm text-red-600 mt-2">{job.errorMessage}</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FileSpreadsheet className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No enrichment jobs yet. Upload a file to get started!</p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirm Enrichment</DialogTitle>
            <DialogDescription>
              Review the details and select team member filtering options before starting enrichment.
            </DialogDescription>
          </DialogHeader>

          {previewData && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Total Firms</p>
                  <p className="text-2xl font-bold">{previewData.firmCount}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Estimated Cost</p>
                  <p className="text-2xl font-bold">${previewData.costEstimate.totalCost.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">
                    ${previewData.costEstimate.perFirmCost.toFixed(4)} per firm
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Estimated Duration</p>
                  <p className="text-2xl font-bold">{previewData.costEstimate.estimatedDuration}</p>
                </div>
              </div>

              {/* Tier Filter */}
              <div className="space-y-3">
                <Label className="text-base font-semibold">Team Member Filter</Label>
                <RadioGroup value={tierFilter} onValueChange={(value: any) => setTierFilter(value)}>
                  <div className="flex items-start space-x-3 space-y-0">
                    <RadioGroupItem value="tier1" id="tier1" />
                    <Label htmlFor="tier1" className="font-normal cursor-pointer">
                      <div>
                        <p className="font-medium">Tier 1 Only (Fastest)</p>
                        <p className="text-sm text-muted-foreground">
                          {getTierFilterDescription("tier1")}
                        </p>
                      </div>
                    </Label>
                  </div>
                  <div className="flex items-start space-x-3 space-y-0">
                    <RadioGroupItem value="tier1-2" id="tier1-2" />
                    <Label htmlFor="tier1-2" className="font-normal cursor-pointer">
                      <div>
                        <p className="font-medium">Tiers 1-2 (Recommended)</p>
                        <p className="text-sm text-muted-foreground">
                          {getTierFilterDescription("tier1-2")}
                        </p>
                      </div>
                    </Label>
                  </div>
                  <div className="flex items-start space-x-3 space-y-0">
                    <RadioGroupItem value="all" id="all" />
                    <Label htmlFor="all" className="font-normal cursor-pointer">
                      <div>
                        <p className="font-medium">All Team Members (Most Comprehensive)</p>
                        <p className="text-sm text-muted-foreground">
                          {getTierFilterDescription("all")}
                        </p>
                      </div>
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Preview */}
              <div>
                <h3 className="font-semibold mb-3">Preview (First 5 Firms)</h3>
                <div className="space-y-2">
                  {previewData.preview.map((firm, index) => (
                    <Card key={index}>
                      <CardContent className="pt-4">
                        <p className="font-medium">{firm.companyName}</p>
                        <p className="text-sm text-muted-foreground">{firm.websiteUrl}</p>
                        <p className="text-xs text-muted-foreground mt-1">{firm.descriptionPreview}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreview(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmEnrichment} disabled={confirmMutation.isPending}>
              {confirmMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Starting...
                </>
              ) : (
                "Start Enrichment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Download Results Button Component with On-Demand Generation
function DownloadResultsButton({ jobId, outputFileUrl }: { jobId: number; outputFileUrl: string | null }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const generateMutation = trpc.enrichment.generateResults.useMutation({
    onSuccess: (data) => {
      toast.success(`Results ready! ${data.firmCount} firms, ${data.teamMemberCount} team members`);
      
      // Convert base64 to blob and trigger download
      const byteCharacters = atob(data.fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = data.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      setIsGenerating(false);
    },
    onError: (error) => {
      toast.error(`Failed to generate results: ${error.message}`);
      setIsGenerating(false);
    },
  });

  const handleDownload = () => {
    // Always generate file on-demand from database
    setIsGenerating(true);
    generateMutation.mutate({ jobId });
  };

  return (
    <Button 
      size="sm" 
      onClick={handleDownload}
      disabled={isGenerating || generateMutation.isPending}
    >
      {isGenerating || generateMutation.isPending ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Generating...
        </>
      ) : (
        <>
          <Download className="h-4 w-4 mr-2" />
          Download Results
        </>
      )}
    </Button>
  );
}
