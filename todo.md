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
- [ ] Test in a real Silverstripe project (DDEV/devcontainer)
- [ ] Polish and commit initial version

### Phase 2: PHPActor Integration
- [ ] Research VSCode <-> PHPActor LSP bridge
- [ ] Map template to PHP class (e.g., Page.ss → App\Page)
- [ ] Query PHPActor for class members, methods, and types
- [ ] Provide variable/method completions in templates
- [ ] Support method chains and relations (e.g., $Image.Fill().URL)
- [ ] Handle loop/with/if scope context
- [ ] Validate and test completions

### Phase 3: Advanced Features
- [ ] Loop context awareness: `<% loop $Children %> $Title <% end_loop %>`
- [ ] Scope navigation: `$Up`, `$Top`
- [ ] Type-aware validation and signature help
- [ ] Community feedback and polish

## How to Work From Here
- Use this file as the single source of truth for project planning
- Check off tasks as they are completed
- Add notes, issues, and ideas as the project evolves
- Keep the extension minimal, modern, and focused on real Silverstripe developer needs

---

*This plan is based on the January 2026 context and will evolve as the project progresses.*
