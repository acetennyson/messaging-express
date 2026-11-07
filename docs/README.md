# Documentation

Start with [Getting started](getting-started.md): you will have a server running and your first message sent in about ten minutes. Then read [Concepts](concepts.md), which explains the ideas everything else builds on.

## Learn

| Page | You will learn |
|---|---|
| [Getting started](getting-started.md) | Install, configure, create a tenant, send a message |
| [Concepts](concepts.md) | Organizations, projects, users, conversations, tokens, events |
| [Authentication](authentication.md) | The three token types, how your backend mints them, CORS |
| [API reference](api-reference.md) | Every route with real requests and responses, and every error |

## Features

| Page | Topic |
|---|---|
| [Access control](access-control.md) | Who may read and write which conversation; rolling it out safely |
| [Realtime](realtime.md) | Live delivery with Socket.IO |
| [Webhooks](webhooks.md) | Signed callbacks to your server, retries |
| [Uploads](uploads.md) | Attachments and storage providers |
| [Rate limiting](rate-limiting.md) | Limits, modes, customizing |
| [End-to-end encryption](e2ee/overview.md) | What it protects, [how it works](e2ee/guide.md), [route contract](e2ee/api.md) |

## Run it

| Page | Topic |
|---|---|
| [Configuration](configuration.md) | Every environment variable |
| [Deployment](deployment.md) | Docker, production, updates, scaling, checklist |
| [Database](database.md) | Tables, seeding, backups |
| [Load testing](load-testing.md) | Soak tests and what to watch |
| [Troubleshooting](troubleshooting.md) | Symptom → cause |

## Build on it

| Page | Topic |
|---|---|
| [Architecture](architecture.md) | How it is built |
| [Contributing](../CONTRIBUTING.md) | Setup, rules, tests, pull requests |
| [Releasing](releasing.md) | Publishing the npm packages |
| [Client SDK](../packages/client/README.md) | `@messaging-express/client` |
| [Encryption package](../packages/client-crypto/README.md) | `@messaging-express/client-crypto` |
| [Changelog](../CHANGELOG.md) | What changed |
