import * as vscode from "vscode";
import { TranslationKeyProvider } from "./translationKeyProvider";

/**
 * Provides autocomplete for Silverstripe translation keys used in .ss templates.
 *
 * Syntax: <%t Namespace\Class.KEY 'Default value' %>
 *
 * Triggers when the cursor is inside a <%t … %> expression:
 *   <%t |                          → suggest all known keys
 *   <%t App\|                      → filter by prefix "App\"
 *   <%t App\Elements\ElementHero.| → filter by full class prefix
 *
 * Selecting a completion inserts: Key 'default value'
 * leaving the user to close with ` %>` (or add interpolation vars first).
 */
export class TranslationCompletionProvider
    implements vscode.CompletionItemProvider
{
    private keyProvider: TranslationKeyProvider;

    constructor(keyProvider?: TranslationKeyProvider) {
        this.keyProvider = keyProvider ?? new TranslationKeyProvider();
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): vscode.CompletionItem[] | undefined {
        const linePrefix = document
            .lineAt(position)
            .text.substring(0, position.character);

        // Match <%t followed by an optional partial key.
        const match = linePrefix.match(/<%t\s+([\w\\]*(?:\.[\w]*)?)$/);
        if (!match) {
            return undefined;
        }

        const typedKey = match[1];

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            document.uri,
        );
        if (!workspaceFolder) {
            return undefined;
        }

        // Read from cache synchronously — warmup runs in background at activation.
        // If warmup hasn’t finished yet, show a placeholder so the user knows.
        const allKeys = this.keyProvider.getCachedKeys(
            workspaceFolder.uri.fsPath,
        );
        if (allKeys === null) {
            return [
                new vscode.CompletionItem(
                    "⏳ Loading translation keys (Silverstripe warming up…)",
                    vscode.CompletionItemKind.Event,
                ),
            ];
        }

        // Range that covers what the user has already typed (so the selection
        // replaces rather than appends)
        const keyStartCol = position.character - typedKey.length;
        const keyStart = new vscode.Position(position.line, keyStartCol);
        const range = new vscode.Range(keyStart, position);

        // Auto-closed `%>` sits right after the cursor with no space (e.g. "<%t |%>") —
        // add one so the inserted text doesn't get glued to the closing tag.
        const lineSuffix = document
            .lineAt(position)
            .text.substring(position.character);
        const trailingSpace = /^%>/.test(lineSuffix) ? " " : "";

        const items: vscode.CompletionItem[] = [];

        for (const entry of allKeys) {
            if (!entry.key.startsWith(typedKey)) {
                continue;
            }

            const item = new vscode.CompletionItem(
                entry.key,
                vscode.CompletionItemKind.Constant,
            );

            // Show English default in detail column (most useful at a glance)
            const displayValue = entry.enValue ?? entry.value;
            item.detail = displayValue || undefined;

            // Rich tooltip: English default + project-locale translation
            const docLines: string[] = [];
            if (entry.enValue) {
                docLines.push(`**${entry.enValue}** *(en)*`);
                if (entry.value && entry.value !== entry.enValue) {
                    docLines.push(`${entry.value} *(${entry.locale})*`);
                }
            } else if (entry.value) {
                docLines.push(`**${entry.value}** *(${entry.locale})*`);
            }
            if (docLines.length) {
                item.documentation = new vscode.MarkdownString(
                    docLines.join("\n\n"),
                );
            }

            // Replace the partial key the user typed
            item.range = range;

            // Insert: full key + English default value (convention for <%t default)
            // Fall back to project-locale value if no English string exists
            const insertDefault = entry.enValue ?? entry.value;
            const escaped = insertDefault.replace(/'/g, "\\'");
            item.insertText = insertDefault
                ? `${entry.key} '${escaped}'${trailingSpace}`
                : `${entry.key}${trailingSpace}`;

            // filterText must match what's typed (including backslashes)
            item.filterText = entry.key;

            // Sort so app keys appear before vendor keys
            item.sortText = entry.key.startsWith("App\\")
                ? `0_${entry.key}`
                : `1_${entry.key}`;

            items.push(item);
        }

        return items;
    }
}
