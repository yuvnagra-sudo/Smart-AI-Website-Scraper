import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getLoginUrl } from "@/const";
import { Upload, Zap, CheckCircle, TrendingUp } from "lucide-react";
import { Link } from "wouter";

export default function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-8 w-8 text-primary" />
            <h1 className="text-2xl font-bold">VC Enrichment</h1>
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

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl font-bold mb-6 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            AI-Powered VC Prospect Research
          </h2>
          <p className="text-xl text-gray-600 mb-8">
            Transform your Excel file of VC firms into a comprehensive database with investment niches, team member LinkedIn profiles, and portfolio company insights—all in minutes.
          </p>
          {user ? (
            <Link href="/dashboard">
              <Button size="lg" className="text-lg px-8 py-6">
                <Upload className="mr-2 h-5 w-5" />
                Start Enriching Data
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

      {/* Features */}
      <section className="container mx-auto px-4 py-16">
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          <Card>
            <CardHeader>
              <Zap className="h-12 w-12 text-blue-600 mb-4" />
              <CardTitle>Automated Enrichment</CardTitle>
              <CardDescription>
                Upload your Excel file and let AI do the heavy lifting. No command line, no technical skills required.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CheckCircle className="h-12 w-12 text-green-600 mb-4" />
              <CardTitle>Verified Data</CardTitle>
              <CardDescription>
                Every data point includes confidence scores and source URLs so you can verify accuracy before outreach.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <TrendingUp className="h-12 w-12 text-purple-600 mb-4" />
              <CardTitle>Comprehensive Insights</CardTitle>
              <CardDescription>
                Get investment niches, team member details with LinkedIn URLs, and recent portfolio companies—all in one place.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {/* How It Works */}
      <section className="container mx-auto px-4 py-16 bg-white/50 rounded-3xl my-16">
        <div className="max-w-4xl mx-auto">
          <h3 className="text-3xl font-bold text-center mb-12">How It Works</h3>
          <div className="space-y-8">
            <div className="flex gap-6 items-start">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-lg">
                1
              </div>
              <div>
                <h4 className="text-xl font-semibold mb-2">Upload Your Excel File</h4>
                <p className="text-gray-600">
                  Prepare an Excel file with three columns: Company Name, Company Website URL, and LinkedIn Description.
                </p>
              </div>
            </div>

            <div className="flex gap-6 items-start">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-lg">
                2
              </div>
              <div>
                <h4 className="text-xl font-semibold mb-2">AI Processes Your Data</h4>
                <p className="text-gray-600">
                  Our AI visits each VC firm's website, extracts investment niches, team members, and portfolio companies automatically.
                </p>
              </div>
            </div>

            <div className="flex gap-6 items-start">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-green-600 text-white flex items-center justify-center font-bold text-lg">
                3
              </div>
              <div>
                <h4 className="text-xl font-semibold mb-2">Download Enriched Results</h4>
                <p className="text-gray-600">
                  Get a comprehensive Excel file with three sheets: VC Firms, Team Members, and Portfolio Companies—ready for your outreach campaigns.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 py-20 text-center">
        <h3 className="text-3xl font-bold mb-6">Ready to Supercharge Your VC Research?</h3>
        <p className="text-xl text-gray-600 mb-8">
          Join professionals who are saving hours of manual research every week.
        </p>
        {user ? (
          <Link href="/dashboard">
            <Button size="lg" className="text-lg px-8 py-6">
              Go to Dashboard
            </Button>
          </Link>
        ) : (
          <Button size="lg" className="text-lg px-8 py-6" asChild>
            <a href={getLoginUrl()}>Sign Up Now</a>
          </Button>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm py-8">
        <div className="container mx-auto px-4 text-center text-gray-600">
          <p>&copy; 2025 VC Enrichment. Powered by AI.</p>
        </div>
      </footer>
    </div>
  );
}
