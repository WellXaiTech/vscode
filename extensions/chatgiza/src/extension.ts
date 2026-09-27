import * as vscode from "vscode";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { agentTurn, type AgentMessage, type ContentPart, type ToolCall } from "./api";
import {
  findReferences,
  getFileOutline,
  getProjectOverview,
  listDirectory,
  proposePlan,
  readFile,
  runTerminalCommand,
  searchWorkspace,
  writeFile,
} from "./tools";

const TOKEN_KEY = "chatgiza.token";
// Raised from 8 -- a real multi-file task (several files touched, a
// build run, fixing what it reports) routinely needs more than 8
// tool-call rounds, and each round is already gated by the same
// per-write/per-command confirmation prompt regardless of the cap, so a
// higher ceiling doesn't change what the user has to approve, just how
// much can get done before this loop gives up and asks them to say
// "continue".
const MAX_AGENT_STEPS = 25;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_ATTACHED_TEXT_CHARS = 50_000;
// Guards against reading a huge video/installer/archive fully into memory
// just to discover it's not a format any branch below can do anything
// with -- checked via a cheap stat() before any real read.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const BINARY_MARKER = String.fromCharCode(0);

function truncateAttachedText(text: string): string {
  if (text.length <= MAX_ATTACHED_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_ATTACHED_TEXT_CHARS)}\n… (truncated, ${text.length - MAX_ATTACHED_TEXT_CHARS} more characters)`;
}

// VS Code's chat UI lets a user attach a file (drag/paste/pick, or the
// paperclip/"Add Context" picker), which shows up as a plain file Uri in
// request.references -- there's no dedicated "this is an image" vs. "this
// is a document" reference type in the API, so this branches purely on
// file extension. This is also the reliable way to hand the model a long
// spec/brief: save it to a file and attach that file, rather than pasting
// the raw text directly into the chat input box, whose own multi-line
// editor can lose content on a very large single paste (a VS Code UI
// limitation this extension has no control over, since it only ever sees
// request.prompt after VS Code's own input box has already captured it).
//
// Coverage: images (as base64 data URLs, same shape the main web chat
// sends), PDF and Word .docx (text extracted via pdf-parse/mammoth), and
// any plain-text file regardless of extension (source code, markdown,
// json, yaml, csv, ini, ...). Anything else -- a genuinely opaque binary
// format like a zip, executable, or media file this extension has no
// parser for -- is reported to the model explicitly instead of silently
// vanishing, so the model can tell the user rather than just not knowing
// the attachment existed.
async function readReferenceParts(references: readonly vscode.ChatPromptReference[]): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const ref of references) {
    // A very long paste into the chat input box doesn't get lost -- VS
    // Code itself swaps it out for a "Pasted text #N" reference chip so
    // the input box doesn't get flooded with raw text, and hands the full
    // pasted string back here as ref.value (ChatPromptReference.value is
    // typed as string | Uri | Location | unknown -- this is the string
    // case). Skipping non-Uri values used to silently drop this, which
    // read exactly like data loss even though VS Code had preserved the
    // full text the whole time.
    if (typeof ref.value === "string") {
      parts.push({ type: "text", text: `Attached pasted text:\n\n${truncateAttachedText(ref.value)}` });
      continue;
    }

    // A reference to a specific range within an open document (e.g. a
    // selection the user attached) -- read just that slice rather than
    // the whole file.
    if (ref.value instanceof vscode.Location) {
      const loc = ref.value;
      try {
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const text = doc.getText(loc.range);
        parts.push({
          type: "text",
          text: `Attached selection from "${vscode.workspace.asRelativePath(loc.uri, false)}" (lines ${loc.range.start.line + 1}-${loc.range.end.line + 1}):\n\n${truncateAttachedText(text)}`,
        });
      } catch (err) {
        parts.push({
          type: "text",
          text: `Attached selection reference couldn't be read (${err instanceof Error ? err.message : String(err)}) -- skipped.`,
        });
      }
      continue;
    }

    if (!(ref.value instanceof vscode.Uri)) {
      // Neither string, Location, nor Uri -- an attachment shape this
      // extension doesn't recognize yet. Surfaced as diagnostic text
      // (id/description/a safe dump of the value) instead of silently
      // dropped, so a real report from a live session shows exactly what
      // VS Code actually sent instead of us having to guess blind.
      let dump: string;
      try {
        dump = JSON.stringify(ref.value, null, 2) ?? String(ref.value);
      } catch {
        dump = Object.prototype.toString.call(ref.value);
      }
      parts.push({
        type: "text",
        text: `Attachment "${ref.id}" has a value shape this extension doesn't know how to read yet (modelDescription: ${ref.modelDescription ?? "none"}). Raw value dump: ${truncateAttachedText(dump)}`,
      });
      continue;
    }
    const uri = ref.value;
    const ext = uri.path.slice(uri.path.lastIndexOf(".")).toLowerCase();
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const mime = IMAGE_MIME_BY_EXT[ext];

    try {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch (statErr) {
        // uri.scheme isn't a real filesystem (e.g. an in-memory/virtual
        // document VS Code created for this attachment) -- fs.stat/
        // fs.readFile only work for registered filesystem providers, but
        // openTextDocument can still resolve many virtual schemes via
        // whatever TextDocumentContentProvider backs them.
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          parts.push({ type: "text", text: `Attached text "${relPath}":\n\n${truncateAttachedText(doc.getText())}` });
          continue;
        } catch {
          throw statErr;
        }
      }
      if (stat.type !== vscode.FileType.File) continue;
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        parts.push({
          type: "text",
          text: `Attached file "${relPath}" is too large to read (${Math.round(stat.size / (1024 * 1024))} MB, limit ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB) -- skipped.`,
        });
        continue;
      }

      if (mime) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const base64 = Buffer.from(bytes).toString("base64");
        parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } });
        continue;
      }

      if (ext === ".pdf") {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const result = await pdfParse(Buffer.from(bytes));
        parts.push({
          type: "text",
          text: `Attached PDF "${relPath}" (${result.numpages} pages), extracted text:\n\n${truncateAttachedText(result.text)}`,
        });
        continue;
      }

      if (ext === ".docx") {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
        parts.push({
          type: "text",
          text: `Attached Word document "${relPath}", extracted text:\n\n${truncateAttachedText(result.value)}`,
        });
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf-8");
      if (text.includes(BINARY_MARKER)) {
        // Binary content this extension has no parser for -- say so
        // explicitly rather than silently dropping the attachment.
        parts.push({
          type: "text",
          text: `Attached file "${relPath}" is a binary format that isn't readable as text (not an image, PDF, or .docx this extension knows how to parse) -- its contents were not included. Ask the user to describe it, or attach a text/PDF/DOCX version instead.`,
        });
        continue;
      }
      parts.push({ type: "text", text: `Attached file "${relPath}":\n\n${truncateAttachedText(text)}` });
    } catch (err) {
      parts.push({
        type: "text",
        text: `Attached file "${relPath}" couldn't be read (${err instanceof Error ? err.message : String(err)}) -- skipped.`,
      });
    }
  }
  return parts;
}

