# What end-to-end encryption does and doesn't protect

*For customers of Messaging Express who turn on end-to-end encryption (E2EE) for their app. Plain language on purpose: please share it with your own security and legal teams.*

## In one paragraph

With E2EE on, the text of messages and the contents of attachments are encrypted on your users' devices and can only be read on the devices of the people in the conversation. Messaging Express, its database, its logs, its backups and its staff cannot read them. We can still see **who talks to whom, and when**.

## What is protected

- **Message text.** Encrypted on the sender's device, decrypted on the recipients' devices. We store and deliver ciphertext.
- **Attachment contents.** Files are encrypted before upload and stored as opaque blobs.
- **Encryption keys.** Conversation keys are wrapped for each device and device private keys never leave the device. We store wrapped keys we cannot open.
- **The optional key backup** is encrypted on the device with a key derived from the user's passphrase. We store a blob we cannot open.
- **A database leak, a stolen backup or a log leak** of Messaging Express reveals ciphertext, not conversations.
- **Removed members.** When someone is removed from an encrypted conversation, the server stops accepting messages under the old key until the remaining members have switched to a new one that the removed person's devices are not given.

## What is NOT protected

- **Metadata is visible to us**: user ids, conversation membership, who sent each message and when, message and file sizes, device names, when devices were added or removed, IP addresses and timing. Attachment file names and any custom `metadata` your app adds are visible too, so use neutral names.
- **Your own systems see ciphertext only, and that has consequences.** Webhooks, search, moderation, translation, analytics, link previews and anything else that reads message text on the server **cannot work** on encrypted conversations. If you need them, do them on the device.
- **A compromised or malicious server (or a compromised admin/API token) can add a device for a user.** Clients that trust new devices automatically (the default) will share the conversation key with it. Apps with high security needs should require users to confirm new devices by comparing safety numbers. This is the most important residual risk.
- **Availability and integrity of delivery.** The server can delay, drop, delete or reorder messages. Encryption doesn't prevent that.
- **Who really wrote a message.** In this version every member holds the same conversation key and messages are not individually signed, so a malicious server could show one member a message as if another member had sent it.
- **No forward secrecy in this version.** Anyone who obtains a conversation key can read every message encrypted under it. The key changes when a member is removed, or when a client rotates it.
- **A user's own device.** Malware, a stolen unlocked phone or a screenshot defeats any E2EE.
- **Weak backup passphrases.** If a user saves a key backup, someone who obtains the stored blob can try passphrases offline. A strong passphrase matters.

## What happens when users lose things

- **Lose one device:** nothing is lost if another device remains; revoke the lost one.
- **Lose all devices, with a backup:** the user registers a new device and restores the backup with their passphrase.
- **Lose all devices, without a backup:** old encrypted messages cannot be read again, by anyone. Your backend can reset the user's devices so they can start again; they will only see new messages and whatever other members choose to re-share.
- **New devices and history:** a newly added device sees past messages only if one of the user's existing devices passes the older keys to it.

## What you control

- E2EE is **opt-in per conversation** (`encryptionMode`) and off for the whole system until you enable it.
- Your backend decides who may add or remove members, and holds the admin token used for recovery. Keep that token on your servers only.
- Turning E2EE off at the server does **not** turn encrypted conversations back into protected plain ones: while it is off the server stops checking them, so a client that sends plaintext into an encrypted conversation would have it stored as such. Plan any change with your users first.

## Summary table

| | Visible to Messaging Express? |
|---|---|
| Message text | No |
| Attachment contents | No |
| Conversation keys, device private keys, backup passphrases | No |
| Who is in a conversation, who sent a message, when | Yes |
| Message and file sizes, file names, custom metadata | Yes |
| Device public keys, device names, device add/revoke times | Yes |
| IP address and request timing | Yes |
