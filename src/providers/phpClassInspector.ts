import { exec } from "node:child_process";
import * as fs from "node:fs";

export interface ClassMember {
    name: string;
    type: string;
    source:
        | "db"
        | "has_one"
        | "has_many"
        | "many_many"
        | "belongs_many_many"
        | "method"
        | "inherited";
    detail?: string;
}

/**
 * Inspects PHP classes via two strategies:
 * 1. Direct parsing of $db, $has_one, $has_many etc. from PHP source
 * 2. PHPActor CLI for inherited/annotated methods
 *
 * Results are cached per class with a file-mtime invalidation.
 */
export class PhpClassInspector {
    private cache: Map<string, { members: ClassMember[]; mtime: number }> =
        new Map();

    /**
     * Get all template-available members for a PHP class (synchronous, source-only).
     * PHPActor is not called here — use getClassMembersAsync for full results.
     * This fast path is used for scope-stack building where relations are all that matter.
     */
    public getClassMembers(
        fqn: string,
        _workspaceRoot: string,
        phpFilePath?: string,
    ): ClassMember[] {
        // Check cache
        if (phpFilePath) {
            try {
                const stat = fs.statSync(phpFilePath);
                const cached = this.cache.get(fqn);
                if (cached && cached.mtime === stat.mtimeMs) {
                    return cached.members;
                }
            } catch {
                // File doesn't exist, skip cache
            }
        }

        const members: ClassMember[] = [];
        const seenNames = new Set<string>();

        // Parse $db, $has_one, etc. from source file
        if (phpFilePath && fs.existsSync(phpFilePath)) {
            for (const member of this.parsePhpSource(phpFilePath)) {
                if (!seenNames.has(member.name)) {
                    members.push(member);
                    seenNames.add(member.name);
                }
            }
        }

        // Cache result
        if (phpFilePath) {
            try {
                const stat = fs.statSync(phpFilePath);
                this.cache.set(fqn, { members, mtime: stat.mtimeMs });
            } catch {
                // Ignore
            }
        }

        return members;
    }

    /**
     * Get all template-available members for a PHP class (async, full results).
     * Source-parsing runs synchronously for instant partial results;
     * PHPActor is awaited asynchronously so the extension host is never blocked.
     */
    public async getClassMembersAsync(
        fqn: string,
        workspaceRoot: string,
        phpFilePath?: string,
    ): Promise<ClassMember[]> {
        // Return from cache if still valid
        if (phpFilePath) {
            try {
                const stat = fs.statSync(phpFilePath);
                const cached = this.cache.get(fqn);
                if (cached && cached.mtime === stat.mtimeMs) {
                    return cached.members;
                }
            } catch {
                // File doesn't exist, skip cache
            }
        }

        const members: ClassMember[] = [];
        const seenNames = new Set<string>();

        // Strategy 1: parse source (fast, sync)
        if (phpFilePath && fs.existsSync(phpFilePath)) {
            for (const member of this.parsePhpSource(phpFilePath)) {
                if (!seenNames.has(member.name)) {
                    members.push(member);
                    seenNames.add(member.name);
                }
            }
        }

        // Strategy 2: PHPActor CLI (async — does not block the extension host)
        for (const member of await this.queryPhpactorAsync(
            fqn,
            workspaceRoot,
        )) {
            if (!seenNames.has(member.name)) {
                members.push(member);
                seenNames.add(member.name);
            }
        }

        // Cache result
        if (phpFilePath) {
            try {
                const stat = fs.statSync(phpFilePath);
                this.cache.set(fqn, { members, mtime: stat.mtimeMs });
            } catch {
                // Ignore
            }
        }

        return members;
    }

    /**
     * Parse PHP source file for Silverstripe ORM config arrays.
     */
    private parsePhpSource(filePath: string): ClassMember[] {
        const members: ClassMember[] = [];

        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            return members;
        }

        const useMap = this.parseUseStatements(content);
        const currentNamespace = this.parseNamespace(content);

