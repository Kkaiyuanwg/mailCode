# mailCode 📧

A lightweight Chrome extension that detects verification codes in recent Gmail messages and automatically fills verification fields on websites.

## Features

- **Automatic code detection:** Finds verification codes in recent unread Gmail messages.
- **Automatic filling:** Detects verification fields and fills them when a matching code arrives.
- **Desktop notifications:** Notifies you when a new code is detected.
- **Manual actions:** Search unread emails, retrieve codes for the current page, or copy them directly.
- **Account selection:** Choose which signed-in Gmail account to use.
- **Privacy-focused:** Email data is processed locally and never sent to external servers.

## Gmail Integration

mailCode uses your existing Gmail browser session to access the Gmail Atom feed. No OAuth, API keys, or additional authentication are required.

Simply sign in to Gmail using the same Chrome profile and select the account you want to use.

The extension only reads unread message summaries. It stores the latest detected code and basic email information locally, without saving full email contents or your Gmail password.

## Automatic Code Filling

When a verification field is detected, mailCode starts monitoring Gmail for a matching code.

- Displays the current detection status next to the verification field.
- Checks for new codes when Gmail synchronizes.
- Uses a 30-second fallback check while waiting for a code.
- Sends a desktop notification when a code is found.
- Fills the verification field automatically.

**Forms are never submitted automatically.**

Automatic filling can be enabled or disabled in the Settings panel.

## Privacy & Permissions

- Uses your existing Gmail session.
- Does not require OAuth or store passwords.
- Processes website detection locally in your browser.
- Does not send email content or website data to external servers.
- Stores detected codes and basic message details locally.

**Required permissions:**
- Gmail website access to read the Atom feed.
- Website access to detect verification fields.
- Notifications for code alerts.
- Background alarms for periodic checks.

> Only enable automatic filling on websites you trust.

## Limitations

- Only unread Gmail messages are checked.
- Codes outside the email summary may not be detected.
- Detection depends on Gmail's synchronization activity.
- Gmail's internal synchronization endpoints are undocumented and may change without notice.