import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ArrowUp, Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

/**
 * Message type matching server-side LLM Message interface
 */
export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AttachedFile = {
  name: string;
  content: string;
};

export type AIChatBoxProps = {
  /**
   * Messages array to display in the chat.
   */
  messages: Message[];

  /**
   * Callback when user sends a message.
   * File contents (if any) are appended to the message text automatically.
   */
  onSendMessage: (content: string) => void;

  /** Whether the AI is currently generating a response */
  isLoading?: boolean;

  /** Placeholder text for the input field */
  placeholder?: string;

  /** Custom className for the container */
  className?: string;

  /** Height of the chat box (default: 600px) */
  height?: string | number;

  /** Empty state message */
  emptyStateMessage?: string;

  /** Suggested prompts shown in the empty state */
  suggestedPrompts?: string[];
};

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? "");
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function AIChatBox({
  messages,
  onSendMessage,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  height = "600px",
  emptyStateMessage = "Start a conversation with AI",
  suggestedPrompts,
}: AIChatBoxProps) {
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayMessages = messages.filter((msg) => msg.role !== "system");

  // Auto-scroll to bottom on new messages or loading state
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLDivElement | null;
    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
      });
    }
  }, [messages, isLoading]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const canSend = (input.trim().length > 0 || attachedFiles.length > 0) && !isLoading;

  const handleSubmit = () => {
    if (!canSend) return;

    let messageContent = input.trim();
    if (attachedFiles.length > 0) {
      const fileParts = attachedFiles.map(
        (f) => `\n\n---\n📎 **${f.name}**\n\`\`\`\n${f.content}\n\`\`\``,
      );
      messageContent = (messageContent + fileParts.join("")).trim();
    }

    onSendMessage(messageContent);
    setInput("");
    setAttachedFiles([]);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      try {
        const content = await readFileAsText(file);
        setAttachedFiles((prev) => [...prev, { name: file.name, content }]);
      } catch {
        console.warn(`[AIChatBox] Could not read file: ${file.name}`);
      }
    }
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div
      className={cn(
        "flex flex-col bg-background text-foreground rounded-xl border shadow-sm overflow-hidden",
        className,
      )}
      style={{ height }}
    >
      {/* ── Messages area ───────────────────────────────────────────── */}
      <div ref={scrollAreaRef} className="flex-1 overflow-hidden">
        {displayMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <Sparkles className="size-10 opacity-20" />
              <p className="text-sm">{emptyStateMessage}</p>
            </div>
            {suggestedPrompts && suggestedPrompts.length > 0 && (
              <div className="flex max-w-xl flex-wrap justify-center gap-2">
                {suggestedPrompts.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => onSendMessage(prompt)}
                    disabled={isLoading}
                    className="rounded-full border border-border bg-muted/40 px-4 py-2 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-5 px-6 py-6">
              {displayMessages.map((message, index) => (
                <div
                  key={index}
                  className={cn(
                    "flex gap-3",
                    message.role === "user"
                      ? "justify-end"
                      : "justify-start items-start",
                  )}
                >
                  {message.role === "assistant" && (
                    <div className="size-7 shrink-0 mt-0.5 rounded-full bg-primary/10 flex items-center justify-center">
                      <Sparkles className="size-3.5 text-primary" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "max-w-[82%] text-sm leading-relaxed",
                      message.role === "user"
                        ? "rounded-2xl bg-muted px-4 py-2.5 text-foreground"
                        : "text-foreground",
                    )}
                  >
                    {message.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <Streamdown>{message.content}</Streamdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    )}
                  </div>
                </div>
              ))}

              {/* Typing indicator */}
              {isLoading && (
                <div className="flex items-start gap-3">
                  <div className="size-7 shrink-0 mt-0.5 rounded-full bg-primary/10 flex items-center justify-center">
                    <Sparkles className="size-3.5 text-primary" />
                  </div>
                  <div className="flex items-center gap-1 pt-2">
                    <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* ── Input area ──────────────────────────────────────────────── */}
      <div className="p-4 pt-2">
        <div className="rounded-2xl border border-input bg-muted/20 transition-colors focus-within:border-ring/60">
          {/* Attached file chips */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {attachedFiles.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs text-foreground"
                >
                  <Paperclip className="size-3 text-muted-foreground" />
                  <span className="max-w-[140px] truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-muted"
                  >
                    <X className="size-3 text-muted-foreground" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="w-full bg-transparent px-4 pt-3 pb-2 text-sm resize-none focus:outline-none placeholder:text-muted-foreground leading-relaxed"
            style={{ minHeight: "44px", maxHeight: "200px", overflowY: "auto" }}
          />

          {/* Toolbar row */}
          <div className="flex items-center justify-between px-3 pb-3">
            {/* Attach file */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Attach file"
            >
              <Paperclip className="size-4" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept=".txt,.md,.csv,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.xml,.yaml,.yml,.sql"
              onChange={handleFileChange}
            />

            {/* Send button */}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              className={cn(
                "flex size-8 items-center justify-center rounded-full transition-colors",
                canSend
                  ? "bg-foreground text-background hover:opacity-80"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
              title="Send message"
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground/50">
          Press Enter to send · Shift+Enter for new line · Attach files with{" "}
          <Paperclip className="inline size-2.5" />
        </p>
      </div>
    </div>
  );
}
