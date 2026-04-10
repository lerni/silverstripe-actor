import * as vscode from 'vscode';
import { TemplateClassMapper } from './templateClassMapper';
import { PhpClassInspector, ClassMember } from './phpClassInspector';

/**
 * Provides $Variable completions in Silverstripe templates based on the
 * mapped PHP class. Combines ORM field parsing with PHPActor method data.
 *
 * Triggers on: $ character
 * Context-aware: respects <% loop %> and <% with %> scope (basic).
 */
export class VariableCompletionProvider implements vscode.CompletionItemProvider {

    private mapper: TemplateClassMapper;
    private inspector: PhpClassInspector;

    constructor(mapper: TemplateClassMapper, inspector: PhpClassInspector) {
        this.mapper = mapper;
        this.inspector = inspector;
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): vscode.ProviderResult<vscode.CompletionItem[]> {

        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // Only trigger after $ (or {$)
        if (!linePrefix.match(/(?:^|[^\\])\$\w*$/) && !linePrefix.match(/\{\$\w*$/)) {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return undefined;
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;

        // 1. Determine which class this template maps to
        let fqn = this.mapper.mapTemplateToClass(document.uri);
        if (!fqn) {
            // Includes don't map directly — try to infer from the parent template context
            // For now, fall back to Page as a reasonable default for includes
            fqn = 'Page';
        }

        // 2. Check if we're inside a <% loop %> or <% with %> block
        const scopeClass = this.resolveScope(document, position, fqn, workspaceRoot);

        // 3. Get class members
        const phpFile = this.mapper.findClassFile(scopeClass, workspaceRoot);
        const members = this.inspector.getClassMembers(scopeClass, workspaceRoot, phpFile || undefined);

        if (members.length === 0) {
            return undefined;
        }

        // 4. Build completion items
        return this.buildCompletionItems(members);
    }

    /**
     * Walk backwards from cursor to find the innermost <% loop $X %> or <% with $X %>.
     * Returns the FQN of the class in that scope, or the original FQN if not in a block.
     */
    private resolveScope(
        document: vscode.TextDocument,
        position: vscode.Position,
        baseFqn: string,
        workspaceRoot: string,
    ): string {
        const textBefore = document.getText(new vscode.Range(
            new vscode.Position(0, 0),
            position,
        ));

        // Track scope: push on loop/with, pop on end_loop/end_with
        const scopeStack: string[] = [];

        // Match opening and closing scope tags
        const openRegex = /<%\s*(?:loop|with)\s+\$(\w+(?:\.\w+)*)\s*%>/g;
        const closeRegex = /<%\s*end_(?:loop|with)\s*%>/g;

        // Collect all tags with positions
        interface ScopeTag {
            type: 'open' | 'close';
            variable?: string;
            index: number;
        }
        const tags: ScopeTag[] = [];

        let match;
        while ((match = openRegex.exec(textBefore)) !== null) {
            tags.push({ type: 'open', variable: match[1], index: match.index });
        }
        while ((match = closeRegex.exec(textBefore)) !== null) {
            tags.push({ type: 'close', index: match.index });
        }

        // Sort by position
        tags.sort((a, b) => a.index - b.index);

        // Walk through tags to determine current scope
        for (const tag of tags) {
            if (tag.type === 'open' && tag.variable) {
                scopeStack.push(tag.variable);
            } else if (tag.type === 'close' && scopeStack.length > 0) {
                scopeStack.pop();
            }
        }

        if (scopeStack.length === 0) {
            return baseFqn;
        }

        // Try to resolve the innermost scope variable to a class
        const scopeVar = scopeStack[scopeStack.length - 1];
        return this.resolveVariableToClass(scopeVar, baseFqn, workspaceRoot);
    }

    /**
     * Try to resolve a template variable name to a PHP class FQN.
     * e.g. "Slides" on ElementHero → App\Models\Slide (via $has_many/$many_many)
     */
    private resolveVariableToClass(
        variable: string,
        parentFqn: string,
        workspaceRoot: string,
    ): string {
        // Get parent class members to find the relation type
        const phpFile = this.mapper.findClassFile(parentFqn, workspaceRoot);
        const members = this.inspector.getClassMembers(parentFqn, workspaceRoot, phpFile || undefined);

        // Look for a relation with this name
        const firstPart = variable.split('.')[0];
        const member = members.find(m =>
            m.name === firstPart &&
            (m.source === 'has_one' || m.source === 'has_many' || m.source === 'many_many' || m.source === 'belongs_many_many')
        );

        if (member && member.detail) {
            // Extract the class name from the detail
            // e.g. "has_one: App\Models\Slide" or "has_many: Slide::class"
            const classMatch = member.detail.match(/:\s*(?:['"]?)?([\w\\]+?)(?:::class)?(?:['"]?)\s*$/);
            if (classMatch) {
                return classMatch[1];
            }
        }

        // Can't resolve — stay in parent scope
        return parentFqn;
    }

    /**
     * Build VSCode CompletionItems from class members.
     */
    private buildCompletionItems(members: ClassMember[]): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Add loop position variables when we might be in a loop
        const loopVars = [
            { name: 'Pos', detail: 'Current position (1-based)' },
            { name: 'Even', detail: 'True if even position' },
            { name: 'Odd', detail: 'True if odd position' },
            { name: 'EvenOdd', detail: '"even" or "odd" string' },
            { name: 'IsFirst', detail: 'True if first item' },
            { name: 'IsLast', detail: 'True if last item' },
            { name: 'TotalItems', detail: 'Total number of items' },
            { name: 'FirstLast', detail: '"first", "last", or ""' },
            { name: 'Top', detail: 'Top-level scope' },
            { name: 'Up', detail: 'Parent scope' },
        ];

        for (const lv of loopVars) {
            const item = new vscode.CompletionItem(lv.name, vscode.CompletionItemKind.Variable);
            item.detail = lv.detail;
            item.sortText = `2_${lv.name}`; // Sort after class members
            items.push(item);
        }

        for (const member of members) {
            const kind = this.memberToCompletionKind(member);
            const item = new vscode.CompletionItem(member.name, kind);

            item.detail = this.memberDetail(member);
            item.documentation = this.memberDocumentation(member);
            item.sortText = `0_${this.memberSortPrefix(member)}_${member.name}`;

            // For methods that take params, add parentheses
            if (member.source === 'method' && !this.isGetterMethod(member.name)) {
                item.insertText = new vscode.SnippetString(`${member.name}($1)`);
            }

            items.push(item);
        }

        return items;
    }

    private memberToCompletionKind(member: ClassMember): vscode.CompletionItemKind {
        switch (member.source) {
            case 'db': return vscode.CompletionItemKind.Field;
            case 'has_one': return vscode.CompletionItemKind.Reference;
            case 'has_many':
            case 'many_many':
            case 'belongs_many_many':
                return vscode.CompletionItemKind.Module;
            case 'method': return vscode.CompletionItemKind.Method;
            default: return vscode.CompletionItemKind.Property;
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
        return parts.join('\n');
    }

    private memberSortPrefix(member: ClassMember): string {
        // db fields first, then relations, then methods
        switch (member.source) {
            case 'db': return '0';
            case 'has_one': return '1';
            case 'has_many':
            case 'many_many':
            case 'belongs_many_many':
                return '2';
            case 'method': return '3';
            default: return '4';
        }
    }

    private isGetterMethod(name: string): boolean {
        return name.startsWith('get') && name.length > 3 && name[3] === name[3].toUpperCase();
    }
}
