import * as vscode from "vscode";
import type { ClassMember, PhpClassInspector } from "./phpClassInspector";
import type { TemplateClassMapper } from "./templateClassMapper";

/**
 * Provides completions in Silverstripe templates:
 * - $Variable completions (triggers on $)
 * - Dot-chain completions like $Image.Fill(300,200). (triggers on .)
 * - Scope navigation: $Up, $Top (resolved through dot-chains)
 *
 * Context-aware: respects <% loop %> and <% with %> scope via a scope stack.
 */
export class VariableCompletionProvider
    implements vscode.CompletionItemProvider
{
    private mapper: TemplateClassMapper;
    private inspector: PhpClassInspector;

    constructor(mapper: TemplateClassMapper, inspector: PhpClassInspector) {
        this.mapper = mapper;
        this.inspector = inspector;
    }

    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): Promise<vscode.CompletionItem[] | undefined> {
        if (token.isCancellationRequested) {
            return undefined;
        }

        const linePrefix = document
            .lineAt(position)
            .text.substring(0, position.character);

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            document.uri,
        );
        if (!workspaceFolder) {
            return undefined;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Determine base class and build scope stack
        let baseFqn = this.mapper.mapTemplateToClass(document.uri);
        if (!baseFqn) {
            baseFqn = "Page";
        }
        const scopeStack = this.buildScopeStack(
            document,
            position,
            baseFqn,
            workspaceRoot,
        );
        const currentFqn = scopeStack[scopeStack.length - 1];

        // Case 1: Dot-chain — $Foo.Bar.|
        const chainSegments = this.parseDotChain(linePrefix);
        if (chainSegments && chainSegments.length > 0) {
            return this.handleDotChain(
                chainSegments,
                scopeStack,
                workspaceRoot,
                token,
            );
        }

        // Case 2: Dollar sign — $|
        if (
            linePrefix.match(/(?:^|[^\\])\$\w*$/) ||
            linePrefix.match(/\{\$\w*$/)
        ) {
            return this.handleDollarSign(
                currentFqn,
                scopeStack.length > 1,
                workspaceRoot,
                token,
            );
        }

        return undefined;
    }

    // ─── Dot-chain parsing ────────────────────────────────────────────

    /**
     * Parse a dot-chain from the line prefix.
     * Returns the completed segments before the last dot, or null if not in a chain.
     * Example: "$Image.Fill(300,200).URL" → ["Image", "Fill(300,200)"]
     */
    private parseDotChain(linePrefix: string): string[] | null {
        // Match $chain. at end of prefix (with optional partial text after last dot)
        const match =
            linePrefix.match(
                /(?:^|[^\\])\$(\w+(?:\.\w+(?:\([^)]*\))?)*)\.\w*$/,
            ) || linePrefix.match(/\{\$(\w+(?:\.\w+(?:\([^)]*\))?)*)\.\w*$/);

        if (!match) {
            return null;
        }

        return this.splitChainString(match[1]);
    }

    /**
     * Split a chain string like "Image.Fill(300,200)" into segments,
     * respecting parenthesized arguments.
     */
    private splitChainString(chainStr: string): string[] {
        const segments: string[] = [];
        let current = "";
        let parenDepth = 0;

        for (const char of chainStr) {
            if (char === "(") {
                parenDepth++;
            }
            if (char === ")") {
                parenDepth--;
            }
            if (char === "." && parenDepth === 0) {
                if (current) {
                    segments.push(current);
                }
                current = "";
            } else {
                current += char;
            }
        }
        if (current) {
            segments.push(current);
        }

        return segments;
    }

    // ─── Dot-chain resolution ─────────────────────────────────────────

    /**
     * Handle dot-chain completions: resolve chain to a type, offer members.
     */
    private async handleDotChain(
        segments: string[],
        scopeStack: string[],
        workspaceRoot: string,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[] | undefined> {
        if (token.isCancellationRequested) {
            return undefined;
        }
        const resolved = await this.resolveDotChain(
            segments,
            scopeStack,
            workspaceRoot,
            token,
        );
        if (!resolved) {
            return undefined;
        }

        const phpFile = this.mapper.findClassFile(resolved.fqn, workspaceRoot);
        const members = await this.inspector.getClassMembersAsync(
            resolved.fqn,
            workspaceRoot,
            phpFile || undefined,
        );

        const items = this.buildCompletionItems(members, false);

        if (resolved.isList) {
            this.addListMethodCompletions(items);
        }

        return items.length > 0 ? items : undefined;
    }

    /**
     * Resolve a dot-chain (array of segments) to a final type.
     * Handles $Up/$Top scope navigation, relation traversal, and method return types.
     */
    private async resolveDotChain(
        segments: string[],
        scopeStack: string[],
        workspaceRoot: string,
        token: vscode.CancellationToken,
    ): Promise<{ fqn: string; isList: boolean } | null> {
        if (segments.length === 0) {
            return null;
        }

        let segmentIndex = 0;
        let currentFqn: string;
        let isList = false;

        const firstName = segments[0].replace(/\(.*\)$/, "");

        if (firstName === "Top") {
            // $Top → root scope
            currentFqn = scopeStack[0];
            segmentIndex = 1;
        } else if (firstName === "Up") {
            // Count consecutive $Up segments
            let upCount = 0;
            while (
                segmentIndex < segments.length &&
                segments[segmentIndex].replace(/\(.*\)$/, "") === "Up"
            ) {
                upCount++;
                segmentIndex++;
            }
            const targetLevel = Math.max(0, scopeStack.length - 1 - upCount);
            currentFqn = scopeStack[targetLevel];
        } else {
            // Normal first segment — resolve against innermost scope
            const innerFqn = scopeStack[scopeStack.length - 1];
            const resolved = await this.resolveSegment(
                firstName,
                segments[0],
                innerFqn,
                false,
                workspaceRoot,
            );
            if (!resolved) {
                return null;
            }
            currentFqn = resolved.fqn;
            isList = resolved.isList;
            segmentIndex = 1;
        }

        // Walk remaining segments
        for (let i = segmentIndex; i < segments.length; i++) {
            if (token.isCancellationRequested) {
                return null;
            }
            const segment = segments[i];
            const memberName = segment.replace(/\(.*\)$/, "");

            const resolved = await this.resolveSegment(
                memberName,
                segment,
                currentFqn,
                isList,
                workspaceRoot,
            );
            if (!resolved) {
                return null;
            }
            currentFqn = resolved.fqn;
            isList = resolved.isList;
        }

        return { fqn: currentFqn, isList };
    }

    /**
     * Resolve a single segment in a dot-chain to a type.
     */
    private async resolveSegment(
        memberName: string,
        _fullSegment: string,
        parentFqn: string,
        parentIsList: boolean,
        workspaceRoot: string,
    ): Promise<{ fqn: string; isList: boolean } | null> {
        // Check known method patterns first (list methods, image methods, etc.)
        const knownResult = this.resolveKnownMethod(
            memberName,
            parentFqn,
            parentIsList,
        );
        if (knownResult !== undefined) {
            return knownResult;
        }

        // Look up member on the parent class
        const phpFile = this.mapper.findClassFile(parentFqn, workspaceRoot);
        const members = await this.inspector.getClassMembersAsync(
            parentFqn,
            workspaceRoot,
            phpFile || undefined,
        );
        const member = members.find((m) => m.name === memberName);

        if (!member) {
            return null;
        }

        switch (member.source) {
            case "has_one": {
                const targetClass = this.extractClassFromDetail(member.detail);

                return targetClass ? { fqn: targetClass, isList: false } : null;
            }
            case "has_many":
            case "many_many":
            case "belongs_many_many": {
                const targetClass = this.extractClassFromDetail(member.detail);

                return targetClass ? { fqn: targetClass, isList: true } : null;
            }
            case "db":
                // DB fields are terminal for chain purposes
                return null;
            case "method":
                return this.resolveMethodReturn(
                    member,
                    parentFqn,
                    parentIsList,
                );
            default:
                return null;
        }
    }

    /**
     * Known Silverstripe method return types.
     * Returns:  { fqn, isList } — resolved type
     *           null — terminal method (returns string/int/void)
     *           undefined — not a known method, fall through to member lookup
     */
    private resolveKnownMethod(
        methodName: string,
        contextFqn: string,
        contextIsList: boolean,
    ): { fqn: string; isList: boolean } | null | undefined {
        // DataList methods (only valid on list types)
        if (contextIsList) {
            switch (methodName) {
                case "Filter":
                case "FilterAny":
                case "Exclude":
                case "Sort":
                case "Reverse":
                case "Limit":
                    return { fqn: contextFqn, isList: true };
                case "First":
                case "Last":
                    return { fqn: contextFqn, isList: false };
                case "Count":
                case "Avg":
                case "Max":
                case "Min":
                case "Sum":
                    return null;
            }
        }

        // Image manipulation → returns same type
        const imageMethods = new Set([
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
            "FocusCropWidth",
            "FocusCropHeight",
            "Resampled",
            "ResizedImage",
            "Fit",
            "FitMax",
        ]);
        if (imageMethods.has(methodName)) {
            return { fqn: contextFqn, isList: false };
        }

        // Casting/formatting methods → terminal
        const terminalMethods = new Set([
            "XML",
            "RAW",
            "ATT",
            "JS",
            "HTMLATT",
            "EscapeXML",
            "LimitCharacters",
            "LimitWordCount",
            "LimitWordCountXML",
            "Summary",
            "BigSummary",
            "ContextSummary",
            "FirstParagraph",
            "FirstSentence",
            "Nice",
            "Long",
            "Short",
            "Full",
            "Ago",
            "Year",
            "Month",
            "Day",
            "Format",
            "FormatFromSettings",
            "URL",
            "AbsoluteURL",
            "getURL",
            "getAbsoluteURL",
        ]);
        if (terminalMethods.has(methodName)) {
            return null;
        }

        // Self-returning
        if (methodName === "Me" || methodName === "forTemplate") {
            return { fqn: contextFqn, isList: contextIsList };
        }

        // Not a known method
        return undefined;
    }

    /**
     * Resolve return type from a PHPActor method member.
     */
    private resolveMethodReturn(
        member: ClassMember,
        parentFqn: string,
        parentIsList: boolean,
    ): { fqn: string; isList: boolean } | null {
        const returnType = member.type;
        if (!returnType || returnType === "<missing>") {
            return null;
        }

        // Self-referencing
        if (
            returnType === "static" ||
            returnType === "self" ||
            returnType === "$this"
        ) {
            return { fqn: parentFqn, isList: parentIsList };
        }

        // Primitives → terminal
        const primitives = [
            "string",
            "int",
            "float",
            "bool",
            "boolean",
            "void",
            "null",
            "array",
            "mixed",
        ];
        if (primitives.includes(returnType.toLowerCase())) {
            return null;
        }

        // Clean up nullable/union types
        let cleanType = returnType.replace(/^\?/, "");
        if (cleanType.includes("|")) {
            const types = cleanType
                .split("|")
                .filter(
                    (t) =>
                        t !== "null" && !primitives.includes(t.toLowerCase()),
                );
            cleanType = types[0] || "";
        }
        if (!cleanType) {
            return null;
        }

        // List types → keep current element type as inner type
        if (
            /DataList|ArrayList|HasManyList|ManyManyList|ManyManyThroughList/.test(
                cleanType,
            )
        ) {
            return { fqn: parentFqn, isList: true };
        }

        // Concrete class FQN
        if (cleanType.includes("\\") || /^[A-Z]/.test(cleanType)) {
            return { fqn: cleanType, isList: false };
        }

        return null;
    }

    // ─── Scope tracking ───────────────────────────────────────────────

    /**
     * Build the full scope stack from document start to cursor position.
     * Index 0 = root (template's base class), last = innermost scope.
     */
    private buildScopeStack(
        document: vscode.TextDocument,
        position: vscode.Position,
        baseFqn: string,
        workspaceRoot: string,
    ): string[] {
        const stack: string[] = [baseFqn];

        const textBefore = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
        );

        interface ScopeTag {
            type: "open" | "close";
            variable?: string;
            index: number;
        }
        const tags: ScopeTag[] = [];

        const openRegex = /<%\s*(?:loop|with)\s+\$(\w+(?:\.\w+)*)\s*%>/g;
        const closeRegex = /<%\s*end_(?:loop|with)\s*%>/g;

        for (const match of textBefore.matchAll(openRegex)) {
            tags.push({
                type: "open",
                variable: match[1],
                index: match.index ?? 0,
            });
        }
        for (const match of textBefore.matchAll(closeRegex)) {
            tags.push({ type: "close", index: match.index ?? 0 });
        }

        tags.sort((a, b) => a.index - b.index);

        for (const tag of tags) {
            if (tag.type === "open" && tag.variable) {
                const parentFqn = stack[stack.length - 1];
                const resolved = this.resolveVariableToClass(
                    tag.variable,
                    parentFqn,
                    workspaceRoot,
                );
                stack.push(resolved);
            } else if (tag.type === "close" && stack.length > 1) {
                stack.pop();
            }
        }

        return stack;
    }

    /**
     * Handle $-triggered completions for the current scope class.
     */
    private async handleDollarSign(
        currentFqn: string,
        isNested: boolean,
        workspaceRoot: string,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[] | undefined> {
        if (token.isCancellationRequested) {
            return undefined;
        }
        const phpFile = this.mapper.findClassFile(currentFqn, workspaceRoot);
        const members = await this.inspector.getClassMembersAsync(
            currentFqn,
            workspaceRoot,
            phpFile || undefined,
        );

        if (members.length === 0) {
            return undefined;
        }

        return this.buildCompletionItems(members, isNested);
    }

    // ─── Resolution helpers ───────────────────────────────────────────

    /**
     * Extract class FQN from member detail string.
     * e.g. "has_one: SilverStripe\Assets\Image" → "SilverStripe\Assets\Image"
     */
    private extractClassFromDetail(detail: string | undefined): string | null {
        if (!detail) {
            return null;
        }
        const match = detail.match(
            /:\s*(?:['"]?)?([\w\\]+?)(?:::class)?(?:['"]?)\s*$/,
        );

        return match ? match[1] : null;
    }

    /**
     * Resolve a template variable name to a PHP class FQN via relation lookup.
     */
    private resolveVariableToClass(
        variable: string,
        parentFqn: string,
        workspaceRoot: string,
    ): string {
        const phpFile = this.mapper.findClassFile(parentFqn, workspaceRoot);
        const members = this.inspector.getClassMembers(
            parentFqn,
            workspaceRoot,
            phpFile || undefined,
        );

        const firstPart = variable.split(".")[0];
        const member = members.find(
            (m) =>
                m.name === firstPart &&
                (m.source === "has_one" ||
                    m.source === "has_many" ||
                    m.source === "many_many" ||
                    m.source === "belongs_many_many"),
        );

        const classMatch = member?.detail?.match(
            /:\s*(?:['"]?)?([\w\\]+?)(?:::class)?(?:['"]?)\s*$/,
        );
        if (classMatch) {
            return classMatch[1];
        }

        return parentFqn;
    }

    // ─── Completion item builders ─────────────────────────────────────

    /**
     * Build completion items from class members.
     */
    private buildCompletionItems(
        members: ClassMember[],
        includeLoopVars: boolean,
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        if (includeLoopVars) {
            // Scope navigation
            const scopeVars = [
                {
                    name: "Up",
                    detail: "Parent scope",
                    doc: "Access the parent scope. Chain with dot: $Up.FieldName",
                },
                {
                    name: "Top",
                    detail: "Root scope",
                    doc: "Access the top-level scope: $Top.FieldName",
                },
            ];
            for (const sv of scopeVars) {
                const item = new vscode.CompletionItem(
                    sv.name,
                    vscode.CompletionItemKind.Reference,
                );
                item.detail = sv.detail;
                item.documentation = sv.doc;
                item.sortText = `1_${sv.name}`;
                items.push(item);
            }

            // Loop position variables
            const posVars = [
                { name: "Pos", detail: "Current position (1-based)" },
                { name: "Even", detail: "True if even position" },
                { name: "Odd", detail: "True if odd position" },
                { name: "EvenOdd", detail: '"even" or "odd" string' },
                { name: "IsFirst", detail: "True if first item" },
                { name: "IsLast", detail: "True if last item" },
                { name: "TotalItems", detail: "Total number of items" },
                { name: "FirstLast", detail: '"first", "last", or ""' },
            ];
            for (const pv of posVars) {
                const item = new vscode.CompletionItem(
                    pv.name,
                    vscode.CompletionItemKind.Variable,
                );
                item.detail = pv.detail;
                item.sortText = `2_${pv.name}`;
                items.push(item);
            }
        }

        for (const member of members) {
            const kind = this.memberToCompletionKind(member);
            const item = new vscode.CompletionItem(member.name, kind);

            item.detail = this.memberDetail(member);
            item.documentation = this.memberDocumentation(member);
            item.sortText = `0_${this.memberSortPrefix(member)}_${member.name}`;

            if (
                member.source === "method" &&
                !this.isGetterMethod(member.name)
            ) {
                item.insertText = new vscode.SnippetString(
                    `${member.name}($1)`,
                );
            }

            items.push(item);
        }

        return items;
    }

    /**
     * Add DataList method completions for list-typed chains.
     */
    private addListMethodCompletions(items: vscode.CompletionItem[]): void {
        const listMethods = [
            { name: "First", detail: "First item in the list" },
            { name: "Last", detail: "Last item in the list" },
            { name: "Count", detail: "Number of items" },
            { name: "Filter", detail: "Filter list by column values" },
            { name: "FilterAny", detail: "Filter by any matching value" },
            { name: "Exclude", detail: "Exclude by column values" },
            { name: "Sort", detail: "Sort list by column" },
            { name: "Reverse", detail: "Reverse list order" },
            { name: "Limit", detail: "Limit number of items" },
        ];

        for (const method of listMethods) {
            const item = new vscode.CompletionItem(
                method.name,
                vscode.CompletionItemKind.Method,
            );
            item.detail = `DataList: ${method.detail}`;
            item.sortText = `0_1_${method.name}`;
            item.insertText = new vscode.SnippetString(`${method.name}($1)`);
            items.push(item);
        }
    }

    private memberToCompletionKind(
        member: ClassMember,
    ): vscode.CompletionItemKind {
        switch (member.source) {
            case "db":
                return vscode.CompletionItemKind.Field;
            case "has_one":
                return vscode.CompletionItemKind.Reference;
            case "has_many":
            case "many_many":
            case "belongs_many_many":
                return vscode.CompletionItemKind.Module;
            case "method":
                return vscode.CompletionItemKind.Method;
            default:
                return vscode.CompletionItemKind.Property;
        }
    }

    private memberDetail(member: ClassMember): string {
        if (member.detail) {
            return member.detail;
        }
        if (member.type) {
            return member.type;
        }

        return member.source;
    }

    private memberDocumentation(member: ClassMember): string {
        const parts: string[] = [];
        if (member.type) {
            parts.push(`Type: ${member.type}`);
        }
        parts.push(`Source: ${member.source}`);

        return parts.join("\n");
    }

    private memberSortPrefix(member: ClassMember): string {
        switch (member.source) {
            case "db":
                return "0";
            case "has_one":
                return "1";
            case "has_many":
            case "many_many":
            case "belongs_many_many":
                return "2";
            case "method":
                return "3";
            default:
                return "4";
        }
    }

    private isGetterMethod(name: string): boolean {
        return (
            name.startsWith("get") &&
            name.length > 3 &&
            name[3] === name[3].toUpperCase()
        );
    }
}
