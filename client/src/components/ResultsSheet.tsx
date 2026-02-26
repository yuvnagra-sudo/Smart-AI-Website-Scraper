import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { getTemplate, type TemplateField } from "@/lib/templates";

// Sheet keys that map to the backend query tab type
type QueryTab = "firms" | "team" | "portfolio";

interface Props {
  jobId: number;
  open: boolean;
  onClose: () => void;
  template?: string;
}

export default function ResultsSheet({ jobId, open, onClose, template = "vc" }: Props) {
  const tpl = getTemplate(template);
  // Default to first sheet that maps to a valid query tab
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
