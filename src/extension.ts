import * as vscode from "vscode";
import { PhpClassInspector } from "./providers/phpClassInspector";
import { TemplateClassMapper } from "./providers/templateClassMapper";
import { TemplateCompletionProvider } from "./providers/templateCompletionProvider";
import { TemplateDefinitionProvider } from "./providers/templateDefinitionProvider";
import { TemplateDiagnosticsProvider } from "./providers/templateDiagnosticsProvider";
import { TemplateKeywordCompletionProvider } from "./providers/templateKeywordCompletionProvider";
import { TranslationCompletionProvider } from "./providers/translationCompletionProvider";
import { TranslationKeyProvider } from "./providers/translationKeyProvider";
import { VariableCompletionProvider } from "./providers/variableCompletionProvider";

export function activate(context: vscode.ExtensionContext) {
    const selector = { scheme: "file", language: "silverstripe" };

    // Shared instances for class mapping and inspection
    const mapper = new TemplateClassMapper();
    const inspector = new PhpClassInspector();

    // Shared translation key provider — pre-warmed async so first <%t completion
    // is instant instead of blocking while PHP boots Silverstripe's CoreKernel.
    const translationKeyProvider = new TranslationKeyProvider();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        translationKeyProvider.preWarm(workspaceFolder.uri.fsPath).catch(() => {
            // Silently ignore warmup errors; getKeys() will retry on first use
        });
    }

    // Register definition provider for template includes
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            selector,
            new TemplateDefinitionProvider(),
        ),
    );

    // Register completion provider for control-tag keywords (if, loop, include, ...)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new TemplateKeywordCompletionProvider(),
            "%",
        ),
    );

    // Register completion provider for template paths (include statements)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new TemplateCompletionProvider(),
            " ",
            '"',
            "'",
        ),
    );

    // Register completion provider for <%t translation keys
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new TranslationCompletionProvider(translationKeyProvider),
            " ", // space after <%t  — shows full list immediately
            "\\", // backslash — namespace separator
            ".", // dot — class.KEY separator
        ),
    );

    // Register completion provider for $Variable and dot-chain completions
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new VariableCompletionProvider(mapper, inspector),
            "$",
            ".",
        ),
    );

    // Diagnostics: unclosed/mismatched block tags, missing $ prefixes, unresolved includes
    new TemplateDiagnosticsProvider().register(context);

    // Status bar item showing mapped class
    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    context.subscriptions.push(statusBar);

    function updateStatusBar(editor?: vscode.TextEditor) {
        if (editor?.document.languageId !== "silverstripe") {
            statusBar.hide();
            return;
        }
        const fqn = mapper.mapTemplateToClass(editor.document.uri);
        if (fqn) {
            statusBar.text = `$(symbol-class) ${fqn}`;
            statusBar.tooltip = `Silverstripe: mapped to PHP class ${fqn}`;
            statusBar.show();
        } else {
            statusBar.text = "$(symbol-file) Include";
            statusBar.tooltip =
                "Silverstripe: include template (no class mapping)";
            statusBar.show();
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    );
    updateStatusBar(vscode.window.activeTextEditor);

    vscode.window.showInformationMessage("Silverstripe Language Support ready");
}

export function deactivate() {}
