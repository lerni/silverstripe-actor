import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface ClassMember {
    name: string;
    type: string;
    source: 'db' | 'has_one' | 'has_many' | 'many_many' | 'belongs_many_many' | 'method' | 'inherited';
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

    private cache: Map<string, { members: ClassMember[]; mtime: number }> = new Map();

    /**
     * Get all template-available members for a PHP class.
     */
    public getClassMembers(fqn: string, workspaceRoot: string, phpFilePath?: string): ClassMember[] {
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

        // Strategy 1: Parse $db, $has_one, etc. from source file
        if (phpFilePath && fs.existsSync(phpFilePath)) {
            const sourceMembers = this.parsePhpSource(phpFilePath);
            for (const member of sourceMembers) {
                if (!seenNames.has(member.name)) {
                    members.push(member);
                    seenNames.add(member.name);
                }
            }
        }

        // Strategy 2: PHPActor CLI for methods (inherited, annotated, etc.)
        const phpactorMembers = this.queryPhpactor(fqn, workspaceRoot);
        for (const member of phpactorMembers) {
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
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return members;
        }

        // Parse private static $db = [...]
        this.parseStaticArray(content, 'db', members);
        this.parseStaticArray(content, 'has_one', members);
        this.parseStaticArray(content, 'has_many', members);
        this.parseStaticArray(content, 'many_many', members);
        this.parseStaticArray(content, 'belongs_many_many', members);

        // Parse @property annotations from class docblock
        this.parseDocblockAnnotations(content, members);

        return members;
    }

    /**
     * Parse a private static $xxx = [...] array from PHP source.
     * Handles both string values and ::class references.
     */
    private parseStaticArray(
        content: string,
        configName: string,
        members: ClassMember[],
    ): void {
        // Match: private static $db = [ ... ];
        // Uses a greedy match within brackets, handling nested brackets
        const regex = new RegExp(
            `private\\s+static\\s+\\$${configName}\\s*=\\s*\\[([^\\]]*(?:\\[[^\\]]*\\][^\\]]*)*)\\]`,
            's'
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
        const entryRegex = /['"](\w+)['"]\s*=>\s*(?:'((?:[^'\\]|\\.|"[^"]*")*)'|"((?:[^"\\]|\\.)*?)"|(\w+(?:\\\w+)*)::class)/g;
        let entryMatch;

        while ((entryMatch = entryRegex.exec(arrayContent)) !== null) {
            const fieldName = entryMatch[1];
            const singleQuotedVal = entryMatch[2]; // e.g. Varchar(255), Enum("small,medium")
            const doubleQuotedVal = entryMatch[3]; // e.g. "Boolean"
            const classRef = entryMatch[4];         // e.g. Slide::class

            const stringType = singleQuotedVal || doubleQuotedVal;
            let type: string;
            if (stringType) {
                type = this.mapSilverstripeType(stringType);
            } else if (classRef) {
                // Extract short class name
                const parts = classRef.split('\\');
                type = parts[parts.length - 1];
            } else {
                type = 'mixed';
            }

            const source = configName as ClassMember['source'];
            members.push({
                name: fieldName,
                type,
                source,
                detail: `${configName}: ${stringType || classRef}`,
            });
        }
    }

    /**
     * Parse @property and @method annotations from the class docblock.
     */
    private parseDocblockAnnotations(content: string, members: ClassMember[]): void {
        // Find the class docblock (last /** ... */ before the class keyword)
        const classDocMatch = content.match(/\/\*\*([\s\S]*?)\*\/\s*(?:abstract\s+)?class\s+/);
        if (!classDocMatch) {
            return;
        }

        const docblock = classDocMatch[1];

        // @property Type $name
        const propertyRegex = /@property\s+([\w\\|]+)\s+\$(\w+)/g;
        let match;
        while ((match = propertyRegex.exec(docblock)) !== null) {
            members.push({
                name: match[2],
                type: match[1],
                source: 'db',
                detail: '@property annotation',
            });
        }

        // @method Type name()
        const methodRegex = /@method\s+([\w\\|]+)\s+(\w+)\s*\(/g;
        while ((match = methodRegex.exec(docblock)) !== null) {
            members.push({
                name: match[2],
                type: match[1],
                source: 'method',
                detail: '@method annotation',
            });
        }
    }

    /**
     * Map Silverstripe field types to human-readable types.
     */
    private mapSilverstripeType(ssType: string): string {
        const baseType = ssType.replace(/\(.*\)/, '').trim();
        const typeMap: Record<string, string> = {
            'Varchar': 'string',
            'Text': 'string',
            'HTMLText': 'string (HTML)',
            'HTMLFragment': 'string (HTML)',
            'Int': 'int',
            'Float': 'float',
            'Decimal': 'float',
            'Boolean': 'boolean',
            'Date': 'date',
            'Datetime': 'datetime',
            'Time': 'time',
            'Enum': 'enum',
            'Currency': 'currency',
            'Percentage': 'float',
            'DBFile': 'file',
        };
        return typeMap[baseType] || ssType;
    }

    /**
     * Query PHPActor CLI for class methods.
     * Returns public methods suitable for template use.
     */
    private queryPhpactor(fqn: string, workspaceRoot: string): ClassMember[] {
        const members: ClassMember[] = [];

        try {
            const result = execSync(
                `phpactor class:reflect --format=json '${fqn}'`,
                {
                    cwd: workspaceRoot,
                    timeout: 10000,
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                }
            );

            const data = JSON.parse(result);
            if (data.error) {
                return members;
            }

            const methods = data.methods || {};
            for (const [name, method] of Object.entries(methods)) {
                const m = method as {
                    name: string;
                    visibility: string;
                    parameters: Record<string, unknown>;
                    type: string;
                    static: number;
                    docblock?: string;
                };

                // Only public, non-static methods with no required parameters
                // (template variables are essentially no-arg getters)
                if (m.visibility !== 'public' || m.static) {
                    continue;
                }

                // Skip internal/framework methods not useful in templates
                if (this.isInternalMethod(m.name)) {
                    continue;
                }

                const params = Object.values(m.parameters || {});
                const hasRequired = params.some((p: any) => !p.has_default);

                // Template-callable methods have 0 required params
                // (or are common methods like Link(), AbsoluteLink())
                if (hasRequired && !this.isCommonTemplateMethod(m.name)) {
                    continue;
                }

                const returnType = m.type !== '<missing>' ? m.type : '';

                members.push({
                    name: m.name,
                    type: returnType,
                    source: 'method',
                    detail: returnType ? `→ ${this.shortenType(returnType)}` : 'method',
                });
            }
        } catch {
            // PHPActor not available or class not found — silent fallback
        }

        return members;
    }

    /**
     * Methods that are framework-internal and shouldn't pollute template completions.
     */
    private isInternalMethod(name: string): boolean {
        const internal = new Set([
            // Lifecycle
            'onBeforeWrite', 'onAfterWrite', 'onBeforeDelete', 'onAfterDelete',
            'requireDefaultRecords', 'populateDefaults', 'onAfterPopulateDefaults',
            // Framework internals
            '__construct', '__get', '__set', '__isset', '__unset', '__toString',
            '__clone', '__debugInfo', '__sleep', '__wakeup', '__serialize', '__unserialize',
            'defineMethods', 'allMethodNames', 'hasMethod',
            'getExtensionInstances', 'getExtensionInstance',
            'addExtension', 'removeExtension', 'hasExtension',
            'invokeWithExtensions', 'extend',
            'setOwner', 'getOwner', 'clearOwner',
            'setField', 'getField', 'setDynamicData', 'getDynamicData',
            'toMap', 'update', 'castedUpdate',
            'write', 'writeToStage', 'doArchive', 'doPublish', 'doUnpublish',
            'writeWithoutVersion', 'writeBaseRecord', 'writeManyManyComponent',
            'validate', 'getCMSFields', 'getCMSActions', 'getCMSValidator',
            'getSettingsFields', 'scaffoldFormFields', 'scaffoldSearchFields',
            'canView', 'canEdit', 'canDelete', 'canCreate', 'canPublish', 'can',
            'providePermissions', 'requirePermission',
            // Versioning internals
            'publishRecursive', 'rollbackRelations', 'deleteFromChangeSets',
            'findOwned', 'hasOwned', 'findOwners', 'findOwnersRecursive',
            'unlinkDisownedObjects', 'unlinkDisownedRelationship',
            'prepopulateVersionNumberCache', 'prepopulateVersionNumberCacheForStage',
            'reset', 'flushCache',
            // Caching/config
            'config', 'stat', 'uninherited', 'set_stat',
            'getSchema', 'baseTable', 'baseClass',
            // Injection
            'create', 'singleton', 'injector',
        ]);
        return internal.has(name);
    }

    /**
     * Common methods that appear in templates even though they take params.
     */
    private isCommonTemplateMethod(name: string): boolean {
        const common = new Set([
            'Link', 'AbsoluteLink', 'Me', 'forTemplate',
            'MetaTags', 'obj', 'dbObject',
            'Children', 'Parent', 'Level', 'Page',
            'Fill', 'FillMax', 'ScaleWidth', 'ScaleHeight', 'ScaleMaxWidth', 'ScaleMaxHeight',
            'CropWidth', 'CropHeight', 'Pad', 'FocusFill', 'FocusFillMax',
            'URL', 'getURL', 'getAbsoluteURL',
            'Sort', 'Filter', 'Exclude', 'Limit', 'First', 'Last', 'Count',
            'Nice', 'XML', 'Raw', 'ATT', 'JS', 'HTMLATT',
            'EscapeXML', 'LimitCharacters', 'LimitWordCount',
        ]);
        return common.has(name);
    }

    /**
     * Shorten a fully qualified type for display.
     */
    private shortenType(type: string): string {
        // SilverStripe\ORM\DataList → DataList
        const parts = type.split('\\');
        return parts[parts.length - 1];
    }

    /**
     * Clear cache (e.g. on ?flush)
     */
    public clearCache(): void {
        this.cache.clear();
    }
}
