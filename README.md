# Silverstripe Language Support

VSCode extension providing intelligent Silverstripe template (`.ss`) language support with PHPActor integration. There are lots of emojis and as you may have guessed, I didn't care about the code too much. It's an experiment to integrate PHPActor, Annotations & Cache into a VSCode plugin.

## Features

- ✅ **Syntax Highlighting**: Rich syntax highlighting for `.ss` template files, including embedded JS and CSS
- ✅ **Emmet Support**: Full Emmet abbreviation expansion inside `.ss` files
- ✅ **Go to Definition**: Navigate from `<% include MyTemplate %>` to the template file
- ✅ **Template Autocomplete**: Suggests available templates when typing `<% include %>`
- ✅ **Variable Completion**: `$Title`, `$Content`, etc. — sourced from `$db`, `$has_one`, `$has_many`, `@property` docblocks, and PHPActor methods
- ✅ **Dot-chain Completion**: `$Image.Fill(300,200).` resolves the return type and offers its members
- ✅ **Loop/With Scope Tracking**: Completions reflect the correct class inside `<% loop %>` and `<% with %>` blocks
- ✅ **`$Up` / `$Top` Navigation**: Scope traversal completions across nested loops
- ✅ **PHPActor Integration**: Queries `phpactor class:reflect` for inherited and annotated methods
- ✅ **Status Bar**: Shows the mapped PHP class (FQN) for the active template file

## For DDEV + Devcontainer Projects

This extension is designed to work within DDEV devcontainer environments.

### Setup in Your Project

1. **Clone into your project:**
   ```bash
   cd /var/www/html
   git clone https://github.com/lerni/silverstripe-actor.git
   ```

2. **Add to `.devcontainer/devcontainer.json`:**
   ```jsonc
   {
     "postCreateCommand": "cd /var/www/html/ss-vscode-actor && npm install && npm run compile",
     "customizations": {
       "vscode": {
         "extensions": [
           // ... other extensions
         ]
       }
     }
   }
   ```

3. **Reload devcontainer:**
   - Press `Cmd/Ctrl + Shift + P`
   - Select "Dev Containers: Rebuild Container"

4. **Open a workspace that includes both:**
   Create a multi-root workspace file (e.g., `myproject.code-workspace`):
   ```json
   {
     "folders": [
       { "path": "." },
       { "path": "ss-vscode-actor", "name": "SS Extension" }
     ]
   }
   ```

5. **Press F5** when `ss-vscode-actor` folder is active to launch Extension Development Host

## Development

### Initial Setup

```bash
cd ss-vscode-actor
npm install
```

### Build Commands

#### Compile Once
```bash
npm run compile
```
Compiles TypeScript to JavaScript in the `dist/` folder.

#### Watch Mode (auto-compile on save)
```bash
npm run watch
```
Automatically recompiles when you save TypeScript files. Keep this running during development.

#### Debug/Test the Extension

1. Open the `ss-vscode-actor` folder in VSCode
2. Press `F5` to launch Extension Development Host (runs the "Run Extension" launch config)
3. Open a Silverstripe project in the new window
4. Test with `.ss` files

The `preLaunchTask` will automatically compile before debugging.

#### Package for Distribution

```bash
npx vsce package
```
Creates: `silverstripe-actor-0.1.0.vsix`

#### Install Packaged Extension

In VS Code:
1. Press `Cmd/Ctrl + Shift + P`
2. Type "Extensions: Install from VSIX"
3. Select `silverstripe-actor-0.1.0.vsix`
4. Reload VS Code when prompted

Or via command line:
```bash
code --install-extension silverstripe-actor-0.1.0.vsix
```

## Architecture

### How it works

The extension combines three strategies for completions:

1. **Direct PHP source parsing** — reads `$db`, `$has_one`, `$has_many`, `$many_many`, `$belongs_many_many` arrays and `@property`/`@method` docblock annotations directly from the PHP file.
2. **PHPActor CLI** — calls `phpactor class:reflect --format=json 'FQN'` to enumerate inherited and annotated public methods. Results are cached per file with mtime invalidation.
3. **Composer and Silverstripe module discovery** — parses Composer metadata and mirrors Silverstripe's manifest rules (`_config/`, `_config.php`, and `_manifest_exclude`) to discover module template directories.

