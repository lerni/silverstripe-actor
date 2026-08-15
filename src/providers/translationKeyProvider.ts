import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface TranslationKey {
    key: string; // e.g. "App\Elements\ElementHero.BlockType"
    value: string; // project-locale value from catalogue (e.g. German "Hero")
    enValue?: string; // English default from en.yml — used for <%t insert text
    locale: string; // catalogue locale (e.g. "de_CH")
}

interface CatalogueCache {
    mtime: number;
    keys: TranslationKey[];
}

/**
 * Provides Silverstripe i18n translation keys for autocomplete.
 *
 * Two-layer strategy:
 *
 * Layer 1 — Silverstripe compiled catalogue (primary):
 *   Silverstripe merges all lang files (app + every vendor module) into a
 *   single MessageCatalogue at dev/build time and caches it in
 *   silverstripe-cache/<site>/catalogue.<locale>.<hash>.php
 *   This is the single source of truth — same as what the framework uses.
 *   We read the project locale from app/_config/*.yml (default_locale) and
 *   load the matching catalogue file via a PHP one-liner.
 *
 * Layer 2 — en.yml fallback (English defaults for insert text):
 *   The catalogue is in the project locale (e.g. de_CH). Templates however
 *   conventionally use an English string as the default value in
 *   <%t Key 'English default' %>.  We scan app/lang/en.yml + vendor en.yml
 *   files to get those English strings.
 *
 * Fallback: if no catalogue exists (dev/build not yet run), fall back to
 * scanning all lang YAML files directly.
 *
 * Cache invalidation: catalogue file mtime is checked on every call.
 */
export class TranslationKeyProvider {
    private catalogueCache: Map<string, CatalogueCache> = new Map();
    private localeCache: Map<string, string> = new Map();
    private warmupPromise: Map<string, Promise<void>> = new Map();

    /**
     * Asynchronously pre-populate the locale and catalogue caches using
     * non-blocking child_process.spawn so the Node.js event loop is never
     * blocked.  Call this at extension activation — by the time the user
     * types <%t the first time, the caches are already hot.
     *
     * Idempotent: a second call while warming is in progress returns the
     * same in-flight Promise.
     */
    public preWarm(workspaceRoot: string): Promise<void> {
        // Only check the in-memory catalogueCache — no FS or PHP calls here.
        // findCatalogueFile / getProjectLocale would trigger spawnSync, defeating
        // the whole point of async pre-warming.
        if (this.catalogueCache.has(workspaceRoot)) {
            return Promise.resolve();
        }
        let p = this.warmupPromise.get(workspaceRoot);
        if (p) {
            return p;
        }
        p = this.doPreWarm(workspaceRoot).finally(() =>
            this.warmupPromise.delete(workspaceRoot),
        );
        this.warmupPromise.set(workspaceRoot, p);
        return p;
    }

    /**
     * Async version of getKeys — awaits the in-flight warmup if one is running,
     * then returns from cache.  The completion provider uses this so that
     * spawnSync never blocks the event loop.
     */
    public async getKeysAsync(
        workspaceRoot: string,
    ): Promise<TranslationKey[]> {
        const inFlight = this.warmupPromise.get(workspaceRoot);
        if (inFlight) {
            await inFlight;
        }
        const cached = this.catalogueCache.get(workspaceRoot);
        if (cached) {
            return cached.keys;
        }
        // No catalogue available — YAML fallback (fast, no PHP)
        return this.getKeysFromYaml(workspaceRoot);
    }

