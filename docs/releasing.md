# Releasing the client packages

Two npm packages live in this repository. The step-by-step flow below (tag, GitHub Actions, provenance) is wired up for the SDK. The encryption package has no publish workflow yet, so it is published by hand from your terminal, see [the encryption package](#the-encryption-package-needs-a-review-first).

| Package | Folder | Purpose |
|---|---|---|
| `@messaging-express/client` | `packages/client` | TypeScript SDK for the REST API and realtime |
| `@messaging-express/client-crypto` | `packages/client-crypto` | End-to-end encryption for the SDK |

Publishing is **public and permanent**: npm never lets you reuse a version number, and unpublishing is only possible for a short window. The SDK is checked by a gate script (`packages/client/scripts/check-release.mjs`) before anything goes out.

## SDK: one-time setup

1. **npm account** with two-factor authentication on (npmjs.com → Account → Two-Factor Authentication). Publishing requires it.
2. **Organization.** Create `messaging-express` on npmjs.com (free for public packages). If the name is taken, stop and pick another scope: the package names must change everywhere before the first publish.
3. **Release metadata and license holder** (from the repo root):
   ```
   node scripts/patch-sdk-release.mjs --holder "Your Name"
   ```
   Commit the result (`package.json` and `LICENSE` of the package).
4. **First publish, from your own terminal.** npm only lets you configure trusted publishing on a package that already exists, so version one cannot come from CI.
   ```
   npm login
   cd packages\client
   npm publish --access public --dry-run
   npm publish --access public
   ```
   The dry run lists what would be uploaded: expect only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`. The real publish runs typecheck, tests, build and the release check first, then asks for your one-time code.
5. **Connect GitHub Actions** so later releases need no token. On npmjs.com open the package → Settings → **Trusted Publisher** → GitHub Actions and enter: organization or user `acetennyson`, repository `messaging-express`, workflow filename `sdk-publish.yml`, environment empty.

## SDK: every later release

1. In the package folder, bump the version: `npm version patch --no-git-tag-version` (or `minor`, `major`).
2. Add a `## [x.y.z] - date` section to the package's `CHANGELOG.md`.
3. Commit and push to `main`; wait for the SDK workflow to go green.
4. Tag and push the tag. The tag must be `sdk-v` plus the exact version:
   ```
   git tag sdk-v0.1.1
   git push origin sdk-v0.1.1
   ```
5. The publish workflow runs the whole gate and publishes. The package page shows a **Provenance** badge when it worked.

## Pre-releases (either package)

To let people try a version without making it the default install, publish it under another tag:

```
npm version 0.1.0-rc.0 --no-git-tag-version
npm publish --access public --tag next
```

`npm install @messaging-express/client` keeps installing `latest`; `@next` installs the pre-release. Promote it later with `npm dist-tag add @messaging-express/client@0.1.0 latest`.

## The encryption package needs a review first

`@messaging-express/client-crypto` is cryptography. Before the version people get by default (`latest`) is published, have a qualified person review the key handling, the wrapping scheme and the message format (see [E2EE overview](e2ee/overview.md) and the package's `WIRE_FORMAT.md`) and fix what they find. Until then publish only pre-releases under the `next` tag and say so in the package README. The package has `check-release.mjs`, `smoke-pack.mjs` and `verify-crypto.mjs` scripts in `packages/client-crypto/scripts`, and `prepublishOnly` runs typecheck, tests and build. Publish it from `packages/client-crypto` with `npm publish --access public --tag next`; its version in `package.json` is `0.0.0` until the first release, so set it first (for example `0.1.0-rc.0`). A wire-format change after real users have data means they cannot read old messages, so settle the format before `latest`.

## If something goes wrong

- **The release check fails** and names the problem (placeholder in LICENSE, tag not matching the version, missing changelog entry). Fix it, commit, and move the tag: `git tag -d sdk-v0.1.1`, `git push origin :refs/tags/sdk-v0.1.1`, then tag and push again.
- **Publish fails with 404 or "access token expired" in CI:** trusted publishing is not connected for this exact workflow filename, or npm is older than 11.5.1.
- **A bad version went out:** publish a fixed version and run `npm deprecate @messaging-express/client@x.y.z "reason"`. Do not rely on unpublishing.
