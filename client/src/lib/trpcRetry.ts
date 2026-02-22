/**
 * Retry logic for tRPC client to handle transient errors
 */

import type { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";

export interface RetryLinkOptions {
  maxRetries?: number;
  retryDelay?: number;
  shouldRetry?: (error: any) => boolean;
}

/**
 * Create a retry link for tRPC client
 */
export function retryLink(options: RetryLinkOptions = {}): TRPCLink<any> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    shouldRetry = (error: any) => {
      // Retry on network errors or 5xx server errors
      if (error?.message?.includes("fetch failed")) return true;
      if (error?.message?.includes("not valid JSON")) return true;
      if (error?.data?.httpStatus >= 500) return true;
      return false;
    },
  } = options;

  return () => {
    return ({ next, op }) => {
      return observable((observer) => {
        let attempts = 0;
        let unsubscribe: { unsubscribe: () => void } | undefined;

        const attempt = () => {
          attempts++;

          unsubscribe = next(op).subscribe({
            next(value) {
              observer.next(value);
            },
            error(error) {
              if (attempts < maxRetries && shouldRetry(error)) {
                console.warn(
                  `[tRPC Retry] Attempt ${attempts}/${maxRetries} failed, retrying in ${retryDelay}ms...`,
                  error.message
                );
                setTimeout(() => {
                  attempt();
                }, retryDelay * attempts); // Exponential backoff
              } else {
                observer.error(error);
              }
            },
            complete() {
              observer.complete();
            },
          });
        };

        attempt();

        return () => {
          unsubscribe?.unsubscribe();
        };
      });
    };
  };
}