    private async doPreWarm(workspaceRoot: string): Promise<void> {
        const autoloader = path.join(workspaceRoot, "vendor", "autoload.php");
        if (!fs.existsSync(autoloader)) {
            return;
        }
        // 1. Detect locale asynchronously — sets localeCache before findCatalogueFile
        const localeOut = await this.runPhpAsync(
            this.buildLocalePhpCode(workspaceRoot),
            workspaceRoot,
        );
        const localeStr = localeOut?.trim();
        this.localeCache.set(
            workspaceRoot,
            localeStr && /^[a-z]{2,3}(_[A-Z]{2,3})?$/.test(localeStr)
                ? localeStr
                : "en",
        );
        // 2. Load catalogue asynchronously (localeCache is now set, no spawnSync)
        const catalogueFile = this.findCatalogueFile(workspaceRoot);
        if (catalogueFile) {
            await this.loadCatalogueAsync(workspaceRoot, catalogueFile);
        }
    }

    private loadCatalogueAsync(
        workspaceRoot: string,
        catalogueFile: string,
    ): Promise<void> {
        return new Promise((resolve) => {
            let mtime = 0;
            try {
                mtime = fs.statSync(catalogueFile).mtimeMs;
            } catch {
                resolve();
                return;
            }
            const phpCode = this.buildCatalogueReadPhpCode(
                workspaceRoot,
                catalogueFile,
            );
            this.runPhpAsync(phpCode, workspaceRoot).then((stdout) => {
                const messages = this.parseMessagesJson(stdout);
                if (messages) {
                    this.cacheKeysFromMessages(workspaceRoot, mtime, messages);
                }
                resolve();
            });
        });
    }

    /** PHP one-liner that loads the compiled catalogue and dumps its messages as JSON. */
    private buildCatalogueReadPhpCode(
        workspaceRoot: string,
        catalogueFile: string,
    ): string {
        const autoloader = path.join(workspaceRoot, "vendor", "autoload.php");
        return [
            `require ${this.phpString(autoloader)};`,
            `require ${this.phpString(catalogueFile)};`,
            "echo json_encode($catalogue->all('messages'), JSON_UNESCAPED_UNICODE);",
        ].join(" ");
    }

    private parseMessagesJson(
        stdout: string | undefined,
    ): Record<string, string> | undefined {
        if (!stdout) {
            return undefined;
        }
        try {
            return JSON.parse(stdout);
        } catch {
            return undefined;
        }
    }

    /** Builds TranslationKey entries from raw catalogue messages and caches the result. */
    private cacheKeysFromMessages(
        workspaceRoot: string,
        mtime: number,
        messages: Record<string, string>,
    ): TranslationKey[] {
        const enMap = this.buildEnMap(workspaceRoot);
        const locale = this.getProjectLocale(workspaceRoot);
        const keys: TranslationKey[] = [];
        for (const [key, value] of Object.entries(messages)) {
            keys.push({ key, value, enValue: enMap.get(key), locale });
        }
        keys.sort((a, b) => a.key.localeCompare(b.key));
        this.catalogueCache.set(workspaceRoot, { mtime, keys });
        return keys;
    }

    /** Escapes a value as a single-quoted PHP string literal (no variable interpolation). */
    private phpString(value: string): string {
        return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    }

    /** Run a PHP -r snippet asynchronously; resolves with stdout or undefined. */
    private runPhpAsync(
        code: string,
        cwd: string,
    ): Promise<string | undefined> {
        return new Promise((resolve) => {
            const chunks: Buffer[] = [];
            const proc = spawn("php", ["-r", code], {
                cwd,
                timeout: 10000,
            });
            proc.stdout.on("data", (d: Buffer) => chunks.push(d));
            proc.on("close", (exitCode: number | null) => {
                if (exitCode === 0 && chunks.length > 0) {
                    resolve(Buffer.concat(chunks).toString("utf-8"));
                } else {
                    resolve(undefined);
                }
            });
            proc.on("error", () => resolve(undefined));
        });
    }

    private buildLocalePhpCode(workspaceRoot: string): string {
        const autoloader = path.join(workspaceRoot, "vendor", "autoload.php");
        return [
            `define('BASE_PATH', ${this.phpString(workspaceRoot)});`,
            `chdir(${this.phpString(workspaceRoot)});`,
            `require ${this.phpString(autoloader)};`,
            "$k = new \\SilverStripe\\Core\\CoreKernel(BASE_PATH);",
            "$k->boot();",
            "echo \\SilverStripe\\i18n\\i18n::get_locale();",
        ].join(" ");
    }

