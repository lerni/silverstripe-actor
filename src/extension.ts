import * as vscode from 'vscode';
import { TemplateDefinitionProvider } from './providers/templateDefinitionProvider';
import { TemplateCompletionProvider } from './providers/templateCompletionProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Silverstripe Language Support activated');

    // Register definition provider for template includes
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { scheme: 'file', language: 'silverstripe' },
            new TemplateDefinitionProvider()
        )
    );

    // Register completion provider for template paths
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', language: 'silverstripe' },
            new TemplateCompletionProvider(),
            ' ', '"', "'"
        )
    );

    vscode.window.showInformationMessage('Silverstripe Language Support ready');
}

export function deactivate() {
    console.log('Silverstripe Language Support deactivated');
}
