import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import {
  Bot, Download, Upload, Clock, CheckCircle, XCircle, Loader2, LogOut,
  FileSpreadsheet, Table2, DollarSign, TrendingUp, Building2, Users,
  HeartPulse, ShoppingCart, Home, MapPin, Info, Sparkles, X, Plus,
} from "lucide-react";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import ResultsSheet from "@/components/ResultsSheet";
import { ALL_TEMPLATES, getTemplate, TEMPLATE_SECTIONS, TEMPLATE_SYSTEM_PROMPTS, type AgentSection as TemplateAgentSection } from "@/lib/templates";

// ---------------------------------------------------------------------------
// Icon map for templates
// ---------------------------------------------------------------------------
const TEMPLATE_ICONS: Record<string, any> = {
  vc:          <TrendingUp className="h-4 w-4" />,
  b2b:         <Building2 className="h-4 w-4" />,
  people:      <Users className="h-4 w-4" />,
  healthcare:  <HeartPulse className="h-4 w-4" />,
  ecommerce:   <ShoppingCart className="h-4 w-4" />,
  realestate:  <Home className="h-4 w-4" />,
  local:       <MapPin className="h-4 w-4" />,
};

const TEMPLATE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  vc:          { bg: "bg-violet-50",  text: "text-violet-700",  border: "border-violet-400" },
  b2b:         { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-400" },
  people:      { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-400" },
  healthcare:  { bg: "bg-rose-50",    text: "text-rose-700",    border: "border-rose-400" },
  ecommerce:   { bg: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-400" },
  realestate:  { bg: "bg-teal-50",    text: "text-teal-700",    border: "border-teal-400" },
  local:       { bg: "bg-green-50",   text: "text-green-700",   border: "border-green-400" },
};

// Pre-fills the textarea with a good starting objective per template
const TEMPLATE_OBJECTIVES: Record<string, string> = {
  vc:         "Research investor type, investment stages, focus niches, team members, and portfolio companies for each VC firm",
  b2b:        "Find organization type, industry, size, key decision makers, and contact info for each company",
  people:     "Find each person's current role, company, professional background, skills, and contact information",
  healthcare: "Find facility type, specialties, key staff, services offered, and contact information for each healthcare provider",
  ecommerce:  "Find product categories, pricing strategy, customer reviews, shipping options, and market positioning for each store",
  realestate: "Find property types, listing prices, agent information, neighborhood details, and market positioning",
  local:      "Find business hours, services, customer reviews, pricing, and contact details for each local business",
};

const SUGGESTION_CHIPS = [
  { label: "VC due diligence",   text: "Research investor type, investment stages, focus sectors, team members, and portfolio companies for each VC firm" },
  { label: "B2B outreach",       text: "Find pain points, recent triggers, decision makers, and personalization hooks for cold email outreach" },
  { label: "Competitor analysis",text: "Find pricing, market positioning, key features, strengths and weaknesses, and recent moves" },
  { label: "Recruiting intel",   text: "Find open roles, hiring velocity, key departments, culture, and employer brand signals" },
  { label: "Website audit",      text: "Audit website quality, SEO health, technical issues, and improvement opportunities" },
  { label: "Market research",    text: "Find target customers, competitive landscape, growth trajectory, and recent trends" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PreviewData {
  fileUrl: string;
  fileKey: string;
  firmCount: number;
  avgDescriptionLength: number;
  costEstimate: {
    totalCost: number;
    totalCostLow?: number;
    totalCostHigh?: number;
    perFirmCost: number;
    estimatedDuration: string;
  };
  preview: Array<{
    companyName: string;
    websiteUrl: string;
    descriptionPreview: string;
  }>;
}

interface AgentSection {
  key: string;
  label: string;
  desc: string;
}

type WizardStep = "idle" | "configure" | "review";
type WizardMode = "ai" | "template";

// ---------------------------------------------------------------------------
// JobLogFeed — live per-URL status shown inside a processing job card
// ---------------------------------------------------------------------------
function JobLogFeed({ jobId }: { jobId: number }) {
  const { data: logs } = trpc.enrichment.getJobLogs.useQuery(
    { jobId },
    { refetchInterval: 3000 }
  );
  if (!logs || logs.length === 0) return null;
  const recent = logs.slice(-5);
  return (
    <div className="mt-3 space-y-1">
      {recent.map((log: any) => (
        <div key={log.id} className="flex items-center gap-2 text-xs">
          <span className={log.status === "success" ? "text-green-600 font-bold" : log.status === "partial" ? "text-amber-600 font-bold" : "text-red-500 font-bold"}>
            {log.status === "success" ? "✓" : log.status === "partial" ? "~" : "✗"}
          </span>
          <span className="text-muted-foreground truncate max-w-[180px]">{log.companyName || log.url}</span>
          {log.fieldsFilled != null && log.fieldsTotal != null && log.fieldsTotal > 0 && (
            <span className="text-muted-foreground ml-auto shrink-0">{log.fieldsFilled}/{log.fieldsTotal} fields</span>
          )}
          {log.errorReason && (
            <span className="text-red-400 shrink-0">{log.errorReason}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Dashboard() {
  const { user, loading: authLoading, logout } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);

  // Wizard state
  const [wizardStep, setWizardStep]           = useState<WizardStep>("idle");
  const [wizardMode, setWizardMode]           = useState<WizardMode>("ai");
  const [description, setDescription]         = useState("");
  const [wizardSections, setWizardSections]   = useState<AgentSection[]>([]);
  const [wizardSystemPrompt, setWizardSystemPrompt] = useState("");
  const [wizardObjective, setWizardObjective] = useState("");

  // Column mapping state
  const [showColumnMapping, setShowColumnMapping] = useState(false);
  const [fileHeaders, setFileHeaders] = useState<{
    columns: string[];
    sampleRows: Array<Record<string, string>>;
    autoDetected: { companyName?: string; websiteUrl?: string; description?: string };
  } | null>(null);
  // Maps each column name → role ("companyName" | "websiteUrl" | "description" | "")
  const [columnRoles, setColumnRoles] = useState<Record<string, string>>({});
  // Store fileUrl/fileKey for re-submit with mapping
  const [pendingFileUrl, setPendingFileUrl] = useState("");
  const [pendingFileKey, setPendingFileKey] = useState("");

  // Template mode state
  const [selectedTemplate, setSelectedTemplate] = useState<string>("vc");
  const [tierFilter, setTierFilter] = useState<"tier1" | "tier1-2" | "all">("all");
  const [templateSections, setTemplateSections] = useState<TemplateAgentSection[]>([]);

  const [viewResultsJob, setViewResultsJob] = useState<{ id: number; template: string; sectionsJson?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track whether the current uploadMutation call is a manual re-submit with explicit mapping
  const isManualMappingRef = useRef(false);

  const { data: jobs, isLoading: jobsLoading, refetch } = trpc.enrichment.listJobs.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 3000,
  });

  const isAdmin = user?.role === "admin";
  const [jobsTab, setJobsTab] = useState<"mine" | "all">("mine");
  const { data: allJobs } = trpc.enrichment.listAllJobsAdmin.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 3000,
  });

  const uploadMutation = trpc.enrichment.uploadAndPreview.useMutation({
    onSuccess: (data) => {
      // Always store headers + file references for column mapping
      if (data.headers) setFileHeaders(data.headers);
      setPendingFileUrl(data.fileUrl);
      setPendingFileKey(data.fileKey);

      // Only auto-fill roles on first upload, not after user re-submits with their manual mapping
      if (!isManualMappingRef.current) {
        const ad = data.headers.autoDetected;
        const roles: Record<string, string> = {};
        for (const col of data.headers.columns) roles[col] = "";
        if (ad.companyName) roles[ad.companyName] = "companyName";
        if (ad.websiteUrl) roles[ad.websiteUrl] = "websiteUrl";
        if (ad.description) roles[ad.description] = "description";
        setColumnRoles(roles);
      }
      isManualMappingRef.current = false;

      if (data.status === "needs_mapping") {
        // Auto-detect failed — show column mapping grid
        setShowColumnMapping(true);
        setUploading(false);
        toast.info("We couldn't auto-detect your columns. Please map them below.");
        return;
      }

      // status === "ready"
      const avgLen = data.preview.length > 0
        ? data.preview.reduce((s: number, f: any) => s + f.descriptionPreview.length, 0) / data.preview.length * 3
        : 200;
      setPreviewData({
        fileUrl: data.fileUrl,
        fileKey: data.fileKey,
        firmCount: data.firmCount,
        avgDescriptionLength: Math.round(avgLen),
        costEstimate: {
          totalCost: data.costEstimate.totalCost,
          totalCostLow: data.costEstimate.totalCostLow,
          totalCostHigh: data.costEstimate.totalCostHigh,
          perFirmCost: data.costEstimate.perFirmCost,
          estimatedDuration: data.costEstimate.estimatedDuration,
        },
        preview: data.preview,
      });
      setShowColumnMapping(false);
      setWizardStep("configure");
      setWizardSections([]);
      setDescription("");
      setUploading(false);
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
      setUploading(false);
    },
  });

  const generatePlanMutation = trpc.enrichment.generateExtractionPlan.useMutation({
    onSuccess: (data) => {
      setWizardSections(data.sections);
      setWizardSystemPrompt(data.systemPrompt);
      setWizardObjective(data.objective);
      toast.success(`Generated ${data.sections.length} extraction sections`);
    },
    onError: (error) => {
      toast.error(`Failed to generate plan: ${error.message}`);
    },
  });

  const confirmMutation = trpc.enrichment.confirmAndStart.useMutation({
    onSuccess: (data) => {
      toast.success(`Extraction started! Processing ${data.firmCount} entries.`);
      setWizardStep("idle");
      setPreviewData(null);
      setWizardSections([]);
      setDescription("");
      setWizardObjective("");
      setWizardSystemPrompt("");
      refetch();
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (error) => {
      toast.error(`Failed to start extraction: ${error.message}`);
    },
  });

  const resumeMutation = trpc.enrichment.resumeJob.useMutation({
    onSuccess: (data) => {
      toast.success(`Job resumed! ${data.remainingCount} entries remaining.`);
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to resume job: ${error.message}`);
    },
  });

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");
    const isCsv   = file.name.endsWith(".csv");
    if (!isExcel && !isCsv) {
      toast.error("Please upload an Excel (.xlsx, .xls) or CSV (.csv) file");
      return;
    }

    setUploading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      const fileData = base64.split(",")[1];
      if (!fileData) { toast.error("Failed to read file"); setUploading(false); return; }
      uploadMutation.mutate({ fileData, fileName: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleConfirmEnrichment = () => {
    if (!previewData) return;
    const isAgentMode = wizardMode === "ai" && wizardSections.length > 0;
    const isTemplateAgentMode = wizardMode === "template" && selectedTemplate !== "vc";

    const extraFields = isAgentMode
      ? { sectionsJson: JSON.stringify(wizardSections), systemPrompt: wizardSystemPrompt, objective: wizardObjective }
      : isTemplateAgentMode
      ? {
          sectionsJson: JSON.stringify(templateSections),
          systemPrompt: TEMPLATE_SYSTEM_PROMPTS[selectedTemplate] ?? "",
          objective: TEMPLATE_OBJECTIVES[selectedTemplate] ?? "",
        }
      : {};

    // Build columnMapping from columnRoles state (if user overrode defaults)
    const companyCol = Object.entries(columnRoles).find(([, r]) => r === "companyName")?.[0];
    const websiteCol = Object.entries(columnRoles).find(([, r]) => r === "websiteUrl")?.[0];
    const descCol = Object.entries(columnRoles).find(([, r]) => r === "description")?.[0];
    const columnMapping = companyCol && websiteCol ? {
      companyNameColumn: companyCol,
      websiteUrlColumn: websiteCol,
      descriptionColumn: descCol || undefined,
    } : undefined;

    confirmMutation.mutate({
      fileUrl: previewData.fileUrl,
      fileKey: previewData.fileKey,
      firmCount: previewData.firmCount,
      tierFilter: selectedTemplate === "vc" ? tierFilter : "all",
      template: selectedTemplate,
      avgDescriptionLength: previewData.avgDescriptionLength,
      columnMapping,
      ...extraFields,
    });
  };

  const handleColumnMappingSubmit = () => {
    const companyCol = Object.entries(columnRoles).find(([, r]) => r === "companyName")?.[0];
    const websiteCol = Object.entries(columnRoles).find(([, r]) => r === "websiteUrl")?.[0];
    const descCol = Object.entries(columnRoles).find(([, r]) => r === "description")?.[0];
    if (!companyCol || !websiteCol) {
      toast.error("Please assign both Company Name and Website URL to a column");
      return;
    }
    isManualMappingRef.current = true;
    uploadMutation.mutate({
      fileUrl: pendingFileUrl,
      fileKey: pendingFileKey,
      columnMapping: {
        companyNameColumn: companyCol,
        websiteUrlColumn: websiteCol,
        descriptionColumn: descCol || undefined,
      },
    });
    setShowColumnMapping(false);
    setUploading(true);
  };

  const handleCancelWizard = () => {
    setWizardStep("idle");
    setPreviewData(null);
    setWizardSections([]);
    setDescription("");
    setShowColumnMapping(false);
    setFileHeaders(null);
    setColumnRoles({});
    setPendingFileUrl("");
    setPendingFileKey("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // -------------------------------------------------------------------------
  // Auth states
  // -------------------------------------------------------------------------
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50">
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

  const displayedJobs: any[] = isAdmin && jobsTab === "all" ? (allJobs ?? []) : (jobs ?? []);
  const hasJobs = displayedJobs.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link href="/">
            <div className="flex items-center gap-2 cursor-pointer">
              <Bot className="h-8 w-8 text-primary" />
              <h1 className="text-2xl font-bold">Smart AI Data Scraper</h1>
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

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Upload Card */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-6 w-6" />
              Upload your list
            </CardTitle>
            <CardDescription>
              Excel (.xlsx) or CSV with columns: <strong>Name</strong>, <strong>Website URL</strong>, <strong>Description</strong> (optional — use as per-URL objective override).
              The scraper will visit each URL and extract structured data automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                disabled={uploading || wizardStep !== "idle"}
                className="flex-1"
              />
              <Button
                disabled={uploading || wizardStep !== "idle"}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Uploading...</>
                ) : (
                  <><FileSpreadsheet className="h-4 w-4 mr-2" />Select File</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Capability notice */}
        <div className="flex items-start gap-2 text-sm text-muted-foreground mb-6 px-1">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Works best on public websites. Social media profiles and login-protected pages have limited support.</span>
        </div>

        {/* ── Column Mapping Card (grid style) ── */}
        {showColumnMapping && fileHeaders && (
          <Card className="mb-6 border-2 border-amber-400">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Map Your Columns</CardTitle>
                <Button variant="ghost" size="sm" onClick={handleCancelWizard}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </div>
              <CardDescription>
                Use the dropdowns above each column to assign: <strong>Company Name</strong>, <strong>Website URL</strong>, and optionally <strong>Description</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Legend */}
              <div className="flex gap-3 mb-3 text-xs">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Company Name (required)</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Website URL (required)</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Description (optional)</span>
              </div>

              {/* Scrollable grid */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm border-collapse min-w-[600px]">
                  {/* Row 1: Role dropdowns */}
                  <thead>
                    <tr className="bg-muted/60">
                      {fileHeaders.columns.map((col) => {
                        const role = columnRoles[col] || "";
                        const roleColor = role === "companyName" ? "border-blue-500 bg-blue-50"
                          : role === "websiteUrl" ? "border-green-500 bg-green-50"
                          : role === "description" ? "border-amber-500 bg-amber-50"
                          : "border-border";
                        return (
                          <th key={col} className="p-1.5 text-left align-top min-w-[140px]">
                            <Select
                              value={role || "__skip__"}
                              onValueChange={(v: string) => {
                                const newRoles = { ...columnRoles };
                                // Clear this role from any other column first
                                if (v !== "__skip__") {
                                  for (const k of Object.keys(newRoles)) {
                                    if (newRoles[k] === v) newRoles[k] = "";
                                  }
                                }
                                newRoles[col] = v === "__skip__" ? "" : v;
                                setColumnRoles(newRoles);
                              }}
                            >
                              <SelectTrigger className={`h-8 text-xs border-2 ${roleColor}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__skip__">-- Skip --</SelectItem>
                                <SelectItem value="companyName">Company Name</SelectItem>
                                <SelectItem value="websiteUrl">Website URL</SelectItem>
                                <SelectItem value="description">Description</SelectItem>
                              </SelectContent>
                            </Select>
                          </th>
                        );
                      })}
                    </tr>
                    {/* Row 2: Column headers from file */}
                    <tr className="border-b bg-muted/30">
                      {fileHeaders.columns.map((col) => {
                        const role = columnRoles[col] || "";
                        const dotColor = role === "companyName" ? "bg-blue-500"
                          : role === "websiteUrl" ? "bg-green-500"
                          : role === "description" ? "bg-amber-500"
                          : "";
                        return (
                          <th key={col} className="px-3 py-2 text-left text-xs font-semibold text-foreground whitespace-nowrap">
                            <span className="flex items-center gap-1.5">
                              {dotColor && <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />}
                              {col}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  {/* Data rows */}
                  <tbody>
                    {fileHeaders.sampleRows.slice(0, 4).map((row, i) => (
                      <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-muted/10"}>
                        {fileHeaders.columns.map((col) => (
                          <td key={col} className="px-3 py-1.5 text-xs text-muted-foreground truncate max-w-[200px] border-t">
                            {row[col] || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer: status + confirm */}
              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  {fileHeaders.sampleRows.length > 4
                    ? `Showing 4 of ${fileHeaders.sampleRows.length} sample rows`
                    : `${fileHeaders.sampleRows.length} sample rows`}
                  {" · "}
                  {(() => {
                    const hasName = Object.values(columnRoles).includes("companyName");
                    const hasUrl = Object.values(columnRoles).includes("websiteUrl");
                    if (hasName && hasUrl) return <span className="text-green-600 font-medium">Ready</span>;
                    const missing = [!hasName && "Company Name", !hasUrl && "Website URL"].filter(Boolean);
                    return <span className="text-amber-600 font-medium">Missing: {missing.join(", ")}</span>;
                  })()}
                </p>
                <Button
                  onClick={handleColumnMappingSubmit}
                  disabled={
                    !Object.values(columnRoles).includes("companyName") ||
                    !Object.values(columnRoles).includes("websiteUrl") ||
                    uploadMutation.isPending
                  }
                >
                  {uploadMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing...</>
                  ) : (
                    "Confirm & Continue"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Configure ── */}
        {wizardStep === "configure" && previewData && (
          <Card className="mb-6 border-2 border-primary/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Configure Extraction</CardTitle>
                <Button variant="ghost" size="sm" onClick={handleCancelWizard}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </div>
              <CardDescription>
                {previewData.firmCount} entries ready · Choose how to extract data from each page
                {fileHeaders && (
                  <button
                    className="ml-2 text-xs text-primary underline hover:text-primary/80"
                    onClick={() => setShowColumnMapping(true)}
                  >
                    Edit column mapping
                  </button>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={wizardMode} onValueChange={(v) => setWizardMode(v as WizardMode)}>
                <TabsList className="mb-4">
                  <TabsTrigger value="ai">
                    <Sparkles className="h-4 w-4 mr-2" />
                    AI Custom Extraction
                  </TabsTrigger>
                  <TabsTrigger value="template">Use Template</TabsTrigger>
                </TabsList>

                {/* ── AI Custom tab ── */}
                <TabsContent value="ai" className="space-y-5">
                  {/* Template preset pills */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Quick-fill from a template:</p>
                    <div className="flex flex-wrap gap-2">
                      {ALL_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          onClick={() => setDescription(TEMPLATE_OBJECTIVES[tpl.id] ?? "")}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors
                            ${description === TEMPLATE_OBJECTIVES[tpl.id]
                              ? `${TEMPLATE_COLORS[tpl.id]?.bg} ${TEMPLATE_COLORS[tpl.id]?.border} ${TEMPLATE_COLORS[tpl.id]?.text}`
                              : "border-border hover:bg-muted/50 text-muted-foreground"
                            }`}
                        >
                          {TEMPLATE_ICONS[tpl.id]}
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Suggestion chips */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Or pick a use case:</p>
                    <div className="flex flex-wrap gap-2">
                      {SUGGESTION_CHIPS.map((chip) => (
                        <button
                          key={chip.label}
                          onClick={() => setDescription(chip.text)}
                          className={`px-3 py-1 rounded-full border text-xs font-medium transition-colors
                            ${description === chip.text
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border hover:bg-muted/50 text-muted-foreground"
                            }`}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Objective textarea */}
                  <div className="space-y-2">
                    <Label htmlFor="description">What do you want to extract?</Label>
                    <Textarea
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="e.g. Find each VC firm's investment focus, portfolio companies, and key team members. Include check size range and geographic focus..."
                      rows={4}
                      className="resize-none"
                    />
                    <p className="text-xs text-muted-foreground">
                      Be specific — mention the fields you want as columns in the output.
                    </p>
                  </div>

                  {/* Generate button */}
                  <Button
                    onClick={() => generatePlanMutation.mutate({ description })}
                    disabled={description.trim().length < 10 || generatePlanMutation.isPending}
                    className="w-full sm:w-auto"
                  >
                    {generatePlanMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating plan...</>
                    ) : (
                      <><Sparkles className="h-4 w-4 mr-2" />Generate Extraction Plan</>
                    )}
                  </Button>

                  {/* Generated sections */}
                  {wizardSections.length > 0 && (
                    <div className="space-y-3 pt-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">
                          Extraction Sections
                          <span className="ml-2 text-muted-foreground font-normal">
                            ({wizardSections.length} output columns)
                          </span>
                        </p>
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => generatePlanMutation.mutate({ description })}
                          disabled={generatePlanMutation.isPending}
                        >
                          Regenerate
                        </button>
                      </div>

                      <div className="space-y-2">
                        {wizardSections.map((section, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 p-3 rounded-lg border bg-muted/20"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">{section.label}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{section.desc}</p>
                            </div>
                            <button
                              onClick={() => setWizardSections(wizardSections.filter((_, j) => j !== i))}
                              className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0"
                              title="Remove section"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        <AddSectionRow onAdd={(s) => setWizardSections([...wizardSections, s])} />
                      </div>

                      <div className="flex justify-end pt-1">
                        <Button onClick={() => setWizardStep("review")}>
                          Next →
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* ── Template tab ── */}
                <TabsContent value="template" className="space-y-5">
                  <div>
                    <Label className="text-sm font-semibold mb-3 block">Select Template</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {ALL_TEMPLATES.map((tpl) => {
                        const isSelected = selectedTemplate === tpl.id;
                        const colors = TEMPLATE_COLORS[tpl.id] ?? TEMPLATE_COLORS.vc;
                        return (
                          <button
                            key={tpl.id}
                            onClick={() => {
                              setSelectedTemplate(tpl.id);
                              if (tpl.id !== "vc") {
                                setTemplateSections(TEMPLATE_SECTIONS[tpl.id] ?? []);
                              } else {
                                setTemplateSections([]);
                              }
                            }}
                            className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 text-center transition-all ${
                              isSelected
                                ? `${colors.bg} ${colors.border} ${colors.text}`
                                : "border-border hover:border-muted-foreground/40 hover:bg-muted/30"
                            }`}
                          >
                            <span className={isSelected ? colors.text : "text-muted-foreground"}>
                              {TEMPLATE_ICONS[tpl.id]}
                            </span>
                            <span className="text-xs font-medium leading-tight">{tpl.name}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {getTemplate(selectedTemplate).description}
                    </p>
                  </div>

                  {/* What will be extracted */}
                  <div>
                    <Label className="text-sm font-semibold mb-3 block">What will be extracted</Label>
                    <Accordion type="single" collapsible defaultValue={getTemplate(selectedTemplate).sheets[0]?.key}>
                      {getTemplate(selectedTemplate).sheets.map((sheet) => (
                        <AccordionItem key={sheet.key} value={sheet.key}>
                          <AccordionTrigger className="text-sm font-medium">
                            {sheet.label}
                            <Badge variant="secondary" className="ml-2 text-xs">{sheet.fields.length} fields</Badge>
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="flex flex-wrap gap-1 pt-1">
                              {sheet.fields.map((f) => (
                                <Badge key={f.key} variant="outline" className="text-xs">{f.label}</Badge>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>

                  {/* Editable sections for non-VC templates */}
                  {selectedTemplate !== "vc" && templateSections.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-semibold">Extraction Sections <span className="font-normal text-muted-foreground">(edit to customize)</span></Label>
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground underline"
                          onClick={() => setTemplateSections(TEMPLATE_SECTIONS[selectedTemplate] ?? [])}
                        >
                          Reset to defaults
                        </button>
                      </div>
                      <div className="space-y-2">
                        {templateSections.map((s, i) => (
                          <div
                            key={s.key}
                            className="flex items-start gap-2 p-3 rounded-lg border bg-muted/20"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">{s.label}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{s.desc}</p>
                            </div>
                            <button
                              onClick={() => setTemplateSections(templateSections.filter((_, j) => j !== i))}
                              className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0"
                              title="Remove section"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <AddSectionRow onAdd={(s) => setTemplateSections([...templateSections, s])} />
                    </div>
                  )}

                  {/* Team Coverage — VC template only */}
                  {selectedTemplate === "vc" && (
                    <div className="space-y-3">
                      <Label className="text-sm font-semibold">Team Coverage</Label>
                      <RadioGroup value={tierFilter} onValueChange={(v: any) => setTierFilter(v)}>
                        {[
                          { value: "tier1",   label: "Decision Makers Only", desc: "Managing Partners, GPs, Investment Partners" },
                          { value: "tier1-2", label: "Decision Makers + Influencers (Recommended)", desc: "Partners, Principals, Senior Associates" },
                          { value: "all",     label: "Full Team", desc: "All investment-facing team members" },
                        ].map((opt) => (
                          <div key={opt.value} className="flex items-start space-x-3 space-y-0">
                            <RadioGroupItem value={opt.value} id={opt.value} />
                            <Label htmlFor={opt.value} className="font-normal cursor-pointer">
                              <p className="font-medium">{opt.label}</p>
                              <p className="text-sm text-muted-foreground">{opt.desc}</p>
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <Button onClick={() => setWizardStep("review")}>
                      Next →
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Review & Start ── */}
        {wizardStep === "review" && previewData && (
          <Card className="mb-6 border-2 border-primary/40">
            <CardHeader>
              <CardTitle className="text-lg">Review & Start</CardTitle>
              <CardDescription>
                Confirm your extraction settings before processing begins
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Stats row */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Entries</p>
                  <p className="text-2xl font-bold">{previewData.firmCount}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Estimated Cost</p>
                  {previewData.costEstimate.totalCostLow != null && previewData.costEstimate.totalCostHigh != null ? (
                    <>
                      <p className="text-xl font-bold text-green-700">
                        ${previewData.costEstimate.totalCostLow.toFixed(2)} – ${previewData.costEstimate.totalCostHigh.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">${previewData.costEstimate.perFirmCost.toFixed(4)}/site</p>
                    </>
                  ) : (
                    <p className="text-2xl font-bold">${previewData.costEstimate.totalCost.toFixed(2)}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Est. Duration</p>
                  <p className="text-2xl font-bold">{previewData.costEstimate.estimatedDuration}</p>
                </div>
              </div>

              {/* Extraction configuration summary */}
              {wizardMode === "ai" && wizardSections.length > 0 ? (
                <div>
                  <p className="text-sm font-semibold mb-2">
                    AI Custom Extraction · {wizardSections.length} sections
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {wizardSections.map((s) => (
                      <Badge key={s.key} variant="outline" className="text-xs">{s.label}</Badge>
                    ))}
                  </div>
                  {wizardObjective && (
                    <p className="text-xs text-muted-foreground mt-2 italic">
                      Objective: {wizardObjective}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold">
                    Template: {getTemplate(selectedTemplate).name}
                  </p>
                  {selectedTemplate === "vc" && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Team coverage: {tierFilter === "tier1" ? "Decision makers only" : tierFilter === "tier1-2" ? "Decision makers + influencers" : "Full team"}
                    </p>
                  )}
                </div>
              )}

              {/* Preview rows */}
              {previewData.preview.length > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2">Preview (first {previewData.preview.length} rows)</p>
                  <div className="space-y-2">
                    {previewData.preview.map((row, i) => (
                      <div key={i} className="p-3 rounded-lg border bg-muted/20">
                        <p className="font-medium text-sm">{row.companyName}</p>
                        <p className="text-xs text-muted-foreground">{row.websiteUrl}</p>
                        {row.descriptionPreview && (
                          <p className="text-xs text-muted-foreground mt-1 opacity-75">{row.descriptionPreview}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" onClick={() => setWizardStep("configure")}>
                  ← Back
                </Button>
                <Button onClick={handleConfirmEnrichment} disabled={confirmMutation.isPending} size="lg">
                  {confirmMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Starting...</>
                  ) : (
                    "Start Extraction"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Jobs List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Extraction Jobs</CardTitle>
                <CardDescription>Track your jobs and download results</CardDescription>
              </div>
              {isAdmin && (
                <div className="flex rounded-md border overflow-hidden text-sm">
                  <button
                    onClick={() => setJobsTab("mine")}
                    className={`px-3 py-1.5 transition-colors ${jobsTab === "mine" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  >
                    My Jobs
                  </button>
                  <button
                    onClick={() => setJobsTab("all")}
                    className={`px-3 py-1.5 transition-colors border-l ${jobsTab === "all" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  >
                    All Jobs (Admin)
                  </button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {jobsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : hasJobs ? (
              <div className="space-y-4">
                {displayedJobs.map((job) => {
                  const progress = job.firmCount && job.firmCount > 0
                    ? Math.round(((job.processedCount || 0) / job.firmCount) * 100)
                    : 0;
                  const isProcessing = job.status === "processing";
                  const jobTemplate = (job as any).template || "vc";
                  const tpl = getTemplate(jobTemplate);
                  const colors = TEMPLATE_COLORS[jobTemplate] ?? TEMPLATE_COLORS.vc;
                  const isAgentJob = !!(job as any).sectionsJson;

                  return (
                    <Card key={job.id} className="border-2">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              {job.status === "completed"  && <CheckCircle className="h-5 w-5 text-green-600" />}
                              {job.status === "failed"     && <XCircle className="h-5 w-5 text-red-600" />}
                              {job.status === "processing" && <Loader2 className="h-5 w-5 animate-spin text-blue-600" />}
                              {job.status === "pending"    && <Clock className="h-5 w-5 text-gray-600" />}
                              <span className="font-semibold capitalize">{job.status}</span>
                              {isAgentJob ? (
                                <Badge variant="outline" className="text-xs text-violet-700">
                                  <Sparkles className="h-3 w-3 mr-1" />
                                  AI Custom
                                </Badge>
                              ) : (
                                <Badge variant="outline" className={`text-xs ${colors.text}`}>
                                  {tpl.name}
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {isAdmin && jobsTab === "all" && (
                                <span className="mr-1 font-medium text-violet-600">User #{job.userId} ·</span>
                              )}
                              {job.firmCount} entries · {new Date(job.createdAt).toLocaleDateString()}
                            </p>

                            {/* Live cost counter (processing) */}
                            {isProcessing && (job as any).totalCostUSD != null && (
                              <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                                <DollarSign className="h-3.5 w-3.5" />
                                <span className="font-mono font-medium">${Number((job as any).totalCostUSD).toFixed(4)}</span>
                                {(job as any).estimatedCostUSD && (
                                  <span className="text-xs opacity-70 ml-1">
                                    / est. ${Number((job as any).estimatedCostUSD).toFixed(2)}
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Actual vs estimated cost (completed) */}
                            {job.status === "completed" && (job as any).totalCostUSD && (
                              <div className="text-sm text-muted-foreground mt-1">
                                Cost: <span className="font-mono font-medium">${Number((job as any).totalCostUSD).toFixed(4)}</span>
                                {(job as any).estimatedCostUSD && (
                                  <span className="text-xs opacity-60 ml-1">
                                    (est. ${Number((job as any).estimatedCostUSD).toFixed(2)})
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2">
                            {job.status === "completed" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setViewResultsJob({ id: job.id, template: jobTemplate, sectionsJson: (job as any).sectionsJson ?? undefined })}
                                >
                                  <Table2 className="h-4 w-4 mr-2" />
                                  View Results
                                </Button>
                                <DownloadResultsButton jobId={job.id} outputFileUrl={job.outputFileUrl} />
                              </>
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

                        {isProcessing && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">
                                {job.processedCount || 0} / {job.firmCount} processed
                              </span>
                              <span className="font-semibold">{progress}%</span>
                            </div>
                            <Progress value={progress} className="h-2" />
                            {job.activeFirmsJson && (() => {
                              const active: string[] = (() => { try { return JSON.parse(job.activeFirmsJson!); } catch { return []; } })();
                              return active.length > 0 ? (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {active.slice(0, 5).map((name) => (
                                    <span key={name} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                      {name}
                                    </span>
                                  ))}
                                  {active.length > 5 && (
                                    <span className="text-xs text-muted-foreground px-2 py-0.5">+{active.length - 5} more</span>
                                  )}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        )}

                        {isProcessing && job.sectionsJson && (
                          <JobLogFeed jobId={job.id} />
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
              /* Empty state onboarding */
              <div className="py-6">
                <h3 className="font-semibold text-lg mb-6 text-center">How it works</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                  <OnboardingStep
                    step={1}
                    title="Prepare your file"
                    description="Create a spreadsheet with columns: Name, Website URL, and an optional Description for per-URL objective override."
                  />
                  <OnboardingStep
                    step={2}
                    title="Describe what to extract"
                    description="Type your research goal and let AI generate a custom extraction plan, or pick from ready-made templates."
                  />
                  <OnboardingStep
                    step={3}
                    title="Download results"
                    description="The scraper visits each site and extracts structured data. Download the Excel when done."
                  />
                </div>
                <div className="bg-muted/40 rounded-lg p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Example file format:</p>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-1 pr-4 font-medium">Name</th>
                        <th className="text-left py-1 pr-4 font-medium">Website URL</th>
                        <th className="text-left py-1 font-medium">Description (optional)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-muted">
                        <td className="py-1 pr-4">Acme Corp</td>
                        <td className="py-1 pr-4">https://acme.com</td>
                        <td className="py-1 text-muted-foreground">Focus on their pricing and team</td>
                      </tr>
                      <tr>
                        <td className="py-1 pr-4">Beta Inc</td>
                        <td className="py-1 pr-4">https://beta.io</td>
                        <td className="py-1 text-muted-foreground"></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Results Sheet */}
      {viewResultsJob !== null && (
        <ResultsSheet
          jobId={viewResultsJob.id}
          open={viewResultsJob !== null}
          onClose={() => setViewResultsJob(null)}
          template={viewResultsJob.template}
          sectionsJson={viewResultsJob.sectionsJson}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OnboardingStep({ step, title, description }: { step: number; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center text-center p-4 bg-muted/30 rounded-lg">
      <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm mb-3">
        {step}
      </div>
      <h4 className="font-semibold text-sm mb-1">{title}</h4>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function AddSectionRow({ onAdd }: { onAdd: (s: AgentSection) => void }) {
  const [label, setLabel] = useState("");

  const submit = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    onAdd({
      key: trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
      label: trimmed,
      desc: `Extract information about ${trimmed.toLowerCase()}.`,
    });
    setLabel("");
  };

  return (
    <div className="flex gap-2">
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Add a section (e.g. Team Size)"
        className="text-sm"
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <Button variant="outline" size="sm" onClick={submit} disabled={!label.trim()}>
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

function DownloadResultsButton({ jobId }: { jobId: number; outputFileUrl?: string | null }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const generateMutation = trpc.enrichment.generateResults.useMutation({
    onSuccess: (data) => {
      toast.success(`Results ready! ${data.firmCount} entries`);
      const byteCharacters = atob(data.fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNumbers)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
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

  return (
    <Button
      size="sm"
      onClick={() => { setIsGenerating(true); generateMutation.mutate({ jobId }); }}
      disabled={isGenerating || generateMutation.isPending}
    >
      {isGenerating || generateMutation.isPending ? (
        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</>
      ) : (
        <><Download className="h-4 w-4 mr-2" />Download Results</>
      )}
    </Button>
  );
}
