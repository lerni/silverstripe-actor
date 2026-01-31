import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Provides autocomplete for template include paths
 * Example: <% include | -> suggests available templates
 */
export class TemplateCompletionProvider implements vscode.CompletionItemProvider {
    
    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[]> {
        
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        
        // Check if we're in an include statement
        if (!linePrefix.match(/<%\s*include\s+[\w\/]*$/)) {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return undefined;
        }

        const templates = this.findAllTemplates(workspaceFolder.uri.fsPath);
        
        return templates.map(template => {
            const item = new vscode.CompletionItem(
                template.name,
                vscode.CompletionItemKind.File
            );
            item.detail = template.path;
            item.insertText = template.name;
            return item;
        });
    }

    /**
     * Find all available templates in the workspace
     */
    private findAllTemplates(workspaceRoot: string): Array<{ name: string; path: string }> {
        const templates: Array<{ name: string; path: string }> = [];
        
        // Search in theme templates
        const themePath = path.join(workspaceRoot, 'themes', 'default', 'templates');
        if (fs.existsSync(themePath)) {
            this.scanDirectory(themePath, themePath, templates);
        }

        // Search in app templates
        const appPath = path.join(workspaceRoot, 'app', 'templates');
        if (fs.existsSync(appPath)) {
            this.scanDirectory(appPath, appPath, templates);
        }

        return templates;
    }

    /**
     * Recursively scan directory for .ss files
     */
    private scanDirectory(
        dir: string,
        baseDir: string,
        templates: Array<{ name: string; path: string }>
    ): void {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    this.scanDirectory(fullPath, baseDir, templates);
                } else if (entry.isFile() && entry.name.endsWith('.ss')) {
                    const relativePath = path.relative(baseDir, fullPath);
                    const templateName = relativePath.replace(/\.ss$/, '').replace(/\\/g, '/');
                    
                    templates.push({
                        name: templateName,
                        path: fullPath
                    });
                }
            }
        } catch (error) {
            // Ignore errors (e.g., permission denied)
        }
    }
}
