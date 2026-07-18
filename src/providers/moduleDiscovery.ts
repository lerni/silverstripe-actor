import * as fs from "node:fs";
import * as path from "node:path";

export interface SilverstripeModule {
    name: string;
    rootPath: string;
    templatesPath: string;
}

/**
 * Discovers Silverstripe modules that have a templates/ directory.
 *
 * Two sources:
 * 1. Vendor packages — resolved from vendor/composer/installed.json, which gives
 *    authoritative install paths (works for path-repo packages outside vendor/ too).
 * 2. Local root-level modules — directories at the project root that have _config/
 *    or _config.php and no _manifest_exclude file, mirroring Silverstripe's own
 *    ManifestFileFinder logic.
 *
 * Results are cached per workspace root.
 */
export class ModuleDiscovery {
    private cache: Map<string, SilverstripeModule[]> = new Map();

    /**
     * Return all modules with a templates/ directory.
     * Pass includeVendor=false to skip vendor packages (e.g. for completion lists).
     */
    public findModulesWithTemplates(
        workspaceRoot: string,
        includeVendor = true,
    ): SilverstripeModule[] {
        const cacheKey = `${workspaceRoot}:${includeVendor}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const modules: SilverstripeModule[] = [];

        if (includeVendor) {
            this.discoverVendorModules(workspaceRoot, modules);
        }

        this.discoverLocalModules(workspaceRoot, modules);

        this.cache.set(cacheKey, modules);

        return modules;
    }

    /**
     * Read vendor/composer/installed.json to resolve vendor package paths.
     * install-path is relative to vendor/composer/ and may use ../ to point
     * at path-repo packages outside vendor/.
     */
    private discoverVendorModules(
        workspaceRoot: string,
        modules: SilverstripeModule[],
    ): void {
        const installedJson = path.join(
            workspaceRoot,
            "vendor",
            "composer",
            "installed.json",
        );
        if (!fs.existsSync(installedJson)) {
            return;
        }

        let installed: {
            packages?: Array<{ name: string; "install-path": string }>;
        };
        try {
            installed = JSON.parse(fs.readFileSync(installedJson, "utf-8"));
        } catch {
            return;
        }

        const packages = installed.packages ?? [];
        const composerDir = path.join(workspaceRoot, "vendor", "composer");

        for (const pkg of packages) {
            const installPath = pkg["install-path"];
            if (!installPath) {
                continue;
            }

            const pkgRoot = path.resolve(composerDir, installPath);

            if (this.hasManifestExclude(pkgRoot)) {
                continue;
            }

            const templatesPath = path.join(pkgRoot, "templates");
            if (fs.existsSync(templatesPath)) {
                modules.push({
                    name: pkg.name,
                    rootPath: pkgRoot,
                    templatesPath,
                });
            }
        }
    }

    /**
     * Scan the project root for local modules not managed via Composer.
     * A directory qualifies if it:
     *   - is a directory
     *   - is not in the skip list
     *   - does not contain _manifest_exclude
     *   - contains _config/ or _config.php  (Silverstripe module marker)
     *   - contains templates/
     */
    private discoverLocalModules(
        workspaceRoot: string,
        modules: SilverstripeModule[],
    ): void {
        const skip = new Set([
            "vendor",
            "node_modules",
            "silverstripe-cache",
            "public",
            ".git",
            ".ddev",
            ".devcontainer",
            ".vscode",
        ]);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (skip.has(entry.name)) {
                continue;
            }

            const dir = path.join(workspaceRoot, entry.name);

            if (this.hasManifestExclude(dir)) {
                continue;
            }

            const hasConfig =
                fs.existsSync(path.join(dir, "_config")) ||
                fs.existsSync(path.join(dir, "_config.php"));
            if (!hasConfig) {
                continue;
            }

            const templatesPath = path.join(dir, "templates");
            if (fs.existsSync(templatesPath)) {
                modules.push({
                    name: entry.name,
                    rootPath: dir,
                    templatesPath,
                });
            }
        }
    }

    private hasManifestExclude(dir: string): boolean {
        return fs.existsSync(path.join(dir, "_manifest_exclude"));
    }
}