    /**
     * Synchronous cache read — returns keys if the cache is populated,
     * or null if the warmup is still in progress (caller can show a placeholder).
     */
    public getCachedKeys(workspaceRoot: string): TranslationKey[] | null {
        const cached = this.catalogueCache.get(workspaceRoot);
        if (cached) {
            return cached.keys;
        }
        // Warmup in progress?
        if (this.warmupPromise.has(workspaceRoot)) {
            return null;
        }
        // No warmup running and no cache — fall back to fast YAML scan
        return this.getKeysFromYaml(workspaceRoot);
    }

    public getKeys(workspaceRoot: string): TranslationKey[] {
        const catalogueFile = this.findCatalogueFile(workspaceRoot);

        if (catalogueFile) {
            return this.getKeysFromCatalogue(workspaceRoot, catalogueFile);
        }

        // Fallback: scan YAML files directly
        return this.getKeysFromYaml(workspaceRoot);
    }

    // ─── Locale detection ─────────────────────────────────────────────────────

    /**
     * Detect the project's active runtime locale by booting Silverstripe's
     * CoreKernel — the only authoritative source, since it applies _config.php,
     * YAML config merging, and all other overrides exactly as the framework does.
     *
     * Falls back to "en" only when PHP/autoloader is unavailable.
     * Result is cached per workspaceRoot (locale doesn't change mid-session).
     */
    public getProjectLocale(workspaceRoot: string): string {
        const cached = this.localeCache.get(workspaceRoot);
        if (cached) {
            return cached;
        }

        const locale = this.detectLocaleViaPhp(workspaceRoot) ?? "en";

        this.localeCache.set(workspaceRoot, locale);
        return locale;
    }

    private detectLocaleViaPhp(workspaceRoot: string): string | undefined {
        const autoloader = path.join(workspaceRoot, "vendor", "autoload.php");
        if (!fs.existsSync(autoloader)) {
            return undefined;
        }
        const result = spawnSync(
            "php",
            ["-r", this.buildLocalePhpCode(workspaceRoot)],
            {
                cwd: workspaceRoot,
                timeout: 8000,
                encoding: "utf-8",
            },
        );
        const locale = result.stdout?.trim();
        if (
            result.status === 0 &&
            locale &&
            /^[a-z]{2,3}(_[A-Z]{2,3})?$/.test(locale)
        ) {
            return locale;
        }
        return undefined;
    }

    // ─── Catalogue (primary source) ───────────────────────────────────────────

    /**
     * Find the compiled catalogue file for the project locale.
     * Pattern: silverstripe-cache/<site>/catalogue.<locale>.<hash>.php
     * Returns the most recently modified matching file.
     */
    private findCatalogueFile(workspaceRoot: string): string | undefined {
        const locale = this.getProjectLocale(workspaceRoot);
        const cacheRoot = path.join(workspaceRoot, "silverstripe-cache");
        if (!fs.existsSync(cacheRoot)) {
            return undefined;
        }
        let best: { file: string; mtime: number } | undefined;
        for (const dir of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
            if (!dir.isDirectory()) {
                continue;
            }
            const dirPath = path.join(cacheRoot, dir.name);
            for (const f of fs.readdirSync(dirPath)) {
                if (
                    f.startsWith(`catalogue.${locale}.`) &&
                    f.endsWith(".php")
                ) {
                    const fullPath = path.join(dirPath, f);
                    try {
                        const mtime = fs.statSync(fullPath).mtimeMs;
                        if (!best || mtime > best.mtime) {
                            best = { file: fullPath, mtime };
                        }
                    } catch {
                        // skip
                    }
                }
            }
        }
        return best?.file;
    }

