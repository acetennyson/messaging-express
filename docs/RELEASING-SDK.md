# Releasing @messaging-express/client

Publishing is **public and permanent**: npm never lets you reuse a version number, and unpublishing is only possible for a short
window. So everything below is checked by a gate (`packages/client/scripts/check-release.mjs`) before anything goes out.

## One-time setup

1. **npm account.** Turn on two-factor authentication (npmjs.com → Account → Two-Factor Authentication). Publishing requires it.
2. **Create the organization** `messaging-express` on npmjs.com (free for public packages). That makes you the owner of the `@messaging-express` scope.
   If the name is taken, stop and pick another scope: the package name must change everywhere before the first publish.
3. **Release metadata and license holder** (repo root):
   ```
   node scripts/patch-sdk-release.mjs --holder "Your Name"
   ```
   Commit the result (`packages/client/package.json`, `packages/client/LICENSE`).
4. **First publish, once, from your own terminal.** npm only lets you configure trusted publishing on a package that already exists, so the very first
   version cannot come from CI.
   ```
   npm login
   cd packages\client
   npm publish --access public --dry-run
   npm publish --access public
   ```
   The dry run lists the files that would be uploaded: expect only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`.
   The real publish runs typecheck, tests, the build and the release check first, then asks for your one-time code.
5. **Connect GitHub Actions** (so later releases need no token at all). On npmjs.com open the package → Settings → **Trusted Publisher** → GitHub Actions:
   - Organization or user: `acetennyson`
   - Repository: `messaging-express`
   - Workflow filename: `sdk-publish.yml`
   - Environment: leave empty

## Every later release

1. In `packages/client`: bump the version (`npm version patch --no-git-tag-version`, or `minor` / `major`).
2. Add a `## [x.y.z] - date` section to `packages/client/CHANGELOG.md`.
3. Commit and push to `main`, and wait for the `SDK` workflow to go green.
4. Tag and push the tag (the tag must be `sdk-v` plus the exact version):
   ```
   git tag sdk-v0.1.1
   git push origin sdk-v0.1.1
   ```
5. The `Publish SDK` workflow runs the whole gate and publishes. The package page on npmjs.com shows a **Provenance** badge when it worked.

## If something goes wrong

- **The release check fails** and names the problem (placeholder in LICENSE, tag not matching the version, missing changelog entry...). Fix it, commit, and move the tag:
  `git tag -d sdk-v0.1.1`, `git push origin :refs/tags/sdk-v0.1.1`, then tag and push again.
- **Publish fails with 404 or "access token expired"** in CI: trusted publishing is not connected for this exact workflow filename, or npm is older than 11.5.1.
- **A bad version went out:** publish a fixed version and mark the bad one with `npm deprecate @messaging-express/client@x.y.z "reason"`. Do not rely on unpublishing.
