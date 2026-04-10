import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Maps a Silverstripe .ss template file to its corresponding PHP class FQN.
 *
 * Silverstripe template resolution rules:
 *   templates/App/Elements/ElementHero.ss       → App\Elements\ElementHero
 *   templates/App/Models/Layout/ElementPage.ss  → App\Models\ElementPage (Layout/ is a sub-type)
 *   templates/Layout/Page.ss                    → Page (Layout/ is a sub-type)
 *   templates/Page.ss                           → Page
 *   templates/App/Includes/Header.ss            → null (includes don't map to a class)
 */
export class TemplateClassMapper {

    /** Cached PSR-4 namespace→directory mappings from Composer */
    private psr4Map: Map<string, string[]> | null = null;
    private psr4LoadedFor: string | null = null;

    /**
     * Given a .ss template URI, return the PHP FQN it maps to (or null).
     */
    public mapTemplateToClass(templateUri: vscode.Uri): string | null {
        const templatePath = templateUri.fsPath;

        // Find the "templates" directory in the path
        const templatesDir = this.findTemplatesRoot(templatePath);
        if (!templatesDir) {
            return null;
        }

        // Get relative path from templates/ dir
        let relativePath = path.relative(templatesDir, templatePath);

        // Normalise separators
        relativePath = relativePath.replace(/\\/g, '/');

        // Remove .ss extension
        relativePath = relativePath.replace(/\.ss$/, '');

        // Skip Includes — they don't map to a class
        if (relativePath.includes('/Includes/') || relativePath.startsWith('Includes/')) {
            return null;
        }

        // Strip Layout/ sub-directory (it's a template type, not namespace)
        // e.g. "App/Models/Layout/ElementPage" → "App/Models/ElementPage"
        // e.g. "Layout/Page" → "Page"
        relativePath = relativePath.replace(/\/?Layout\//, '/').replace(/^\//, '');

        // Strip _suffix (e.g. ElementPage_produkt → ElementPage)
        const parts = relativePath.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart.includes('_')) {
            parts[parts.length - 1] = lastPart.split('_')[0];
            relativePath = parts.join('/');
        }

        // Convert path separators to namespace separators
        const fqn = relativePath.replace(/\//g, '\\');

        return fqn || null;
    }

    /**
     * Walk up from the template file to find the "templates" directory.
     */
    private findTemplatesRoot(filePath: string): string | null {
        const parts = filePath.split(path.sep);
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i] === 'templates') {
                return parts.slice(0, i + 1).join(path.sep);
            }
        }
        return null;
    }

    /**
     * Try to locate the PHP source file for a given FQN within the workspace.
     * Uses Composer's PSR-4 autoload map for accurate resolution of any class.
     */
    public findClassFile(fqn: string, workspaceRoot: string): string | null {
        const namespaceParts = fqn.split('\\');

        // Strategy 1: Use Composer's PSR-4 map (most accurate, covers vendor too)
        const psr4Result = this.findViaPsr4(fqn, workspaceRoot);
        if (psr4Result) {
            return psr4Result;
        }

        // Strategy 2: Direct convention (App\ → app/src/, root → app/src/)
        const candidates = [];
        if (namespaceParts[0] === 'App') {
            candidates.push(path.join(workspaceRoot, 'app', 'src', ...namespaceParts.slice(1)) + '.php');
        }
        candidates.push(path.join(workspaceRoot, 'app', 'src', ...namespaceParts) + '.php');
        // Root-level class (no namespace, like Page)
        if (namespaceParts.length === 1) {
            candidates.push(path.join(workspaceRoot, 'app', 'src', namespaceParts[0]) + '.php');
        }

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Resolve a FQN to a file path using Composer's autoload_psr4.php.
     * Parses the PSR-4 map once and caches it.
     */
    private findViaPsr4(fqn: string, workspaceRoot: string): string | null {
        this.loadPsr4Map(workspaceRoot);
        if (!this.psr4Map) {
            return null;
        }

        // Try each registered namespace prefix, longest match first
        // e.g. for "App\Elements\ElementHero":
        //   "App\Elements\" → no match
        //   "App\" → match → dir + "Elements/ElementHero.php"
        const fqnParts = fqn.split('\\');

        for (let prefixLen = fqnParts.length - 1; prefixLen >= 1; prefixLen--) {
            const prefix = fqnParts.slice(0, prefixLen).join('\\') + '\\';
            const dirs = this.psr4Map.get(prefix);
            if (!dirs) {
                continue;
            }

            const relativePath = fqnParts.slice(prefixLen).join(path.sep) + '.php';
            for (const dir of dirs) {
                const fullPath = path.join(dir, relativePath);
                if (fs.existsSync(fullPath)) {
                    return fullPath;
                }
            }
        }

        return null;
    }

    /**
     * Parse Composer's autoload_psr4.php into a usable map.
     * Format: 'Namespace\\' => array('/absolute/path/to/src')
     */
    private loadPsr4Map(workspaceRoot: string): void {
        if (this.psr4LoadedFor === workspaceRoot && this.psr4Map) {
            return;
        }

        this.psr4Map = new Map();
        this.psr4LoadedFor = workspaceRoot;

        const psr4File = path.join(workspaceRoot, 'vendor', 'composer', 'autoload_psr4.php');
        if (!fs.existsSync(psr4File)) {
            return;
        }

        try {
            const content = fs.readFileSync(psr4File, 'utf-8');

            // Parse PHP array entries:
            // 'App\\' => array($baseDir . '/app/src'),
            // 'SilverStripe\\CMS\\' => array($vendorDir . '/silverstripe/cms/src'),
            const entryRegex = /'([^']+)'\s*=>\s*array\(([^)]+)\)/g;
            let match;

            while ((match = entryRegex.exec(content)) !== null) {
                // PHP uses double backslashes in strings, normalize to single
                const namespace = match[1].replace(/\\\\/g, '\\');
                const pathsStr = match[2];

                // Parse path entries: $baseDir . '/app/src' or $vendorDir . '/silverstripe/cms/src'
                const pathRegex = /\$(baseDir|vendorDir)\s*\.\s*'([^']+)'/g;
                const dirs: string[] = [];
                let pathMatch;

                while ((pathMatch = pathRegex.exec(pathsStr)) !== null) {
                    const varName = pathMatch[1];
                    const relPath = pathMatch[2];
                    const base = varName === 'vendorDir'
                        ? path.join(workspaceRoot, 'vendor')
                        : workspaceRoot;
                    dirs.push(path.join(base, relPath));
                }

                if (dirs.length > 0) {
                    this.psr4Map.set(namespace, dirs);
                }
            }
        } catch {
            // Failed to parse — fall back to convention
        }
    }

    /**
     * Clear cached PSR-4 map (e.g. after composer install)
     */
    public clearCache(): void {
        this.psr4Map = null;
        this.psr4LoadedFor = null;
    }
}
