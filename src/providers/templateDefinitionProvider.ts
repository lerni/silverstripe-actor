import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Provides "Go to Definition" for Silverstripe template includes
 * Example: <% include MyTemplate %> -> jump to MyTemplate.ss
 */
export class TemplateDefinitionProvider implements vscode.DefinitionProvider {

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition> {
        const range = document.getWordRangeAtPosition(
            position,
            /include\s+[\w\/\\]+/
        );

        if (!range) {
            return null;
        }

        const text = document.getText(range);
        const match = text.match(/include\s+([\w\/\\]+)/);

        if (!match) {
            return null;
        }

        const templateName = match[1];
        const templatePath = this.findTemplate(templateName, document.uri);

        if (!templatePath) {
            return null;
        }

        return new vscode.Location(
            vscode.Uri.file(templatePath),
            new vscode.Position(0, 0)
        );
    }

    /**
     * Find template file in theme directories
     */
    private findTemplate(templateName: string, currentUri: vscode.Uri): string | null {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentUri);
        if (!workspaceFolder) {
            return null;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Convert namespace path to file path
        // Example: SilverStripe/Blog/Pagination -> SilverStripe/Blog/Pagination.ss
        const possiblePaths = [
            // Theme templates
            path.join(workspaceRoot, 'themes', 'default', 'templates', `${templateName}.ss`),
            path.join(workspaceRoot, 'themes', 'default', 'templates', templateName, `${path.basename(templateName)}.ss`),
            // App templates
            path.join(workspaceRoot, 'app', 'templates', `${templateName}.ss`),
            path.join(workspaceRoot, 'app', 'templates', templateName, `${path.basename(templateName)}.ss`),
            // Vendor module templates (basic search)
            ...this.searchVendorTemplates(workspaceRoot, templateName)
        ];

        for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
                return possiblePath;
            }
        }

        return null;
    }

    /**
     * Search for templates in vendor modules
     */
    private searchVendorTemplates(workspaceRoot: string, templateName: string): string[] {
        const paths: string[] = [];
        const vendorPath = path.join(workspaceRoot, 'vendor');

        if (!fs.existsSync(vendorPath)) {
            return paths;
        }

        // Common Silverstripe modules
        const commonModules = [
            'silverstripe/admin',
            'silverstripe/cms',
            'silverstripe/framework',
            'silverstripe/blog',
            'dnadesign/silverstripe-elemental'
        ];

        for (const module of commonModules) {
            const modulePath = path.join(vendorPath, module, 'templates');
            if (fs.existsSync(modulePath)) {
                paths.push(
                    path.join(modulePath, `${templateName}.ss`),
                    path.join(modulePath, templateName, `${path.basename(templateName)}.ss`)
                );
            }
        }

        return paths;
    }
}
