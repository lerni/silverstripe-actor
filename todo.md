# Silverstripe Language Server Extension – Project Plan

## Context & Motivation

This project aims to build a modern, maintainable VSCode extension for Silverstripe template (`.ss`) files, designed for DDEV/devcontainer workflows and leveraging PHPActor for deep PHP insights. The goal is to provide:
- Syntax highlighting for Silverstripe templates
- Go-to-definition for `<% include %>` and similar constructs
- Template path autocomplete
- (Planned) Variable/method completion and type info via PHPActor

### Why?
- Existing extensions are outdated, overcomplicated, or IDEA-only
- We want a clean, dependency-light, open solution for VSCode
- PHPActor is already used for PHP, so we want to bridge its power into templates

## Conversation Summary (Jan 2026)
- Compared IDEA plugin, adrian.silverstripe, and silverstripe-syntax-highlighter
- Decided to start fresh, using only the best parts (syntax, navigation)
- Outlined a phased plan: start with highlighting/navigation, then add PHPActor-powered completions
- Set up a new repo (`ss-lang-server/`) for clean development, to be cloned per-project and registered in devcontainer
- Ensured all steps are DDEV/devcontainer compatible

## Project Phases & Steps

### Phase 1: Foundation (MVP)
- [x] Create clean extension structure in `ss-lang-server/`
- [x] Copy syntax grammar from enhanced-silverstripe-syntax-highlighter
- [x] Implement go-to-definition for `<% include %>`
- [x] Implement template path autocomplete
- [x] Remove all sanchez/adrian legacy code
- [x] Set up TypeScript, build, and debug configs
- [x] Document devcontainer usage and multi-root workspace setup
- [x] Test in a real Silverstripe project (DDEV/devcontainer)
- [x] Coloring SS Template expressions and make it configurable as in `ss-lang-server-variants/silverstripe-syntax-highlighter`
- [x] We want Emmet working (configurationDefaults emmet.includeLanguages)
- [x] We want JS in script-tags with JS highlighting (embeddedLanguages in grammar)
- [x] We want CSS in style-tags highlighted correctly (embeddedLanguages in grammar)
- [x] Registered injection grammar in package.json (was only on disk, not wired up)
- [ ] Polish and commit initial version

### Phase 1.5: Silverstripe Manifest Integration
- [x] Investigate Silverstripe manifest cache structure (`silverstripe-cache/`)
  - ThemeResourceLoader: hashed keys → absolute paths (not useful for reverse lookup)
  - ClassInfo: table name → class name mapping (limited use)
  - Decision: Composer's PSR-4 map is more useful than SS cache
- [x] Parse Composer autoload_psr4.php for namespace→directory mappings
  - Resolves ANY class (app + vendor) to source file
  - Cached per workspace, handles PHP double-backslash escaping
- [x] Use PSR-4 map to resolve vendor classes (SiteTree, BaseElement, Image, etc.)
- [ ] Watch for `composer install`/`update` to invalidate PSR-4 cache
- [ ] Use manifest data to enhance go-to-definition with vendor module support

### Phase 2: PHPActor Integration
- [x] Map templates to PHP classes (templateClassMapper.ts)
  - App/Elements/ElementHero.ss → App\Elements\ElementHero
  - Layout/Page.ss → Page (strips Layout/ sub-type)
  - Handles _suffix variants and Includes exclusion
- [x] Query PHPActor CLI for class members (phpClassInspector.ts)
  - `phpactor class:reflect --format=json 'FQN'` for inherited methods
  - Direct parsing of $db, $has_one, $has_many, $many_many from PHP source
  - Parses @property/@method docblock annotations
  - Results cached per class with file-mtime invalidation
  - Filters internal methods, keeps template-relevant public methods
- [x] Provide $Variable completions in templates (variableCompletionProvider.ts)
  - Triggers on $ character
  - Sorted: db fields → relations → methods
  - Includes loop position variables ($Pos, $Even, $IsFirst, etc.)
- [x] Basic loop/with scope tracking
  - Tracks <% loop %> and <% with %> blocks via scope stack
  - Resolves scope variable to relation target class
- [x] Status bar shows mapped PHP class for current template
- [ ] Support method chains and relations (e.g., $Image.Fill().URL) — dot-chain resolver
- [ ] Enhanced scope tracking with $Up/$Top support
- [ ] Validate and test completions

