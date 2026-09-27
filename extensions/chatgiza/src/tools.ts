import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";

const MAX_OUTPUT_CHARS = 8000;
const COMMAND_TIMEOUT_MS = 60_000;

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)`;
}

function workspaceRoot(): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No folder is open in this VS Code window -- open a project folder first.");
  }
  return folders[0];
}

// Resolves a model-provided relative path against the workspace root,
// refusing anything that would escape it (e.g. "../../etc/passwd") --
// the model only ever sees paths relative to the open workspace, and
// this is the one place that boundary is actually enforced.
//
// A plain uri.fsPath.startsWith(root.fsPath) check here used to look
// like a real boundary but wasn't one: with root "C:\work\proj", the
// path "../proj-secrets/.env" resolves to "C:\work\proj-secrets\.env",
// and that string genuinely does start with "C:\work\proj" as a literal
// prefix, since "proj-secrets" itself starts with "proj" -- so a sibling
// directory could be reached even though it's not inside the workspace
// at all. path.relative is the correct check: it returns a path
// starting with ".." exactly when the target is outside root, regardless
// of how the two directory names happen to overlap as strings.
function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = workspaceRoot();
  const uri = vscode.Uri.joinPath(root.uri, relativePath);
  const rel = path.relative(root.uri.fsPath, uri.fsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" resolves outside the open workspace.`);
  }
  return uri;
}

export async function readFile(relativePath: string): Promise<string> {
  const uri = resolveWorkspacePath(relativePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return truncate(Buffer.from(bytes).toString("utf-8"));
}

export async function listDirectory(relativePath: string): Promise<string> {
  const uri = resolveWorkspacePath(relativePath || ".");
  const entries = await vscode.workspace.fs.readDirectory(uri);
  if (entries.length === 0) return "(empty directory)";
  return entries
    .map(([name, type]) => `${type === vscode.FileType.Directory ? "[dir] " : "      "}${name}`)
    .join("\n");
}

const OVERVIEW_MAX_FILES = 400;

// Gives the model real, upfront awareness of the whole project shape --
// every file path plus package.json's declared dependencies/scripts --
// instead of it having to build that picture blindly, one
// list_directory/read_file call at a time. Computed fresh on every turn
// (not cached), so it can never go stale if the user adds/removes files
// mid-session, and capped so a huge repo doesn't blow the context budget.
export async function getProjectOverview(): Promise<string> {
  const root = workspaceRoot();
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*"),
    "**/{node_modules,.git,dist,build,out,.next,coverage,.vercel}/**",
    OVERVIEW_MAX_FILES
  );

  const paths = files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
  const tree = paths.length > 0 ? paths.map((p) => `- ${p}`).join("\n") : "(no files found)";
  const truncatedNote =
    paths.length >= OVERVIEW_MAX_FILES
      ? `\n… (showing the first ${OVERVIEW_MAX_FILES} files; use list_directory/search_workspace for the rest)`
      : "";

  let packageInfo = "";
  try {
    const pkgUri = vscode.Uri.joinPath(root.uri, "package.json");
    const pkgText = Buffer.from(await vscode.workspace.fs.readFile(pkgUri)).toString("utf-8");
    const pkg = JSON.parse(pkgText) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const scripts = Object.entries(pkg.scripts ?? {}).map(([name, cmd]) => `  ${name}: ${cmd}`);
    packageInfo =
      `\n\npackage.json:\n` +
      `- name: ${pkg.name ?? "(unnamed)"}\n` +
      (deps.length ? `- dependencies: ${deps.join(", ")}\n` : "") +
      (devDeps.length ? `- devDependencies: ${devDeps.join(", ")}\n` : "") +
      (scripts.length ? `- scripts:\n${scripts.join("\n")}` : "");
  } catch {
    // No package.json (or it's malformed) -- not every project has one,
    // so this just omits the section rather than erroring.
  }

  return `Workspace: "${root.name}"\n\nFiles (${paths.length}${truncatedNote ? "+" : ""}):\n${tree}${truncatedNote}${packageInfo}`;
}

const SYMBOL_KIND_NAMES: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.EnumMember]: "enum member",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.TypeParameter]: "type",
};

// Uses whatever language server VS Code already has active for the file
// (TypeScript, Python, Go, whatever the user has installed) -- the same
// intelligence behind "Go to Symbol" and the Outline view -- so this
// works for any language without ChatGiZa needing its own parser per
// language. Far cheaper than read_file for "what's in this file":
// classes/functions/methods with their line numbers, not the full text.
export async function getFileOutline(relativePath: string): Promise<string> {
  const uri = resolveWorkspacePath(relativePath);
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
    "vscode.executeDocumentSymbolProvider",
    uri
  );
  if (!symbols || symbols.length === 0) {
    return "No symbols found -- either this file has no top-level declarations, or there's no language server active for it (read_file to see the raw contents instead).";
  }

  const lines: string[] = [];
  function walk(list: vscode.DocumentSymbol[], depth: number) {
    for (const s of list) {
      const kind = SYMBOL_KIND_NAMES[s.kind] ?? "symbol";
      lines.push(`${"  ".repeat(depth)}${kind} ${s.name} (line ${s.range.start.line + 1})`);
      if (s.children?.length) walk(s.children, depth + 1);
    }
  }
  walk(symbols, 0);
  return lines.join("\n");
}

