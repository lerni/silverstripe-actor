import * as vscode from 'vscode';
import { TemplateDefinitionProvider } from './providers/templateDefinitionProvider';
import { TemplateCompletionProvider } from './providers/templateCompletionProvider';
import { TemplateClassMapper } from './providers/templateClassMapper';
import { PhpClassInspector } from './providers/phpClassInspector';
import { VariableCompletionProvider } from './providers/variableCompletionProvider';

export function activate(context: vscode.ExtensionContext) {
    const selector = { scheme: 'file', language: 'silverstripe' };

    // Shared instances for class mapping and inspection
    const mapper = new TemplateClassMapper();
    const inspector = new PhpClassInspector();

    // Register definition provider for template includes
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            selector,
            new TemplateDefinitionProvider()
        )
    );

    // Register completion provider for template paths (include statements)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new TemplateCompletionProvider(),
            ' ', '"', "'"
        )
    );

    // Register completion provider for $Variable completions
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new VariableCompletionProvider(mapper, inspector),
            '$'
        )
    );

    // Status bar item showing mapped class
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBar);

    function updateStatusBar(editor?: vscode.TextEditor) {
        if (!editor || editor.document.languageId !== 'silverstripe') {
            statusBar.hide();
            return;
        }
        const fqn = mapper.mapTemplateToClass(editor.document.uri);
        if (fqn) {
            statusBar.text = `$(symbol-class) ${fqn}`;
            statusBar.tooltip = `Silverstripe: mapped to PHP class ${fqn}`;
            statusBar.show();
        } else {
            statusBar.text = '$(symbol-file) Include';
            statusBar.tooltip = 'Silverstripe: include template (no class mapping)';
            statusBar.show();
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateStatusBar)
    );
    updateStatusBar(vscode.window.activeTextEditor);

    vscode.window.showInformationMessage('Silverstripe Language Support ready');
}

export function deactivate() {
    console.log('Silverstripe Language Support deactivated');
}
