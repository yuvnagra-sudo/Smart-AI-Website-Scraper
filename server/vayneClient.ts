/**
 * Vayne.io API Client
 * Structured data extraction from websites
 * Documentation: https://docs.vayne.io
 */

import axios from "axios";
import { env } from "./_core/env";

const VAYNE_API_URL = "https://www.vayne.io/api/v1";
const VAYNE_API_KEY = env.vayneApiKey;

export interface VayneExtractionRequest {
  url: string;
  schema?: Record<string, any>; // JSON schema for structured extraction
  instructions?: string; // Natural language instructions
  timeout?: number; // Timeout in seconds (default: 30)
}

export interface VayneExtractionResult {
  success: boolean;
  data: any;
  metadata?: {
    url: string;
    extractedAt: string;
    processingTime: number;
  };
  error?: string;
}

/**
 * Extract structured data from a URL using Vayne.io
 */
export async function extractWithVayne(
  request: VayneExtractionRequest
): Promise<VayneExtractionResult> {
  try {
    const response = await axios.post(
      `${VAYNE_API_URL}/extract`,
      {
        url: request.url,
        schema: request.schema,
        instructions: request.instructions,
        timeout: request.timeout || 30,
      },
      {
        headers: {
          "Authorization": `Bearer ${VAYNE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: (request.timeout || 30) * 1000 + 5000, // Add 5s buffer
      }
    );

    return {
      success: true,
      data: response.data.data,
      metadata: {
        url: request.url,
        extractedAt: new Date().toISOString(),
        processingTime: response.data.processingTime || 0,
      },
    };
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message;
    console.error(`[Vayne] Extraction failed for ${request.url}:`, errorMessage);
    console.error(`[Vayne] Full error:`, JSON.stringify({
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message,
    }, null, 2));
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Test Vayne.io API connectivity
 */
export async function testVayneConnection(): Promise<boolean> {
  try {
    // Test with a simple extraction
    const result = await extractWithVayne({
      url: "https://example.com",
      instructions: "Extract the page title",
      timeout: 10,
    });
    
    return result.success;
  } catch (error) {
    console.error("[Vayne] Connection test failed:", error);
    return false;
  }
}
