import * as vscode from "vscode";

interface KeywordSpec {
    keyword: string;
    detail: string;
}

/** Silverstripe template control-tag keywords, offered right after typing `<%`. */
const KEYWORDS: KeywordSpec[] = [
    { keyword: "if", detail: "<% if $Condition %> ... <% end_if %>" },
    { keyword: "else_if", detail: "<% else_if $Condition %>" },
    { keyword: "else", detail: "<% else %>" },
    { keyword: "end_if", detail: "Closes <% if %>" },
    { keyword: "loop", detail: "<% loop $List %> ... <% end_loop %>" },
    { keyword: "end_loop", detail: "Closes <% loop %>" },
    { keyword: "with", detail: "<% with $Object %> ... <% end_with %>" },
    { keyword: "end_with", detail: "Closes <% with %>" },
    { keyword: "cached", detail: "<% cached %> ... <% end_cached %>" },
    { keyword: "end_cached", detail: "Closes <% cached %>" },
    { keyword: "uncached", detail: "<% uncached %> ... <% end_uncached %>" },
    { keyword: "end_uncached", detail: "Closes <% uncached %>" },
    { keyword: "include", detail: "<% include TemplateName %>" },
    {
        keyword: "require",
        detail: "<% require css(...) %> / <% require javascript(...) %>",
    },
    { keyword: "base_tag", detail: "<% base_tag %>" },
    { keyword: "t", detail: "<%t Namespace\\Class.KEY 'Default value' %>" },
];

/**
 * Suggests Silverstripe control-tag keywords (if, loop, with, include, ...)
 * right after typing `<%`, before the more specific providers take over.
 */
export class TemplateKeywordCompletionProvider
    implements vscode.CompletionItemProvider
{
    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): vscode.CompletionItem[] | undefined {
        const linePrefix = document
            .lineAt(position)
            .text.substring(0, position.character);

        // Only right after "<%", optionally with a partial keyword already typed.
        // (Also excludes "<%--" comments, since "-" breaks this match.)
        if (!/<%\s*[A-Za-z_]*$/.test(linePrefix)) {
            return undefined;
        }

        // Auto-closing "<%" leaves "%>" immediately after the cursor with no
        // space, so accepting a suggestion would otherwise produce "if%>".
        const lineSuffix = document
            .lineAt(position)
            .text.slice(position.character);
        const needsTrailingSpace = /^%>/.test(lineSuffix);

        return KEYWORDS.map(({ keyword, detail }) => {
            const item = new vscode.CompletionItem(
                keyword,
                vscode.CompletionItemKind.Keyword,
            );
            item.detail = detail;
            item.insertText = needsTrailingSpace ? `${keyword} ` : keyword;
            return item;
        });
    }
}
