# Silverstripe Language Support

VSCode extension providing intelligent Silverstripe template (`.ss`) language support with PHPActor integration.

## Features

- ✅ **Syntax Highlighting**: Rich syntax highlighting for `.ss` template files
- ✅ **Go to Definition**: Navigate from `<% include MyTemplate %>` to template file
- ✅ **Template Autocomplete**: Suggests available templates when typing includes
- 🚧 **PHPActor Integration**: Variable completion based on PHP class analysis (Phase 2)

## For DDEV + Devcontainer Projects

This extension is designed to work within DDEV devcontainer environments.

### Setup in Your Project

1. **Clone into your project:**
   ```bash
   cd /var/www/html
   git clone git@github.com:yourusername/ss-lang-server.git
   ```

2. **Add to `.devcontainer/devcontainer.json`:**
   ```jsonc
   {
     "postCreateCommand": "cd /var/www/html/ss-lang-server && npm install && npm run compile",
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
       { "path": "ss-lang-server", "name": "SS Extension" }
     ]
   }
   ```

5. **Press F5** when `ss-lang-server` folder is active to launch Extension Development Host

## Development

### Initial Setup

```bash
cd ss-lang-server
npm install
```

### Compile

```bash
npm run compile
```

### Watch Mode (auto-compile on save)

```bash
npm run watch
```

### Debug

1. Open the `ss-lang-server` folder in VSCode
2. Press `F5` to launch Extension Development Host
3. Open a Silverstripe project in the new window
4. Test with `.ss` files

### Package for Distribution

```bash
npm run package
# Creates: silverstripe-ls-0.1.0.vsix
```

### Install Packaged Extension

```bash
code --install-extension silverstripe-ls-0.1.0.vsix
```

## Architecture

### Phase 1 (Current): Template Navigation
- ✅ Syntax highlighting from `silverstripe-syntax-highlighter`
- ✅ Go to definition for `<% include %>`
- ✅ Template path autocomplete
- ✅ No external dependencies (no sanchez!)

### Phase 2 (Planned): PHPActor Integration
- Query PHPActor for class members
- Variable completion: `$Title`, `$Content`, etc.
- Method chain support: `$Image.Fill(200, 200).URL`
- Follow relations: `$Member.Email`

### Phase 3 (Future): Advanced Features
- Loop context awareness: `<% loop $Children %> $Title <% end_loop %>`
- Scope navigation: `$Up`, `$Top`
- Type-aware validation
- Signature help for methods

## Project Structure

```
ss-lang-server/
├── src/
│   ├── extension.ts                    # Main entry point
│   └── providers/
│       ├── templateDefinitionProvider.ts    # Go-to-definition
│       └── templateCompletionProvider.ts    # Autocomplete
├── syntaxes/
│   ├── silverstripe.tmLanguage.json         # Main syntax
│   └── silverstripe-injection.tmLanguage.json
├── dist/                               # Compiled output (gitignored)
├── package.json                        # Extension manifest
├── tsconfig.json                       # TypeScript config
└── .vscode/
    ├── launch.json                     # Debug config
    └── tasks.json                      # Build tasks
```

## Using in Multiple Projects

Since this is a git repository, you can:

1. **Clone into each project** you work on
2. **Use the same devcontainer pattern** in all projects
3. **Pull updates** with `git pull` when improvements are made

## Contributing

This is a clean-slate implementation built specifically for:
- Modern Silverstripe (4.x, 5.x, 6.x)
- DDEV + devcontainer workflows
- PHPActor integration (not sanchez)
- Minimal dependencies

## License

MIT
