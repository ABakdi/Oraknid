# Mail

Oraknid can hold your mail accounts, so your agents can read, sort and draft, and so you can do it all in one place.

## Adding an account

On the **Mail** page, **Add an account**. Pick Gmail, Outlook or another provider, and IMAP or POP3:

- **Gmail and Outlook**: **Sign in with Google** or **Sign in with Microsoft** once you've set up your app (below), or use an **app password**, made in your account's security settings. Oraknid shows the link.
- **Any other provider**: its IMAP or POP3 server and its SMTP server. Type your address and Oraknid finds them from your domain (Namecheap, Zoho, Fastmail, iCloud and others); **Test** checks both before you connect, and a refusal says what to check.

The password goes to your keychain, never to Oraknid's database. If it stops working, the account shows **Reconnect**.

With IMAP, what you do (read, star, move, delete) happens on the server, so your other mail apps see it. With POP3, mail is downloaded and kept here; it stays on the server unless you turn on **delete from server**.

## Signing in with Google or Microsoft

Instead of an app password, Gmail and Outlook can sign in with Google or Microsoft. Oraknid has no app of its own with them: you register one, once, in your own Google or Microsoft account, and give Oraknid its ID in **Settings → Connections → Email accounts → Sign-in with Google and Microsoft**. The card shows each step and the redirect address to copy.

**Google** (Gmail):

1. On [console.cloud.google.com](https://console.cloud.google.com), create a project and enable the **Gmail API**.
2. **OAuth consent screen**: External, in testing, with your own address as a test user, and the scope `https://mail.google.com/`.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. A desktop app comes back to any address on 127.0.0.1, so there is nothing else to register.
4. Paste its **client ID** and **client secret** in Oraknid.

While the app is "in testing", Google asks you to sign in again every seven days; publishing it (for your own use) ends that.

**Microsoft** (Outlook, Hotmail, Microsoft 365):

1. On [entra.microsoft.com](https://entra.microsoft.com), **App registrations → New registration**, for accounts in any organisation and personal Microsoft accounts.
2. **Authentication**: turn on **Allow public client flows** (so you can sign in with a code). To sign in through the browser instead, add the platform **Mobile and desktop applications** with the redirect address the card shows.
3. **API permissions → Add a permission → APIs my organisation uses → Office 365 Exchange Online**: `IMAP.AccessAsUser.All` and `SMTP.Send` (delegated), and `offline_access`.
4. Paste its **Application (client) ID** in Oraknid. Microsoft needs no secret.

Then, in **Add an account**, press **Sign in with Google** (its page opens in a new tab and comes back to Oraknid) or **Sign in with Microsoft** (Oraknid shows a code: type it on Microsoft's page, and the account appears). The client secret and the tokens stay in your keychain; Oraknid renews the access as it runs out. If you revoke it, the account shows **Reconnect**, which signs you in again.

Signing in works on the computer running Oraknid, not away from home.

## Reading safely

Mail is shown in a frame where nothing can run. Remote images, which tell a sender you opened their mail, stay hidden until you allow them for a message or a sender.

## Agents and mail

A job whose skill uses the **email** tool can search, read, label, move, and write drafts. An agent's draft is marked as such and waits in **Waiting for you** until you approve it. Nothing is sent without you, unless you turn on auto-send for an account. Every agent action on your mail is in the log.
