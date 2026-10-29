import type { SyntaxNode } from "@lezer/common";
import { parser as javascript } from "@lezer/javascript";
import { parser as python } from "@lezer/python";

export const MAX_SCRIPT_BYTES = 65_536;
type Language = "python" | "javascript";
type Value = { kind: "string" | "path" | "symbol"; value: string };
const WRITERS = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function children(node: SyntaxNode | null): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) nodes.push(child);
  return nodes;
}

// Decode only an explicit literal subset, never eval user text. In particular,
// Python concatenation/prefixes and JS templates are not static path evidence.
function literal(text: string): string | undefined {
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) return;
  let value = "";
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char === quote || char === "\n" || char === "\r") return;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = text[++i];
    const simple: Record<string, string> = {
      "\\": "\\",
      "'": "'",
      '"': '"',
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (Object.hasOwn(simple, escaped)) value += simple[escaped];
    else if (escaped === "u" || escaped === "x") {
      const length = escaped === "u" ? 4 : 2;
      const digits = text.slice(i + 1, i + 1 + length);
      if (digits.length !== length || !/^[\da-f]+$/i.test(digits)) return;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      i += length;
    } else return;
  }
  return value;
}

/** A bounded, deliberately partial interpreter of syntax, not executable code.
 * Only straight-line bindings are followed. Unknown scopes invalidate bindings;
 * callers must keep coverage unverified regardless of the returned targets.
 */
