const BASE_URL = "https://www.chatgiza.com";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// Mirrors the backend's SanitizedContentPart (src/lib/agentMessages.ts) --
// lets a user turn carry an attached image (read from a VS Code chat
// reference, see extension.ts) as a base64 data URL, alongside its text.
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type AgentMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AgentTurnResult =
  | { type: "final"; message: { role: "assistant"; content: string } }
  | { type: "tool_calls"; message: { role: "assistant"; content: string | null; tool_calls: ToolCall[] } };

type StreamEvent =
  | { type: "content"; text: string }
  | { type: "tool_call_start" }
  | { type: "done"; toolCalls: ToolCall[]; content: string | null }
  | { type: "error"; error: string };

// One request/response round of the agent loop -- the extension (see
// extension.ts) is what actually drives the loop and executes any tool
// calls the model asks for, since only the extension has access to the
// user's real workspace and terminal. The backend streams its answer as
// newline-delimited JSON (same shape /api/build/turn uses); onContent is
// called with each text chunk as it arrives so the caller can show it
// typing in live, rather than the chat panel sitting blank until the
// whole completion finishes. onToolCallStart fires once, the moment the
// model starts forming a tool call -- its arguments can still take a
// while to finish streaming with no more text chunks in between, so
// without this the caller has no way to show "still working" during
// that gap.
export async function agentTurn(
  token: string,
  messages: AgentMessage[],
  projectOverview: string | undefined,
  onContent: (chunk: string) => void,
  onToolCallStart: () => void
): Promise<AgentTurnResult> {
  const res = await fetch(`${BASE_URL}/api/agent/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, projectOverview }),
  });

  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    const errorMessage = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null;
    throw new Error(errorMessage || `ChatGiZa returned ${res.status}`);
  }
  if (!res.body) {
    throw new Error("ChatGiZa returned an empty response.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: { toolCalls: ToolCall[]; content: string | null } | null = null;
  let streamError: string | null = null;

  while (true) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "content" && typeof event.text === "string") {
        onContent(event.text);
      } else if (event.type === "tool_call_start") {
        onToolCallStart();
      } else if (event.type === "done") {
        done = { toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls : [], content: event.content ?? null };
      } else if (event.type === "error" && typeof event.error === "string") {
        streamError = event.error;
      }
    }
  }

  if (streamError) throw new Error(streamError);
  if (!done) throw new Error("ChatGiZa didn't finish its response.");

  if (done.toolCalls.length > 0) {
    return { type: "tool_calls", message: { role: "assistant", content: done.content, tool_calls: done.toolCalls } };
  }
  return { type: "final", message: { role: "assistant", content: done.content ?? "" } };
}