    private getKeysFromCatalogue(
        workspaceRoot: string,
        catalogueFile: string,
    ): TranslationKey[] {
        let mtime = 0;
        try {
            mtime = fs.statSync(catalogueFile).mtimeMs;
        } catch {
            return this.getKeysFromYaml(workspaceRoot);
        }

        const cached = this.catalogueCache.get(workspaceRoot);
        if (cached && cached.mtime === mtime) {
            return cached.keys;
        }

        // Extract messages from the PHP catalogue via a one-liner.
        // The catalogue requires the Symfony MessageCatalogue class.
        const phpCode = this.buildCatalogueReadPhpCode(
            workspaceRoot,
            catalogueFile,
        );

        const result = spawnSync("php", ["-r", phpCode], {
            cwd: workspaceRoot,
            timeout: 8000,
            encoding: "utf-8",
        });

        if (result.status !== 0 || !result.stdout) {
            return this.getKeysFromYaml(workspaceRoot);
        }

        const messages = this.parseMessagesJson(result.stdout);
        if (!messages) {
            return this.getKeysFromYaml(workspaceRoot);
        }

        return this.cacheKeysFromMessages(workspaceRoot, mtime, messages);
    }

    // ─── English defaults map (for insert text) ───────────────────────────────

    /**
     * Build a Map<key, englishValue> from all en.yml files.
     * App files take precedence over vendor files (first-seen-wins).
     */
    private buildEnMap(workspaceRoot: string): Map<string, string> {
        const map = new Map<string, string>();
        for (const file of this.findEnYamlFiles(workspaceRoot)) {
            try {
                for (const entry of this.parseYamlFile(file)) {
                    if (!map.has(entry.key)) {
                        map.set(entry.key, entry.value);
                    }
                }
            } catch {
                // skip
            }
        }
        return map;
    }

    private findEnYamlFiles(workspaceRoot: string): string[] {
        const files: string[] = [];
        // 1. app/lang/en.yml
        const appEn = path.join(workspaceRoot, "app", "lang", "en.yml");
        if (fs.existsSync(appEn)) {
            files.push(appEn);
        }
        // 2. themes/*/lang/en.yml
        const themesRoot = path.join(workspaceRoot, "themes");
        if (fs.existsSync(themesRoot)) {
            for (const entry of fs.readdirSync(themesRoot, {
                withFileTypes: true,
            })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const f = path.join(themesRoot, entry.name, "lang", "en.yml");
                if (fs.existsSync(f)) {
                    files.push(f);
                }
            }
        }
        // 3. vendor/*/*/lang/en.yml
        const vendorRoot = path.join(workspaceRoot, "vendor");
        if (fs.existsSync(vendorRoot)) {
            for (const org of fs.readdirSync(vendorRoot, {
                withFileTypes: true,
            })) {
                if (!org.isDirectory() || org.name === "composer") {
                    continue;
                }
                const orgPath = path.join(vendorRoot, org.name);
                for (const pkg of fs.readdirSync(orgPath, {
                    withFileTypes: true,
                })) {
                    if (!pkg.isDirectory()) {
                        continue;
                    }
                    const f = path.join(orgPath, pkg.name, "lang", "en.yml");
                    if (fs.existsSync(f)) {
                        files.push(f);
                    }
                }
            }
        }
        return files;
    }

    // ─── YAML fallback (when no catalogue exists yet) ─────────────────────────

    private getKeysFromYaml(workspaceRoot: string): TranslationKey[] {
        const enEntries: TranslationKey[] = [];
        const otherEntries: TranslationKey[] = [];
        for (const file of this.findAllLangFiles(workspaceRoot)) {
            try {
                const parsed = this.parseYamlFile(file);
                for (const k of parsed) {
                    if (k.locale === "en") {
                        enEntries.push(k);
                    } else {
                        otherEntries.push(k);
                    }
                }
            } catch {
                // skip
            }
        }
        // First-seen-wins; en beats other locales
        const seen = new Map<string, TranslationKey>();
        for (const k of [...enEntries, ...otherEntries]) {
            if (!seen.has(k.key)) {
                seen.set(k.key, k);
            }
        }
        return Array.from(seen.values()).sort((a, b) =>
            a.key.localeCompare(b.key),
        );
    }

