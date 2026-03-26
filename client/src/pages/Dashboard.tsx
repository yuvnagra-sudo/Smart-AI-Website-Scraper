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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import {
  Bot, Download, Upload, Clock, CheckCircle, XCircle, Loader2, LogOut,
  FileSpreadsheet, Table2, DollarSign, TrendingUp, Building2, Users,
  HeartPulse, ShoppingCart, Home, MapPin, Info, Sparkles, X, Plus, List, Search,
  PauseCircle, PlayCircle, ChevronDown, ChevronUp, AlertCircle,
} from "lucide-react";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import ResultsSheet from "@/components/ResultsSheet";
import { ALL_TEMPLATES, getTemplate, TEMPLATE_SECTIONS, TEMPLATE_SYSTEM_PROMPTS, type AgentSection as TemplateAgentSection } from "@/lib/templates";
import type { SkillContext } from "../../../shared/skillContext";

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
  directory:   <List className="h-4 w-4" />,
};

const TEMPLATE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  vc:          { bg: "bg-violet-50",  text: "text-violet-700",  border: "border-violet-400" },
  b2b:         { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-400" },
  people:      { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-400" },
  healthcare:  { bg: "bg-rose-50",    text: "text-rose-700",    border: "border-rose-400" },
  ecommerce:   { bg: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-400" },
  realestate:  { bg: "bg-teal-50",    text: "text-teal-700",    border: "border-teal-400" },
  local:       { bg: "bg-green-50",   text: "text-green-700",   border: "border-green-400" },
  directory:   { bg: "bg-slate-50",   text: "text-slate-700",   border: "border-slate-400" },
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
  directory:  "Visit each company's own website from the directory listing and extract their description, services, team size, location, and key contact",
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

type DiscoverResult = {
  status: "ready";
  fileUrl: string; fileKey: string;
  firmCount: number; avgDescriptionLength: number; pagesVisited: number;
  costEstimate: { totalCost: number; totalCostLow: number; totalCostHigh: number; perFirmCost: number; estimatedDuration: string };
  preview: { companyName: string; websiteUrl: string; descriptionPreview: string }[];
  headers: { columns: string[]; sampleRows: Record<string, string>[]; autoDetected: { companyName?: string; websiteUrl?: string } };
};

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
  const [wizardSkillContext, setWizardSkillContext] = useState<SkillContext | null>(null);
  const [showSkillRefine, setShowSkillRefine] = useState(false);

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

  // Job list UI state
  const [expandedJobIds, setExpandedJobIds] = useState<Set<number>>(new Set());
  const [visibleJobCount, setVisibleJobCount] = useState(10);

  // Upload mode: file upload, paste URLs, or crawl a directory
  const [uploadMode, setUploadMode] = useState<"file" | "paste" | "crawl">("file");
  const [manualUrls, setManualUrls] = useState("");
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlMaxPages, setCrawlMaxPages] = useState(5);

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
        setShowColumnMapping(true);
        setUploading(false);
        if ((data as any).mappingError) {
          toast.error(`Column mapping failed: ${(data as any).mappingError}`);
        } else {
          toast.info("We couldn't auto-detect your columns. Please map them below.");
        }
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
      setWizardSkillContext(data.skillContext ?? null);
      setShowSkillRefine(false);
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
      setWizardSkillContext(null);
      setShowSkillRefine(false);
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
  const cancelMutation = trpc.enrichment.cancelJob.useMutation({
    onSuccess: () => {
      toast.success("Job cancellation requested — will stop within 5 seconds.");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to cancel job: ${error.message}`);
    },
  });

  const pauseMutation = trpc.enrichment.pauseJob.useMutation({
    onSuccess: () => {
      toast.success("Job paused — partial results will be available for download shortly.");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to pause job: ${error.message}`);
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
      ? {
          sectionsJson: JSON.stringify(wizardSections),
          systemPrompt: wizardSystemPrompt,
          objective: wizardObjective,
          skillContextJson: wizardSkillContext ? JSON.stringify(wizardSkillContext) : undefined,
        }
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
    const columnMapping = websiteCol ? {
      companyNameColumn: companyCol || undefined,
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
    if (!websiteCol) {
      toast.error("Please assign a Website URL column");
      return;
    }
    isManualMappingRef.current = true;
    uploadMutation.mutate({
      fileUrl: pendingFileUrl,
      fileKey: pendingFileKey,
      columnMapping: {
        companyNameColumn: companyCol || undefined,
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
    setCrawlUrl("");
    setCrawlMaxPages(5);
  };

  const handleUrlSubmit = () => {
    const urls = manualUrls
      .split("\n")
      .map((u: string) => u.trim())
      .filter((u: string) => u.startsWith("http"));
    if (urls.length === 0) { toast.error("No valid URLs found — each line should start with http"); return; }
    // Build minimal CSV: header + one row per URL with empty company name
    const csv = "Company Name,Website URL\n" + urls.map((u: string) => `"","${u}"`).join("\n");
    // Encode as base64 (UTF-8 safe via TextEncoder)
    const bytes = new TextEncoder().encode(csv);
    let binary = "";
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    const base64 = btoa(binary);
    setUploading(true);
    uploadMutation.mutate({ fileData: base64, fileName: "manual-urls.csv" });
  };

  const discoverMutation = trpc.enrichment.discoverFromUrl.useMutation({
    onSuccess: (data: DiscoverResult) => {
      setPendingFileUrl(data.fileUrl);
      setPendingFileKey(data.fileKey);
      setColumnRoles({ "Company Name": "companyName", "Website URL": "websiteUrl" });
      setFileHeaders(data.headers);
      setPreviewData({
        fileUrl: data.fileUrl,
        fileKey: data.fileKey,
        firmCount: data.firmCount,
        avgDescriptionLength: data.avgDescriptionLength,
        costEstimate: data.costEstimate,
        preview: data.preview,
      });
      setWizardStep("configure");
      setUploading(false);
      toast.success(`Found ${data.firmCount} entries across ${data.pagesVisited} page${data.pagesVisited !== 1 ? "s" : ""}`);
    },
    onError: (error: { message: string }) => {
      toast.error(`Discovery failed: ${error.message}`);
      setUploading(false);
    },
  });

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
              Add your URLs
            </CardTitle>
            <CardDescription>
              Upload a spreadsheet or paste URLs directly. Excel/CSV should have a <strong>Website URL</strong> column (required), plus optional <strong>Name</strong> and <strong>Description</strong> columns.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Mode toggle */}
            <div className="flex gap-2 mb-4">
              <Button
                variant={uploadMode === "file" ? "default" : "outline"}
                size="sm"
                disabled={uploading || wizardStep !== "idle"}
                onClick={() => setUploadMode("file")}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Upload File
              </Button>
              <Button
                variant={uploadMode === "paste" ? "default" : "outline"}
                size="sm"
                disabled={uploading || wizardStep !== "idle"}
                onClick={() => setUploadMode("paste")}
              >
                <List className="h-4 w-4 mr-2" />
                Paste URLs
              </Button>
              <Button
                variant={uploadMode === "crawl" ? "default" : "outline"}
                size="sm"
                disabled={uploading || wizardStep !== "idle"}
                onClick={() => setUploadMode("crawl")}
              >
                <Search className="h-4 w-4 mr-2" />
                Crawl Directory
              </Button>
            </div>

            {uploadMode === "paste" && (
              <div className="space-y-3">
                <Textarea
                  placeholder={"Paste one URL per line:\nhttps://www.goodfirms.co/company/toast-studio\nhttps://clutch.co/profile/example-agency"}
                  value={manualUrls}
                  onChange={(e: { target: HTMLTextAreaElement }) => setManualUrls(e.target.value)}
                  disabled={uploading || wizardStep !== "idle"}
                  rows={5}
                  className="font-mono text-sm"
                />
                <Button
                  disabled={uploading || wizardStep !== "idle" || !manualUrls.trim()}
                  onClick={handleUrlSubmit}
                >
                  {uploading ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing...</>
                  ) : (
                    <>Process URLs &#8594;</>
                  )}
                </Button>
              </div>
            )}

            {uploadMode === "crawl" && (
              <div className="space-y-3">
                <Input
                  placeholder="https://clutch.co/agencies/digital-marketing"
                  value={crawlUrl}
                  onChange={(e: { target: HTMLInputElement }) => setCrawlUrl(e.target.value)}
                  disabled={uploading || wizardStep !== "idle"}
                  className="font-mono text-sm"
                />
                <div className="flex items-center gap-3">
                  <Label className="text-sm text-muted-foreground shrink-0">Max pages:</Label>
                  <Select
                    value={String(crawlMaxPages)}
                    onValueChange={(v: string) => setCrawlMaxPages(Number(v))}
                  >
                    <SelectTrigger className="w-28" disabled={uploading || wizardStep !== "idle"}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2">2 pages</SelectItem>
                      <SelectItem value="5">5 pages</SelectItem>
                      <SelectItem value="10">10 pages</SelectItem>
                      <SelectItem value="20">20 pages</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    ~{crawlMaxPages * 25}–{crawlMaxPages * 50} companies
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    disabled={uploading || wizardStep !== "idle" || !crawlUrl.trim()}
                    onClick={() => {
                      if (!crawlUrl.startsWith("http")) { toast.error("URL must start with http"); return; }
                      setUploading(true);
                      discoverMutation.mutate({ directoryUrl: crawlUrl, maxPages: crawlMaxPages });
                    }}
                  >
                    {uploading ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Discovering...</>
                    ) : (
                      <>Discover Entries</>
                    )}
                  </Button>
                  {uploading && (
                    <span className="text-xs text-muted-foreground">This may take 20–60 seconds...</span>
                  )}
                </div>
              </div>
            )}

            {uploadMode === "file" && (
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
            )}
          </CardContent>
        </Card>

        {/* Capability notice */}
        <div className="flex items-start gap-2 text-sm text-muted-foreground mb-6 px-1">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Works best on public websites. Social media profiles and login-protected pages have limited support.</span>
        </div>

        {/* ── Wizard Progress Bar ── */}
        {(showColumnMapping || wizardStep !== "idle") && (
          <div className="flex items-center mb-6 px-1">
            {[
              { label: "Upload", step: 1 },
              { label: "Configure", step: 2 },
              { label: "Review & Start", step: 3 },
            ].map(({ label, step }, i) => {
              const current = showColumnMapping ? 1 : wizardStep === "configure" ? 2 : 3;
              const done = step < current;
              const active = step === current;
              return (
                <div key={step} className="flex items-center flex-1 last:flex-none">
                  <button
                    className="flex items-center gap-2 group"
                    disabled={!done}
                    onClick={() => {
                      if (step === 1 && current > 1) {
                        setWizardStep("configure");
                        setShowColumnMapping(false);
                      }
                      if (step === 2 && current === 3) setWizardStep("configure");
                    }}
                  >
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors
                      ${active ? "bg-primary border-primary text-primary-foreground"
                        : done ? "bg-green-500 border-green-500 text-white group-hover:bg-green-600 cursor-pointer"
                        : "border-muted-foreground/30 text-muted-foreground/50"}`}>
                      {done ? <CheckCircle className="h-4 w-4" /> : step}
                    </span>
                    <span className={`text-sm font-medium hidden sm:block
                      ${active ? "text-foreground" : done ? "text-green-700" : "text-muted-foreground/50"}`}>
                      {label}
                    </span>
                  </button>
                  {i < 2 && (
                    <div className={`flex-1 h-0.5 mx-3 ${done ? "bg-green-400" : "bg-muted-foreground/20"}`} />
                  )}
                </div>
              );
            })}
          </div>
        )}

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
                Use the dropdowns above each column to assign: <strong>Website URL</strong> (required), and optionally <strong>Company Name</strong> and <strong>Description</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Legend */}
              <div className="flex gap-3 mb-3 text-xs">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Company Name (optional)</span>
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
                                <SelectItem value="__skip__">-- Skip this column --</SelectItem>
                                <SelectItem value="companyName">Company Name</SelectItem>
                                <SelectItem value="websiteUrl">Website URL *</SelectItem>
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
              {!Object.values(columnRoles).includes("websiteUrl") && (
                <div className="flex items-center gap-2 mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  Assign the <strong>Website URL *</strong> column to continue
                </div>
              )}
              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  {fileHeaders.sampleRows.length > 4
                    ? `Showing 4 of ${fileHeaders.sampleRows.length} sample rows`
                    : `${fileHeaders.sampleRows.length} sample rows`}
                  {" · "}
                  {(() => {
                    const hasUrl = Object.values(columnRoles).includes("websiteUrl");
                    if (hasUrl) return <span className="text-green-600 font-medium">Ready</span>;
                    return <span className="text-amber-600 font-medium">Missing: Website URL *</span>;
                  })()}
                </p>
                <Button
                  onClick={handleColumnMappingSubmit}
                  disabled={
                    !Object.values(columnRoles).includes("websiteUrl") ||
                    uploadMutation.isPending
                  }
                >
                  {uploadMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing...</>
                  ) : (
                    "Confirm & Continue →"
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
                <div className="mb-4">
                  <TabsList>
                    <TabsTrigger value="ai">
                      <Sparkles className="h-4 w-4 mr-2" />
                      AI Custom Extraction
                    </TabsTrigger>
                    <TabsTrigger value="template">Use Template</TabsTrigger>
                  </TabsList>
                  {((wizardMode === "ai" && (description.trim().length > 0 || wizardSections.length > 0)) ||
                    (wizardMode === "template" && templateSections.length > 0)) && (
                    <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Switching modes will clear your current configuration
                    </p>
                  )}
                </div>

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

                      {/* Refine Targeting panel — auto-populated from skill context */}
                      {wizardSkillContext && (
                        <div className="border rounded-lg overflow-hidden">
                          <button
                            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
                            onClick={() => setShowSkillRefine(!showSkillRefine)}
                          >
                            <span className="flex items-center gap-2">
                              <Sparkles className="h-4 w-4 text-primary" />
                              Refine targeting
                              <span className="text-xs font-normal text-muted-foreground">(optional — edit AI-inferred criteria)</span>
                            </span>
                            {showSkillRefine ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>

                          {showSkillRefine && (
                            <div className="px-4 pb-4 space-y-4 border-t bg-muted/10">
                              <div className="space-y-1.5 pt-3">
                                <Label className="text-xs font-semibold">Ideal company profile</Label>
                                <Textarea
                                  className="text-xs min-h-[56px] resize-none"
                                  value={wizardSkillContext.icpSummary}
                                  onChange={(e) => setWizardSkillContext({ ...wizardSkillContext, icpSummary: e.target.value })}
                                  placeholder="e.g. B2B SaaS, 50-500 employees, Series A/B, US or EU"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-semibold">Decision maker titles <span className="font-normal text-muted-foreground">(comma-separated, priority order)</span></Label>
                                <Input
                                  className="text-xs"
                                  value={wizardSkillContext.targetTitles.join(", ")}
                                  onChange={(e) => setWizardSkillContext({
                                    ...wizardSkillContext,
                                    targetTitles: e.target.value.split(",").map(t => t.trim()).filter(Boolean),
                                  })}
                                  placeholder="e.g. VP Engineering, CTO, Head of Engineering"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-semibold">Skip companies that show...</Label>
                                <Textarea
                                  className="text-xs min-h-[56px] resize-none"
                                  value={wizardSkillContext.exclusionSignals.join(", ")}
                                  onChange={(e) => setWizardSkillContext({
                                    ...wizardSkillContext,
                                    exclusionSignals: e.target.value.split(",").map(t => t.trim()).filter(Boolean),
                                  })}
                                  placeholder="e.g. agency, crypto/web3, less than 10 employees"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-semibold">Research goal</Label>
                                <Input
                                  className="text-xs"
                                  value={wizardSkillContext.outreachGoal}
                                  onChange={(e) => setWizardSkillContext({ ...wizardSkillContext, outreachGoal: e.target.value })}
                                  placeholder="e.g. Find engineering leads to pitch CI/CD tooling"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

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
              <div className="space-y-3">
                {displayedJobs.slice(0, visibleJobCount).map((job) => {
                  const progress = job.firmCount && job.firmCount > 0
                    ? Math.round(((job.processedCount || 0) / job.firmCount) * 100)
                    : 0;
                  const isProcessing = job.status === "processing";
                  const jobTemplate = (job as any).template || "vc";
                  const tpl = getTemplate(jobTemplate);
                  const colors = TEMPLATE_COLORS[jobTemplate] ?? TEMPLATE_COLORS.vc;
                  const isAgentJob = !!(job as any).sectionsJson;

                  // Compact view for done/failed/cancelled jobs (collapsed by default)
                  const isDone = ["completed", "failed", "cancelled"].includes(job.status);
                  const isExpanded = expandedJobIds.has(job.id);

                  if (isDone && !isExpanded) {
                    return (
                      <div key={job.id} className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-white hover:bg-muted/20 transition-colors">
                        <span className="shrink-0">
                          {job.status === "completed" && <CheckCircle className="h-4 w-4 text-green-600" />}
                          {job.status === "failed"    && <XCircle className="h-4 w-4 text-red-500" />}
                          {job.status === "cancelled" && <XCircle className="h-4 w-4 text-orange-400" />}
                        </span>
                        {isAgentJob ? (
                          <span className="text-xs font-medium text-violet-700 shrink-0">AI Custom</span>
                        ) : (
                          <span className={`text-xs font-medium shrink-0 ${colors.text}`}>{tpl.name}</span>
                        )}
                        <span className="text-sm text-muted-foreground shrink-0">{job.firmCount} entries</span>
                        {(job as any).totalCostUSD && (
                          <span className="text-sm font-mono text-muted-foreground shrink-0">
                            ${Number((job as any).totalCostUSD).toFixed(4)}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground shrink-0">
                          {new Date(job.createdAt).toLocaleDateString()}
                        </span>
                        <div className="flex items-center gap-2 ml-auto">
                          {job.status === "completed" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setViewResultsJob({ id: job.id, template: jobTemplate, sectionsJson: (job as any).sectionsJson ?? undefined })}
                              >
                                <Table2 className="h-3 w-3 mr-1" />
                                View
                              </Button>
                              <DownloadResultsButton jobId={job.id} outputFileUrl={job.outputFileUrl} compact />
                            </>
                          )}
                          {job.status === "failed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => resumeMutation.mutate({ jobId: job.id })}
                              disabled={resumeMutation.isPending}
                            >
                              <PlayCircle className="h-3 w-3 mr-1" />
                              Resume
                            </Button>
                          )}
                          <button
                            className="text-muted-foreground hover:text-foreground p-1 rounded"
                            onClick={() => setExpandedJobIds(prev => { const next = new Set(prev); next.add(job.id); return next; })}
                            title="Expand"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <Card key={job.id} className="border-2">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              {job.status === "completed"  && <CheckCircle className="h-5 w-5 text-green-600" />}
                              {job.status === "failed"     && <XCircle className="h-5 w-5 text-red-600" />}
                              {job.status === "cancelled"  && <XCircle className="h-5 w-5 text-orange-500" />}
                              {job.status === "processing" && <Loader2 className="h-5 w-5 animate-spin text-blue-600" />}
                              {job.status === "pending"    && <Clock className="h-5 w-5 text-gray-600" />}
                              {(job.status as string) === "paused" && <PauseCircle className="h-5 w-5 text-amber-500" />}
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

                            {/* Actual vs estimated cost (completed, expanded) */}
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

                          <div className="flex gap-2 flex-wrap items-start">
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
                            {(job.status === "failed" || job.status === "paused") && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => resumeMutation.mutate({ jobId: job.id })}
                                disabled={resumeMutation.isPending}
                              >
                                {resumeMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                  <PlayCircle className="h-4 w-4 mr-2" />
                                )}
                                Resume
                              </Button>
                            )}
                            {job.status === "paused" && (job as any).outputFileKey && (
                              <DownloadResultsButton jobId={job.id} outputFileUrl={job.outputFileUrl} />
                            )}
                            {(job.status === "processing" || job.status === "pending") && (
                              <>
                                {/* Export partial results while job is running (agent jobs only, available after 5 firms) */}
                                {(job as any).sectionsJson && (job.processedCount ?? 0) >= 5 && (
                                  <DownloadResultsButton jobId={job.id} outputFileUrl={null} />
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-amber-600 border-amber-300 hover:bg-amber-50"
                                  onClick={() => pauseMutation.mutate({ jobId: job.id })}
                                  disabled={pauseMutation.isPending}
                                >
                                  {pauseMutation.isPending ? (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  ) : (
                                    <PauseCircle className="h-4 w-4 mr-2" />
                                  )}
                                  Pause
                                </Button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="text-red-600 border-red-300 hover:bg-red-50"
                                      disabled={cancelMutation.isPending}
                                    >
                                      {cancelMutation.isPending ? (
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      ) : (
                                        <XCircle className="h-4 w-4 mr-2" />
                                      )}
                                      Cancel
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogTitle>Cancel this job?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Processing will stop within a few seconds. URLs already processed remain downloadable — no completed work is lost.
                                    </AlertDialogDescription>
                                    <div className="flex justify-end gap-3 mt-4">
                                      <AlertDialogCancel>Keep Running</AlertDialogCancel>
                                      <AlertDialogAction
                                        className="bg-red-600 hover:bg-red-700 text-white"
                                        onClick={() => cancelMutation.mutate({ jobId: job.id })}
                                      >
                                        Yes, Cancel Job
                                      </AlertDialogAction>
                                    </div>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </>
                            )}
                            {/* Collapse button for expanded done jobs */}
                            {isDone && (
                              <button
                                className="text-muted-foreground hover:text-foreground p-1.5 rounded border"
                                onClick={() => setExpandedJobIds(prev => { const next = new Set(prev); next.delete(job.id); return next; })}
                                title="Collapse"
                              >
                                <ChevronUp className="h-4 w-4" />
                              </button>
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

                {/* Show older jobs */}
                {displayedJobs.length > visibleJobCount && (
                  <button
                    className="w-full py-2.5 text-sm text-muted-foreground hover:text-foreground border border-dashed rounded-lg hover:border-muted-foreground/40 transition-colors"
                    onClick={() => setVisibleJobCount(c => c + 10)}
                  >
                    Show {Math.min(10, displayedJobs.length - visibleJobCount)} older jobs
                  </button>
                )}
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

function DownloadResultsButton({ jobId, compact = false }: { jobId: number; outputFileUrl?: string | null; compact?: boolean }) {
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

  if (compact) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => { setIsGenerating(true); generateMutation.mutate({ jobId }); }}
        disabled={isGenerating || generateMutation.isPending}
      >
        {isGenerating || generateMutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Download className="h-3 w-3" />
        )}
      </Button>
    );
  }

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
