import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ModuleDiscovery } from "./moduleDiscovery";

/**
 * Provides autocomplete for template include paths
 * Example: <% include | -> suggests available templates
 */
export class TemplateCompletionProvider
    implements vscode.CompletionItemProvider
{
    private discovery = new ModuleDiscovery();

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): vscode.ProviderResult<vscode.CompletionItem[]> {
        const linePrefix = document
            .lineAt(position)
            .text.substr(0, position.character);

        // Check if we're in an include statement
        if (!linePrefix.match(/<%\s*include\s+[\w/]*$/)) {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            document.uri,
        );
        if (!workspaceFolder) {
            return undefined;
        }

        const templates = this.findAllTemplates(workspaceFolder.uri.fsPath);

        // Without a trailing space, accepting a suggestion right before "%>"
        // produces "TemplateName%>" instead of "TemplateName %>".
        const lineSuffix = document
            .lineAt(position)
            .text.slice(position.character);
        const needsTrailingSpace = /^%>/.test(lineSuffix);

        return templates.map((template) => {
            const item = new vscode.CompletionItem(
                template.name,
                vscode.CompletionItemKind.File,
            );
            item.detail = template.path;
            item.insertText = needsTrailingSpace
                ? `${template.name} `
                : template.name;
            return item;
        });
    }

    /**
     * Find all available templates in the workspace.
     * Scans all theme directories under themes/ and app/templates,
     * plus any local root-level Silverstripe modules.
     * Vendor packages are excluded to keep the completion list focused.
     */
    private findAllTemplates(
        workspaceRoot: string,
    ): Array<{ name: string; path: string }> {
        const templates: Array<{ name: string; path: string }> = [];

        // All themes: themes/*/templates
        const themesRoot = path.join(workspaceRoot, "themes");
        if (fs.existsSync(themesRoot)) {
            for (const entry of fs.readdirSync(themesRoot, {
                withFileTypes: true,
            })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const themePath = path.join(
                    themesRoot,
                    entry.name,
                    "templates",
                );
                if (fs.existsSync(themePath)) {
                    this.scanDirectory(themePath, themePath, templates);
                }
            }
        }

        // App templates
        const appPath = path.join(workspaceRoot, "app", "templates");
        if (fs.existsSync(appPath)) {
            this.scanDirectory(appPath, appPath, templates);
        }

        // Local root-level modules (e.g. cms-task/, mcp-server-poc/)
        // excludeVendor=true to avoid flooding the list with framework templates
        for (const mod of this.discovery.findModulesWithTemplates(
            workspaceRoot,
            false,
        )) {
            this.scanDirectory(mod.templatesPath, mod.templatesPath, templates);
        }

        return templates;
    }

    /**
     * Recursively scan directory for .ss files
     */
    private scanDirectory(
        dir: string,
        baseDir: string,
        templates: Array<{ name: string; path: string }>,
    ): void {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    this.scanDirectory(fullPath, baseDir, templates);
                } else if (entry.isFile() && entry.name.endsWith(".ss")) {
                    const relativePath = path.relative(baseDir, fullPath);
                    const templateName = relativePath
                        .replace(/\.ss$/, "")
                        .replace(/\\/g, "/");

                    templates.push({
                        name: templateName,
                        path: fullPath,
                    });
                }
            }
        } catch {
            // Ignore errors (e.g., permission denied)
        }
    }
}
