# Contributing

## Releasing to the Marketplace

Publishing runs automatically via GitHub Actions (`.github/workflows/ci.yml`) whenever a tag matching `v*` is pushed. The workflow verifies the tag matches `package.json`'s `version`, then runs `vsce publish`.

**One-time setup — add the `VSCE_PAT` secret:**
1. Create a Personal Access Token in [Azure DevOps](https://dev.azure.com) (any organization, scope: **Marketplace → Manage**).
2. In the GitHub repo, go to Settings → Secrets and variables → Actions → New repository secret.
3. Name it `VSCE_PAT` and paste the token.

**To cut a new release locally:**
```bash
# 1. Bump the version in package.json (patch/minor/major) and commit
npm version patch -m "Release v%s"

# 2. Push the commit and the new tag
git push && git push --tags
```
`npm version` updates `package.json`, commits, and creates a `vX.Y.Z` tag. Pushing the tag triggers the `publish` job, which builds and runs `vsce publish` using the `VSCE_PAT` secret.
