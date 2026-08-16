import * as vscode from "vscode";
import { TemplateDefinitionProvider } from "./templateDefinitionProvider";

/** Block tags that open a scope, mapped to the tag that must close it. */
const BLOCK_OPENERS: Record<string, string> = {
    if: "end_if",
    loop: "end_loop",
    with: "end_with",
    cached: "end_cached",
    uncached: "end_uncached",
};

const CONTROL_TAG_REGEX =
    /<%\s*(if|else_if|else|end_if|loop|end_loop|with|end_with|cached|end_cached|uncached|end_uncached|include)\b([^%]*?)%>/g;

const CONDITION_KEYWORDS = new Set([
    "not",
    "and",
    "or",
    "true",
    "false",
    "null",
]);

interface StackEntry {
    tag: string;
    range: vscode.Range;
}

/**
 * Diagnoses common Silverstripe template mistakes:
 * - unclosed / mismatched control block tags (if, loop, with, cached, uncached)
 * - `<% if %>` / `<% else_if %>` conditions referencing a variable without its `$` prefix
 * - `<% include %>` pointing at a template that cannot be resolved
 */
export class TemplateDiagnosticsProvider {
    private collection =
        vscode.languages.createDiagnosticCollection("silverstripe");
    private definitionProvider = new TemplateDefinitionProvider();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    public register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(this.collection);

        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
            vscode.workspace.onDidChangeTextDocument((e) =>
                this.scheduleRefresh(e.document),
            ),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.collection.delete(doc.uri);
            }),
        );

        for (const doc of vscode.workspace.textDocuments) {
            this.refresh(doc);
        }
    }

    private scheduleRefresh(document: vscode.TextDocument): void {
        if (document.languageId !== "silverstripe") {
            return;
        }
        const key = document.uri.toString();
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                this.refresh(document);
            }, 300),
        );
    }

    private refresh(document: vscode.TextDocument): void {
        if (document.languageId !== "silverstripe") {
            return;
        }

        const text = this.maskComments(document.getText());
        const diagnostics: vscode.Diagnostic[] = [];

        const tags = this.scanControlTags(text);
        this.checkBlockNesting(document, tags, diagnostics);
        this.checkMissingDollar(document, tags, diagnostics);
        this.checkUnresolvedIncludes(document, tags, diagnostics);

        this.collection.set(document.uri, diagnostics);
    }

    /** Blanks out `<%-- ... --%>` comments so their contents never trigger diagnostics. */
    private maskComments(text: string): string {
        return text.replace(/<%--[\s\S]*?--%>/g, (match) =>
            match.replace(/[^\n]/g, " "),
        );
    }

    private scanControlTags(text: string) {
        const tags: {
            tag: string;
            condition: string;
            tagStart: number;
            conditionStart: number;
        }[] = [];

        for (const match of text.matchAll(CONTROL_TAG_REGEX)) {
            const tag = match[1];
            const condition = match[2];
            const tagStart = match.index ?? 0;
            const conditionStart =
                tagStart + (match[0].indexOf(match[1]) + match[1].length);
            tags.push({ tag, condition, tagStart, conditionStart });
        }

        return tags;
    }

    private checkBlockNesting(
        document: vscode.TextDocument,
        tags: ReturnType<TemplateDiagnosticsProvider["scanControlTags"]>,
        diagnostics: vscode.Diagnostic[],
    ): void {
        const stack: StackEntry[] = [];

        for (const { tag, tagStart } of tags) {
            const range = new vscode.Range(
                document.positionAt(tagStart),
                document.positionAt(tagStart + 2 + tag.length),
            );

            if (tag in BLOCK_OPENERS) {
                stack.push({ tag, range });
                continue;
            }

            if (tag === "else_if" || tag === "else") {
                if (
                    stack.length === 0 ||
                    stack[stack.length - 1].tag !== "if"
                ) {
                    diagnostics.push(
                        this.error(
                            range,
                            `<% ${tag} %> found outside of an <% if %> block.`,
                        ),
                    );
                }
                continue;
            }

            if (tag.startsWith("end_")) {
                const top = stack.pop();
                if (!top) {
                    diagnostics.push(
                        this.error(
                            range,
                            `<% ${tag} %> has no matching opening tag.`,
                        ),
                    );
                } else if (BLOCK_OPENERS[top.tag] !== tag) {
                    diagnostics.push(
                        this.error(
                            range,
                            `Expected <% ${BLOCK_OPENERS[top.tag]} %> to close <% ${top.tag} %>, found <% ${tag} %>.`,
                        ),
                    );
                    // Put it back so a later matching end tag can still resolve this opener.
                    stack.push(top);
                }
            }
        }

        for (const unclosed of stack) {
            diagnostics.push(
                this.error(
                    unclosed.range,
                    `<% ${unclosed.tag} %> is never closed with <% ${BLOCK_OPENERS[unclosed.tag]} %>.`,
                ),
            );
        }
    }

    private checkMissingDollar(
        document: vscode.TextDocument,
        tags: ReturnType<TemplateDiagnosticsProvider["scanControlTags"]>,
        diagnostics: vscode.Diagnostic[],
    ): void {
        for (const { tag, condition, conditionStart } of tags) {
            if (tag !== "if" && tag !== "else_if") {
                continue;
            }

            // Blank out quoted strings so their contents aren't mistaken for variables.
            const masked = condition.replace(/(['"])(?:(?!\1).)*\1/g, (m) =>
                " ".repeat(m.length),
            );

            for (const wordMatch of masked.matchAll(
                /[A-Za-z_][A-Za-z0-9_]*/g,
            )) {
                const word = wordMatch[0];
                const wordIndex = wordMatch.index ?? 0;

                if (CONDITION_KEYWORDS.has(word.toLowerCase())) {
                    continue;
                }

                const precedingChar =
                    wordIndex > 0 ? masked[wordIndex - 1] : undefined;
                if (precedingChar === "$") {
                    continue; // already a $Variable
                }

                const followingChar = masked
                    .slice(wordIndex + word.length)
                    .trimStart()[0];
                if (followingChar === "(") {
                    continue; // looks like a helper/function call, not a bare variable
                }

                const start = conditionStart + wordIndex;
                const range = new vscode.Range(
                    document.positionAt(start),
                    document.positionAt(start + word.length),
                );
                diagnostics.push(
                    this.warning(
                        range,
                        `'${word}' is missing the required '$' prefix.`,
                    ),
                );
            }
        }
    }

    private checkUnresolvedIncludes(
        document: vscode.TextDocument,
        tags: ReturnType<TemplateDiagnosticsProvider["scanControlTags"]>,
        diagnostics: vscode.Diagnostic[],
    ): void {
        for (const { tag, condition, conditionStart } of tags) {
            if (tag !== "include") {
                continue;
            }

            const nameMatch = condition.match(/^\s*([\w\\/]+)/);
            if (!nameMatch) {
                continue;
            }

            const templateName = nameMatch[1];
            const resolved = this.definitionProvider.findTemplate(
                templateName,
                document.uri,
            );
            if (resolved) {
                continue;
            }

            const start =
                conditionStart +
                (nameMatch.index ?? 0) +
                nameMatch[0].indexOf(templateName);
            const range = new vscode.Range(
                document.positionAt(start),
                document.positionAt(start + templateName.length),
            );
            diagnostics.push(
                this.warning(
                    range,
                    `Cannot resolve included template '${templateName}'.`,
                ),
            );
        }
    }

    private error(range: vscode.Range, message: string): vscode.Diagnostic {
        const diagnostic = new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "silverstripe";
        return diagnostic;
    }

    private warning(range: vscode.Range, message: string): vscode.Diagnostic {
        const diagnostic = new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "silverstripe";
        return diagnostic;
    }
}