For template includes, the extension uses this Silverstripe-style manifest discovery to find templates in vendor packages and local modules, in addition to app and theme templates.

Template-to-class mapping follows Silverstripe conventions:
- `templates/App/Elements/ElementHero.ss` → `App\Elements\ElementHero`
- `templates/Layout/Page.ss` → `Page` (strips `Layout/` sub-type)
- `templates/App/Includes/Header.ss` → no class (includes are excluded)
- `ElementPage_produkt.ss` → `ElementPage` (strips `_suffix` variants)

### Project Structure

```
ss-vscode-actor/
├── src/
│   ├── extension.ts                         # Entry point, registers all providers
│   └── providers/
│       ├── templateDefinitionProvider.ts    # Go-to-definition for <% include %>
│       ├── templateCompletionProvider.ts    # Autocomplete for template paths
│       ├── templateClassMapper.ts           # Maps .ss file → PHP class FQN
│       ├── phpClassInspector.ts             # Reads PHP source + queries PHPActor
│       └── variableCompletionProvider.ts    # $Variable and dot-chain completions
├── syntaxes/
│   ├── silverstripe.tmLanguage.json         # Main grammar
│   └── silverstripe-injection.tmLanguage.json
├── dist/                                    # Compiled output (gitignored)
├── package.json                             # Extension manifest
├── tsconfig.json                            # TypeScript config
└── .vscode/
    ├── launch.json                          # Debug config
    └── tasks.json                           # Build tasks
```

### Known limitations / still to do
- PSR-4 cache is not invalidated when `composer install`/`update` runs (requires reload)
- Signature help for methods not yet implemented

## Customizing Syntax Highlighting

The extension provides rich syntax highlighting for Silverstripe templates using TextMate scopes. You can customize the colors to match your preferred theme.

### Inspecting Scopes

1. Open any `.ss` file
2. Press `Cmd/Ctrl + Shift + P` → "Developer: Inspect Editor Tokens and Scopes"
3. Click on any Silverstripe syntax element to see its scope

### Example Customizations

Add to your VSCode `settings.json` (Preferences → Settings → `{}` icon):

```jsonc
"editor.tokenColorCustomizations": {
    "textMateRules": [
        {
            // <% %> brackets
            "scope": "punctuation.definition.silverstripe",
            "settings": {
                "foreground": "#30afae"
            }
        },
        {
            // Keywords: if, loop, with, include, etc.
            "scope": "keyword.silverstripe",
            "settings": {
                "foreground": "#559ad1"
            }
        },
        {
            // Control structure names: end_if, end_loop
            "scope": "entity.name.type.silverstripe",
            "settings": {
                "foreground": "#C695C6",
                "fontStyle": "italic"
            }
        },
        {
            // Variables: $Title, $Content
            "scope": "entity.name.silverstripe variable.silverstripe",
            "settings": {
                "foreground": "#f6ac81"
            }
        },
        {
            // Method calls: .Fill(), .URL
            "scope": "entity.name.function.silverstripe",
            "settings": {
                "foreground": "#dcc665"
            }
        },
        {
            // Comments: <%-- comment --%>
            "scope": "comment.block.silverstripe",
            "settings": {
                "foreground": "#9E9E9E",
                "fontStyle": "italic"
            }
        }
    ]
}
```

### Available Scopes

- `punctuation.definition.silverstripe` - `<%` and `%>` delimiters
- `keyword.silverstripe` - Control keywords (`if`, `loop`, `include`, etc.)
- `entity.name.type.silverstripe` - Type names and end tags
- `entity.name.silverstripe` - Variable names
- `entity.name.function.silverstripe` - Method calls
- `comment.block.silverstripe` - Template comments
- `string.quoted.double.silverstripe` - Double-quoted strings
- `string.quoted.single.silverstripe` - Single-quoted strings
- `punctuation.separator.silverstripe` - Commas and separators

## License

MIT
