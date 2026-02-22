/**
 * Jina Reader Integration
 * Converts web pages to clean, structured markdown for LLM processing
 */

const JINA_API_KEY = process.env.JINA_API_KEY;

export interface JinaReaderResult {
  markdown: string;
  title: string;
  url: string;
  links: Array<{ text: string; url: string }>;
}

/**
 * Convert a URL to clean markdown using Jina Reader
 * @param url - The URL to convert
 * @returns Clean markdown with preserved link structure
 */
export async function convertUrlToMarkdown(url: string): Promise<JinaReaderResult | null> {
  if (!JINA_API_KEY) {
    console.error('[JinaReader] JINA_API_KEY not found in environment');
    return null;
  }

  try {
    console.log(`[JinaReader] Converting URL to markdown: ${url}`);
    
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
      headers: {
        'Authorization': `Bearer ${JINA_API_KEY}`,
        'X-Return-Format': 'markdown',
        'X-With-Links-Summary': 'true',
      },
    });

    if (!response.ok) {
      console.error(`[JinaReader] HTTP error: ${response.status} ${response.statusText}`);
      return null;
    }

    const markdown = await response.text();
    
    // Extract links from markdown (format: [text](url))
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const links: Array<{ text: string; url: string }> = [];
    let match;
    
    while ((match = linkRegex.exec(markdown)) !== null) {
      links.push({
        text: match[1],
        url: match[2],
      });
    }

    // Extract title (first # heading)
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : '';

    console.log(`[JinaReader] Converted ${url} → ${markdown.length} chars, ${links.length} links`);

    return {
      markdown,
      title,
      url,
      links,
    };
  } catch (error) {
    console.error('[JinaReader] Error:', error);
    return null;
  }
}

/**
 * Convert HTML to markdown using Jina Reader (for already-fetched HTML)
 * Note: Jina Reader works best with URLs, not raw HTML
 * This function is a fallback for cases where we already have HTML
 */
export async function convertHtmlToMarkdown(html: string, baseUrl: string): Promise<string | null> {
  // Jina Reader doesn't support direct HTML input
  // For now, we'll return null and rely on URL-based conversion
  console.warn('[JinaReader] Direct HTML conversion not supported, use convertUrlToMarkdown instead');
  return null;
}
