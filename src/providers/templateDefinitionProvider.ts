import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ModuleDiscovery } from "./moduleDiscovery";

/**
 * Provides "Go to Definition" for Silverstripe template includes and vite asset tags.
 * - <% include MyTemplate %> → MyTemplate.ss
 * - <% vite 'src/css/style.css' %> → themes/{theme}/src/css/style.css
 * - $viteAsset('src/images/logo.svg') → themes/{theme}/src/images/logo.svg
 * - $viteContent('src/images/icon.svg') → themes/{theme}/src/images/icon.svg
 */
export class TemplateDefinitionProvider implements vscode.DefinitionProvider {
    private discovery = new ModuleDiscovery();

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Definition> {
        const line = document.lineAt(position).text;
        const col = position.character;

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            document.uri,
        );
        if (!workspaceFolder) {
            return null;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;

        // ── <% vite '...' %> block tag ────────────────────────────────────
        // Supports comma-separated entries and both quote styles.
        const viteTagRegex =
            /<%\s*vite\s+((?:['"][^'"]*['"](?:\s*,\s*['"][^'"]*['"])*))\s*%>/g;
        for (const viteMatch of line.matchAll(viteTagRegex)) {
            const hit = this.resolveQuotedPathAtCol(
                viteMatch[1],
                line.indexOf(viteMatch[1], viteMatch.index ?? 0),
                col,
                workspaceRoot,
            );
            if (hit !== undefined) {
                return hit;
            }
        }

        // ── $viteAsset('...') and $viteContent('...') variables ────────────
        const viteVarRegex =
            /\$vite(?:Asset|Content)\(\s*(['"])([^'"]*)\1\s*\)/g;
        for (const viteVarMatch of line.matchAll(viteVarRegex)) {
            const start = viteVarMatch.index ?? 0;
            const end = start + viteVarMatch[0].length;
            if (col >= start && col <= end) {
                const resolved = this.findViteAsset(
                    viteVarMatch[2],
                    workspaceRoot,
                );
                if (resolved) {
                    return new vscode.Location(
                        vscode.Uri.file(resolved),
                        new vscode.Position(0, 0),
                    );
                }
                return null;
            }
        }

        // ── include tags ───────────────────────────────────────────────────
        const range = document.getWordRangeAtPosition(
            position,
            /include\s+[\w/\\]+/,
        );

        if (!range) {
            return null;
        }

        const text = document.getText(range);
        const match = text.match(/include\s+([\w/\\]+)/);

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
            new vscode.Position(0, 0),
        );
    }

    /**
     * Search all theme directories for a vite asset path.
     * e.g. 'src/css/jobs.css' resolves to themes/default/src/css/jobs.css
     */
    private findViteAsset(
        assetPath: string,
        workspaceRoot: string,
    ): string | null {
        const themesRoot = path.join(workspaceRoot, "themes");
        if (!fs.existsSync(themesRoot)) {
            return null;
        }
        for (const entry of fs.readdirSync(themesRoot, {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const candidate = path.join(themesRoot, entry.name, assetPath);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Given a string of comma-separated quoted paths (single or double quotes),
     * the absolute column where that string starts, and the cursor column,
     * returns a Location if the cursor is over one of the paths, null if it is
     * over the string but no file is found, or undefined if the cursor is outside.
     */
    private resolveQuotedPathAtCol(
        argsText: string,
        argsStart: number,
        col: number,
        workspaceRoot: string,
    ): vscode.Location | null | undefined {
        for (const q of argsText.matchAll(/(['"])([^'"]*)\1/g)) {
            const pathStart = argsStart + (q.index ?? 0);
            const pathEnd = pathStart + q[0].length;
            if (col >= pathStart && col <= pathEnd) {
                const resolved = this.findViteAsset(q[2], workspaceRoot);
                return resolved
                    ? new vscode.Location(
                          vscode.Uri.file(resolved),
                          new vscode.Position(0, 0),
                      )
                    : null;
            }
        }
        return undefined; // cursor not over any quoted path
    }

    /**
     * Find template file in theme directories
     */
    public findTemplate(
        templateName: string,
        currentUri: vscode.Uri,
    ): string | null {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentUri);
        if (!workspaceFolder) {
            return null;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Build candidate paths: all themes, then app, then modules/vendor
        const possiblePaths: string[] = [];

        // All themes: themes/*/templates  (matches completion provider behaviour)
        const themesRoot = path.join(workspaceRoot, "themes");
        if (fs.existsSync(themesRoot)) {
            for (const entry of fs.readdirSync(themesRoot, {
                withFileTypes: true,
            })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const tplDir = path.join(themesRoot, entry.name, "templates");
                possiblePaths.push(
                    path.join(tplDir, `${templateName}.ss`),
                    path.join(
                        tplDir,
                        templateName,
                        `${path.basename(templateName)}.ss`,
                    ),
                );
            }
        }

        // App templates
        possiblePaths.push(
            path.join(workspaceRoot, "app", "templates", `${templateName}.ss`),
            path.join(
                workspaceRoot,
                "app",
                "templates",
                templateName,
                `${path.basename(templateName)}.ss`,
            ),
        );

        // Module + vendor templates
        possiblePaths.push(
            ...this.searchVendorTemplates(workspaceRoot, templateName),
        );

        for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
                return possiblePath;
            }
        }

        return null;
    }

    /**
     * Search for templates in vendor modules and local root-level modules.
     * Uses Composer's installed.json for authoritative vendor paths and
     * mirrors Silverstripe's ManifestFileFinder logic (_config/ + no _manifest_exclude).
     */
    private searchVendorTemplates(
        workspaceRoot: string,
        templateName: string,
    ): string[] {
        const paths: string[] = [];

        for (const mod of this.discovery.findModulesWithTemplates(
            workspaceRoot,
            true,
        )) {
            paths.push(
                path.join(mod.templatesPath, `${templateName}.ss`),
                path.join(
                    mod.templatesPath,
                    templateName,
                    `${path.basename(templateName)}.ss`,
                ),
            );
        }

        return paths;
    }
}