### Phase 3: Advanced Features (AST/Parser-Powered)

**Implementation Approach - Three Options:**

**Option A: Skip Phase 3 (Regex-Only)**
- Stay with Phase 1-2 regex pattern matching
- Ship faster, minimal maintenance
- Handles 80% of use cases perfectly
- Add Phase 3 later only if users request it

**Option B: Lightweight Scope Tracker (Recommended Middle Ground)**
- Build simple scope stack (~50-100 lines): track `<% loop %>`, `<% with %>`, `<% if %>` blocks
- Don't parse full syntax, just block boundaries
- Enough for context-aware completions without compiler complexity
- Handles 90% of cases, avoids deep regex and full parser

**Option C: Full AST Parser (Most Complete)**
- Recursive descent parser (~500 lines) 
- Complete syntax tree with validation
- Handles all edge cases and enables refactoring tools
- Requires compiler theory knowledge and ongoing maintenance

*Current plan: Option C is detailed below, but Option B is likely the sweet spot.*

---

**Why we need a Parser/AST:**
An Abstract Syntax Tree would give us hierarchical understanding of template structure, enabling:
- Accurate scope tracking through nested blocks
- Type resolution at any cursor position (for PHPActor queries)
- Understanding of method chains: `$Children.Filter('X').Sort('Y').First`
- Validation of template syntax and control flow

**What the AST needs to parse (from Silverstripe syntax):**

*Control Structures:*
- [ ] `<% if $Condition %>...<% end_if %>` with `<% else_if %>`, `<% else %>`
- [ ] `<% loop $Collection %>...<% end_loop %>`
- [ ] `<% with $Object %>...<% end_with %>`
- [ ] Boolean operators: `||`, `or`, `&&`, `and`, `not`
- [ ] Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`

*Variables & Methods:*
- [ ] Simple variables: `$Title`, `$Content`
- [ ] Method calls: `$Foo("param")`, `$Foo('param')`, `$Foo(param)`
- [ ] Method chains: `$Foo.Bar`, `$Image.Fill(300,200).URL`
- [ ] Arguments: strings, numbers, booleans, null, other variables
- [ ] List methods: `.Sort()`, `.Limit()`, `.Filter()`, `.Reverse()`

*Scope Navigation:*
- [ ] `$Up` - traverse up one scope level
- [ ] `$Top` - jump to root scope
- [ ] `$Me` - current object in scope (calls forTemplate())

*Loop Position Indicators:*
- [ ] `$Even`, `$Odd`, `$EvenOdd`, `$Pos`, `$FromEnd`, `$TotalItems`
- [ ] `$IsFirst`, `$IsLast`, `$Middle`, `$FirstLast`, `$MiddleString`
- [ ] `$Modulus(N)`, `$MultipleOf(N)`

*Other Template Features:*
- [ ] `<% include TemplateName %>` with passed arguments
- [ ] `<% base_tag %>`, `<% require %>` and other special tags
- [ ] Comments: `<%-- hidden comment --%>`
- [ ] Escaping: `{$Var}`, `\$Var`, `${$Var}`

**Implementation Plan:**
- [ ] Design AST node types (IfNode, LoopNode, VariableNode, MethodCallNode, etc.)
- [ ] Build recursive descent parser in TypeScript (~300-500 lines)
- [ ] Create scope stack tracker (push on loop/with/if, pop on end)
- [ ] Map cursor position → current scope → available types
- [ ] Query PHPActor for type info based on current scope
- [ ] Provide context-aware completions
- [ ] Add validation warnings for invalid syntax/logic

**Advanced Features Enabled by AST:**
- [ ] Loop context awareness: know what type `$Title` refers to inside `<% loop $Children %>`
- [ ] Scope navigation validation: warn if `$Up` goes beyond root
- [ ] Method chain completion: after `$Image.Fill(300,200).` suggest image manipulation methods
- [ ] Type-aware validation and signature help
- [ ] Smart refactoring: rename variables across template
- [ ] Template structure outline view

**Community & Polish:**
- [ ] Performance testing with large templates
- [ ] Community feedback and testing
- [ ] Documentation and examples

## How to Work From Here
- Use this file as the single source of truth for project planning
- Check off tasks as they are completed
- Add notes, issues, and ideas as the project evolves
- Keep the extension minimal, modern, and focused on real Silverstripe developer needs

---

*This plan is based on the January 2026 context and will evolve as the project progresses.*
