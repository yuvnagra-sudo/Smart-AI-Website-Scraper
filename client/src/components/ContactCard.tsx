import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertTriangle, ExternalLink } from "lucide-react";

interface ContactRow {
  name?: string;
  title?: string;
  decisionMakerTier?: string;
  email?: string;
  emailVerified?: boolean | "catch-all";
  employmentConfidence?: "confirmed" | "likely" | "stale-risk" | "unverified";
  linkedinUrl?: string;
  [key: string]: any;
}

export function ContactCard({ row }: { row: ContactRow }) {
  const tierColors: Record<string, string> = {
    "Tier 1": "bg-green-100 text-green-700",
    "Tier 2": "bg-blue-100 text-blue-700",
    "Tier 3": "bg-amber-100 text-amber-700",
  };

  const tierColor = row.decisionMakerTier ? (tierColors[row.decisionMakerTier] ?? "bg-gray-100 text-gray-600") : "";

  return (
    <div className="px-4 py-3 border-b last:border-b-0 hover:bg-muted/20 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Name + tier */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{row.name}</span>
            {row.decisionMakerTier && (
              <Badge variant="secondary" className={`text-xs ${tierColor}`}>
                {row.decisionMakerTier}
              </Badge>
            )}
            {row.employmentConfidence === "stale-risk" && (
              <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-700">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Possible former employee
              </Badge>
            )}
            {row.employmentConfidence === "confirmed" && (
              <Badge variant="secondary" className="text-xs bg-green-50 text-green-700">
                <CheckCircle className="h-3 w-3 mr-1" />
                Confirmed
              </Badge>
            )}
          </div>

          {/* Title */}
          {row.title && (
            <p className="text-xs text-muted-foreground mt-0.5">{row.title}</p>
          )}

          {/* Email */}
          {row.email && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-xs font-mono text-muted-foreground">{row.email}</span>
              {row.emailVerified === true && (
                <span className="inline-flex items-center gap-0.5 text-xs text-green-700 font-medium">
                  <CheckCircle className="h-3 w-3" /> Verified
                </span>
              )}
              {row.emailVerified === "catch-all" && (
                <span className="text-xs text-amber-600 font-medium">catch-all domain</span>
              )}
            </div>
          )}
        </div>

        {/* LinkedIn link */}
        {row.linkedinUrl && (
          <a
            href={row.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-700 shrink-0 mt-0.5"
            title="LinkedIn"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  );
}