async function getStoredToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(TOKEN_KEY);
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Rebuilds the running conversation from VS Code's own chat history for
// this participant, rather than the extension keeping a separate copy --
// stays in sync with whatever the user sees in the chat panel (including
// after they delete/edit turns there) for free.
//
// This used to only extract the final markdown answer, which is how a
// previous turn's real tool_calls/tool results silently disappeared by
// the next message -- the model's own final summary survived (per its
// own "give a clear, concise summary of what you did" instruction), but
// the exact files touched, search results, and command output didn't.
// stream.progress(...) calls (the "Reading X…"/"Writing Y…" lines
// already shown live in the chat, see describeToolCall below) are also
// real entries in this same history array, as ChatResponseProgressPart --
// folding those in gives the model back a real trail of what actually
// happened, sourced entirely from what's already visible in the chat UI
// (so it stays in sync with a deleted/edited turn exactly as before,
// nothing new to keep in sync separately).
function historyToMessages(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      let markdownText = "";
      const actions: string[] = [];
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) {
          markdownText += part.value.value;
        } else if (part instanceof vscode.ChatResponseProgressPart) {
          actions.push(part.value);
        }
      }
      const content = [actions.length > 0 ? `[Actions taken: ${actions.join("; ")}]` : "", markdownText]
        .filter((s) => s.trim())
        .join("\n\n");
      if (content.trim()) messages.push({ role: "assistant", content });
    }
  }
  return messages;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("chatgiza.signIn", async () => {
      const openChoice = await vscode.window.showInformationMessage(
        "Sign in to ChatGiZa in your browser, generate a token, then come back and paste it here.",
        "Open chatgiza.com/vscode-auth"
      );
      if (openChoice) {
        await vscode.env.openExternal(vscode.Uri.parse("https://www.chatgiza.com/vscode-auth"));
      }
      const token = await vscode.window.showInputBox({
        prompt: "Paste your ChatGiZa token",
        password: true,
        ignoreFocusOut: true,
      });
      if (token?.trim()) {
        await context.secrets.store(TOKEN_KEY, token.trim());
        vscode.window.showInformationMessage("Signed in to ChatGiZa. Open chat and mention @chatgiza to start.");
      }
    }),
    vscode.commands.registerCommand("chatgiza.signOut", async () => {
      await context.secrets.delete(TOKEN_KEY);
      vscode.window.showInformationMessage("Signed out of ChatGiZa.");
    })
  );

  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, cancellationToken) => {
    const token = await getStoredToken(context);
    if (!token) {
      stream.markdown(
        "You're not signed in yet. Run **ChatGiZa: Sign In** from the Command Palette (Ctrl/Cmd+Shift+P) first."
      );
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      stream.markdown("Open a project folder first (**File > Open Folder**) so I have somewhere to work.");
      return;
    }

    const messages = historyToMessages(chatContext.history);
    const attachedParts = await readReferenceParts(request.references);
    if (attachedParts.length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: request.prompt || "See attached file(s)/image(s)." }, ...attachedParts],
      });
    } else {
      messages.push({ role: "user", content: request.prompt });
    }

    // Computed once per user message (not on every step of the loop
    // below) -- one findFiles pass is enough to orient the model for
    // this whole turn, and the file list can't meaningfully change
    // between one tool call and the next within the same request.
    let projectOverview: string | undefined;
    try {
      projectOverview = await getProjectOverview();
    } catch (err) {
      console.error("ChatGiZa: couldn't build project overview:", err);
    }

    // Set once the user approves a propose_plan call -- scoped to this
    // one request (a fresh handler invocation per user message), so it
    // never leaks approval from one task into an unrelated later one.
    // Once true, write_file/run_terminal_command skip their own
    // individual confirmation for the rest of this turn.
    let planApproved = false;

    async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
      switch (name) {
        case "read_file":
          return readFile(String(args.path ?? ""));
        case "list_directory":
          return listDirectory(String(args.path ?? "."));
        case "search_workspace":
          return searchWorkspace(String(args.query ?? ""), !!args.isRegex);
        case "get_file_outline":
          return getFileOutline(String(args.path ?? ""));
        case "find_references":
          return findReferences(String(args.path ?? ""), Number(args.line ?? 0), Number(args.character ?? 0));
        case "propose_plan": {
          const steps = Array.isArray(args.steps) ? args.steps.map((s) => String(s)) : [];
          const approved = await proposePlan(String(args.summary ?? ""), steps);
          planApproved = approved;
          return approved
            ? "The user approved this plan. Proceed with it -- write_file and run_terminal_command won't prompt separately for the rest of this turn."
            : "The user declined this plan. Stop and ask what they'd like instead; don't propose a slightly different plan and try again.";
        }
        case "write_file":
          return writeFile(String(args.path ?? ""), String(args.content ?? ""), planApproved);
        case "run_terminal_command":
          return runTerminalCommand(String(args.command ?? ""), planApproved);
        default:
          return `Unknown tool "${name}".`;
      }
    }

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      if (cancellationToken.isCancellationRequested) return;

      let streamedAnyContent = false;
      let result;
      try {
        result = await agentTurn(
          token,
          messages,
          projectOverview,
          (chunk) => {
            streamedAnyContent = true;
            stream.markdown(chunk);
          },
          () => stream.progress("Working on it…")
        );
      } catch (err) {
        stream.markdown(`⚠️ ${err instanceof Error ? err.message : "Something went wrong talking to ChatGiZa."}`);
        return;
      }

      if (result.type === "final") {
        // Already shown live via the onContent callback above -- only
        // the empty-response fallback still needs printing here.
        if (!streamedAnyContent) stream.markdown("(no response)");
        return;
      }

      // Defensive: result.type is "tool_calls" here, so this should
      // always be a real array -- but a version mismatch between an
      // outdated extension build and this server's response shape could
      // otherwise crash with a cryptic "Cannot read properties of
      // undefined" instead of a message that actually explains what's
      // wrong.
      if (!result.message || !Array.isArray(result.message.tool_calls)) {
        stream.markdown(
          "⚠️ Got an unexpected response shape from ChatGiZa. Try **ChatGiZa: Sign In** again, or reload " +
            "this VS Code window (Ctrl/Cmd+Shift+P → \"Developer: Reload Window\") to make sure the latest " +
            "extension version is actually running."
        );
        return;
      }

      const toolCalls: ToolCall[] = result.message.tool_calls;
      messages.push(result.message);

      for (const call of toolCalls) {
        if (cancellationToken.isCancellationRequested) return;
        const args = safeParseArgs(call.function.arguments);
        stream.progress(describeToolCall(call.function.name, args));
        let output: string;
        try {
          output = await executeTool(call.function.name, args);
        } catch (err) {
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }

    stream.markdown(
      `\n\nThis is taking more than ${MAX_AGENT_STEPS} steps, so I'm pausing here rather than continuing ` +
        "unbounded. Everything done so far is saved in this chat -- just say **continue** and I'll pick up " +
        "exactly where I left off, using what's already been read/written as context."
    );
  };

  const participant = vscode.chat.createChatParticipant("chatgiza.agent", handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
  context.subscriptions.push(participant);
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Reading ${args.path}…`;
    case "list_directory":
      return `Listing ${args.path || "."}…`;
    case "search_workspace":
      return `Searching for "${args.query}"…`;
    case "get_file_outline":
      return `Outlining ${args.path}…`;
    case "find_references":
      return `Finding references in ${args.path}…`;
    case "propose_plan":
      return `Proposing a plan: ${args.summary}`;
    case "write_file":
      return `Writing ${args.path}…`;
    case "run_terminal_command":
      return `Running: ${args.command}`;
    default:
      return `Running ${name}…`;
  }
}

export function deactivate() {}
