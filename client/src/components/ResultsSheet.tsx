import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";

type Tab = "firms" | "team" | "portfolio";

interface Props {
  jobId: number;
  open: boolean;
  onClose: () => void;
}

export default function ResultsSheet({ jobId, open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("firms");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const { data, isLoading } = trpc.enrichment.getJobResults.useQuery(
    { jobId, tab, page, search: search || undefined },
    { enabled: open, keepPreviousData: true }
  );

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const handleTabChange = (newTab: string) => {
    setTab(newTab as Tab);
    setPage(1);
    setSearch("");
    setSearchInput("");
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle>Results — Job #{jobId}</SheetTitle>
        </SheetHeader>

        <Tabs value={tab} onValueChange={handleTabChange} className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-3 border-b gap-4">
            <TabsList>
              <TabsTrigger value="firms">VC Firms</TabsTrigger>
              <TabsTrigger value="team">Team Members</TabsTrigger>
              <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder={tab === "firms" ? "Search firms…" : tab === "team" ? "Search members…" : "Search companies…"}
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
              <>
                <TabsContent value="firms" className="mt-0">
                  <FirmsTable rows={data.rows as any} />
                </TabsContent>
                <TabsContent value="team" className="mt-0">
                  <TeamTable rows={data.rows as any} />
                </TabsContent>
                <TabsContent value="portfolio" className="mt-0">
                  <PortfolioTable rows={data.rows as any} />
                </TabsContent>
              </>
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

function FirmsTable({ rows }: { rows: Array<Record<string, any>> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead>Website</TableHead>
          <TableHead>Investor Type</TableHead>
          <TableHead>Stages</TableHead>
          <TableHead>Niches</TableHead>
          <TableHead>Verified</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.companyName}</TableCell>
            <TableCell className="max-w-[160px] truncate">
              {row.websiteUrl ? (
                <a href={row.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm">
                  {row.websiteUrl}
                </a>
              ) : "—"}
            </TableCell>
            <TableCell className="text-sm">{row.investorType || "—"}</TableCell>
            <TableCell className="text-sm max-w-[140px] truncate">{row.investmentStages || "—"}</TableCell>
            <TableCell className="text-sm max-w-[140px] truncate">{row.investmentNiches || "—"}</TableCell>
            <TableCell>
              {row.websiteVerified === "Yes" ? (
                <Badge variant="secondary" className="bg-green-100 text-green-700 text-xs">Verified</Badge>
              ) : (
                <Badge variant="outline" className="text-xs">Unverified</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TeamTable({ rows }: { rows: Array<Record<string, any>> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Firm</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>LinkedIn</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{row.vcFirm}</TableCell>
            <TableCell className="text-sm max-w-[160px] truncate">{row.title || "—"}</TableCell>
            <TableCell>
              {row.decisionMakerTier && (
                <Badge
                  variant="secondary"
                  className={`text-xs ${
                    row.decisionMakerTier === "Tier 1" ? "bg-purple-100 text-purple-700" :
                    row.decisionMakerTier === "Tier 2" ? "bg-blue-100 text-blue-700" :
                    "bg-gray-100 text-gray-600"
                  }`}
                >
                  {row.decisionMakerTier}
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-sm">{row.email || "—"}</TableCell>
            <TableCell>
              {row.linkedinUrl ? (
                <a href={row.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm">
                  LinkedIn
                </a>
              ) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PortfolioTable({ rows }: { rows: Array<Record<string, any>> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Portfolio Company</TableHead>
          <TableHead>VC Firm</TableHead>
          <TableHead>Investment Date</TableHead>
          <TableHead>Sector / Niche</TableHead>
          <TableHead>Recency</TableHead>
          <TableHead>Website</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.portfolioCompany}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{row.vcFirm}</TableCell>
            <TableCell className="text-sm">{row.investmentDate || "—"}</TableCell>
            <TableCell className="text-sm max-w-[140px] truncate">{row.investmentNiche || "—"}</TableCell>
            <TableCell>
              {row.recencyCategory ? (
                <Badge
                  variant="secondary"
                  className={`text-xs ${
                    row.recencyCategory === "Recent" ? "bg-green-100 text-green-700" :
                    row.recencyCategory === "Moderate" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-600"
                  }`}
                >
                  {row.recencyCategory}
                </Badge>
              ) : "—"}
            </TableCell>
            <TableCell>
              {row.websiteUrl ? (
                <a href={row.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm">
                  Visit
                </a>
              ) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