    private findAllLangFiles(workspaceRoot: string): string[] {
        const files: string[] = [];
        this.collectYamlFiles(path.join(workspaceRoot, "app", "lang"), files);
        const themesRoot = path.join(workspaceRoot, "themes");
        if (fs.existsSync(themesRoot)) {
            for (const entry of fs.readdirSync(themesRoot, {
                withFileTypes: true,
            })) {
                if (entry.isDirectory()) {
                    this.collectYamlFiles(
                        path.join(themesRoot, entry.name, "lang"),
                        files,
                    );
                }
            }
        }
        const vendorRoot = path.join(workspaceRoot, "vendor");
        if (fs.existsSync(vendorRoot)) {
            for (const org of fs.readdirSync(vendorRoot, {
                withFileTypes: true,
            })) {
                if (!org.isDirectory() || org.name === "composer") {
                    continue;
                }
                const orgPath = path.join(vendorRoot, org.name);
                for (const pkg of fs.readdirSync(orgPath, {
                    withFileTypes: true,
                })) {
                    if (!pkg.isDirectory()) {
                        continue;
                    }
                    this.collectYamlFiles(
                        path.join(orgPath, pkg.name, "lang"),
                        files,
                    );
                }
            }
        }
        return files;
    }

    private collectYamlFiles(dir: string, out: string[]): void {
        if (!fs.existsSync(dir)) {
            return;
        }
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith(".yml") || f.endsWith(".yaml")) {
                out.push(path.join(dir, f));
            }
        }
    }

    // ─── YAML parser ──────────────────────────────────────────────────────────

    /**
     * Minimal parser for Silverstripe lang YAML files:
     *   locale:              depth 0  (ignored)
     *     Namespace\Class:   depth 2  (class key)
     *       KEY: 'value'     depth 4  (translation entry)
     * Nested objects (PLURALS etc.) and block scalars are skipped.
     */
    private parseYamlFile(filePath: string): TranslationKey[] {
        const locale = path.basename(filePath).replace(/\.(yml|yaml)$/, "");
        const content = fs.readFileSync(filePath, "utf-8");
        const result: TranslationKey[] = [];
        let currentClass = "";
        let skipDepth = -1;

        for (const raw of content.split("\n")) {
            const trimmed = raw.trimEnd();
            if (!trimmed.trim() || trimmed.trim().startsWith("#")) {
                continue;
            }
            const indent = trimmed.length - trimmed.trimStart().length;

            if (skipDepth >= 0 && indent > skipDepth) {
                continue;
            }
            skipDepth = -1;

            if (indent === 0) {
                continue;
            }
            if (indent === 2) {
                const m = trimmed.trim().match(/^([\w\\/]+):\s*$/);
                currentClass = m ? m[1] : "";
                continue;
            }
            if (indent === 4 && currentClass) {
                const m = trimmed.trim().match(/^(\w+):\s*(.*)$/);
                if (!m) {
                    continue;
                }
                const rawValue = m[2].trim();
                if (rawValue === "|" || rawValue === ">" || rawValue === "") {
                    skipDepth = indent;
                    continue;
                }
                result.push({
                    key: `${currentClass}.${m[1]}`,
                    value: this.unquote(rawValue),
                    locale,
                });
            }
        }
        return result;
    }

    private unquote(s: string): string {
        if (
            (s.startsWith("'") && s.endsWith("'")) ||
            (s.startsWith('"') && s.endsWith('"'))
        ) {
            return s.slice(1, -1);
        }
        return s;
    }
}
