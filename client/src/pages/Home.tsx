import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getLoginUrl } from "@/const";
import {
  Bot, Upload, Zap, CheckCircle, Globe, Cpu, FileSpreadsheet,
  TrendingUp, Building2, Users, HeartPulse, ShoppingCart, Home as HomeIcon, MapPin,
  AlertTriangle,
} from "lucide-react";
import { Link } from "wouter";

const INDUSTRIES = [
  { id: "vc",         icon: TrendingUp,  label: "VC & Investors",       color: "bg-violet-100 text-violet-700" },
  { id: "b2b",        icon: Building2,   label: "B2B Companies",        color: "bg-blue-100 text-blue-700" },
  { id: "people",     icon: Users,       label: "People & Profiles",    color: "bg-amber-100 text-amber-700" },
  { id: "healthcare", icon: HeartPulse,  label: "Healthcare",           color: "bg-rose-100 text-rose-700" },
  { id: "ecommerce",  icon: ShoppingCart,label: "E-Commerce",           color: "bg-orange-100 text-orange-700" },
  { id: "realestate", icon: HomeIcon,    label: "Real Estate",          color: "bg-teal-100 text-teal-700" },
  { id: "local",      icon: MapPin,      label: "Local Businesses",     color: "bg-green-100 text-green-700" },
];

export default function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Bot className="h-8 w-8 text-primary" />
            <h1 className="text-2xl font-bold">Smart AI Data Scraper</h1>
          </div>
          <div>
            {user ? (
              <Link href="/dashboard">
                <Button>Go to Dashboard</Button>
              </Link>
            ) : (
              <Button asChild>
                <a href={getLoginUrl()}>Sign In</a>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-5xl font-bold mb-6 bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent leading-tight">
            Turn any website into clean, structured data
          </h2>
          <p className="text-xl text-muted-foreground mb-10">
            Upload a list of URLs, pick a template, and let the AI scrape and organize the data for you.
            No coding. No APIs. Just an Excel file of results.
          </p>
          {user ? (
            <Link href="/dashboard">
              <Button size="lg" className="text-lg px-8 py-6">
                <Upload className="mr-2 h-5 w-5" />
                Start Scraping
              </Button>
            </Link>
          ) : (
            <Button size="lg" className="text-lg px-8 py-6" asChild>
              <a href={getLoginUrl()}>
                <Upload className="mr-2 h-5 w-5" />
                Get Started Free
              </a>
            </Button>
          )}
        </div>
      </section>

      {/* Industry tiles */}
      <section className="container mx-auto px-4 pb-16">
        <p className="text-center text-sm font-medium text-muted-foreground uppercase tracking-widest mb-6">
          Works for any industry
        </p>
        <div className="flex flex-wrap justify-center gap-3 max-w-3xl mx-auto">
          {INDUSTRIES.map(({ id, icon: Icon, label, color }) => (
            <div
              key={id}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${color}`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-white/60 py-20">
        <div className="container mx-auto px-4 max-w-4xl">
          <h3 className="text-3xl font-bold text-center mb-12">How it works</h3>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: 1,
                title: "Upload your URLs",
                desc: "Create a spreadsheet with Name, Website URL, and an optional Description column. Upload it to the dashboard.",
              },
              {
                step: 2,
                title: "Pick a template",
                desc: "Choose from 7 pre-built templates (VC, B2B, Healthcare, and more) that define which fields to extract.",
              },
              {
                step: 3,
                title: "Download results",
                desc: "The scraper visits each site and returns an organized Excel file — org profiles, contacts, and more.",
              },
            ].map(({ step, title, desc }) => (
              <div key={step} className="flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg mb-4">
                  {step}
                </div>
                <h4 className="font-semibold text-lg mb-2">{title}</h4>
                <p className="text-muted-foreground text-sm">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto px-4 py-20">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {[
            {
              icon: Globe,
              color: "text-blue-600",
              title: "JS-rendered sites",
              desc: "Uses a real browser to handle dynamic content, SPAs, and lazy-loaded pages.",
            },
            {
              icon: Cpu,
              color: "text-indigo-600",
              title: "Parallel processing",
              desc: "Up to 50 concurrent workers — 1,000 sites in roughly 10 minutes.",
            },
            {
              icon: Zap,
              color: "text-amber-600",
              title: "AI extraction",
              desc: "LLM reads each page and fills in structured fields — no regex, no fragile selectors.",
            },
            {
              icon: FileSpreadsheet,
              color: "text-green-600",
              title: "Flexible templates",
              desc: "Pre-built field sets for VCs, B2B, healthcare, e-commerce, and more.",
            },
          ].map(({ icon: Icon, color, title, desc }) => (
            <Card key={title}>
              <CardHeader>
                <Icon className={`h-10 w-10 mb-2 ${color}`} />
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{desc}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* Limitations banner */}
      <section className="container mx-auto px-4 pb-16 max-w-3xl">
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold mb-1">Honest limitations</p>
            <p>
              Social media profiles (LinkedIn, Twitter/X, Instagram) and login-protected pages are not supported.
              Sites with aggressive bot-blocking may return partial data. Results are best on public-facing
              company and directory websites.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 py-20 text-center">
        <h3 className="text-3xl font-bold mb-4">Ready to scrape your first list?</h3>
        <p className="text-muted-foreground mb-8">No setup. No code. Just upload and go.</p>
        {user ? (
          <Link href="/dashboard">
            <Button size="lg" className="text-lg px-8 py-6">Go to Dashboard</Button>
          </Link>
        ) : (
          <Button size="lg" className="text-lg px-8 py-6" asChild>
            <a href={getLoginUrl()}>Get Started Free</a>
          </Button>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm py-8">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <p>Smart AI Data Scraper · Powered by AI</p>
        </div>
      </footer>
    </div>
  );
}
