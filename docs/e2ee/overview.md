# End-to-end encryption: what it protects and what it does not

*Written in plain language for people who turn on end-to-end encryption (E2EE) in their app. Please share it with your own security and legal teams.*

## In one paragraph

With E2EE on, the text of messages and the contents of attachments are encrypted on your users' devices and can only be read on the devices of the people in the conversation. The Messaging Express server, its database, logs and backups cannot read them. The server can still see **who talks to whom, and when**.

E2EE is optional, off by default for the whole system (`E2EE_ENABLED`), and chosen per conversation (`encryptionMode`). The server side is described in the [E2EE guide](guide.md) and [E2EE API](api.md); the client side is the [`@messaging-express/client-crypto`](../../packages/client-crypto/README.md) package.

## What is protected

- **Message text.** Encrypted on the sender's device, decrypted on the recipients' devices. The server stores and delivers ciphertext.
- **Attachment contents.** Files are encrypted before upload and stored as opaque blobs.
- **Keys.** Conversation keys are wrapped for each device; device private keys never leave the device. The server stores wrapped keys it cannot open.
- **The optional key backup** is encrypted on the device with a key derived from a recovery code or passphrase. The server stores a blob it cannot open.
- **A database leak, a stolen backup or a log leak** reveals ciphertext, not conversations.
- **Removed members.** When someone is removed from an encrypted conversation, the server refuses new messages under the old key until a remaining member switches to a new key that the removed person's devices are not given.

## What is not protected

- **Metadata is visible to the server:** user ids, who is in a conversation, who sent each message and when, message and file sizes, device names, when devices were added or removed, IP addresses and timing. Attachment file names and any custom `metadata` your app adds are visible too, so use neutral names.
- **Your own systems see ciphertext only.** Webhooks, search, moderation, translation, analytics, link previews and anything else that reads message text on the server **cannot work** on encrypted conversations. Do those on the device if you need them.
- **A compromised server (or a compromised admin or API token) can add a rogue device for a user.** Clients that trust new devices automatically (the default) will share the conversation key with it. Apps with high security needs should have users confirm new devices and compare safety numbers. This is the most important residual risk.
- **Availability and delivery integrity.** The server can delay, drop, delete, repeat or reorder messages.
- **Who really wrote a message.** All members hold the same conversation key and messages are not individually signed, so a malicious server could show one member a message as if another member had sent it. The client binds each message to the sender id the server reports, which stops re-attribution after the fact but not a lying server.
- **No forward secrecy.** Anyone who obtains a conversation key can read every message encrypted under it. The key changes when a member is removed or a client rotates it.
- **A user's own device.** Malware, a stolen unlocked phone or a screenshot defeats any E2EE.
- **Weak backup passphrases.** Someone who obtains the stored backup blob can try passphrases offline. A generated recovery code cannot be guessed; a human passphrase is only as strong as the human.
- **Independent review.** This is a first-version design reviewed by its author. Get an independent review before relying on it for high-stakes use.

## What the server can and cannot see

| Visible to the server (and anyone with its database or logs) | Not visible |
|---|---|
| Who is in which conversation, who sent what, and when | Message text, attachment contents |
| Message and attachment sizes and counts, file names, custom `metadata` | Conversation keys, device private keys, backup secrets |
| Device public keys, device names, add and revoke times | Which wrapped key opens which plaintext key |
| IP addresses and request timing | |

## Attackers at a glance

| Attacker | Reads messages? | Notes |
|---|---|---|
| Passive network observer (TLS intact) | No | |
| Server operator or database thief | No | Can see metadata, withhold, reorder or repeat messages, and try a rogue device |
| Server that adds a rogue device, nobody checking | **Yes, from then on** | Detected by device-change events and safety numbers; prevented by requiring confirmation of new devices |
| Member of the conversation | Yes | Can also impersonate other members |
| Removed member | Not new messages | Keeps old keys and what they downloaded |
| Thief with an unlocked device | Everything that device could read | |
| Holder of a stolen backup blob | No, unless the secret is weak | 64 MiB Argon2id per guess |

## When users lose things

- **One device lost:** nothing is lost if another remains; revoke the lost one.
- **All devices lost, with a backup:** register a new device and restore the backup with the recovery code or passphrase.
- **All devices lost, no backup:** old encrypted messages cannot be read again, by anyone. Your backend can reset the user's devices (see the [E2EE API](api.md#admin-reset-a-users-devices)) so they can start again; they only see new messages and whatever other members re-share.
- **New devices and history:** a new device reads past messages only if one of the user's existing devices passes the older keys to it.

## What you control

- E2EE is **opt-in per conversation** and disabled for the whole system until you enable it.
- Your backend decides who may add or remove members and holds the admin token used for recovery. Keep that token on your servers only.
- **Turning E2EE off at the server does not turn encrypted conversations back into protected ones.** While the switch is off the server stops checking them, so plaintext sent into an encrypted conversation would be stored as plaintext. Plan any change with your users first. See [rollback](guide.md#turning-it-off-read-this-first).
