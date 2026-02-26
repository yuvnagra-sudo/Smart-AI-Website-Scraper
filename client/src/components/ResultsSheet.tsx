import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight, Search, Sparkles, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { getTemplate, type TemplateField } from "@/lib/templates";

// Sheet keys that map to the backend query tab type
type QueryTab = "firms" | "team" | "portfolio";

interface AgentSection { key: string; label: string; desc: string; }

interface Props {
  jobId: number;
  open: boolean;
  onClose: () => void;
  template?: string;
  sectionsJson?: string; // Present for AI custom extraction jobs
}

export default function ResultsSheet({ jobId, open, onClose, template = "vc", sectionsJson }: Props) {
  // ── Agent job (AI custom extraction) ──────────────────────────────────────
  if (sectionsJson) {
    return <AgentJobSheet jobId={jobId} open={open} onClose={onClose} sectionsJson={sectionsJson} />;
  }

  // ── Template job (existing VC/B2B/etc pipeline) ──────────────────────────
  return <TemplateJobSheet jobId={jobId} open={open} onClose={onClose} template={template} />;
}

// ---------------------------------------------------------------------------
// Agent job results view
// ---------------------------------------------------------------------------

function AgentJobSheet({ jobId, open, onClose, sectionsJson }: {
  jobId: number;
  open: boolean;
  onClose: () => void;
  sectionsJson: string;
}) {
  const [activeTab, setActiveTab] = useState<"results" | "urls">("results");
  const [isDownloading, setIsDownloading] = useState(false);

  let sections: AgentSection[] = [];
  try { sections = JSON.parse(sectionsJson); } catch { /* ignore */ }

  const downloadMutation = trpc.enrichment.generateResults.useMutation({
    onSuccess: (data) => {
      const byteChars = atob(data.fileData);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = data.fileName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      setIsDownloading(false);
    },
    onError: () => setIsDownloading(false),
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-600" />
            AI Custom Extraction — Job #{jobId}
          </SheetTitle>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-3 border-b">
            <TabsList>
              <TabsTrigger value="results">Results</TabsTrigger>
              <TabsTrigger value="urls">Collected URLs</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto p-6">
            <TabsContent value="results" className="mt-0 space-y-5">
              <div>
                <p className="text-sm font-semibold mb-2">
                  {sections.length} extraction sections (output columns)
                </p>
                <div className="flex flex-wrap gap-2">
                  {sections.map((s) => (
                    <Badge key={s.key} variant="outline" className="text-xs">
                      {s.label}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-5 space-y-3">
                <p className="text-sm font-medium">Download to view full results</p>
                <p className="text-sm text-muted-foreground">
                  AI custom extraction results are stored in the Excel output file with one row per processed URL
                  and one column per extraction section listed above.
                </p>
                <Button
                  onClick={() => { setIsDownloading(true); downloadMutation.mutate({ jobId }); }}
                  disabled={isDownloading || downloadMutation.isPending}
                >
                  {isDownloading || downloadMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</>
                  ) : (
                    <><Download className="h-4 w-4 mr-2" />Download Results Excel</>
                  )}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="urls" className="mt-0 space-y-5">
              <div className="rounded-lg border bg-muted/30 p-5 space-y-3">
                <p className="text-sm font-medium">Collected URLs tab</p>
                <p className="text-sm text-muted-foreground">
                  When the scraper detected directory pages, it collected entity URLs into a
                  "Collected URLs" sheet in the Excel output. Each row contains the company name,
                  directory page URL, and native company website URL (if found).
                </p>
                <Button
                  onClick={() => { setIsDownloading(true); downloadMutation.mutate({ jobId }); }}
                  disabled={isDownloading || downloadMutation.isPending}
                >
                  {isDownloading || downloadMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</>
                  ) : (
                    <><Download className="h-4 w-4 mr-2" />Download Results Excel</>
                  )}
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Template job results view (existing VC/B2B/etc pipeline)
// ---------------------------------------------------------------------------

function TemplateJobSheet({ jobId, open, onClose, template }: {
  jobId: number;
  open: boolean;
  onClose: () => void;
  template: string;
}) {
  const tpl = getTemplate(template);
  const validSheets = tpl.sheets.filter(s => ["firms", "team", "portfolio"].includes(s.key));
  const [activeSheetKey, setActiveSheetKey] = useState<string>(validSheets[0]?.key ?? "firms");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const activeSheet = validSheets.find(s => s.key === activeSheetKey) ?? validSheets[0];

  const { data, isLoading } = trpc.enrichment.getJobResults.useQuery(
    { jobId, tab: activeSheetKey as QueryTab, page, search: search || undefined },
    { enabled: open, keepPreviousData: true }
  );

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const handleTabChange = (newKey: string) => {
    setActiveSheetKey(newKey);
    setPage(1);
    setSearch("");
    setSearchInput("");
  };

  const searchPlaceholder = activeSheet
    ? `Search ${activeSheet.label.toLowerCase()}…`
    : "Search…";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle>Results — Job #{jobId}</SheetTitle>
        </SheetHeader>

        <Tabs value={activeSheetKey} onValueChange={handleTabChange} className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-3 border-b gap-4">
            <TabsList>
              {validSheets.map(sheet => (
                <TabsTrigger key={sheet.key} value={sheet.key}>
                  {sheet.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder={searchPlaceholder}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
              </div>
              <Button size="sm" variant="outline" onClick={handleSearch}>Search</Button>
            </div>

            {data && (
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {data.total} total
              </span>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : !data || data.rows.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No results found{search ? ` for "${search}"` : ""}.
              </div>
            ) : (
              validSheets.map(sheet => (
                <TabsContent key={sheet.key} value={sheet.key} className="mt-0">
                  <DynamicTable rows={data.rows as any[]} fields={sheet.fields} />
                </TabsContent>
              ))
            )}
          </div>

          {/* Pagination */}
          {data && data.pages > 1 && (
            <div className="flex items-center justify-center gap-3 px-6 py-3 border-t">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {data.pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= data.pages}
                onClick={() => setPage(p => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Generic table driven by template field definitions
// ---------------------------------------------------------------------------

const URL_FIELDS    = new Set(["websiteUrl", "linkedinUrl", "dataSourceUrl", "investorTypeSourceUrl", "investmentStagesSourceUrl", "nichesSourceUrl"]);
const BADGE_FIELDS  = new Set(["websiteVerified", "decisionMakerTier", "recencyCategory"]);

function DynamicTable({ rows, fields }: { rows: Array<Record<string, any>>; fields: TemplateField[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {fields.map(f => (
            <TableHead key={f.key}>{f.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={row.id ?? i}>
            {fields.map(f => (
              <TableCell key={f.key} className="text-sm max-w-[180px] truncate">
                <CellValue fieldKey={f.key} value={row[f.key]} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CellValue({ fieldKey, value }: { fieldKey: string; value: any }) {
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>;

  if (URL_FIELDS.has(fieldKey)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
        {fieldKey === "websiteUrl" ? value : "Link"}
      </a>
    );
  }

  if (BADGE_FIELDS.has(fieldKey)) {
    const colorClass =
      value === "Yes" || value === "Tier 1" || value === "Recent"
        ? "bg-green-100 text-green-700"
        : value === "Tier 2" || value === "Moderate"
        ? "bg-blue-100 text-blue-700"
        : value === "Tier 3"
        ? "bg-amber-100 text-amber-700"
        : "bg-gray-100 text-gray-600";
    return (
      <Badge variant="secondary" className={`text-xs ${colorClass}`}>
        {value}
      </Badge>
    );
  }

  return <span>{String(value)}</span>;
}