// Finds every place a symbol is actually used across the whole workspace
// (via the language server's real cross-file reference index, not a text
// search) -- how one function/class connects to the rest of the codebase,
// which is exactly what changing or removing it safely requires knowing.
// line/character pin the symbol's exact position -- get them from a prior
// get_file_outline or search_workspace result rather than guessing.
export async function findReferences(relativePath: string, line: number, character: number): Promise<string> {
  const uri = resolveWorkspacePath(relativePath);
  const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, character));
  const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
    "vscode.executeReferenceProvider",
    uri,
    position
  );
  if (!locations || locations.length === 0) {
    return "No references found -- either the symbol is unused elsewhere, the position doesn't land on a symbol, or there's no language server active for this file.";
  }
  return locations
    .map((loc) => `${vscode.workspace.asRelativePath(loc.uri, false)}:${loc.range.start.line + 1}`)
    .sort()
    .join("\n");
}

const SEARCH_MAX_FILES = 500;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const NUL_CHAR = String.fromCharCode(0);

// Built on workspace.findFiles + manual matching rather than the proposed
// (non-stable) workspace.findTextInFiles API -- that one isn't part of
// the stable extension API surface most users' VS Code installs expose,
// so relying on it would silently break for anyone not running with
// proposed APIs enabled. Slower, but works everywhere.
export async function searchWorkspace(query: string, isRegex: boolean): Promise<string> {
  const root = workspaceRoot();
  let pattern: RegExp;
  try {
    pattern = isRegex ? new RegExp(query, "g") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch (err) {
    return `Invalid search pattern: ${err instanceof Error ? err.message : String(err)}`;
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*"),
    "**/{node_modules,.git,dist,build,out,.next}/**",
    SEARCH_MAX_FILES
  );

  const results: string[] = [];
  for (const uri of files) {
    if (results.length >= SEARCH_MAX_MATCHES) break;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.type !== vscode.FileType.File || stat.size > SEARCH_MAX_FILE_BYTES) continue;

    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
    } catch {
      continue;
    }
    if (text.includes(NUL_CHAR)) continue;

    const relPath = vscode.workspace.asRelativePath(uri, false);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && results.length < SEARCH_MAX_MATCHES; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (results.length === 0) return "No matches found.";
  return truncate(results.join("\n"));
}

// write_file and run_terminal_command are the two tools that actually
// change something on the user's machine -- each shows a real
// confirmation prompt naming the exact change/command before doing
// anything, and returns a clear "cancelled by user" result (not an
// error) if declined, so the model can react sensibly instead of
// retrying blindly. skipConfirm is set once the user has already
// approved a whole batch via proposePlan below -- the change is still
// real and still logged, it just doesn't interrupt with its own
// separate prompt on top of the one already given for the batch.
export async function writeFile(relativePath: string, content: string, skipConfirm = false): Promise<string> {
  const uri = resolveWorkspacePath(relativePath);
  let existed = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    existed = false;
  }

  if (!skipConfirm) {
    const choice = await vscode.window.showWarningMessage(
      `ChatGiZa wants to ${existed ? "overwrite" : "create"} "${relativePath}". Allow?`,
      { modal: true },
      "Allow"
    );
    if (choice !== "Allow") {
      return `The user declined to ${existed ? "overwrite" : "create"} "${relativePath}". Do not write this file; ask the user what they'd like instead if relevant.`;
    }
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    // Opening the file for the user to see is a nice-to-have, not
    // essential -- the write itself already succeeded above.
  }
  return `${existed ? "Overwrote" : "Created"} "${relativePath}" (${content.length} characters).`;
}

export async function runTerminalCommand(command: string, skipConfirm = false): Promise<string> {
  const root = workspaceRoot();
  if (!skipConfirm) {
    const choice = await vscode.window.showWarningMessage(
      `ChatGiZa wants to run this command in "${root.name}":\n${command}`,
      { modal: true },
      "Run"
    );
    if (choice !== "Run") {
      return `The user declined to run: ${command}`;
    }
  }

  return new Promise((resolve) => {
    exec(
      command,
      { cwd: root.uri.fsPath, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout.trim()) parts.push(`stdout:\n${truncate(stdout.trim())}`);
        if (stderr.trim()) parts.push(`stderr:\n${truncate(stderr.trim())}`);
        if (error) parts.push(`exit code: ${error.code ?? "unknown"}${error.killed ? " (timed out)" : ""}`);
        resolve(parts.length > 0 ? parts.join("\n\n") : "(command produced no output)");
      }
    );
  });
}

// One upfront review for a whole multi-step task, instead of the user
// getting interrupted file by file as each write_file/run_terminal_command
// call happens. Approving here doesn't skip the fact that real changes are
// still happening -- it just moves the single decision point earlier, to
// before any of it starts, with the full picture in view at once.
export async function proposePlan(summary: string, steps: string[]): Promise<boolean> {
  const stepList = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const choice = await vscode.window.showWarningMessage(
    `ChatGiZa wants to: ${summary}\n\n${stepList}`,
    { modal: true },
    "Allow"
  );
  return choice === "Allow";
}