        // Parse private static $db = [...]
        this.parseStaticArray(content, "db", members, useMap, currentNamespace);
        this.parseStaticArray(
            content,
            "has_one",
            members,
            useMap,
            currentNamespace,
        );
        this.parseStaticArray(
            content,
            "has_many",
            members,
            useMap,
            currentNamespace,
        );
        this.parseStaticArray(
            content,
            "many_many",
            members,
            useMap,
            currentNamespace,
        );
        this.parseStaticArray(
            content,
            "belongs_many_many",
            members,
            useMap,
            currentNamespace,
        );

        // Parse @property annotations from class docblock
        this.parseDocblockAnnotations(content, members);

        return members;
    }

    /**
     * Parse a private static $xxx = [...] array from PHP source.
     * Handles both string values and ::class references.
     * classRef short names are resolved through the use-statement map and
     * current namespace so dot-chain traversal gets a usable FQN.
     */
    private parseStaticArray(
        content: string,
        configName: string,
        members: ClassMember[],
        useMap: Map<string, string>,
        currentNamespace: string | null,
    ): void {
        // Match: private static $db = [ ... ];
        // Uses a greedy match within brackets, handling nested brackets
        const regex = new RegExp(
            `private\\s+static\\s+\\$${configName}\\s*=\\s*\\[([^\\]]*(?:\\[[^\\]]*\\][^\\]]*)*)\\]`,
            "s",
        );
        const match = content.match(regex);
        if (!match) {
            return;
        }

        const arrayContent = match[1];

        // Match key => value pairs
        // 'FieldName' => 'Varchar(255)'
        // 'FieldName' => 'Enum("small,medium,fullscreen")'
        // 'FieldName' => ClassName::class
        const entryRegex =
            /['"](\w+)['"]\s*=>\s*(?:'((?:[^'\\]|\\.|"[^"]*")*)'|"((?:[^"\\]|\\.)*?)"|(\w+(?:\\\w+)*)::class)/g;
        let entryMatch: RegExpMatchArray;

        for (entryMatch of arrayContent.matchAll(entryRegex)) {
            const fieldName = entryMatch[1];
            const singleQuotedVal = entryMatch[2]; // e.g. Varchar(255), Enum("small,medium")
            const doubleQuotedVal = entryMatch[3]; // e.g. "Boolean"
            const classRef = entryMatch[4]; // e.g. Slide::class

            const stringType = singleQuotedVal || doubleQuotedVal;
            let type: string;
            if (stringType) {
                type = this.mapSilverstripeType(stringType);
            } else if (classRef) {
                type = this.resolveClassName(
                    classRef,
                    useMap,
                    currentNamespace,
                );
            } else {
                type = "mixed";
            }

            const source = configName as ClassMember["source"];
            members.push({
                name: fieldName,
                type,
                source,
                detail: `${configName}: ${stringType || type}`,
            });
        }
    }

    /**
     * Parse @property and @method annotations from the class docblock.
     */
    private parseDocblockAnnotations(
        content: string,
        members: ClassMember[],
    ): void {
        // Find the class docblock (last /** ... */ before the class keyword)
        const classDocMatch = content.match(
            /\/\*\*([\s\S]*?)\*\/\s*(?:abstract\s+)?class\s+/,
        );
        if (!classDocMatch) {
            return;
        }

        const docblock = classDocMatch[1];

        // @property Type $name
        const propertyRegex = /@property\s+([\w\\|]+)\s+\$(\w+)/g;
        for (const match of docblock.matchAll(propertyRegex)) {
            members.push({
                name: match[2],
                type: match[1],
                source: "db",
                detail: "@property annotation",
            });
        }

        // @method Type name()
        const methodRegex = /@method\s+([\w\\|]+)\s+(\w+)\s*\(/g;
        for (const match of docblock.matchAll(methodRegex)) {
            members.push({
                name: match[2],
                type: match[1],
                source: "method",
                detail: "@method annotation",
            });
        }
    }

    /**
     * Resolve a class name captured from a ::class reference to a FQN.
     *
     * Resolution order:
     *   1. Already fully qualified (contains backslash) — use as-is.
     *   2. Found in the file's use-statement map — return the imported FQN.
     *   3. Unqualified name in a namespaced file — prepend the current namespace.
     *   4. Fallback — return the name as-is.
     */
    private resolveClassName(
        shortName: string,
        useMap: Map<string, string>,
        currentNamespace: string | null,
    ): string {
        if (shortName.includes("\\")) {
            return shortName; // already FQN
        }
        if (useMap.has(shortName)) {
            return useMap.get(shortName) ?? shortName;
        }
        if (currentNamespace) {
            return `${currentNamespace}\\${shortName}`;
        }
        return shortName;
    }

    /**
     * Extract the declared namespace from PHP source.
     * e.g. "namespace App\Elements;" → "App\Elements"
     */
    private parseNamespace(content: string): string | null {
        const match = content.match(/^namespace\s+([\w\\]+)\s*;/m);
        return match ? match[1] : null;
    }

    /**
     * Parse use statements from PHP source into a shortName → FQN map.
     *
     * Handles:
     *   use Foo\Bar\Baz;               → { Baz: 'Foo\Bar\Baz' }
     *   use Foo\Bar\Baz as B;          → { B: 'Foo\Bar\Baz' }
     *   use Foo\Bar\{Baz, Qux as Q};   → { Baz: 'Foo\Bar\Baz', Q: 'Foo\Bar\Qux' }
     */
    private parseUseStatements(content: string): Map<string, string> {
        const useMap = new Map<string, string>();

        // Simple: use Foo\Bar\Baz; or use Foo\Bar\Baz as Alias;
        const simpleRegex = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm;
        for (const match of content.matchAll(simpleRegex)) {
            const fqn = match[1];
            const alias = match[2];
            const shortName = alias ?? fqn.split("\\").pop() ?? fqn;
            useMap.set(shortName, fqn);
        }

        // Group: use Foo\Bar\{Baz, Qux as Q};
        const groupRegex = /^use\s+([\w\\]+)\\{([^}]+)}\s*;/gm;
        for (const match of content.matchAll(groupRegex)) {
            const namespace = match[1];
            for (const item of match[2].split(",")) {
                const parts = item.trim().split(/\s+as\s+/);
                const className = parts[0].trim();
                const alias = parts[1]?.trim();
                const shortName = alias ?? className;
                useMap.set(shortName, `${namespace}\\${className}`);
            }
        }

        return useMap;
    }

    /**
     * Map Silverstripe field types to human-readable types.
     */
    private mapSilverstripeType(ssType: string): string {
        const baseType = ssType.replace(/\(.*\)/, "").trim();
        const typeMap: Record<string, string> = {
            Varchar: "string",
            Text: "string",
            HTMLText: "string (HTML)",
            HTMLFragment: "string (HTML)",
            Int: "int",
            Float: "float",
            Decimal: "float",
            Boolean: "boolean",
            Date: "date",
            Datetime: "datetime",
            Time: "time",
            Enum: "enum",
            Currency: "currency",
            Percentage: "float",
            DBFile: "file",
        };
        return typeMap[baseType] || ssType;
    }

    /**
     * Query PHPActor CLI asynchronously.
     * Resolves to an empty array if PHPActor is unavailable or the class is not found.
     */
    private queryPhpactorAsync(
        fqn: string,
        workspaceRoot: string,
    ): Promise<ClassMember[]> {
        return new Promise((resolve) => {
            exec(
                `phpactor class:reflect --format=json '${fqn}'`,
                { cwd: workspaceRoot, timeout: 5000 },
                (error, stdout) => {
                    if (error || !stdout) {
                        resolve([]);
                        return;
                    }
                    try {
                        const data = JSON.parse(stdout);
                        resolve(this.parsePhpactorOutput(data));
                    } catch {
                        resolve([]);
                    }
                },
            );
        });
    }

    /**
     * Parse a PHPActor class:reflect JSON response into ClassMember entries.
     */
    private parsePhpactorOutput(data: Record<string, unknown>): ClassMember[] {
        const members: ClassMember[] = [];
        if (data.error) {
            return members;
        }
        const methods = (data.methods || {}) as Record<string, unknown>;
        for (const method of Object.values(methods)) {
            const m = method as {
                name: string;
                visibility: string;
                parameters: Record<string, unknown>;
                type: string;
                static: number;
                docblock?: string;
            };
            if (m.visibility !== "public" || m.static) {
                continue;
            }
            if (this.isInternalMethod(m.name)) {
                continue;
            }
            const params = Object.values(m.parameters || {}) as Array<{
                has_default: boolean;
            }>;
            const hasRequired = params.some((p) => !p.has_default);
            if (hasRequired && !this.isCommonTemplateMethod(m.name)) {
                continue;
            }
            const returnType = m.type !== "<missing>" ? m.type : "";
            members.push({
                name: m.name,
                type: returnType,
                source: "method",
                detail: returnType
                    ? `→ ${this.shortenType(returnType)}`
                    : "method",
            });
        }
        return members;
    }

    /**
     * Methods that are framework-internal and shouldn't pollute template completions.
     */
    private isInternalMethod(name: string): boolean {
        const internal = new Set([
            // Lifecycle
            "onBeforeWrite",
            "onAfterWrite",
            "onBeforeDelete",
            "onAfterDelete",
            "requireDefaultRecords",
            "populateDefaults",
            "onAfterPopulateDefaults",
            // Framework internals
            "__construct",
            "__get",
            "__set",
            "__isset",
            "__unset",
            "__toString",
            "__clone",
            "__debugInfo",
            "__sleep",
            "__wakeup",
            "__serialize",
            "__unserialize",
            "defineMethods",
            "allMethodNames",
            "hasMethod",
            "getExtensionInstances",
            "getExtensionInstance",
            "addExtension",
            "removeExtension",
            "hasExtension",
            "invokeWithExtensions",
            "extend",
            "setOwner",
            "getOwner",
            "clearOwner",
            "setField",
            "getField",
            "setDynamicData",
            "getDynamicData",
            "toMap",
            "update",
            "castedUpdate",
            "write",
            "writeToStage",
            "doArchive",
            "doPublish",
            "doUnpublish",
            "writeWithoutVersion",
            "writeBaseRecord",
            "writeManyManyComponent",
            "validate",
            "getCMSFields",
            "getCMSActions",
            "getCMSValidator",
            "getSettingsFields",
            "scaffoldFormFields",
            "scaffoldSearchFields",
            "canView",
            "canEdit",
            "canDelete",
            "canCreate",
            "canPublish",
            "can",
            "providePermissions",
            "requirePermission",
            // Versioning internals
            "publishRecursive",
            "rollbackRelations",
            "deleteFromChangeSets",
            "findOwned",
            "hasOwned",
            "findOwners",
            "findOwnersRecursive",
            "unlinkDisownedObjects",
            "unlinkDisownedRelationship",
            "prepopulateVersionNumberCache",
            "prepopulateVersionNumberCacheForStage",
            "reset",
            "flushCache",
            // Caching/config
            "config",
            "stat",
            "uninherited",
            "set_stat",
            "getSchema",
            "baseTable",
            "baseClass",
            // Injection
            "create",
            "singleton",
            "injector",
        ]);
        return internal.has(name);
    }

    /**
     * Common methods that appear in templates even though they take params.
     */
    private isCommonTemplateMethod(name: string): boolean {
        const common = new Set([
            "Link",
            "AbsoluteLink",
            "Me",
            "forTemplate",
            "MetaTags",
            "obj",
            "dbObject",
            "Children",
            "Parent",
            "Level",
            "Page",
            "Fill",
            "FillMax",
            "ScaleWidth",
            "ScaleHeight",
            "ScaleMaxWidth",
            "ScaleMaxHeight",
            "CropWidth",
            "CropHeight",
            "Pad",
            "FocusFill",
            "FocusFillMax",
            "URL",
            "getURL",
            "getAbsoluteURL",
            "Sort",
            "Filter",
            "Exclude",
            "Limit",
            "First",
            "Last",
            "Count",
            "Nice",
            "XML",
            "Raw",
            "ATT",
            "JS",
            "HTMLATT",
            "EscapeXML",
            "LimitCharacters",
            "LimitWordCount",
        ]);
        return common.has(name);
    }

    /**
     * Shorten a fully qualified type for display.
     */
    private shortenType(type: string): string {
        // SilverStripe\ORM\DataList → DataList
        const parts = type.split("\\");
        return parts[parts.length - 1];
    }

    /**
     * Clear cache (e.g. on ?flush)
     */
    public clearCache(): void {
        this.cache.clear();
    }
}