export function scriptWriteTargets(source: string, language: Language): string[] {
  if (Buffer.byteLength(source) > MAX_SCRIPT_BYTES) return [];
  try {
    const tree = (language === "python" ? python : javascript).parse(source);
    const cursor = tree.cursor();
    let nodes = 0;
    do {
      if (++nodes > 20_000 || cursor.type.isError) return [];
      // A cwd change invalidates relative attribution for the entire script.
      if (
        ["PropertyName", "VariableName", "VariableDefinition"].includes(cursor.name) &&
        ["chdir", "exec", "eval"].includes(source.slice(cursor.from, cursor.to))
      )
        return [];
    } while (cursor.next());
    const bindings = new Map<string, Value | undefined>();
    if (language === "python") bindings.set("open", { kind: "symbol", value: "open" });
    else bindings.set("require", { kind: "symbol", value: "require" });
    const paths = new Set<string>();
    const text = (node: SyntaxNode) => source.slice(node.from, node.to);
    const symbol = (value: string): Value => ({ kind: "symbol", value });
    const bind = (name: string, value: Value | undefined) => {
      // Even a literal reassignment is outside our single-assignment subset.
      bindings.set(name, bindings.has(name) ? undefined : value);
    };
    const forget = () => {
      for (const name of bindings.keys()) bindings.set(name, undefined);
    };
    const args = (node: SyntaxNode) =>
      children(node.getChild("ArgList")).filter((child) => !["(", ")", ","].includes(child.name));
    const resolveValue = (node: SyntaxNode | undefined): Value | undefined => {
      if (!node) return;
      if (node.name === "String") {
        const value = literal(text(node));
        return value === undefined ? undefined : { kind: "string", value };
      }
      if (node.name === "VariableName") return bindings.get(text(node));
      if (node.name === "MemberExpression") {
        const [base, dot, property] = children(node);
        if (dot?.name !== "." || property?.name !== "PropertyName") return;
        const owner = resolveValue(base);
        const name = text(property);
        if (owner?.kind === "symbol") {
          if (owner.value === "pathlib" && name === "Path") return symbol("Path");
          if (owner.value === "fs" && name === "promises") return symbol("fs");
          if (owner.value === "fs" && WRITERS.has(name)) return symbol("write");
        }
      }
      if (node.name === "CallExpression") {
        const callee = resolveValue(node.firstChild ?? undefined);
        const parameters = args(node);
        const first = resolveValue(parameters[0]);
        if (callee?.kind === "symbol" && first?.kind === "string" && parameters.length === 1) {
          if (callee.value === "Path") return { kind: "path", value: first.value };
          if (callee.value === "require" && FS_MODULES.has(first.value)) return symbol("fs");
        }
      }
    };
    const inspect = (node: SyntaxNode): void => {
      // Do not attribute calls in unexecuted functions, classes, or callbacks.
      if (/Function|Class|Lambda|ArrowFunction/.test(node.name)) return;
      if (["AssignmentExpression", "UpdateExpression"].includes(node.name)) {
        forget();
        return;
      }
      if (node.name === "CallExpression") {
        const calleeNode = node.firstChild;
        if (!calleeNode) return;
        const callee = resolveValue(calleeNode);
        const parameters = args(node);
        const first = resolveValue(parameters[0]);
        if (callee?.kind === "symbol" && callee.value === "write" && first?.kind === "string")
          paths.add(first.value);
        if (callee?.kind === "symbol" && callee.value === "open") {
          const modeAt = parameters.findIndex(
            (p) => p.name === "VariableName" && text(p) === "mode",
          );
          const mode = resolveValue(modeAt < 0 ? parameters[1] : parameters[modeAt + 2]);
          if (
            first &&
            ["string", "path"].includes(first.kind) &&
            mode?.kind === "string" &&
            /^[rwax][bt+]*$/.test(mode.value) &&
            /[wax+]/.test(mode.value)
          )
            paths.add(first.value);
        }
        if (calleeNode.name === "MemberExpression") {
          const [base, dot, property] = children(calleeNode);
          const owner = resolveValue(base);
          if (
            dot?.name === "." &&
            property &&
            owner?.kind === "path" &&
            ["write_text", "write_bytes"].includes(text(property))
          )
            paths.add(owner.value);
        }
      }
      for (const child of children(node)) inspect(child);
    };
    const importStatement = (node: SyntaxNode) => {
      const statement = text(node).trim().replace(/;$/, "");
      if (language === "python") {
        const module = /^import pathlib(?: as (\w+))?$/.exec(statement);
        const path = /^from pathlib import Path(?: as (\w+))?$/.exec(statement);
        if (module) bind(module[1] ?? "pathlib", symbol("pathlib"));
        else if (path) bind(path[1] ?? "Path", symbol("Path"));
        else forget();
        return;
      }
      const sourceNode = node.getChild("String");
      if (!sourceNode || !FS_MODULES.has(literal(text(sourceNode)) ?? "")) {
        forget();
        return;
      }
      const group = node.getChild("ImportGroup");
      if (group) {
        for (const entry of text(group).slice(1, -1).split(",")) {
          const match = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
          if (match)
            bind(match[2] ?? match[1], WRITERS.has(match[1]) ? symbol("write") : undefined);
        }
      } else {
        const name = node.getChild("VariableDefinition");
        if (name) bind(text(name), symbol("fs"));
      }
    };
    for (const statement of children(tree.topNode)) {
      if (["Comment", "LineComment", "BlockComment", ";"].includes(statement.name)) continue;
      if (["ImportStatement", "ImportDeclaration"].includes(statement.name)) {
        importStatement(statement);
        continue;
      }
      if (statement.name === "AssignStatement" || statement.name === "VariableDeclaration") {
        const parts = children(statement).filter(
          (p) => !["const", "let", "var", ";"].includes(p.name),
        );
        const [target, operator, expression] = parts;
        if (parts.length !== 3 || !target || !operator || text(operator) !== "=") {
          forget();
          continue;
        }
        inspect(expression);
        if (
          ["VariableName", "VariableDefinition"].includes(target.name) &&
          IDENTIFIER.test(text(target))
        )
          bind(text(target), resolveValue(expression));
        else if (
          target.name === "ObjectPattern" &&
          resolveValue(expression)?.kind === "symbol" &&
          resolveValue(expression)?.value === "fs"
        ) {
          for (const entry of text(target).slice(1, -1).split(",")) {
            const match = /^\s*(\w+)(?:\s*:\s*(\w+))?\s*$/.exec(entry);
            if (match)
              bind(match[2] ?? match[1], WRITERS.has(match[1]) ? symbol("write") : undefined);
            else forget();
          }
        } else forget();
      } else if (statement.name === "ExpressionStatement") inspect(statement);
      else if (statement.name === "WithStatement") {
        // Opening in write mode itself mutates. The body is a separate scope
        // for our conservative analysis, so do not retain its bindings.
        for (const child of children(statement))
          if (child.name === "CallExpression") inspect(child);
        forget();
      } else forget();
    }
    return [...paths];
  } catch {
    return [];
  }
}
